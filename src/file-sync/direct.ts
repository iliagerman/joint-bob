import { createPublicKey, type KeyObject } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import type { Writable } from "node:stream";
import { z } from "zod";
import type { FilesService, PeerRequest, PeerResponse, PeerTransport } from "./core.js";
import { STREAM_WINDOW_BYTES, type ConfigureArgs, type FilesEndpoint, type PeerSpec, type RelayedRequest, type RequestStats, type ServeAnswer } from "./protocol.js";
import { canonicalPublicKey, ClusterProtocolError, signRequest, verifyRequest } from "./signing.js";
import { FILES_API } from "./wire.js";

/* The worker's network layer (FILE-SYNC design §1 "Network path", §5.1): a listener on this node's
   Tailscale addresses that serves /api/cluster/v2/files/* to signed peers, and the client transport
   that tries a peer's advertised origins first and falls back to the relay through main. Over the
   direct path file bytes and index pages never touch the main thread. The byte-stream helpers at the
   end carry the relay fallback and main's serve routes across the thread boundary. */

export const FILES_PREFIX = `${FILES_API}/`;
/** POST bodies are small JSON (paths, hashes, cursors); anything bigger is a mistake or an attack. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** A refused body is read and dropped up to this much, so its sender gets the 413; past it the socket is closed. */
const DRAIN_BYTES = 8 * 1024 * 1024;
/** A transfer with no byte for this long is given up; there is no cap on its total time. */
export const STALL_MS = 30_000;
/** An origin that failed is skipped this long (relay/transport.ts uses the same 5 min). */
export const ORIGIN_RETRY_MS = 5 * 60_000;
/** A reader (a peer, or the worker on the relay path) that takes no byte for this long is dropped. */
export const DRAIN_STALL_MS = 120_000;
/** The configured port, then the next ones, when another process holds it (design §1: 22700..22709). */
export const PORT_ATTEMPTS = 10;

export type Route = "direct" | "relay" | "none";

const ENDPOINTS: Readonly<Record<string, { endpoint: FilesEndpoint; method: "GET" | "POST" }>> = {
  shares: { endpoint: "shares", method: "GET" },
  index: { endpoint: "index", method: "GET" },
  changed: { endpoint: "changed", method: "POST" },
  fetch: { endpoint: "fetch", method: "POST" },
  file: { endpoint: "file", method: "POST" },
  status: { endpoint: "status", method: "POST" },
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

// ---- answers ----

function jsonAnswer(status: number, json: unknown): ServeAnswer { return { status, headers: {}, json }; }

/**
 * A FilesService failure as an answer. Errors that carry an HTTP status keep it and their message
 * (the service words them for peers); anything else is a 500 without details.
 */
export function errorAnswer(error: unknown, log?: (message: string) => void): ServeAnswer {
  if (error instanceof z.ZodError) return jsonAnswer(400, { error: "Invalid request" });
  const status = (error as { statusCode?: unknown; status?: unknown })?.statusCode ?? (error as { status?: unknown })?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return jsonAnswer(status, { error: messageOf(error).slice(0, 500) });
  if ((error as { code?: unknown })?.code === "unavailable") return jsonAnswer(501, { error: "Not available in this phase" });
  log?.(`File sync could not answer a peer: ${messageOf(error)}`);
  return jsonAnswer(500, { error: "File sync could not answer" });
}

function firstValues(search: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of search) if (!(key in query)) query[key] = value;
  return query;
}

// ---- replay protection ----

/** Replay protection; production uses file-sync.db's nonces table (FileSyncDb.consumeNonce). */
export interface NonceStore {
  /** False when the nonce was seen before (a replay). */
  consume(sender: string, nonce: string, now: number): boolean;
}

// ---- listener ----

export interface DirectListenerOptions {
  nodeId: string;
  service(): FilesService | undefined;
  nonces(): NonceStore;
  publicKeyFor(peer: string): KeyObject | undefined;
  now?(): number;
  log?(message: string): void;
}

