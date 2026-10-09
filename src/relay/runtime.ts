// The machine side of relays (RELAY-PLAN.md §4.1, §4.6, §4.8).
//
// Each relay membership keeps one outbound WebSocket. Nothing listens on the internet:
// other machines and phones reach this one only through channels on those sockets. A relay
// node additionally reaches machines on its own relay through an in-process hub.
//
// Incoming channels are handed to the ordinary HTTP server, so every request meets the
// same routes, signed-request checks and sharing rules as a direct one.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { clusterPublicKeyFingerprint, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { ChannelHub, type IncomingChannel } from "./hub.js";
import { channelPrologue, expectAnnouncedPeer, expectPinnedPeer, localRelayIdentity, type LocalRelayIdentity } from "./identity.js";
import {
  FRAME_CONTROL, MAX_FRAME, RELAY_NAME_PATTERN, authPayload, decodeFrame, encodeControl, normalizeRelayOrigin, pairingCode, relayConnectUrl, welcomePayload,
  type ChannelKind, type ControlMessage, type PeerListing,
} from "./protocol.js";
import type { RelayServer } from "./relay-server.js";
import { RelayChannelError, RelayStream } from "./stream.js";
import { PollClient, relayPollUrl, type FrameSocket } from "./poll.js";
import { createMembership, deleteMembership, lastPeerRoutes, listMemberships, membership, membershipByOrigin, recordPeerRoute, updateMembership, type RelayMembership } from "./store.js";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** How long a new channel waits for a relay to report its peer online. */
const ROUTE_WAIT_MS = 5_000;
/** The relay pings every 30 s and a long-poll answers within 25 s; silence this long means the link is dead. */
const SILENCE_LIMIT_MS = 90_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Membership ID of the relay this node serves itself; it has no database row. */
export const LOCAL_RELAY_ID = "local";

export interface RuntimeHandlers {
  /** A syncthing channel from a peer was accepted; pipe it into the local Syncthing listener. */
  acceptSyncthing(stream: RelayStream, from: string): void;
  /** Whether a peer may open a Syncthing tunnel here (it must already share files with this machine). */
  syncthingAllowed(from: string): boolean;
  /** Peer IDs this machine knows from its clusters and twins. */
  knownPeers(): string[];
  /** A peer was seen online through a relay. */
  peerOnline(nodeId: string): void;
  /** The set of admitted relays changed, which can change the URL this machine advertises. */
  membershipsChanged(): void;
  nodeName(): string;
  /** Use long-polling from the start instead of trying WebSockets first. */
  preferPoll?: boolean;
}

export interface RelayRoute { membershipId: string; hub: ChannelHub }

/** Nonces and the relay key from one connection's introduction, before the relay admits this machine. */
interface AdmissionHandshake { origin: string; machineNonce: string; relayNonce: string; relayPublicKey: string }

class RelayConnection {
  ws: FrameSocket | undefined;
  /** Names on this relay of the peers this machine asked about, and whether phones can open them. */
  readonly listings = new Map<string, PeerListing>();
  /** The relay machine's own name on its relay, and whether phones can open it. */
  relayListing: PeerListing | undefined;
  /** Long-polling replaces the WebSocket after it repeatedly fails to open (RELAY-PLAN.md D1). */
  private usePoll: boolean;
  private failedToOpen = 0;
  hub: ChannelHub | undefined;
  readonly online = new Set<string>();
  connected = false;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  /** A token is spent once; it lives only in memory until the relay accepts it. */
  token: string | undefined;
  request = false;

  constructor(private readonly runtime: RelayRuntime, readonly id: string) {
    this.usePoll = runtime.handlers.preferPoll === true;
  }

  get membership(): RelayMembership | undefined { return membership(this.runtime.db, this.id); }

  start(): void {
    this.stopped = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.connect();
  }

