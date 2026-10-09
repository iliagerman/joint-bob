// The relay role of a Joint Bob machine (RELAY-PLAN.md §4.7, §6 M2).
//
// Admitted machines keep one WebSocket here. The relay pairs channels between them and
// copies frames across without reading them; Noise keeps machine-to-machine payloads
// opaque. It also serves the phone gateway: `https://<name>.<relay-domain>` is proxied over
// a plain channel into that machine's own UI, where the machine's own sign-in rules apply.
//
// The relay is a transport only. Admission here grants no access to any cluster, project
// or conversation: every request still meets the receiving machine's usual checks.
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import WebSocket, { WebSocketServer } from "ws";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { ChannelHub, type IncomingChannel } from "./hub.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import {
  CONNECT_PATH, FRAME_CLOSE, FRAME_CONTROL, FRAME_DATA, FRAME_WINDOW, INITIAL_WINDOW, MAX_FRAME, MAX_WINDOW, RELAY_NAME_PATTERN,
  REQUEST_NONCE_PATTERN, authPayload, decodeFrame, encodeClose, encodeControl, pairingCode, welcomePayload, type ChannelKind, type ControlMessage, type DeniedCode, type PeerListing,
} from "./protocol.js";
import { RelayStream, relayTransportOf } from "./stream.js";
import { POLL_PATH, PollServer, type FrameSocket } from "./poll.js";
import {
  addMachineUsage, admitMachine, audit, countAdmittedMachines, currentMonth, deleteMachine, ensureRelaySchema, expirePendingMachines, isKeyRevoked, machineUsage, markMachineAlerted,
  redeemRelayToken, relayMachine, relayMachineByName, renameRelayMachine, servingSettings, setMachinePhoneSignIn, setMachineStatus,
  touchMachine, upsertPendingMachine, type RelayMachine, type ServingSettings,
} from "./store.js";

const AUTH_TIMEOUT_MS = 15_000;
const HEARTBEAT_MS = 30_000;
const MAX_CHANNELS_PER_MACHINE = 512;
const MAX_GATEWAY_CHANNELS_PER_MACHINE = 128;
const MAX_GATEWAY_REQUESTS_PER_IP = 32;
/** A machine that stops reading while this much waits for it is cut off. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Connections from one address that have not authenticated yet. */
const MAX_UNAUTHENTICATED_PER_IP = 16;
const MAX_WATCHED = 10_000;
const REQUESTS_PER_HOUR = 5;
const USAGE_FLUSH_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

interface Session {
  readonly kind: "remote" | "local" | "gateway";
  readonly nodeId: string;
  readonly publicKey: string;
  gatewayEnabled: boolean;
  readonly watching: Set<string>;
  readonly channels: Set<number>;
  /** Phone gateway channels into this machine, counted apart so phones cannot starve machine traffic. */
  readonly gatewayChannels: Set<number>;
  usageDelta: number;
  deliver(frame: Buffer): void;
  terminate(reason: string, message?: ControlMessage): void;
}

interface Channel {
  readonly id: number;
  readonly a: Session;
  readonly b: Session;
  readonly kind: ChannelKind;
  /** Bytes each side may still send. */
  readonly credit: Map<Session, number>;
}

interface PendingConnection {
  ws: FrameSocket;
  relayNonce: string;
  machineNonce: string;
  gateway: boolean;
}

export interface LocalMachineHandlers {
  onIncoming(incoming: IncomingChannel): RelayStream | string;
  onControl(message: ControlMessage): void;
}

export class RelayServer {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  private readonly polls = new PollServer((socket, request) => this.accept(socket, clientAddress(request)));
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingConnection>();
  private readonly watchers = new Map<string, Set<Session>>();
  private readonly channels = new Map<number, Channel>();
  private readonly requestLog = new Map<string, number[]>();
  private nextChannel = 1;
  private settings: ServingSettings;
  private localSession: Session | undefined;
  private localHub: ChannelHub | undefined;
  private gatewaySession: Session | undefined;
  private gatewayHub: ChannelHub | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  readonly publicKey: string;
  readonly fingerprint: string;