interface Bound { address: string; server: http.Server }

/**
 * One http.Server per address. Only /api/cluster/v2/files/* exists; every request must be signed by
 * a configured peer for this node exactly like a cluster request (signing.ts), with a fresh nonce.
 * Authorization per share is the FilesService's job.
 */
export class DirectListener {
  /** Signed requests this listener accepted (status and the idle-traffic check). */
  served = 0;
  private bound: Bound[] = [];
  private wanted = "";
  private binding: Promise<string[]> = Promise.resolve([]);
  private readonly sockets = new Set<import("node:net").Socket>();

  constructor(private readonly options: DirectListenerOptions) {}

  get origins(): string[] {
    return this.bound.map(({ address, server }) => {
      const port = (server.address() as { port: number }).port;
      return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
    });
  }

  /** Binds the addresses (unchanged addresses and port keep their servers); [] closes everything. */
  listen(addresses: readonly string[], port: number): Promise<string[]> {
    const usable = [...new Set(addresses)].filter((address) => {
      // A wildcard would bind every interface, LAN and public ones included.
      if (isIP(address) && address !== "0.0.0.0" && address !== "::") return true;
      this.options.log?.(`File sync does not listen on ${JSON.stringify(address)}: only a specific IP address is allowed`);
      return false;
    }).sort();
    const key = usable.length ? `${usable.join(",")}@${port}` : "";
    if (key === this.wanted) return this.binding;
    this.wanted = key;
    this.binding = this.binding.catch(() => []).then(async () => {
      await this.closeServers();
      if (key !== this.wanted || !usable.length) return this.origins;
      await this.bindAll(usable, port);
      return this.origins;
    });
    return this.binding;
  }