  stop(reason = "Stopped"): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.teardown(reason);
    this.ws?.close(1000, reason.slice(0, 120));
    this.ws = undefined;
  }

  private connect(): void {
    const current = this.membership;
    if (!current || this.stopped) return;
    const ws: FrameSocket = this.usePoll
      ? new PollClient(relayPollUrl(current.origin))
      : new WebSocket(relayConnectUrl(current.origin), { maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 15_000 });
    this.ws = ws;
    let opened = false;
    let lastHeard = Date.now();
    const heard = (): void => { lastHeard = Date.now(); };
    // A NAT that drops an idle mapping or a relay host that loses power sends no close; notice the silence.
    const watchdog = setInterval(() => { if (Date.now() - lastHeard > SILENCE_LIMIT_MS) ws.terminate(); }, SILENCE_LIMIT_MS / 3);
    watchdog.unref();
    ws.on("open", () => { opened = true; this.failedToOpen = 0; heard(); });
    ws.on("ping", heard);
    const handshake: AdmissionHandshake = { origin: current.origin, machineNonce: randomBytes(32).toString("base64url"), relayNonce: "", relayPublicKey: "" };
    ws.on("message", (data: Buffer | Buffer[], isBinary: boolean) => {
      heard();
      if (ws !== this.ws || !isBinary) return;
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      try {
        if (this.hub) { this.hub.handleFrame(frame); return; }
        const decoded = decodeFrame(frame);
        if (decoded.type === FRAME_CONTROL) this.admissionStep(ws, handshake, decoded.message);
      } catch (error) {
        updateMembership(this.runtime.db, this.id, { lastError: error instanceof Error ? error.message.slice(0, 300) : "Relay protocol error" });
        this.runtime.changed();
        ws.close(1008, "Protocol error");
      }
    });
    ws.on("close", () => {
      clearInterval(watchdog);
      if (ws !== this.ws) return;
      // A proxy that blocks WebSockets fails every attempt before it opens: switch transports.
      if (!opened && ++this.failedToOpen >= 2) { this.usePoll = !this.usePoll; this.failedToOpen = 0; }
      this.teardown("Relay connection closed");
      this.ws = undefined;
      this.scheduleReconnect();
    });
    ws.on("error", (error: Error) => {
      if (ws !== this.ws) return;
      updateMembership(this.runtime.db, this.id, { lastError: error.message.slice(0, 300) });
    });
  }

  /** The exchange before a relay admits this machine: hello, then auth, then pending, welcome or denied. */
  private admissionStep(ws: FrameSocket, handshake: AdmissionHandshake, message: ControlMessage): void {
    if (message.t === "hello") { this.answerHello(ws, handshake, message); return; }
    if (!handshake.relayNonce) throw new RelayChannelError("The relay did not introduce itself");
    if (message.t === "pending" || message.t === "welcome") this.acceptAnswer(ws, handshake, message);
    else if (message.t === "denied") this.acceptRefusal(message);
  }

  private answerHello(ws: FrameSocket, handshake: AdmissionHandshake, message: Extract<ControlMessage, { t: "hello" }>): void {
    const pinned = this.membership?.fingerprint;
    if (typeof message.relayPublicKey !== "string" || typeof message.nonce !== "string" || !UUID.test(String(message.relayNodeId))) throw new RelayChannelError("The relay's introduction is malformed");
    handshake.relayPublicKey = message.relayPublicKey;
    handshake.relayNonce = message.nonce;
    this.relayNodeId = message.relayNodeId;
    if (pinned && clusterPublicKeyFingerprint(handshake.relayPublicKey) !== pinned) throw new RelayChannelError("The relay's key does not match the one this machine pinned");
    ws.send(encodeControl({
      t: "auth", nodeId: this.runtime.nodeId, publicKey: this.runtime.identity.publicKey, name: this.runtime.handlers.nodeName(), nonce: handshake.machineNonce,
      signature: signClusterMessage(this.runtime.db, this.runtime.nodeId, "relay-auth", authPayload(handshake.relayNonce, handshake.machineNonce, handshake.origin, this.runtime.nodeId)),
      ...(this.token ? { token: this.token } : {}), ...(this.request ? { request: true } : {}),
      ...(this.membership?.requestNonce ? { requestNonce: this.membership.requestNonce } : {}),
      gateway: this.membership?.phoneSignIn ?? true,
    }));
  }

  private acceptAnswer(ws: FrameSocket, handshake: AdmissionHandshake, message: Extract<ControlMessage, { t: "pending" | "welcome" }>): void {
    const status = message.t === "pending" ? "pending" : "admitted";
    if (!verifyClusterMessage(handshake.relayPublicKey, "relay-welcome", welcomePayload(handshake.relayNonce, handshake.machineNonce, this.runtime.nodeId, status), message.signature)) {
      throw new RelayChannelError("The relay's answer is not signed by its key");
    }
    const fingerprint = clusterPublicKeyFingerprint(handshake.relayPublicKey);
    if (message.t === "pending") {
      // The code is computed here from this machine's own view (its key, the relay key it
      // pinned, its request nonce), never taken from the relay's message.
      const nonce = this.membership?.requestNonce;
      const code = nonce ? pairingCode(clusterPublicKeyFingerprint(this.runtime.identity.publicKey), fingerprint, this.runtime.nodeId, nonce) : null;
      updateMembership(this.runtime.db, this.id, { status: "pending", fingerprint, pairingCode: code, lastError: null });
      this.runtime.changed();
      return;
    }
    const wasAdmitted = this.membership?.status === "admitted";
    this.token = undefined;
    this.request = false;
    // The relay picks the name; it must be a plain DNS label, since it becomes part of the phone address.
    if (typeof message.name !== "string" || !RELAY_NAME_PATTERN.test(message.name)) throw new RelayChannelError("The relay sent an invalid machine name");
    updateMembership(this.runtime.db, this.id, {
      status: "admitted", fingerprint, name: message.name, environment: String(message.environment ?? "").slice(0, 40), pairingCode: null, lastError: null,
      lastConnectedAt: new Date().toISOString(), relayNodeId: this.relayNodeId ?? null,
    });
    this.relayListing = typeof message.relayName === "string" && RELAY_NAME_PATTERN.test(message.relayName) ? { name: message.relayName, phone: message.relayPhone !== false } : undefined;
    this.attempt = 0;
    this.connected = true;
    this.hub = new ChannelHub({
      send: (out) => { if (ws.readyState === WebSocket.OPEN) ws.send(out); },
      onIncoming: (incoming) => this.runtime.acceptIncoming(incoming, this.id),
      onControl: (control) => this.handleControl(control),
    });
    this.sendWatch();
    this.runtime.changed();
    if (!wasAdmitted) this.runtime.handlers.membershipsChanged();
  }

  private acceptRefusal(message: Extract<ControlMessage, { t: "denied" }>): void {
    const status = message.code === "revoked" ? "revoked" : message.code === "suspended" ? "suspended" : "denied";
    updateMembership(this.runtime.db, this.id, { status, lastError: String(message.reason ?? "Refused").slice(0, 300) });
    this.token = undefined;
    this.request = false;
    // Refusals are decisions; only the operator's change and the user's retry reconnect.
    if (message.code !== "unavailable") this.stopped = true;
    this.runtime.changed();
    this.runtime.handlers.membershipsChanged();
  }

  /** The relay's node ID from its introduction; phone gateway channels must come from it. */
  relayNodeId: string | undefined;

  private teardown(reason: string): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.hub?.closeAll(reason);
    this.hub = undefined;
    this.online.clear();
    this.listings.clear();
    if (wasConnected) this.runtime.changed();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt, 6));
    this.attempt += 1;
    this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, delay * (0.75 + Math.random() * 0.5));
    this.timer.unref();
  }

  sendWatch(): void {
    if (!this.hub || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeControl({ t: "watch", nodeIds: this.runtime.watchedIds() }));
  }

  sendGateway(enabled: boolean): void {
    if (this.hub && this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeControl({ t: "gateway", enabled }));
  }

  private handleControl(message: ControlMessage): void {
    if (message.t === "presence") {
      applyPresence(message, this.runtime, this.online, this.listings);
      this.runtime.changed();
      return;
    }
    if (message.t === "admin") {
      if (message.event === "renamed" && typeof message.name === "string" && RELAY_NAME_PATTERN.test(message.name)) updateMembership(this.runtime.db, this.id, { name: message.name });
      if (message.event === "suspended" || message.event === "revoked") { updateMembership(this.runtime.db, this.id, { status: message.event }); this.stopped = true; }
      this.runtime.changed();
      if (message.event !== "renamed") this.runtime.handlers.membershipsChanged();
    }
  }
}

