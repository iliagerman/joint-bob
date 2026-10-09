import { randomBytes } from "node:crypto";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { ChannelHub } from "./hub.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import {
  CONNECT_PATH,
  FRAME_CLOSE,
  FRAME_CONTROL,
  FRAME_DATA,
  FRAME_WINDOW,
  INITIAL_WINDOW,
  MAX_FRAME,
  MAX_WINDOW,
  RELAY_NAME_PATTERN,
  REQUEST_NONCE_PATTERN,
  authPayload,
  decodeFrame,
  encodeClose,
  encodeControl,
  pairingCode,
  welcomePayload
} from "./protocol.js";
import { RelayStream, relayTransportOf } from "./stream.js";
import { POLL_PATH, PollServer } from "./poll.js";
import {
  addMachineUsage,
  admitMachine,
  audit,
  countAdmittedMachines,
  currentMonth,
  deleteMachine,
  ensureRelaySchema,
  expirePendingMachines,
  isKeyRevoked,
  machineUsage,
  markMachineAlerted,
  redeemRelayToken,
  relayMachine,
  relayMachineByName,
  renameRelayMachine,
  servingSettings,
  setMachinePhoneSignIn,
  setMachineStatus,
  touchMachine,
  upsertPendingMachine
} from "./store.js";
const AUTH_TIMEOUT_MS = 15e3;
const HEARTBEAT_MS = 3e4;
const MAX_CHANNELS_PER_MACHINE = 512;
const MAX_GATEWAY_CHANNELS_PER_MACHINE = 128;
const MAX_GATEWAY_REQUESTS_PER_IP = 32;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_UNAUTHENTICATED_PER_IP = 16;
const MAX_WATCHED = 1e4;
const REQUESTS_PER_HOUR = 5;
const USAGE_FLUSH_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOP_BY_HOP = /* @__PURE__ */ new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
class RelayServer {
  constructor(db, nodeId, nodeName, alert) {
    this.db = db;
    this.nodeId = nodeId;
    this.nodeName = nodeName;
    this.alert = alert;
    ensureRelaySchema(db);
    const identity = getOrCreateClusterIdentity(db, nodeId);
    this.publicKey = identity.publicKey;
    this.fingerprint = identity.fingerprint;
    this.settings = servingSettings(db);
  }
  db;
  nodeId;
  nodeName;
  alert;
  sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  polls = new PollServer((socket, request) => this.accept(socket, clientAddress(request)));
  sessions = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  watchers = /* @__PURE__ */ new Map();
  channels = /* @__PURE__ */ new Map();
  requestLog = /* @__PURE__ */ new Map();
  nextChannel = 1;
  settings;
  localSession;
  localHub;
  gatewaySession;
  gatewayHub;
  heartbeat;
  publicKey;
  fingerprint;
  get enabled() {
    return this.settings.enabled && Boolean(this.settings.origin);
  }
  get origin() {
    return this.settings.origin;
  }
  get environment() {
    return this.settings.environment;
  }
  get connectedCount() {
    return [...this.sessions.values()].filter((session) => session.kind === "remote").length;
  }
  isOnline(nodeId) {
    return this.sessions.has(nodeId);
  }
  /** Re-reads the settings after they changed. Turning serving off disconnects everyone. */
  reload() {
    this.settings = servingSettings(this.db);
    if (!this.enabled) {
      for (const session of [...this.sessions.values()]) if (session.kind === "remote") session.terminate("Relay serving was turned off");
      for (const [nodeId, pending] of this.pending) {
        pending.ws.close(1001, "Relay serving was turned off");
        this.pending.delete(nodeId);
      }
      this.polls.closeAll("Relay serving was turned off");
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = void 0;
      return;
    }
    this.enforceOwnMachinesOnly();
    const self = relayMachine(this.db, this.nodeId);
    if (!self || self.status !== "admitted") admitMachine(this.db, this.nodeId, this.publicKey, this.nodeName(), "self");
    if (this.localSession) this.localSession.gatewayEnabled = relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true;
    this.heartbeat ??= setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }
  /** In own-machines-only mode, disconnects machines that are not, or are no longer, this relay's twins. */
  enforceOwnMachinesOnly() {
    if (!this.enabled || !this.settings.ownMachinesOnly) return;
    for (const session of [...this.sessions.values()]) if (session.kind === "remote" && !this.servesMachine(session.nodeId)) session.terminate("This relay now serves only its owner's machines");
    for (const [nodeId, pending] of this.pending) if (!this.servesMachine(nodeId)) this.deny(pending.ws, "This relay serves only its owner's machines", "owner-only");
  }
  // ------------------------------------------------------------ in-process endpoints
  /** The relay node's own machine side: a hub that reaches other machines through this relay. */
  attachLocalMachine(handlers) {
    if (this.localHub) return this.localHub;
    let hub;
    const session = {
      kind: "local",
      nodeId: this.nodeId,
      publicKey: this.publicKey,
      gatewayEnabled: relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true,
      watching: /* @__PURE__ */ new Set(),
      channels: /* @__PURE__ */ new Set(),
      gatewayChannels: /* @__PURE__ */ new Set(),
      usageDelta: 0,
      deliver: (frame) => inProcess(() => hub.handleFrame(frame)),
      terminate: () => void 0
    };
    hub = new ChannelHub({
      send: (frame) => inProcess(() => this.handleSessionFrame(session, frame)),
      onIncoming: handlers.onIncoming,
      onControl: handlers.onControl
    });
    this.localSession = session;
    this.localHub = hub;
    if (this.enabled) this.activate(session);
    return hub;
  }
  /** The local machine is a member of its own relay only while serving is on. */
  syncLocalPresence() {
    if (!this.localSession) return;
    if (this.enabled && !this.sessions.has(this.nodeId)) this.activate(this.localSession);
    if (!this.enabled && this.sessions.get(this.nodeId) === this.localSession) this.deactivate(this.localSession);
  }
  localPhoneSignIn() {
    return relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true;
  }
  /** The relay machine's own name on its relay, and whether phones can open it. */
  selfListing() {
    if (!this.enabled) return void 0;
    const self = relayMachine(this.db, this.nodeId);
    return self ? { name: self.name, phone: this.localSession?.gatewayEnabled ?? self.phoneSignIn } : void 0;
  }
  /** With "own machines only" on, a machine must be this machine or one of its twins. */
  servesMachine(nodeId) {
    if (!this.settings.ownMachinesOnly || nodeId === this.nodeId) return true;
    try {
      return isTrustedTwin(this.db, this.nodeId, nodeId);
    } catch {
      return false;
    }
  }
  setLocalPhoneSignIn(enabled) {
    setMachinePhoneSignIn(this.db, this.nodeId, enabled);
    if (this.localSession) this.localSession.gatewayEnabled = enabled;
    if (this.sessions.has(this.nodeId)) this.announce(this.nodeId, true);
  }
  gateway() {
    if (!this.gatewaySession || !this.gatewayHub) {
      let hub;
      const session = {
        kind: "gateway",
        nodeId: this.nodeId,
        publicKey: this.publicKey,
        gatewayEnabled: false,
        watching: /* @__PURE__ */ new Set(),
        channels: /* @__PURE__ */ new Set(),
        gatewayChannels: /* @__PURE__ */ new Set(),
        usageDelta: 0,
        deliver: (frame) => inProcess(() => hub.handleFrame(frame)),
        terminate: () => void 0
      };
      hub = new ChannelHub({ send: (frame) => inProcess(() => this.handleSessionFrame(session, frame)), onIncoming: () => "The gateway accepts no channels" });
      this.gatewaySession = session;
      this.gatewayHub = hub;
    }
    return { session: this.gatewaySession, hub: this.gatewayHub };
  }
  // ------------------------------------------------------------ machine connections
  handleUpgrade(request, socket, head) {
    if (relayTransportOf(socket)) return false;
    const pathname = new URL(request.url ?? "/", "http://relay").pathname;
    if (pathname === CONNECT_PATH && !this.gatewayLabel(request)) {
      if (!this.enabled) {
        refuseUpgrade(socket, 404, "Relay serving is off");
        return true;
      }
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws, clientAddress(request)));
      return true;
    }
    return this.handleGatewayUpgrade(request, socket, head);
  }
  unauthenticated = /* @__PURE__ */ new Map();
  accept(ws, clientIp) {
    const relayNonce = randomBytes(32).toString("base64url");
    let session;
    let authenticated = false;
    let alive = true;
    const waiting = (this.unauthenticated.get(clientIp) ?? 0) + 1;
    if (waiting > MAX_UNAUTHENTICATED_PER_IP) {
      ws.close(1013, "Too many connections");
      return;
    }
    this.unauthenticated.set(clientIp, waiting);
    let counted = true;
    const stopCounting = () => {
      if (!counted) return;
      counted = false;
      const left = (this.unauthenticated.get(clientIp) ?? 1) - 1;
      if (left <= 0) this.unauthenticated.delete(clientIp);
      else this.unauthenticated.set(clientIp, left);
    };
    const timer = setTimeout(() => {
      if (!authenticated) ws.close(1008, "Authentication timed out");
    }, AUTH_TIMEOUT_MS);
    timer.unref();
    ws.relayAlive = () => {
      const was = alive;
      alive = false;
      return was;
    };
    ws.on("pong", () => {
      alive = true;
    });
    ws.send(encodeControl({ t: "hello", relayNodeId: this.nodeId, relayPublicKey: this.publicKey, nonce: relayNonce, protocol: 1 }));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        ws.close(1003, "Binary frames only");
        return;
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      try {
        if (session) {
          this.handleSessionFrame(session, frame);
          return;
        }
        if (authenticated) return;
        const decoded = decodeFrame(frame);
        if (decoded.type !== FRAME_CONTROL || decoded.message.t !== "auth") throw new Error("Expected authentication");
        authenticated = true;
        stopCounting();
        clearTimeout(timer);
        session = this.authenticate(ws, decoded.message, relayNonce, clientIp, (activated) => {
          session = activated;
        });
      } catch (error) {
        ws.close(1008, error instanceof Error ? error.message.slice(0, 120) : "Protocol error");
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      stopCounting();
      if (session) this.deactivate(session);
      for (const [nodeId, pending] of this.pending) {
        if (pending.ws !== ws) continue;
        this.pending.delete(nodeId);
        this.pendingActivation.delete(nodeId);
      }
    });
    ws.on("error", () => ws.terminate());
  }
  authenticate(ws, message, relayNonce, clientIp, onActivated) {
    if (!UUID.test(message.nodeId) || typeof message.publicKey !== "string" || message.publicKey.length > 4096 || typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce)) throw new Error("Malformed authentication");
    if (message.nodeId === this.nodeId) throw new Error("A relay cannot connect to itself");
    if (!verifyClusterMessage(message.publicKey, "relay-auth", authPayload(relayNonce, message.nonce, this.origin, message.nodeId), message.signature)) throw new Error("Authentication signature is invalid");
    const machineFingerprint = clusterPublicKeyFingerprint(message.publicKey);
    const proposedName = typeof message.name === "string" ? message.name.slice(0, 80) : "machine";
    const requestNonce = typeof message.requestNonce === "string" && REQUEST_NONCE_PATTERN.test(message.requestNonce) ? message.requestNonce : void 0;
    if (!this.servesMachine(message.nodeId)) return this.deny(ws, "This relay serves only its owner's machines", "owner-only");
    expirePendingMachines(this.db);
    let machine = relayMachine(this.db, message.nodeId);
    if (machine?.status === "revoked" || isKeyRevoked(this.db, machineFingerprint, clusterPublicKeyFingerprint)) return this.deny(ws, "This machine was removed from the relay", "revoked");
    if (machine && clusterPublicKeyFingerprint(machine.publicKey) !== machineFingerprint) {
      if (machine.status === "pending" && typeof message.token === "string") {
        this.decline(message.nodeId, "a token holder with another key");
        machine = void 0;
      } else {
        audit(this.db, "key-conflict", message.nodeId, `another key claimed this machine ID from ${clientIp}`);
        return this.deny(ws, "This machine ID is registered with a different key", "key-mismatch");
      }
    }
    if (machine?.status === "suspended") return this.deny(ws, "This machine is suspended on the relay", "suspended");
    if (machine?.status !== "admitted" && typeof message.token === "string") {
      if (countAdmittedMachines(this.db) >= this.settings.maxMachines) return this.deny(ws, "The relay is full", "full");
      const token = redeemRelayToken(this.db, message.token);
      if (!token) return this.deny(ws, "The relay token is invalid, used or expired", "invalid-token");
      if (machine?.status === "pending") this.dropPendingConnection(message.nodeId);
      machine = admitMachine(this.db, message.nodeId, message.publicKey, token.suggestedName ?? proposedName, `token:${token.id}`);
      audit(this.db, "admitted", message.nodeId, `${machine.name} with token "${token.label}"`);
    }
    if (machine?.status === "admitted") return this.welcome(ws, machine, relayNonce, message);
    if ((!machine || machine.status === "pending") && (message.request === true || machine) && !requestNonce) {
      return this.deny(ws, "This version of Joint Bob cannot request access; update it or use a relay token", "not-admitted");
    }
    if (!machine && message.request === true) {
      if (!this.settings.requestsEnabled) return this.deny(ws, "This relay does not accept access requests", "requests-off");
      if (!this.allowRequest(clientIp)) return this.deny(ws, "Too many access requests; try again later", "rate-limited");
      machine = upsertPendingMachine(this.db, message.nodeId, message.publicKey, proposedName, pairingCode(machineFingerprint, this.fingerprint, message.nodeId, requestNonce));
      audit(this.db, "requested", message.nodeId, `${proposedName} from ${clientIp}`);
    }
    if (machine?.status === "pending") {
      const code = pairingCode(machineFingerprint, this.fingerprint, message.nodeId, requestNonce);
      if (code !== machine.pairingCode) machine = upsertPendingMachine(this.db, message.nodeId, message.publicKey, machine.name, code);
      this.pending.get(message.nodeId)?.ws.close(1e3, "Replaced by a newer connection");
      this.pending.set(message.nodeId, { ws, relayNonce, machineNonce: message.nonce, gateway: message.gateway === true });
      ws.send(encodeControl({ t: "pending", pairingCode: code, signature: this.sign(welcomePayload(relayNonce, message.nonce, message.nodeId, "pending")) }));
      this.pendingActivation.set(message.nodeId, onActivated);
      return void 0;
    }
    return this.deny(ws, "This machine is not admitted. Use a relay token or request access.", "not-admitted");
  }
  pendingActivation = /* @__PURE__ */ new Map();
  welcome(ws, machine, relayNonce, message) {
    ws.trust?.();
    const relay = this.selfListing();
    ws.send(encodeControl({
      t: "welcome",
      name: machine.name,
      environment: this.settings.environment,
      relayOrigin: this.origin,
      ...relay ? { relayName: relay.name, relayPhone: relay.phone } : {},
      signature: this.sign(welcomePayload(relayNonce, message.nonce, message.nodeId, "admitted"))
    }));
    const session = {
      kind: "remote",
      nodeId: machine.nodeId,
      publicKey: machine.publicKey,
      gatewayEnabled: message.gateway === true,
      watching: /* @__PURE__ */ new Set(),
      channels: /* @__PURE__ */ new Set(),
      gatewayChannels: /* @__PURE__ */ new Set(),
      usageDelta: 0,
      deliver: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          ws.terminate();
          return;
        }
        ws.send(frame);
      },
      terminate: (reason, control) => {
        if (control && ws.readyState === WebSocket.OPEN) ws.send(encodeControl(control));
        ws.close(1e3, reason.slice(0, 120));
        this.deactivate(session);
      }
    };
    setMachinePhoneSignIn(this.db, machine.nodeId, session.gatewayEnabled);
    this.sessions.get(machine.nodeId)?.terminate("Replaced by a newer connection");
    this.activate(session);
    return session;
  }
  deny(ws, reason, code) {
    ws.send(encodeControl({ t: "denied", reason, code }));
    ws.close(1008, reason.slice(0, 120));
    return void 0;
  }
  sign(payload) {
    return signClusterMessage(this.db, this.nodeId, "relay-welcome", payload);
  }
  allowRequest(clientIp, at = Date.now()) {
    if (this.requestLog.size > 1e3) {
      for (const [ip, times] of this.requestLog) if (times.every((time) => at - time >= 60 * 60 * 1e3)) this.requestLog.delete(ip);
    }
    const recent = (this.requestLog.get(clientIp) ?? []).filter((time) => at - time < 60 * 60 * 1e3);
    if (recent.length >= REQUESTS_PER_HOUR) {
      this.requestLog.set(clientIp, recent);
      return false;
    }
    recent.push(at);
    this.requestLog.set(clientIp, recent);
    return true;
  }
  activate(session) {
    this.sessions.set(session.nodeId, session);
    if (session.kind === "remote") touchMachine(this.db, session.nodeId);
    this.announce(session.nodeId, true);
  }
  deactivate(session) {
    if (this.sessions.get(session.nodeId) !== session) return;
    this.sessions.delete(session.nodeId);
    for (const id of [...session.channels]) this.dropChannel(id, "Machine disconnected", session);
    for (const nodeId of session.watching) this.unwatch(nodeId, session);
    session.watching.clear();
    this.flushUsage(session, true);
    if (session.kind === "remote") touchMachine(this.db, session.nodeId);
    this.announce(session.nodeId, false);
  }
  unwatch(nodeId, session) {
    const set = this.watchers.get(nodeId);
    if (!set) return;
    set.delete(session);
    if (!set.size) this.watchers.delete(nodeId);
  }
  announce(nodeId, online) {
    const listings = online ? this.listingsFor([nodeId]) : {};
    for (const watcher of this.watchers.get(nodeId) ?? []) {
      watcher.deliver(encodeControl({ t: "presence", online: online ? [nodeId] : [], offline: online ? [] : [nodeId], listings }));
    }
  }
  /** Names and phone availability of online machines, only ever for node IDs a watcher already named. */
  listingsFor(nodeIds) {
    const out = {};
    for (const nodeId of nodeIds) {
      const session = this.sessions.get(nodeId);
      const machine = session ? relayMachine(this.db, nodeId) : void 0;
      if (session && machine) out[nodeId] = { name: machine.name, phone: session.gatewayEnabled };
    }
    return out;
  }
  ping() {
    for (const ws of this.sockets.clients) {
      const alive = ws.relayAlive;
      if (alive && !alive()) {
        ws.terminate();
        continue;
      }
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
  // ------------------------------------------------------------ routing
  handleSessionFrame(session, frame) {
    if (this.sessions.get(session.nodeId) !== session && session.kind !== "gateway") return;
    const decoded = decodeFrame(frame);
    switch (decoded.type) {
      case FRAME_CONTROL:
        this.handleControl(session, decoded.message);
        return;
      case FRAME_DATA: {
        const channel = this.channelFor(session, decoded.channel);
        if (!channel) return;
        const available = channel.credit.get(session) ?? 0;
        if (decoded.payload.length > available) {
          this.dropChannel(channel.id, "Flow control violated");
          return;
        }
        channel.credit.set(session, available - decoded.payload.length);
        const other = channel.a === session ? channel.b : channel.a;
        this.countUsage(session, decoded.payload.length);
        this.countUsage(other, decoded.payload.length);
        other.deliver(frame);
        return;
      }
      case FRAME_WINDOW: {
        const channel = this.channelFor(session, decoded.channel);
        if (!channel) return;
        const other = channel.a === session ? channel.b : channel.a;
        const credit = (channel.credit.get(other) ?? 0) + decoded.credit;
        if (credit > MAX_WINDOW) {
          this.dropChannel(channel.id, "Flow control violated");
          return;
        }
        channel.credit.set(other, credit);
        other.deliver(frame);
        return;
      }
      case FRAME_CLOSE: {
        const channel = this.channelFor(session, decoded.channel);
        if (channel) this.dropChannel(channel.id, decoded.reason, session);
        return;
      }
    }
  }
  channelFor(session, id) {
    const channel = this.channels.get(id);
    return channel && (channel.a === session || channel.b === session) ? channel : void 0;
  }
  /** Ends a channel and tells every side that did not ask for it. */
  dropChannel(id, reason, initiatedBy) {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    channel.a.channels.delete(id);
    channel.b.channels.delete(id);
    channel.b.gatewayChannels.delete(id);
    for (const side of [channel.a, channel.b]) if (side !== initiatedBy) side.deliver(encodeClose(id, reason));
  }
  handleControl(session, message) {
    switch (message.t) {
      case "watch": {
        if (!Array.isArray(message.nodeIds)) return;
        const wanted = new Set(message.nodeIds.filter((nodeId) => typeof nodeId === "string" && UUID.test(nodeId)).slice(0, MAX_WATCHED));
        for (const nodeId of session.watching) if (!wanted.has(nodeId)) this.unwatch(nodeId, session);
        session.watching.clear();
        for (const nodeId of wanted) {
          session.watching.add(nodeId);
          let set = this.watchers.get(nodeId);
          if (!set) {
            set = /* @__PURE__ */ new Set();
            this.watchers.set(nodeId, set);
          }
          set.add(session);
        }
        const online = [...wanted].filter((nodeId) => this.sessions.has(nodeId));
        session.deliver(encodeControl({ t: "presence", online, offline: [...wanted].filter((nodeId) => !this.sessions.has(nodeId)), listings: this.listingsFor(online) }));
        return;
      }
      case "gateway":
        session.gatewayEnabled = message.enabled === true;
        if (session.kind === "remote") setMachinePhoneSignIn(this.db, session.nodeId, session.gatewayEnabled);
        this.announce(session.nodeId, true);
        return;
      case "open": {
        const refuse = (error) => session.deliver(encodeControl({ t: "open-failed", ref: message.ref, error }));
        if (typeof message.ref !== "number" || !["peer", "syncthing"].includes(message.kind)) {
          refuse("Invalid request");
          return;
        }
        const target = typeof message.to === "string" ? this.sessions.get(message.to) : void 0;
        if (!target || target === session || target.kind === "gateway") {
          refuse("That machine is not connected to this relay");
          return;
        }
        if (!this.servesMachine(session.nodeId) || !this.servesMachine(target.nodeId)) {
          refuse("This relay serves only its owner's machines");
          return;
        }
        const problem = this.channelProblem(session) ?? this.channelProblem(target);
        if (problem) {
          refuse(problem);
          return;
        }
        const id = this.openChannel(session, target, message.kind);
        target.deliver(encodeControl({ t: "incoming", channel: id, from: session.nodeId, fromKey: session.publicKey, kind: message.kind }));
        session.deliver(encodeControl({ t: "opened", ref: message.ref, channel: id }));
        return;
      }
      case "reject": {
        const channel = this.channelFor(session, message.channel);
        if (channel) this.dropChannel(channel.id, typeof message.reason === "string" ? message.reason : "Refused", session);
        return;
      }
      default:
        return;
    }
  }
  channelProblem(session, kind = "peer") {
    if (kind === "gateway" ? session.gatewayChannels.size >= MAX_GATEWAY_CHANNELS_PER_MACHINE : session.channels.size - session.gatewayChannels.size >= MAX_CHANNELS_PER_MACHINE) return "Too many open channels";
    if (session.kind !== "remote" || !this.settings.monthlyCapBytes) return void 0;
    if (machineUsage(this.db, session.nodeId) + session.usageDelta >= this.settings.monthlyCapBytes) return "This machine used its monthly relay allowance";
    return void 0;
  }
  openChannel(a, b, kind) {
    let id = this.nextChannel;
    while (this.channels.has(id) || id === 0) id = id % 4294967295 + 1;
    this.nextChannel = id % 4294967295 + 1;
    this.channels.set(id, { id, a, b, kind, credit: /* @__PURE__ */ new Map([[a, INITIAL_WINDOW], [b, INITIAL_WINDOW]]) });
    a.channels.add(id);
    b.channels.add(id);
    if (kind === "gateway") b.gatewayChannels.add(id);
    return id;
  }
  countUsage(session, bytes) {
    if (session.kind !== "remote") return;
    session.usageDelta += bytes;
    if (session.usageDelta >= USAGE_FLUSH_BYTES) this.flushUsage(session, false);
  }
  flushUsage(session, final) {
    if (session.kind !== "remote" || session.usageDelta === 0) return;
    const month = currentMonth();
    addMachineUsage(this.db, session.nodeId, session.usageDelta, month);
    session.usageDelta = 0;
    const cap = this.settings.monthlyCapBytes;
    if (!cap || final) return;
    const machine = relayMachine(this.db, session.nodeId);
    if (!machine || machine.alertedMonth === month || machineUsage(this.db, session.nodeId, month) < cap) return;
    markMachineAlerted(this.db, session.nodeId, month);
    audit(this.db, "allowance-reached", session.nodeId, machine.name);
    if (this.settings.alertTopic) this.alert(this.settings.alertTopic, `Relay machine ${machine.name} used its monthly allowance. New channels are refused until next month.`);
  }
  // ------------------------------------------------------------ operator actions
  approve(nodeId, actor) {
    const machine = relayMachine(this.db, nodeId);
    if (!machine || machine.status !== "pending") throw new RelayServerError(404, "No pending request for that machine");
    if (countAdmittedMachines(this.db) >= this.settings.maxMachines) throw new RelayServerError(409, "The relay is full");
    const admitted = admitMachine(this.db, nodeId, machine.publicKey, machine.name, `approved:${actor}`);
    audit(this.db, "approved", nodeId, `${admitted.name} by ${actor}`);
    const pending = this.pending.get(nodeId);
    const activate = this.pendingActivation.get(nodeId);
    this.pending.delete(nodeId);
    this.pendingActivation.delete(nodeId);
    if (pending && activate && pending.ws.readyState === WebSocket.OPEN) {
      activate(this.welcome(pending.ws, admitted, pending.relayNonce, { nodeId, publicKey: admitted.publicKey, nonce: pending.machineNonce, gateway: pending.gateway }));
    }
    return admitted;
  }
  decline(nodeId, actor) {
    const machine = relayMachine(this.db, nodeId);
    if (!machine || machine.status !== "pending") throw new RelayServerError(404, "No pending request for that machine");
    deleteMachine(this.db, nodeId);
    audit(this.db, "denied", nodeId, `${machine.name} by ${actor}`);
    const pending = this.dropPendingConnection(nodeId);
    if (pending) this.deny(pending.ws, "The relay operator declined this request", "declined");
  }
  dropPendingConnection(nodeId) {
    const pending = this.pending.get(nodeId);
    this.pending.delete(nodeId);
    this.pendingActivation.delete(nodeId);
    return pending;
  }
  rename(nodeId, name, actor) {
    const before = relayMachine(this.db, nodeId);
    const machine = renameRelayMachine(this.db, nodeId, name);
    audit(this.db, "renamed", nodeId, `${before?.name ?? ""} \u2192 ${machine.name} by ${actor}`);
    this.sessions.get(nodeId)?.deliver(encodeControl({ t: "admin", event: "renamed", name: machine.name }));
    if (this.sessions.has(nodeId)) this.announce(nodeId, true);
    return machine;
  }
  setStatus(nodeId, status, actor) {
    const machine = relayMachine(this.db, nodeId);
    if (!machine || machine.status === "pending" || machine.status === "revoked") throw new RelayServerError(404, "Machine not found");
    if (nodeId === this.nodeId) throw new RelayServerError(409, "The relay machine itself cannot be suspended or removed");
    setMachineStatus(this.db, nodeId, status);
    audit(this.db, status === "admitted" ? "resumed" : status, nodeId, `${machine.name} by ${actor}`);
    if (status !== "admitted") this.sessions.get(nodeId)?.terminate(status === "revoked" ? "Removed from the relay" : "Suspended on the relay", { t: "admin", event: status });
  }
  // ------------------------------------------------------------ phone gateway
  /** The machine label in `<label>.<relay host>`, or undefined for any other host. */
  gatewayLabel(request) {
    if (!this.enabled) return void 0;
    const relayHost = new URL(this.origin).host.toLowerCase();
    const host = String(request.headers.host ?? "").toLowerCase();
    if (!host.endsWith(`.${relayHost}`)) return void 0;
    const label = host.slice(0, -(relayHost.length + 1));
    return RELAY_NAME_PATTERN.test(label) ? label : void 0;
  }
  gatewayTarget(label) {
    const machine = relayMachineByName(this.db, label);
    if (!machine || machine.status !== "admitted") return void 0;
    const session = this.sessions.get(machine.nodeId);
    return session && session.kind !== "gateway" && session.gatewayEnabled && this.servesMachine(machine.nodeId) ? session : void 0;
  }
  gatewayByIp = /* @__PURE__ */ new Map();
  /** Counts a phone's concurrent requests; the count drops when its gateway stream closes. */
  admitGatewayRequest(clientIp) {
    const count = this.gatewayByIp.get(clientIp) ?? 0;
    if (count >= MAX_GATEWAY_REQUESTS_PER_IP) return false;
    this.gatewayByIp.set(clientIp, count + 1);
    return true;
  }
  releaseGatewayRequest(clientIp) {
    const count = (this.gatewayByIp.get(clientIp) ?? 1) - 1;
    if (count <= 0) this.gatewayByIp.delete(clientIp);
    else this.gatewayByIp.set(clientIp, count);
  }
  openGatewayStream(target, clientIp) {
    const { session, hub } = this.gateway();
    const id = this.openChannel(session, target, "gateway");
    const stream = new RelayStream("gateway", void 0);
    stream.once("close", () => this.releaseGatewayRequest(clientIp));
    target.deliver(encodeControl({ t: "incoming", channel: id, from: this.nodeId, fromKey: this.publicKey, kind: "gateway", clientIp }));
    hub.adopt(stream, id);
    return stream;
  }
  /** Proxies a phone's request to the named machine. Returns false for hosts that are not gateway names. */
  handleRequest(request, response) {
    if (relayTransportOf(request.socket)) return false;
    const label = this.gatewayLabel(request);
    if (!label) {
      if (new URL(request.url ?? "/", "http://relay").pathname !== POLL_PATH) return false;
      if (!this.enabled) {
        response.writeHead(404).end();
        return true;
      }
      this.polls.handle(request, response);
      return true;
    }
    const target = this.gatewayTarget(label);
    if (!target) {
      sendNotFound(response);
      return true;
    }
    const problem = this.channelProblem(target, "gateway");
    if (problem) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end(problem);
      return true;
    }
    const clientIp = clientAddress(request);
    if (!this.admitGatewayRequest(clientIp)) {
      response.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" }).end("Too many requests");
      return true;
    }
    const stream = this.openGatewayStream(target, clientIp);
    const proxied = http.request({
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request.rawHeaders, clientIp, this.origin),
      createConnection: () => stream
    });
    proxied.on("response", (answer) => {
      const status = answer.statusCode ?? 0;
      try {
        if (status < 100 || status > 599) throw new Error("Invalid status");
        response.writeHead(status, answer.statusMessage, filterRawHeaders(answer.rawHeaders));
      } catch {
        answer.destroy();
        proxied.destroy();
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end("The machine sent an invalid answer.");
        else response.destroy();
        return;
      }
      answer.on("error", () => response.destroy());
      answer.pipe(response);
    });
    proxied.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end("The machine did not answer through the relay.");
      else response.destroy();
    });
    response.on("close", () => {
      if (!response.writableFinished) proxied.destroy();
    });
    request.pipe(proxied);
    return true;
  }
  handleGatewayUpgrade(request, socket, head) {
    const label = this.gatewayLabel(request);
    if (!label) return false;
    const target = this.gatewayTarget(label);
    if (!target) {
      refuseUpgrade(socket, 404, "Not found");
      return true;
    }
    if (this.channelProblem(target, "gateway")) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    const clientIp = clientAddress(request);
    if (!this.admitGatewayRequest(clientIp)) {
      refuseUpgrade(socket, 429, "Too Many Requests");
      return true;
    }
    const stream = this.openGatewayStream(target, clientIp);
    const headers = forwardedHeaders(request.rawHeaders, clientIp, this.origin, true);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
    stream.write(`${lines.join("\r\n")}\r
\r
`);
    if (head.length) stream.write(head);
    socket.on("error", () => stream.destroy());
    stream.on("error", () => socket.destroy());
    socket.pipe(stream);
    stream.pipe(socket);
    return true;
  }
}
class RelayServerError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
  statusCode;
}
function inProcess(work) {
  queueMicrotask(() => {
    try {
      work();
    } catch (error) {
      console.warn("Relay in-process frame failed", error);
    }
  });
}
const LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function clientAddress(request) {
  const remote = request.socket.remoteAddress ?? "";
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return LOOPBACK.has(remote) && forwarded.length ? forwarded[forwarded.length - 1] : remote;
}
function forwardedHeaders(rawHeaders, clientIp, origin, keepUpgrade = false) {
  const out = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (name.startsWith("x-forwarded-") || name === "forwarded") continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
    out.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  out.push("X-Forwarded-For", clientIp, "X-Forwarded-Proto", new URL(origin).protocol.replace(":", ""));
  return out;
}
function filterRawHeaders(rawHeaders) {
  const out = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "set-cookie" && /;\s*domain\s*=/i.test(rawHeaders[index + 1])) continue;
    out.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return out;
}
function sendNotFound(response) {
  response.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Joint-Bob-Relay": "gateway" });
  response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Not found</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem"><h1>No machine here</h1>
<p>No machine with this name is reachable through this relay right now. It may be offline, or phone sign-in may be turned off for it.</p></body>`);
}
function refuseUpgrade(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r
Connection: close\r
Content-Length: 0\r
\r
`);
}
export {
  RelayServer,
  RelayServerError,
  clientAddress
};