  private async bindAll(addresses: string[], port: number): Promise<void> {
    for (let attempt = 0; attempt < PORT_ATTEMPTS && port + attempt <= 65_535; attempt++) {
      const candidate = port + attempt;
      const bound: Bound[] = [];
      let inUse = false;
      for (const address of addresses) {
        try { bound.push({ address, server: await this.bindOne(address, candidate) }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") { inUse = true; break; }
          // The address went away (Tailscale down): the others still serve.
          this.options.log?.(`File sync could not listen on ${address}:${candidate}: ${messageOf(error)}`);
        }
      }
      if (!inUse) { this.bound = bound; return; }
      // Every address shares one port, so peers can be told one origin per address.
      await Promise.all(bound.map(({ server }) => closeServer(server)));
    }
    this.options.log?.(`File sync could not listen: ports ${port}–${port + PORT_ATTEMPTS - 1} are in use; peers reach this node through the relay`);
  }

  private bindOne(address: string, port: number): Promise<http.Server> {
    const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5_000 }, (request, response) => {
      void this.handle(request, response).catch((error) => {
        this.options.log?.(`File sync could not answer a direct request: ${messageOf(error)}`);
        if (!response.headersSent) sendJson(response, 500, { error: "File sync could not answer" });
        else response.destroy();
      });
    });
    // A peer that stops reading is dropped; a transfer that moves never is.
    server.setTimeout(120_000);
    server.maxConnections = 256;
    server.on("connection", (socket) => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address, port, exclusive: true }, () => {
        server.off("error", reject);
        server.on("error", (error) => this.options.log?.(`File sync listener on ${address} failed: ${messageOf(error)}`));
        resolve(server);
      });
    });
  }

  private async closeServers(): Promise<void> {
    const servers = this.bound.splice(0);
    await Promise.all(servers.map(({ server }) => closeServer(server)));
  }

  async close(): Promise<void> {
    this.wanted = "";
    await this.binding.catch(() => undefined);
    await this.closeServers();
    for (const socket of this.sockets) socket.destroy();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const target = request.url ?? "/";
    const pathname = target.split("?")[0];
    const route = pathname.startsWith(FILES_PREFIX) ? ENDPOINTS[pathname.slice(FILES_PREFIX.length)] : undefined;
    if (!route || request.method !== route.method) { sendJson(response, 404, { error: "Not found" }); return; }
    const encoding = request.headers["content-encoding"];
    if (encoding && encoding !== "identity") { sendJson(response, 415, { error: "Unsupported cluster request body" }); return; }
    const raw = await readBody(request, MAX_BODY_BYTES);
    if (raw === "too-large") { if (!response.destroyed) sendJson(response, 413, { error: "File sync request body is too large" }); return; }
    if (raw === "aborted") return;
    const now = this.options.now?.() ?? Date.now();
    let sender: string;
    try {
      const envelope = verifyRequest(this.options.nodeId, route.method, target, raw, request.headers.authorization, (peer) => this.options.publicKeyFor(peer), now);
      if (!this.options.nonces().consume(envelope.senderNodeId, envelope.nonce, now)) throw new ClusterProtocolError("Cluster request replayed");
      sender = envelope.senderNodeId;
      this.served++;
    } catch (error) {
      if (!(error instanceof ClusterProtocolError)) this.options.log?.(`File sync could not check a direct request: ${messageOf(error)}`);
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    let body: unknown;
    if (route.method === "POST") {
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { sendJson(response, 400, { error: "Invalid request" }); return; }
    }
    const service = this.options.service();
    if (!service) { sendJson(response, 503, { error: "File sync is starting" }); return; }
    const range = route.endpoint === "file" && typeof request.headers.range === "string" ? request.headers.range : undefined;
    let answer: ServeAnswer;
    try { answer = await service.serve(sender, route.endpoint, firstValues(new URL(target, "http://direct.invalid").searchParams), body, range); }
    catch (error) { answer = errorAnswer(error, this.options.log); }
    await writeAnswer(response, answer);
  }
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function sendJson(response: http.ServerResponse, status: number, json: unknown): void {
  const text = JSON.stringify(json);
  // A body left unread (404, 415) is discarded by Node once the answer ends, within requestTimeout.
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  response.end(text);
}

/**
 * The request body up to `limit`. Past it the rest is read and dropped (up to DRAIN_BYTES), so the
 * peer finishes sending and reads the 413 instead of a reset connection; more than that and the
 * socket goes.
 */
function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer | "too-large" | "aborted"> {
  const declared = Number(request.headers["content-length"] ?? 0);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (value: Buffer | "too-large" | "aborted") => { if (!done) { done = true; resolve(value); } };
    if (Number.isFinite(declared) && declared > DRAIN_BYTES) { finish("too-large"); request.destroy(); return; }
    if (Number.isFinite(declared) && declared > limit) finish("too-large");
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > DRAIN_BYTES) { request.destroy(); return; }
      if (done) return;
      if (total > limit) { chunks.length = 0; finish("too-large"); return; }
      chunks.push(chunk);
    });
    request.once("end", () => finish(Buffer.concat(chunks, total)));
    request.once("error", () => finish("aborted"));
    request.once("close", () => { if (!request.complete) finish("aborted"); });
  });
}

/** Writes a FilesService answer; a byte body follows the socket's pace and stops when the peer goes. */
export async function writeAnswer(response: http.ServerResponse, answer: ServeAnswer): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(answer.headers ?? {})) if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name.toLowerCase()] = String(value);
  headers["cache-control"] ??= "no-store";
  if (answer.json !== undefined || !answer.body) {
    if (answer.body) void answer.body[Symbol.asyncIterator]().return?.();
    const text = answer.json === undefined ? "" : JSON.stringify(answer.json);
    response.writeHead(answer.status, { ...headers, ...(answer.json === undefined ? {} : { "content-type": "application/json; charset=utf-8" }), "content-length": String(Buffer.byteLength(text)) });
    response.end(text);
    return;
  }
  response.writeHead(answer.status, headers);
  await pipeBody(response, answer.body);
}