export class RelayRuntime extends EventEmitter {
  readonly identity: LocalRelayIdentity;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly extraWatched = new Set<string>();
  /** The peers the relays were last asked to report. */
  private watched = new Set<string>();
  private localHub: ChannelHub | undefined;
  private readonly localOnline = new Set<string>();
  private readonly localListings = new Map<string, PeerListing>();
  /** The relay that last carried a channel to each peer, tried first next time. */
  private readonly lastRoutes: Map<string, string>;

  constructor(readonly db: DatabaseSync, readonly nodeId: string, private readonly httpServer: Server, readonly handlers: RuntimeHandlers, readonly relayServer: RelayServer) {
    super();
    // Every channel waiting for a route listens for changes.
    this.setMaxListeners(0);
    this.identity = localRelayIdentity(db, nodeId);
    this.lastRoutes = lastPeerRoutes(db);
  }

  start(): void {
    for (const item of listMemberships(this.db)) {
      if (item.status === "revoked" || item.status === "denied" || item.status === "suspended") continue;
      this.connectionFor(item.id).start();
    }
    this.localHub = this.relayServer.attachLocalMachine({
      onIncoming: (incoming) => this.acceptIncoming(incoming, LOCAL_RELAY_ID),
      onControl: (message) => {
        if (message.t !== "presence") return;
        applyPresence(message, this, this.localOnline, this.localListings);
        this.changed();
      },
    });
    this.refreshWatch();
  }