  constructor(private readonly db: DatabaseSync, readonly nodeId: string, private readonly nodeName: () => string, private readonly alert: (topic: string, message: string) => void) {
    ensureRelaySchema(db);
    const identity = getOrCreateClusterIdentity(db, nodeId);
    this.publicKey = identity.publicKey;
    this.fingerprint = identity.fingerprint;
    this.settings = servingSettings(db);
  }

  get enabled(): boolean { return this.settings.enabled && Boolean(this.settings.origin); }
  get origin(): string { return this.settings.origin; }
  get environment(): string { return this.settings.environment; }
  get connectedCount(): number { return [...this.sessions.values()].filter((session) => session.kind === "remote").length; }
  isOnline(nodeId: string): boolean { return this.sessions.has(nodeId); }

  /** Re-reads the settings after they changed. Turning serving off disconnects everyone. */
  reload(): void {
    this.settings = servingSettings(this.db);
    if (!this.enabled) {
      for (const session of [...this.sessions.values()]) if (session.kind === "remote") session.terminate("Relay serving was turned off");
      for (const [nodeId, pending] of this.pending) { pending.ws.close(1001, "Relay serving was turned off"); this.pending.delete(nodeId); }
      this.polls.closeAll("Relay serving was turned off");
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      return;
    }
    this.enforceOwnMachinesOnly();
    // The relay node is a working machine too, with a name on its own relay.
    const self = relayMachine(this.db, this.nodeId);
    if (!self || self.status !== "admitted") admitMachine(this.db, this.nodeId, this.publicKey, this.nodeName(), "self");
    if (this.localSession) this.localSession.gatewayEnabled = relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true;
    this.heartbeat ??= setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** In own-machines-only mode, disconnects machines that are not, or are no longer, this relay's twins. */
  enforceOwnMachinesOnly(): void {
    if (!this.enabled || !this.settings.ownMachinesOnly) return;
    for (const session of [...this.sessions.values()]) if (session.kind === "remote" && !this.servesMachine(session.nodeId)) session.terminate("This relay now serves only its owner's machines");
    for (const [nodeId, pending] of this.pending) if (!this.servesMachine(nodeId)) this.deny(pending.ws, "This relay serves only its owner's machines", "owner-only");
  }

  // ------------------------------------------------------------ in-process endpoints

  /** The relay node's own machine side: a hub that reaches other machines through this relay. */
  attachLocalMachine(handlers: LocalMachineHandlers): ChannelHub {
    if (this.localHub) return this.localHub;
    let hub!: ChannelHub;
    const session: Session = {
      kind: "local", nodeId: this.nodeId, publicKey: this.publicKey, gatewayEnabled: relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true,
      watching: new Set(), channels: new Set(), gatewayChannels: new Set(), usageDelta: 0,
      deliver: (frame) => inProcess(() => hub.handleFrame(frame)),
      terminate: () => undefined,
    };
    hub = new ChannelHub({
      send: (frame) => inProcess(() => this.handleSessionFrame(session, frame)),
      onIncoming: handlers.onIncoming,
      onControl: handlers.onControl,
    });
    this.localSession = session;
    this.localHub = hub;
    if (this.enabled) this.activate(session);
    return hub;
  }

  /** The local machine is a member of its own relay only while serving is on. */
  syncLocalPresence(): void {
    if (!this.localSession) return;
    if (this.enabled && !this.sessions.has(this.nodeId)) this.activate(this.localSession);
    if (!this.enabled && this.sessions.get(this.nodeId) === this.localSession) this.deactivate(this.localSession);
  }

  localPhoneSignIn(): boolean { return relayMachine(this.db, this.nodeId)?.phoneSignIn ?? true; }

  /** The relay machine's own name on its relay, and whether phones can open it. */
  selfListing(): PeerListing | undefined {
    if (!this.enabled) return undefined;
    const self = relayMachine(this.db, this.nodeId);
    return self ? { name: self.name, phone: this.localSession?.gatewayEnabled ?? self.phoneSignIn } : undefined;
  }

  /** With "own machines only" on, a machine must be this machine or one of its twins. */
  private servesMachine(nodeId: string): boolean {
    if (!this.settings.ownMachinesOnly || nodeId === this.nodeId) return true;
    try { return isTrustedTwin(this.db, this.nodeId, nodeId); } catch { return false; }
  }

  setLocalPhoneSignIn(enabled: boolean): void {
    setMachinePhoneSignIn(this.db, this.nodeId, enabled);
    if (this.localSession) this.localSession.gatewayEnabled = enabled;
    if (this.sessions.has(this.nodeId)) this.announce(this.nodeId, true);
  }

  private gateway(): { session: Session; hub: ChannelHub } {
    if (!this.gatewaySession || !this.gatewayHub) {
      let hub!: ChannelHub;
      const session: Session = {
        kind: "gateway", nodeId: this.nodeId, publicKey: this.publicKey, gatewayEnabled: false, watching: new Set(), channels: new Set(), gatewayChannels: new Set(), usageDelta: 0,
        deliver: (frame) => inProcess(() => hub.handleFrame(frame)),
        terminate: () => undefined,
      };
      hub = new ChannelHub({ send: (frame) => inProcess(() => this.handleSessionFrame(session, frame)), onIncoming: () => "The gateway accepts no channels" });
      this.gatewaySession = session;
      this.gatewayHub = hub;
    }
    return { session: this.gatewaySession, hub: this.gatewayHub };
  }

  // ------------------------------------------------------------ machine connections

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (relayTransportOf(socket)) return false;
    const pathname = new URL(request.url ?? "/", "http://relay").pathname;
    if (pathname === CONNECT_PATH && !this.gatewayLabel(request)) {
      if (!this.enabled) { refuseUpgrade(socket, 404, "Relay serving is off"); return true; }
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws, clientAddress(request)));
      return true;
    }
    return this.handleGatewayUpgrade(request, socket, head);
  }

  private readonly unauthenticated = new Map<string, number>();

  private accept(ws: FrameSocket, clientIp: string): void {
    const relayNonce = randomBytes(32).toString("base64url");
    let session: Session | undefined;
    let authenticated = false;
    let alive = true;
    const waiting = (this.unauthenticated.get(clientIp) ?? 0) + 1;
    if (waiting > MAX_UNAUTHENTICATED_PER_IP) { ws.close(1013, "Too many connections"); return; }
    this.unauthenticated.set(clientIp, waiting);
    let counted = true;
    const stopCounting = (): void => {
      if (!counted) return;
      counted = false;
      const left = (this.unauthenticated.get(clientIp) ?? 1) - 1;
      if (left <= 0) this.unauthenticated.delete(clientIp); else this.unauthenticated.set(clientIp, left);
    };
    const timer = setTimeout(() => { if (!authenticated) ws.close(1008, "Authentication timed out"); }, AUTH_TIMEOUT_MS);
    timer.unref();
    (ws as FrameSocket & { relayAlive?: () => boolean }).relayAlive = () => { const was = alive; alive = false; return was; };
    ws.on("pong", () => { alive = true; });
    ws.send(encodeControl({ t: "hello", relayNodeId: this.nodeId, relayPublicKey: this.publicKey, nonce: relayNonce, protocol: 1 }));
    ws.on("message", (data: Buffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) { ws.close(1003, "Binary frames only"); return; }
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      try {
        if (session) { this.handleSessionFrame(session, frame); return; }
        if (authenticated) return; // pending: nothing is accepted until the operator decides
        const decoded = decodeFrame(frame);
        if (decoded.type !== FRAME_CONTROL || decoded.message.t !== "auth") throw new Error("Expected authentication");
        authenticated = true;
        stopCounting();
        clearTimeout(timer);
        session = this.authenticate(ws, decoded.message, relayNonce, clientIp, (activated) => { session = activated; });
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

  private authenticate(ws: FrameSocket, message: Extract<ControlMessage, { t: "auth" }>, relayNonce: string, clientIp: string, onActivated: (session: Session) => void): Session | undefined {
    if (!UUID.test(message.nodeId) || typeof message.publicKey !== "string" || message.publicKey.length > 4096 || typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.nonce)) throw new Error("Malformed authentication");
    if (message.nodeId === this.nodeId) throw new Error("A relay cannot connect to itself");
    if (!verifyClusterMessage(message.publicKey, "relay-auth", authPayload(relayNonce, message.nonce, this.origin, message.nodeId), message.signature)) throw new Error("Authentication signature is invalid");
    const machineFingerprint = clusterPublicKeyFingerprint(message.publicKey);
    const proposedName = typeof message.name === "string" ? message.name.slice(0, 80) : "machine";
    const requestNonce = typeof message.requestNonce === "string" && REQUEST_NONCE_PATTERN.test(message.requestNonce) ? message.requestNonce : undefined;
    if (!this.servesMachine(message.nodeId)) return this.deny(ws, "This relay serves only its owner's machines", "owner-only");
    expirePendingMachines(this.db);
    let machine = relayMachine(this.db, message.nodeId);
    // A removed key stays out, under this node ID or any other.
    if (machine?.status === "revoked" || isKeyRevoked(this.db, machineFingerprint, clusterPublicKeyFingerprint)) return this.deny(ws, "This machine was removed from the relay", "revoked");
    if (machine && clusterPublicKeyFingerprint(machine.publicKey) !== machineFingerprint) {
      // Anyone can file an access request for any node ID; such a request must not lock the
      // real machine out. A token holder replaces it, and a conflicting request is recorded.
      if (machine.status === "pending" && typeof message.token === "string") {
        this.decline(message.nodeId, "a token holder with another key");
        machine = undefined;
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
      machine = upsertPendingMachine(this.db, message.nodeId, message.publicKey, proposedName, pairingCode(machineFingerprint, this.fingerprint, message.nodeId, requestNonce!));
      audit(this.db, "requested", message.nodeId, `${proposedName} from ${clientIp}`);
    }
    if (machine?.status === "pending") {
      // The same machine reconnecting keeps its request; its code follows the nonce it holds.
      const code = pairingCode(machineFingerprint, this.fingerprint, message.nodeId, requestNonce!);
      if (code !== machine.pairingCode) machine = upsertPendingMachine(this.db, message.nodeId, message.publicKey, machine.name, code);
      this.pending.get(message.nodeId)?.ws.close(1000, "Replaced by a newer connection");
      this.pending.set(message.nodeId, { ws, relayNonce, machineNonce: message.nonce, gateway: message.gateway === true });
      ws.send(encodeControl({ t: "pending", pairingCode: code, signature: this.sign(welcomePayload(relayNonce, message.nonce, message.nodeId, "pending")) }));
      // Approval later turns this connection into a session through onActivated.
      this.pendingActivation.set(message.nodeId, onActivated);
      return undefined;
    }
    return this.deny(ws, "This machine is not admitted. Use a relay token or request access.", "not-admitted");
  }

  private readonly pendingActivation = new Map<string, (session: Session) => void>();

  private welcome(ws: FrameSocket, machine: RelayMachine, relayNonce: string, message: { nodeId: string; publicKey: string; nonce: string; gateway: boolean }): Session {
    (ws as FrameSocket & { trust?: () => void }).trust?.();
    const relay = this.selfListing();
    ws.send(encodeControl({
      t: "welcome", name: machine.name, environment: this.settings.environment, relayOrigin: this.origin,
      ...(relay ? { relayName: relay.name, relayPhone: relay.phone } : {}),
      signature: this.sign(welcomePayload(relayNonce, message.nonce, message.nodeId, "admitted")),
    }));
    const session: Session = {
      kind: "remote", nodeId: machine.nodeId, publicKey: machine.publicKey, gatewayEnabled: message.gateway === true,
      watching: new Set(), channels: new Set(), gatewayChannels: new Set(), usageDelta: 0,
      deliver: (frame) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Flow control bounds channel data, but a machine that stops reading must not grow the relay's memory.
        if ((ws as FrameSocket & { bufferedAmount?: number }).bufferedAmount! > MAX_BUFFERED_BYTES) { ws.terminate(); return; }
        ws.send(frame);
      },
      terminate: (reason, control) => {
        if (control && ws.readyState === WebSocket.OPEN) ws.send(encodeControl(control));
        ws.close(1000, reason.slice(0, 120));
        this.deactivate(session);
      },
    };
    setMachinePhoneSignIn(this.db, machine.nodeId, session.gatewayEnabled);
    this.sessions.get(machine.nodeId)?.terminate("Replaced by a newer connection");
    this.activate(session);
    return session;
  }

  private deny(ws: FrameSocket, reason: string, code: DeniedCode): undefined {
    ws.send(encodeControl({ t: "denied", reason, code }));
    ws.close(1008, reason.slice(0, 120));
    return undefined;
  }

  private sign(payload: string): string { return signClusterMessage(this.db, this.nodeId, "relay-welcome", payload); }

  private allowRequest(clientIp: string, at = Date.now()): boolean {
    if (this.requestLog.size > 1000) {
      for (const [ip, times] of this.requestLog) if (times.every((time) => at - time >= 60 * 60 * 1000)) this.requestLog.delete(ip);
    }
    const recent = (this.requestLog.get(clientIp) ?? []).filter((time) => at - time < 60 * 60 * 1000);
    if (recent.length >= REQUESTS_PER_HOUR) { this.requestLog.set(clientIp, recent); return false; }
    recent.push(at);
    this.requestLog.set(clientIp, recent);
    return true;
  }

  private activate(session: Session): void {
    this.sessions.set(session.nodeId, session);
    if (session.kind === "remote") touchMachine(this.db, session.nodeId);
    this.announce(session.nodeId, true);
  }

  private deactivate(session: Session): void {
    if (this.sessions.get(session.nodeId) !== session) return;
    this.sessions.delete(session.nodeId);
    for (const id of [...session.channels]) this.dropChannel(id, "Machine disconnected", session);
    for (const nodeId of session.watching) this.unwatch(nodeId, session);
    session.watching.clear();
    this.flushUsage(session, true);
    if (session.kind === "remote") touchMachine(this.db, session.nodeId);
    this.announce(session.nodeId, false);
  }

  private unwatch(nodeId: string, session: Session): void {
    const set = this.watchers.get(nodeId);
    if (!set) return;
    set.delete(session);
    if (!set.size) this.watchers.delete(nodeId);
  }

  private announce(nodeId: string, online: boolean): void {
    const listings = online ? this.listingsFor([nodeId]) : {};
    for (const watcher of this.watchers.get(nodeId) ?? []) {
      watcher.deliver(encodeControl({ t: "presence", online: online ? [nodeId] : [], offline: online ? [] : [nodeId], listings }));
    }
  }

  /** Names and phone availability of online machines, only ever for node IDs a watcher already named. */
  private listingsFor(nodeIds: string[]): Record<string, PeerListing> {
    const out: Record<string, PeerListing> = {};
    for (const nodeId of nodeIds) {
      const session = this.sessions.get(nodeId);
      const machine = session ? relayMachine(this.db, nodeId) : undefined;
      if (session && machine) out[nodeId] = { name: machine.name, phone: session.gatewayEnabled };
    }
    return out;
  }

  private ping(): void {
    for (const ws of this.sockets.clients) {
      const alive = (ws as WebSocket & { relayAlive?: () => boolean }).relayAlive;
      if (alive && !alive()) { ws.terminate(); continue; }
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }

  // ------------------------------------------------------------ routing

  private handleSessionFrame(session: Session, frame: Buffer): void {
    if (this.sessions.get(session.nodeId) !== session && session.kind !== "gateway") return;
    const decoded = decodeFrame(frame);
    switch (decoded.type) {
      case FRAME_CONTROL: this.handleControl(session, decoded.message); return;
      case FRAME_DATA: {
        const channel = this.channelFor(session, decoded.channel);
        if (!channel) return;
        const available = channel.credit.get(session) ?? 0;
        if (decoded.payload.length > available) { this.dropChannel(channel.id, "Flow control violated"); return; }
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
        if (credit > MAX_WINDOW) { this.dropChannel(channel.id, "Flow control violated"); return; }
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

  private channelFor(session: Session, id: number): Channel | undefined {
    const channel = this.channels.get(id);
    return channel && (channel.a === session || channel.b === session) ? channel : undefined;
  }

  /** Ends a channel and tells every side that did not ask for it. */
  private dropChannel(id: number, reason: string, initiatedBy?: Session): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.channels.delete(id);
    channel.a.channels.delete(id);
    channel.b.channels.delete(id);
    channel.b.gatewayChannels.delete(id);
    for (const side of [channel.a, channel.b]) if (side !== initiatedBy) side.deliver(encodeClose(id, reason));
  }

  private handleControl(session: Session, message: ControlMessage): void {
    switch (message.t) {
      case "watch": {
        if (!Array.isArray(message.nodeIds)) return;
        const wanted = new Set(message.nodeIds.filter((nodeId) => typeof nodeId === "string" && UUID.test(nodeId)).slice(0, MAX_WATCHED));
        for (const nodeId of session.watching) if (!wanted.has(nodeId)) this.unwatch(nodeId, session);
        session.watching.clear();
        for (const nodeId of wanted) {
          session.watching.add(nodeId);
          let set = this.watchers.get(nodeId);
          if (!set) { set = new Set(); this.watchers.set(nodeId, set); }
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
        const refuse = (error: string): void => session.deliver(encodeControl({ t: "open-failed", ref: message.ref, error }));
        if (typeof message.ref !== "number" || !["peer", "syncthing"].includes(message.kind)) { refuse("Invalid request"); return; }
        const target = typeof message.to === "string" ? this.sessions.get(message.to) : undefined;
        if (!target || target === session || target.kind === "gateway") { refuse("That machine is not connected to this relay"); return; }
        if (!this.servesMachine(session.nodeId) || !this.servesMachine(target.nodeId)) { refuse("This relay serves only its owner's machines"); return; }
        const problem = this.channelProblem(session) ?? this.channelProblem(target);
        if (problem) { refuse(problem); return; }
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

  private channelProblem(session: Session, kind: ChannelKind = "peer"): string | undefined {
    if (kind === "gateway" ? session.gatewayChannels.size >= MAX_GATEWAY_CHANNELS_PER_MACHINE : session.channels.size - session.gatewayChannels.size >= MAX_CHANNELS_PER_MACHINE) return "Too many open channels";
    if (session.kind !== "remote" || !this.settings.monthlyCapBytes) return undefined;
    if (machineUsage(this.db, session.nodeId) + session.usageDelta >= this.settings.monthlyCapBytes) return "This machine used its monthly relay allowance";
    return undefined;
  }

  private openChannel(a: Session, b: Session, kind: ChannelKind): number {
    let id = this.nextChannel;
    while (this.channels.has(id) || id === 0) id = (id % 0xffffffff) + 1;
    this.nextChannel = (id % 0xffffffff) + 1;
    this.channels.set(id, { id, a, b, kind, credit: new Map([[a, INITIAL_WINDOW], [b, INITIAL_WINDOW]]) });
    a.channels.add(id);
    b.channels.add(id);
    if (kind === "gateway") b.gatewayChannels.add(id);
    return id;
  }

  private countUsage(session: Session, bytes: number): void {
    if (session.kind !== "remote") return;
    session.usageDelta += bytes;
    if (session.usageDelta >= USAGE_FLUSH_BYTES) this.flushUsage(session, false);
  }

  private flushUsage(session: Session, final: boolean): void {
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

  approve(nodeId: string, actor: string): RelayMachine {
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

  decline(nodeId: string, actor: string): void {
    const machine = relayMachine(this.db, nodeId);
    if (!machine || machine.status !== "pending") throw new RelayServerError(404, "No pending request for that machine");
    deleteMachine(this.db, nodeId);
    audit(this.db, "denied", nodeId, `${machine.name} by ${actor}`);
    const pending = this.dropPendingConnection(nodeId);
    if (pending) this.deny(pending.ws, "The relay operator declined this request", "declined");
  }

  private dropPendingConnection(nodeId: string): PendingConnection | undefined {
    const pending = this.pending.get(nodeId);
    this.pending.delete(nodeId);
    this.pendingActivation.delete(nodeId);
    return pending;
  }

  rename(nodeId: string, name: string, actor: string): RelayMachine {
    const before = relayMachine(this.db, nodeId);
    const machine = renameRelayMachine(this.db, nodeId, name);
    audit(this.db, "renamed", nodeId, `${before?.name ?? ""} → ${machine.name} by ${actor}`);
    this.sessions.get(nodeId)?.deliver(encodeControl({ t: "admin", event: "renamed", name: machine.name }));
    if (this.sessions.has(nodeId)) this.announce(nodeId, true);
    return machine;
  }

  setStatus(nodeId: string, status: "admitted" | "suspended" | "revoked", actor: string): void {
    const machine = relayMachine(this.db, nodeId);
    if (!machine || machine.status === "pending" || machine.status === "revoked") throw new RelayServerError(404, "Machine not found");
    if (nodeId === this.nodeId) throw new RelayServerError(409, "The relay machine itself cannot be suspended or removed");
    setMachineStatus(this.db, nodeId, status);
    audit(this.db, status === "admitted" ? "resumed" : status, nodeId, `${machine.name} by ${actor}`);
    if (status !== "admitted") this.sessions.get(nodeId)?.terminate(status === "revoked" ? "Removed from the relay" : "Suspended on the relay", { t: "admin", event: status });
  }

  // ------------------------------------------------------------ phone gateway

  /** The machine label in `<label>.<relay host>`, or undefined for any other host. */
  gatewayLabel(request: IncomingMessage): string | undefined {
    if (!this.enabled) return undefined;
    const relayHost = new URL(this.origin).host.toLowerCase();
    const host = String(request.headers.host ?? "").toLowerCase();
    if (!host.endsWith(`.${relayHost}`)) return undefined;
    const label = host.slice(0, -(relayHost.length + 1));
    return RELAY_NAME_PATTERN.test(label) ? label : undefined;
  }

  private gatewayTarget(label: string): Session | undefined {
    const machine = relayMachineByName(this.db, label);
    if (!machine || machine.status !== "admitted") return undefined;
    const session = this.sessions.get(machine.nodeId);
    return session && session.kind !== "gateway" && session.gatewayEnabled && this.servesMachine(machine.nodeId) ? session : undefined;
  }

  private readonly gatewayByIp = new Map<string, number>();

  /** Counts a phone's concurrent requests; the count drops when its gateway stream closes. */
  private admitGatewayRequest(clientIp: string): boolean {
    const count = this.gatewayByIp.get(clientIp) ?? 0;
    if (count >= MAX_GATEWAY_REQUESTS_PER_IP) return false;
    this.gatewayByIp.set(clientIp, count + 1);
    return true;
  }

  private releaseGatewayRequest(clientIp: string): void {
    const count = (this.gatewayByIp.get(clientIp) ?? 1) - 1;
    if (count <= 0) this.gatewayByIp.delete(clientIp);
    else this.gatewayByIp.set(clientIp, count);
  }

  private openGatewayStream(target: Session, clientIp: string): RelayStream {
    const { session, hub } = this.gateway();
    const id = this.openChannel(session, target, "gateway");
    const stream = new RelayStream("gateway", undefined);
    stream.once("close", () => this.releaseGatewayRequest(clientIp));
    target.deliver(encodeControl({ t: "incoming", channel: id, from: this.nodeId, fromKey: this.publicKey, kind: "gateway", clientIp }));
    hub.adopt(stream, id);
    return stream;
  }

  /** Proxies a phone's request to the named machine. Returns false for hosts that are not gateway names. */
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean {
    if (relayTransportOf(request.socket)) return false;
    const label = this.gatewayLabel(request);
    if (!label) {
      if (new URL(request.url ?? "/", "http://relay").pathname !== POLL_PATH) return false;
      if (!this.enabled) { response.writeHead(404).end(); return true; }
      this.polls.handle(request, response);
      return true;
    }
    const target = this.gatewayTarget(label);
    if (!target) { sendNotFound(response); return true; }
    const problem = this.channelProblem(target, "gateway");
    if (problem) { response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end(problem); return true; }
    const clientIp = clientAddress(request);
    if (!this.admitGatewayRequest(clientIp)) { response.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "5" }).end("Too many requests"); return true; }
    const stream = this.openGatewayStream(target, clientIp);
    const proxied = http.request({
      method: request.method, path: request.url, headers: forwardedHeaders(request.rawHeaders, clientIp, this.origin),
      createConnection: () => stream as unknown as import("node:net").Socket,
    });
    proxied.on("response", (answer) => {
      // A machine controls this answer; a malformed one must never take the relay down.
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
    response.on("close", () => { if (!response.writableFinished) proxied.destroy(); });
    request.pipe(proxied);
    return true;
  }

  private handleGatewayUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const label = this.gatewayLabel(request);
    if (!label) return false;
    const target = this.gatewayTarget(label);
    if (!target) { refuseUpgrade(socket, 404, "Not found"); return true; }
    if (this.channelProblem(target, "gateway")) { refuseUpgrade(socket, 503, "Service Unavailable"); return true; }
    const clientIp = clientAddress(request);
    if (!this.admitGatewayRequest(clientIp)) { refuseUpgrade(socket, 429, "Too Many Requests"); return true; }
    const stream = this.openGatewayStream(target, clientIp);
    const headers = forwardedHeaders(request.rawHeaders, clientIp, this.origin, true);
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
    stream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) stream.write(head);
    socket.on("error", () => stream.destroy());
    stream.on("error", () => socket.destroy());
    socket.pipe(stream);
    stream.pipe(socket);
    return true;
  }
}

export class RelayServerError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** Frames between in-process endpoints run in order on the next microtask; a failure is logged, never thrown into the event loop. */
function inProcess(work: () => void): void {
  queueMicrotask(() => {
    try { work(); } catch (error) { console.warn("Relay in-process frame failed", error); }
  });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The phone's address. Behind a loopback reverse proxy (Caddy) that is the last forwarded hop. */
export function clientAddress(request: IncomingMessage): string {
  const remote = request.socket.remoteAddress ?? "";
  const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return LOOPBACK.has(remote) && forwarded.length ? forwarded[forwarded.length - 1] : remote;
}

/** Request headers for the machine: the phone's own, minus hop-by-hop and any forwarded claims, plus the relay's. */
function forwardedHeaders(rawHeaders: string[], clientIp: string, origin: string, keepUpgrade = false): string[] {
  const out: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (name.startsWith("x-forwarded-") || name === "forwarded") continue;
    if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
    out.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  out.push("X-Forwarded-For", clientIp, "X-Forwarded-Proto", new URL(origin).protocol.replace(":", ""));
  return out;
}

/** Response headers for the phone: hop-by-hop headers go, and so does any cookie scoped to a
    Domain, which one machine could use to plant cookies on its sibling names. */
function filterRawHeaders(rawHeaders: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "set-cookie" && /;\s*domain\s*=/i.test(rawHeaders[index + 1])) continue;
    out.push(rawHeaders[index], rawHeaders[index + 1]);
  }
  return out;
}

function sendNotFound(response: ServerResponse): void {
  // The marker lets the Relay tab's check confirm that wildcard names reach this relay.
  response.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Joint-Bob-Relay": "gateway" });
  response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Not found</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:32rem;padding:0 1rem"><h1>No machine here</h1>
<p>No machine with this name is reachable through this relay right now. It may be offline, or phone sign-in may be turned off for it.</p></body>`);
}

function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