/**
 * Async-iterable bytes into a writable response with backpressure. A reader that takes nothing for
 * `drainMs` is dropped; a failure destroys the response so the reader never takes a short body for
 * a whole one.
 */
export async function pipeBody(response: Writable, body: AsyncIterable<Uint8Array>, drainMs = DRAIN_STALL_MS): Promise<void> {
  const iterator = body[Symbol.asyncIterator]();
  let gone = false;
  let wake: (() => void) | undefined;
  const onClose = () => { gone = true; wake?.(); };
  response.once("close", onClose);
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) { finished = true; break; }
      if (gone || response.destroyed) break;
      if (!response.write(value)) {
        let timer: NodeJS.Timeout | undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
          response.once("drain", resolve);
          timer = setTimeout(() => { response.destroy(new Error("File sync reader stopped reading")); resolve(); }, drainMs);
          timer.unref();
        });
        clearTimeout(timer);
        response.off("drain", wake!);
        wake = undefined;
        if (gone || response.destroyed) break;
      }
    }
    if (finished && !gone) response.end();
  } catch (error) {
    finished = true;
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    response.off("close", onClose);
    if (!finished) await iterator.return?.().catch(() => undefined);
  }
}

// ---- client transport ----

export type RelaySend = (peer: string, request: RelayedRequest, signal?: AbortSignal) => Promise<PeerResponse>;

export interface DirectTransportOptions {
  nodeId: string;
  /** The fallback: main sends the request through peerFetch (relay or the peer's replication URL). */
  relay: RelaySend;
  now?(): number;
  fetch?: typeof fetch;
  stallMs?: number;
  retryMs?: number;
}

interface PeerRoute { origins: string[]; working?: string; route: Route; /** Main has it as away: no direct attempts until it is back. */ away?: boolean }

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { for await (const _chunk of body) { /* a small error answer; read so the connection is free again */ } } catch { /* nothing to keep */ }
}

/**
 * PeerTransport for the worker: a peer's advertised direct origins first (signed with this node's
 * key right before sending), the relay through main when none answers. The origin that worked is
 * tried first next time; one that failed is skipped for five minutes. Every engine request is
 * idempotent (reads, and notices carrying maxSeq), so a request whose direct attempt failed before
 * an answer arrived is safe to send again over the relay. A 401 or 404 from an origin means that
 * something else answers there (another node, another service, a stale address): it counts as no
 * answer, since the peer's own listener knows every endpoint and every key main accepts.
 */
export class DirectTransport implements PeerTransport {
  /** Requests by the route that carried them, or failed when none did (status and the idle-traffic check). */
  readonly sent = { direct: 0, relay: 0, failed: 0 };
  private signingKey: KeyObject | undefined;
  private readonly peers = new Map<string, PeerRoute>();
  private readonly failedUntil = new Map<string, number>();