  stop(): void {
    for (const connection of this.connections.values()) connection.stop("Shutting down");
    this.connections.clear();
  }

  /** Something visible changed: listeners refresh status, and Syncthing tunnels re-plan. */
  changed(): void { this.emit("changed"); }

  private connectionFor(id: string): RelayConnection {
    let connection = this.connections.get(id);
    if (!connection) { connection = new RelayConnection(this, id); this.connections.set(id, connection); }
    return connection;
  }

  // ------------------------------------------------------------ memberships

  /** Adds a relay from a token link (`https://<relay>/enroll#<fingerprint>.<secret>`). */
  addWithToken(link: string): RelayMembership {
    const { origin, fingerprint, secret } = parseEnrollLink(link);
    const existing = membershipByOrigin(this.db, origin);
    if (existing && existing.fingerprint && existing.fingerprint !== fingerprint) throw new RelayRuntimeError(409, "This relay's key differs from the one this machine pinned");
    if (this.relayServer.enabled && normalizeRelayOrigin(this.relayServer.origin) === origin) throw new RelayRuntimeError(409, "This machine is that relay");
    const item = existing ?? createMembership(this.db, origin, fingerprint);
    updateMembership(this.db, item.id, { status: "connecting", fingerprint, lastError: null });
    const connection = this.connectionFor(item.id);
    connection.stop("Reconnecting with a token");
    connection.token = secret;
    connection.start();
    this.changed();
    return membership(this.db, item.id)!;
  }

  /** Asks a relay to admit this machine; the operator approves it after comparing the pairing code. */
  requestAccess(originInput: string): RelayMembership {
    let origin: string;
    try { origin = normalizeRelayOrigin(originInput); } catch { throw new RelayRuntimeError(400, "Enter the relay's HTTPS address"); }
    if (this.relayServer.enabled && normalizeRelayOrigin(this.relayServer.origin) === origin) throw new RelayRuntimeError(409, "This machine is that relay");
    const item = membershipByOrigin(this.db, origin) ?? createMembership(this.db, origin, null);
    // A fresh secret nonce per request makes the pairing code impossible to precompute.
    updateMembership(this.db, item.id, { status: "connecting", lastError: null, requestNonce: item.requestNonce ?? randomBytes(32).toString("base64url") });
    const connection = this.connectionFor(item.id);
    connection.stop("Requesting access");
    connection.request = true;
    connection.start();
    this.changed();
    return membership(this.db, item.id)!;
  }

  reconnect(id: string): void {
    const item = membership(this.db, id);
    if (!item) throw new RelayRuntimeError(404, "Relay not found");
    const connection = this.connectionFor(id);
    connection.stop("Reconnecting");
    if (item.status === "denied" && item.requestNonce) connection.request = true;
    updateMembership(this.db, id, { status: item.status === "admitted" ? "admitted" : "connecting", lastError: null });
    connection.start();
    this.changed();
  }

  leave(id: string): void {
    if (id === LOCAL_RELAY_ID) throw new RelayRuntimeError(409, "Turn relay serving off in the Relay tab instead");
    if (!membership(this.db, id)) throw new RelayRuntimeError(404, "Relay not found");
    this.connections.get(id)?.stop("Left the relay");
    this.connections.delete(id);
    deleteMembership(this.db, id);
    this.changed();
    this.handlers.membershipsChanged();
  }

  setPhoneSignIn(id: string, enabled: boolean): void {
    if (id === LOCAL_RELAY_ID) { this.relayServer.setLocalPhoneSignIn(enabled); this.changed(); return; }
    if (!membership(this.db, id)) throw new RelayRuntimeError(404, "Relay not found");
    updateMembership(this.db, id, { phoneSignIn: enabled });
    this.connections.get(id)?.sendGateway(enabled);
    this.changed();
  }

  /** Runtime status for the settings UI. */
  status(): Array<RelayMembership & { connected: boolean; onlinePeers: number }> {
    return listMemberships(this.db).map((item) => {
      const connection = this.connections.get(item.id);
      return { ...item, connected: Boolean(connection?.connected), onlinePeers: connection?.online.size ?? 0 };
    });
  }

  localStatus(): { connected: boolean; onlinePeers: number } {
    return { connected: this.relayServer.enabled, onlinePeers: this.localOnline.size };
  }

  hasAdmittedRelay(): boolean {
    return this.relayServer.enabled || listMemberships(this.db).some((item) => item.status === "admitted");
  }

  // ------------------------------------------------------------ presence and routing

  watchList(): string[] {
    const ids = new Set([...this.handlers.knownPeers(), ...this.extraWatched]);
    ids.delete(this.nodeId);
    return [...ids].filter((id) => UUID.test(id));
  }

  /** Re-sends every relay the peers to watch, after clusters or twins changed. */
  refreshWatch(): void {
    this.watched = new Set(this.watchList());
    for (const connection of this.connections.values()) connection.sendWatch();
    if (this.localHub && this.relayServer.enabled) this.localHub.sendControl({ t: "watch", nodeIds: this.watchedIds() });
  }

  /** Whether the relays were asked to report this peer. Reports about any other machine are ignored. */
  isWatched(nodeId: string): boolean { return this.watched.has(nodeId); }
  watchedIds(): string[] { return [...this.watched]; }

  /** Makes sure presence is tracked for a peer that a request is about to reach. Peers
      learned after the relays were last told (a cluster just joined) are added then. */
  ensureWatched(nodeId: string): void {
    if (!UUID.test(nodeId) || nodeId === this.nodeId || this.watched.has(nodeId)) return;
    if (!this.handlers.knownPeers().includes(nodeId)) this.extraWatched.add(nodeId);
    this.refreshWatch();
  }