  constructor(private readonly options: DirectTransportOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  setSigningKey(key: KeyObject | undefined): void { this.signingKey = key; }

  /** From configure: the full peer list; a peer left out is forgotten. */
  setPeers(peers: readonly PeerSpec[]): void {
    const keep = new Set(peers.map((peer) => peer.nodeId));
    for (const nodeId of this.peers.keys()) if (!keep.has(nodeId)) this.peers.delete(nodeId);
    for (const peer of peers) this.setOrigins(peer.nodeId, peer.origins);
  }

  /** Origins a peer advertised, as main accepted them (configure, peerPresence). */
  setOrigins(peer: string, origins: readonly string[]): void {
    const state = this.peers.get(peer) ?? { origins: [], route: "none" as Route };
    state.origins = [...new Set(origins.filter(validOrigin))];
    if (state.working && !state.origins.includes(state.working)) state.working = undefined;
    this.peers.set(peer, state);
  }

  /** A peer came back or this node woke: its addresses deserve a new try before their backoff ends. */
  resetBackoff(peer?: string): void {
    if (peer === undefined) {
      this.failedUntil.clear();
      for (const state of this.peers.values()) state.away = false;
      return;
    }
    const state = this.peers.get(peer);
    if (state) state.away = false;
    for (const origin of state?.origins ?? []) this.failedUntil.delete(origin);
  }

  /** The peer reached this node after looking away. */
  reachable(peer: string): void { this.resetBackoff(peer); }

  route(peer: string): Route { return this.peers.get(peer)?.route ?? "none"; }

  private candidates(peer: string, request: PeerRequest): string[] {
    const state = this.peers.get(peer);
    if (!state || !this.signingKey || state.away || request.via === "relay") return [];
    const now = this.now();
    const ordered = state.working ? [state.working, ...state.origins.filter((origin) => origin !== state.working)] : state.origins;
    return ordered.filter((origin) => (this.failedUntil.get(origin) ?? 0) <= now);
  }

  private skip(state: PeerRoute, origin: string): void {
    this.failedUntil.set(origin, this.now() + (this.options.retryMs ?? ORIGIN_RETRY_MS));
    if (state.working === origin) state.working = undefined;
  }

  async request(peer: string, request: PeerRequest): Promise<PeerResponse> {
    const state = this.peers.get(peer) ?? { origins: [], route: "none" as Route };
    this.peers.set(peer, state);
    for (const origin of this.candidates(peer, request)) {
      if (request.signal?.aborted) throw request.signal.reason;
      let response: PeerResponse;
      try {
        response = await this.direct(peer, origin, request);
      } catch (error) {
        if (request.signal?.aborted) throw error;
        // No answer from this origin: skip it for a while and try the next one, then the relay.
        this.skip(state, origin);
        continue;
      }
      if (response.status === 401 || response.status === 404) {
        await drain(response.body);
        this.skip(state, origin);
        continue;
      }
      state.working = origin;
      state.route = "direct";
      this.sent.direct++;
      return { ...response, route: "direct" };
    }
    try {
      const response = await this.options.relay(peer, {
        method: request.method, target: request.target, purpose: request.purpose,
        ...(request.json !== undefined ? { json: request.json } : {}),
        ...(request.headers ? { headers: request.headers } : {}),
        ...((request as { foreground?: boolean }).foreground ? { foreground: true } : {}),
      }, request.signal);
      state.route = "relay";
      state.away = false;
      this.sent.relay++;
      return { ...response, route: "relay" };
    } catch (error) {
      this.sent.failed++;
      if (!request.signal?.aborted) state.route = "none";
      // Main refused it as away (or found it so): connecting to its addresses again waits until main reports it back.
      if ((error as { away?: unknown })?.away === true) state.away = true;
      throw error;
    }
  }

  private async direct(peer: string, origin: string, request: PeerRequest): Promise<PeerResponse> {
    const post = request.method === "POST";
    const raw = post ? Buffer.from(JSON.stringify(request.json ?? {})) : Buffer.alloc(0);
    const guard = stallGuard(this.options.stallMs ?? STALL_MS, request.signal);
    try {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) if (!["authorization", "host", "content-length", "content-type"].includes(name.toLowerCase())) headers[name] = value;
      if (post) headers["content-type"] = "application/json";
      // Signed immediately before sending: the receiver allows ±60 s.
      headers.authorization = signRequest(this.signingKey!, this.options.nodeId, peer, request.method, request.target, raw, this.now());
      const response = await (this.options.fetch ?? fetch)(new URL(request.target, origin), {
        method: request.method, headers, redirect: "error", signal: guard.signal, ...(post ? { body: raw } : {}),
      });
      guard.touch();
      const answer: Record<string, string> = {};
      response.headers.forEach((value, name) => { answer[name] = value; });
      return { status: response.status, headers: answer, body: guardedBody(response.body, guard) };
    } catch (error) {
      guard.done();
      throw guard.signal.aborted && !request.signal?.aborted ? guard.signal.reason : error;
    }
  }
}

function validOrigin(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value; } catch { return false; }
}