  /**
   * Relays through which a peer is online right now, best first. There is nothing to choose
   * by hand: the relay that last carried a channel to the peer comes first, then the others
   * in the order they were added. A relay that is gone simply stops reporting the peer.
   */
  routes(nodeId: string): RelayRoute[] {
    const out: RelayRoute[] = [];
    if (this.localHub && this.relayServer.enabled && this.relayServer.isOnline(nodeId) && nodeId !== this.nodeId) out.push({ membershipId: LOCAL_RELAY_ID, hub: this.localHub });
    for (const item of listMemberships(this.db)) {
      const connection = this.connections.get(item.id);
      if (connection?.hub && connection.online.has(nodeId)) out.push({ membershipId: item.id, hub: connection.hub });
    }
    const last = this.lastRoutes.get(nodeId);
    const index = out.findIndex((route) => route.membershipId === last);
    if (index > 0) out.unshift(...out.splice(index, 1));
    return out;
  }

  hasRoute(nodeId: string): boolean { return this.routes(nodeId).length > 0; }

  /** False when this machine serves no relay and has no live relay connection: every peer is direct. */
  hasAnyRelay(): boolean {
    if (this.relayServer.enabled) return true;
    for (const connection of this.connections.values()) if (connection.hub) return true;
    return false;
  }

  /**
   * Opens an encrypted channel to a peer. It tries each relay that reports the peer, best
   * first, and remembers the one that worked. A peer this machine just started watching may
   * not be reported yet, so the stream waits briefly for a relay to report it.
   */
  openStream(nodeId: string, kind: Exclude<ChannelKind, "gateway">): RelayStream {
    this.ensureWatched(nodeId);
    const stream = new RelayStream(kind, {
      initiator: true, identity: this.identity, expectRemote: expectPinnedPeer(this.db, nodeId), prologue: channelPrologue(kind, this.nodeId, nodeId),
    });
    const tried = new Set<string>();
    let current: string | undefined;
    const tryOpen = (): boolean => {
      const route = this.routes(nodeId).find((candidate) => !tried.has(candidate.membershipId));
      if (!route) return false;
      tried.add(route.membershipId);
      current = route.membershipId;
      route.hub.openWith(stream, nodeId, kind);
      return true;
    };
    // A relay that cannot reach the peer after all hands the stream to the next one.
    stream.retryOpen = () => tryOpen();
    stream.once("relay-ready", () => { if (current) this.rememberRoute(nodeId, current); });
    if (tryOpen()) return stream;
    const stopWaiting = (): void => { clearTimeout(timer); this.off("changed", onChange); };
    const onChange = (): void => { if (stream.destroyed) stopWaiting(); else if (tryOpen()) stopWaiting(); };
    const timer = setTimeout(() => { stopWaiting(); stream.fail(new RelayChannelError("No relay can reach that machine right now")); }, ROUTE_WAIT_MS);
    timer.unref();
    this.on("changed", onChange);
    stream.once("close", stopWaiting);
    return stream;
  }

  private rememberRoute(nodeId: string, membershipId: string): void {
    if (this.lastRoutes.get(nodeId) === membershipId) return;
    this.lastRoutes.set(nodeId, membershipId);
    recordPeerRoute(this.db, nodeId, membershipId);
  }

  /** Phone addresses on one relay: this machine, the relay machine, and the peers this machine knows there. */
  phoneDirectory(membershipId: string): Array<{ nodeId: string; name: string; phone: boolean; kind: "this" | "relay" | "peer" }> {
    if (membershipId === LOCAL_RELAY_ID) {
      const self = this.relayServer.selfListing();
      return [
        ...(self ? [{ nodeId: this.nodeId, ...self, kind: "this" as const }] : []),
        ...[...this.localListings].filter(([nodeId]) => this.localOnline.has(nodeId)).map(([nodeId, listing]) => ({ nodeId, ...listing, kind: "peer" as const })),
      ];
    }
    const item = membership(this.db, membershipId);
    const connection = this.connections.get(membershipId);
    if (!item || item.status !== "admitted") return [];
    const entries: Array<{ nodeId: string; name: string; phone: boolean; kind: "this" | "relay" | "peer" }> = [];
    if (item.name) entries.push({ nodeId: this.nodeId, name: item.name, phone: item.phoneSignIn, kind: "this" });
    if (connection?.relayListing && item.relayNodeId) entries.push({ nodeId: item.relayNodeId, ...connection.relayListing, kind: "relay" });
    for (const [nodeId, listing] of connection?.listings ?? []) {
      if (nodeId !== item.relayNodeId && connection?.online.has(nodeId)) entries.push({ nodeId, ...listing, kind: "peer" });
    }
    return entries;
  }