async function* guardedBody(body: ReadableStream<Uint8Array> | null, guard: StallGuard): AsyncGenerator<Uint8Array> {
  if (!body) { guard.done(); return; }
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch (error) { throw guard.signal.aborted ? guard.signal.reason : error; }
      if (next.done) { complete = true; return; }
      guard.touch();
      yield next.value;
    }
  } finally {
    guard.done();
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// ---- stall guard ----

export interface StallGuard {
  readonly signal: AbortSignal;
  /** Bytes moved: the stall clock starts over. */
  touch(): void;
  /** Waiting on our own side (a slow reader), not on the peer: the clock stops. */
  pause(): void;
  resume(): void;
  done(): void;
}

/** Aborts with a TimeoutError after `ms` without a touch; the parent signal aborts it too. No total cap. */
export function stallGuard(ms: number, parent?: AbortSignal, message = "File sync transfer stalled"): StallGuard {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const fire = () => controller.abort(new DOMException(message, "TimeoutError"));
  const arm = () => {
    if (finished || controller.signal.aborted) return;
    if (timer) timer.refresh();
    else { timer = setTimeout(fire, ms); timer.unref(); }
  };
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const onParent = () => { stop(); controller.abort(parent!.reason); };
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParent, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    pause: stop,
    resume: arm,
    done() { finished = true; stop(); parent?.removeEventListener("abort", onParent); },
  };
}

// ---- the worker's network layer ----

export interface NetworkOptions {
  nodeId: string;
  relay: RelaySend;
  service(): FilesService | undefined;
  nonces(): NonceStore;
  log?(message: string): void;
  fetch?: typeof fetch;
  stallMs?: number;
  retryMs?: number;
  now?(): number;
}

/** Listener plus transport, kept in line with configure and peerPresence. */
export class Network {
  readonly transport: DirectTransport;
  readonly listener: DirectListener;
  private keys = new Map<string, KeyObject>();
  private pems = new Map<string, string>();

  constructor(private readonly options: NetworkOptions) {
    this.transport = new DirectTransport({ nodeId: options.nodeId, relay: options.relay, fetch: options.fetch, stallMs: options.stallMs, retryMs: options.retryMs, now: options.now });
    this.listener = new DirectListener({
      nodeId: options.nodeId, service: options.service, nonces: options.nonces, now: options.now, log: options.log,
      publicKeyFor: (peer) => this.keys.get(peer),
    });
  }

  get origins(): string[] { return this.listener.origins; }

  /** Applies the network part of configure; returns the origins this node listens on. */
  async configure(args: ConfigureArgs): Promise<string[]> {
    this.transport.setSigningKey(args.signingKey);
    this.transport.setPeers(args.peers);
    const keys = new Map<string, KeyObject>();
    const pems = new Map<string, string>();
    for (const peer of args.peers) {
      const known = this.pems.get(peer.nodeId) === peer.publicKey ? this.keys.get(peer.nodeId) : undefined;
      try {
        keys.set(peer.nodeId, known ?? createPublicKey(canonicalPublicKey(peer.publicKey)));
        pems.set(peer.nodeId, peer.publicKey);
      } catch { this.options.log?.(`File sync ignores peer ${peer.nodeId}: its public key is invalid`); }
    }
    this.keys = keys;
    this.pems = pems;
    const listen = args.enabled && args.listen ? args.listen : { addresses: [], port: 0 };
    return this.listener.listen(listen.addresses, listen.port);
  }

  /**
   * Origins come only from main (configure, peerPresence), which keeps those that pass
   * acceptablePeerOrigin; a peer's own /files/shares answer could point this node anywhere.
   */
  peerPresence(args: { peer: string; present: boolean; origins?: string[] }): void {
    if (args.origins) this.transport.setOrigins(args.peer, args.origins);
    if (args.present) this.transport.resetBackoff(args.peer);
  }

  /** Request counts since the worker started. */
  get stats(): RequestStats {
    return { sent: { ...this.transport.sent }, served: { direct: this.listener.served } };
  }