  /** Decides about a channel another machine (or the relay's phone gateway) opened to this one. */
  acceptIncoming(incoming: IncomingChannel, membershipId: string): RelayStream | string {
    if (incoming.kind === "gateway") {
      const phone = membershipId === LOCAL_RELAY_ID ? this.relayServer.enabled && this.relayServer.localPhoneSignIn() : membership(this.db, membershipId)?.phoneSignIn === true;
      if (!phone) return "Phone sign-in is off on this machine";
      const expected = membershipId === LOCAL_RELAY_ID ? this.nodeId : this.connections.get(membershipId)?.relayNodeId;
      if (expected && incoming.from !== expected) return "Gateway channels come only from the relay";
      const stream = new RelayStream("gateway", undefined);
      stream.remoteAddress = typeof incoming.clientIp === "string" ? incoming.clientIp.slice(0, 64) : undefined;
      stream.once("relay-ready", () => this.httpServer.emit("connection", stream));
      return stream;
    }
    if (!UUID.test(incoming.from) || incoming.from === this.nodeId) return "Invalid peer";
    const stream = new RelayStream(incoming.kind, {
      initiator: false, identity: this.identity, expectRemote: expectAnnouncedPeer(this.db, incoming.from, incoming.fromKey),
      prologue: channelPrologue(incoming.kind, incoming.from, this.nodeId),
    });
    if (incoming.kind === "syncthing") {
      if (!this.handlers.syncthingAllowed(incoming.from)) return "This machine shares no files with that peer";
      stream.once("relay-ready", () => this.handlers.acceptSyncthing(stream, incoming.from));
    } else {
      stream.once("relay-ready", () => this.httpServer.emit("connection", stream));
    }
    stream.on("error", () => undefined);
    return stream;
  }
}

/** Applies a presence report. Only peers this machine asked about are taken, so a relay cannot add machines or phone addresses. */
function applyPresence(message: Extract<ControlMessage, { t: "presence" }>, runtime: RelayRuntime, online: Set<string>, listings: Map<string, PeerListing>): void {
  for (const nodeId of Array.isArray(message.offline) ? message.offline : []) { online.delete(nodeId); listings.delete(nodeId); }
  for (const nodeId of Array.isArray(message.online) ? message.online : []) {
    if (typeof nodeId !== "string" || !runtime.isWatched(nodeId)) continue;
    online.add(nodeId);
    runtime.handlers.peerOnline(nodeId);
  }
  for (const [nodeId, listing] of Object.entries(message.listings ?? {})) {
    if (online.has(nodeId) && listing && typeof listing.name === "string" && RELAY_NAME_PATTERN.test(listing.name)) listings.set(nodeId, { name: listing.name, phone: listing.phone === true });
  }
}

export class RelayRuntimeError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function parseEnrollLink(link: string): { origin: string; fingerprint: string; secret: string } {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new RelayRuntimeError(400, "Paste the whole relay link"); }
  const [fingerprint, secret, ...rest] = url.hash.slice(1).split(".");
  if (url.pathname !== "/enroll" || rest.length || !/^[0-9a-f]{64}$/.test(fingerprint ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) {
    throw new RelayRuntimeError(400, "This is not a relay link");
  }
  let origin: string;
  try { origin = normalizeRelayOrigin(url.origin); } catch { throw new RelayRuntimeError(400, "Relay links must use HTTPS"); }
  return { origin, fingerprint, secret };
}

export function enrollLink(origin: string, fingerprint: string, secret: string): string {
  return `${origin}/enroll#${fingerprint}.${secret}`;
}

export { pairingCode };