  close(): Promise<void> { return this.listener.close(); }
}

// ---- byte streams between the threads ----

/** Receivers acknowledge at least this much at a time, or whenever they have read everything. */
const ACK_BYTES = 256 * 1024;

/** A transferable copy: the sender never hands away memory something else may still use. */
export function ownedChunk(chunk: Uint8Array): ArrayBuffer {
  return new Uint8Array(chunk).buffer as ArrayBuffer;
}

/** The sender's side of a stream: at most `limit` bytes sent and not acknowledged before it waits. */
export class StreamWindow {
  private inFlight = 0;
  private closed = false;
  private wake: (() => void) | undefined;
  /** The most bytes ever unacknowledged at once (tests check the window holds). */
  peak = 0;

  constructor(readonly limit = STREAM_WINDOW_BYTES) {}

  sent(bytes: number): void { this.inFlight += bytes; this.peak = Math.max(this.peak, this.inFlight); }

  acked(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - Math.max(0, bytes));
    if (this.inFlight <= this.limit) this.release();
  }

  /** Resolves once more may be sent; false once the stream is closed. */
  async ready(): Promise<boolean> {
    while (!this.closed && this.inFlight > this.limit) await new Promise<void>((resolve) => { this.wake = resolve; });
    return !this.closed;
  }

  close(): void { this.closed = true; this.release(); }
  get isClosed(): boolean { return this.closed; }
  /** The receiver holds a full window: the sender has to wait for an ack. */
  get blocked(): boolean { return !this.closed && this.inFlight > this.limit; }

  private release(): void { const wake = this.wake; this.wake = undefined; wake?.(); }
}

/** The receiver's side: an async iterable fed by messages, acknowledging what its reader takes. */
export class StreamReceiver implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private waiting: { resolve(result: IteratorResult<Uint8Array>): void; reject(error: unknown): void } | undefined;
  private ended = false;
  private failure: { error: unknown } | undefined;
  private finished = false;
  private unacked = 0;
  private iterated = false;

  constructor(private readonly hooks: { consumed(bytes: number): void; cancel(): void }) {}

  get done(): boolean { return this.finished; }

  push(chunk: Uint8Array): void {
    if (this.finished || this.ended || this.failure) return;
    const waiting = this.waiting;
    if (waiting) { this.waiting = undefined; waiting.resolve(this.take(chunk)); }
    else this.queue.push(chunk);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    const waiting = this.waiting;
    if (waiting && !this.queue.length) { this.waiting = undefined; this.finished = true; waiting.resolve({ done: true, value: undefined }); }
  }

  fail(error: unknown): void {
    if (this.finished || this.ended || this.failure) return;
    this.failure = { error };
    const waiting = this.waiting;
    if (waiting && !this.queue.length) { this.waiting = undefined; this.finished = true; waiting.reject(error); }
  }

  private take(chunk: Uint8Array): IteratorResult<Uint8Array> {
    this.unacked += chunk.byteLength;
    if (this.unacked >= ACK_BYTES || !this.queue.length) { const bytes = this.unacked; this.unacked = 0; this.hooks.consumed(bytes); }
    return { done: false, value: chunk };
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    if (this.queue.length) return Promise.resolve(this.take(this.queue.shift()!));
    if (this.failure) { this.finished = true; return Promise.reject(this.failure.error); }
    if (this.ended || this.finished) { this.finished = true; return Promise.resolve({ done: true, value: undefined }); }
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  /** The reader stopped early: the sender is told to stop. */
  private stop(): Promise<IteratorResult<Uint8Array>> {
    const cancelled = !this.finished && !this.ended && !this.failure;
    this.finished = true;
    this.queue.length = 0;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve({ done: true, value: undefined });
    if (cancelled) this.hooks.cancel();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterated) throw new Error("A file sync stream can be read once");
    this.iterated = true;
    return { next: () => this.next(), return: () => this.stop() };
  }
}
