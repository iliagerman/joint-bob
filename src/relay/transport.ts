// How a request reaches a peer (RELAY-PLAN.md §4.4–4.6).
//
// `peerFetch` and `peerWebSocket` take the same arguments as `fetch` and `new WebSocket`.
// A peer with a direct URL is tried directly first; if that cannot connect and a relay
// both machines are on can reach it, the request goes through the relay instead. A peer
// that only has relays advertises a URL under `.relay.invalid` and always goes through one.
//
// Choosing a path never changes what is asked or who answers: the request, its signature
// and the receiving machine's checks are the same either way.
import http, { type IncomingMessage } from "node:http";
import net, { type Socket } from "node:net";
import { Readable } from "node:stream";
import WebSocket, { type ClientOptions } from "ws";
import { virtualRelayNodeId, virtualRelayUrl } from "./protocol.js";
import type { RelayRuntime } from "./runtime.js";
import type { RelayStream } from "./stream.js";

/** After a direct connection fails, prefer the relay for this long before trying direct again. */
const DIRECT_RETRY_MS = 5 * 60_000;
/** How long a direct address may take to accept a TCP connection before the relay is used. */
const PROBE_TIMEOUT_MS = 3_000;
const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

let runtime: RelayRuntime | undefined;
const directFailedUntil = new Map<string, number>();
const agents = new Map<string, http.Agent>();

export function setRelayTransport(active: RelayRuntime | undefined): void {
  runtime = active;
  directFailedUntil.clear();
  probes.clear();
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

export function activeRelayRuntime(): RelayRuntime | undefined { return runtime; }

type Route = { kind: "direct"; nodeId?: string } | { kind: "relay"; nodeId: string } | { kind: "unreachable"; nodeId: string };

/**
 * The caller names the peer it means: a URL is only where to find it. A relay-only URL must
 * name that same node, and relay fallback goes to that node, never to whoever else lists the
 * same URL, so a cluster member cannot draw another machine's traffic by copying its URL.
 */
function chooseRoute(url: URL, peerId: string | undefined): Route {
  const virtual = virtualRelayNodeId(url);
  if (virtual) {
    if (peerId && peerId !== virtual) return { kind: "unreachable", nodeId: peerId };
    // A relay-only peer always goes through a relay; opening the channel waits for one to report it.
    return runtime ? { kind: "relay", nodeId: virtual } : { kind: "unreachable", nodeId: virtual };
  }
  // Without relays, or without knowing which peer is meant, the request goes direct as before relays existed.
  if (!peerId || !runtime?.hasAnyRelay()) return { kind: "direct" };
  runtime.ensureWatched(peerId);
  if (directFailedRecently(url.origin) && runtime.hasRoute(peerId)) return { kind: "relay", nodeId: peerId };
  return { kind: "direct", nodeId: peerId };
}

function directFailedRecently(origin: string): boolean { return (directFailedUntil.get(origin) ?? 0) > Date.now(); }

function markDirectFailed(origin: string): void {
  const fresh = !directFailedRecently(origin);
  directFailedUntil.set(origin, Date.now() + DIRECT_RETRY_MS);
  // A peer that moved to the relay may now need a Syncthing tunnel.
  if (fresh) runtime?.changed();
}

function markDirectWorked(origin: string): void {
  if (directFailedUntil.delete(origin)) runtime?.changed();
  probes.set(origin, { ok: true, until: Date.now() + DIRECT_RETRY_MS });
}

const probes = new Map<string, { ok: boolean; until: number; pending?: Promise<boolean> }>();

/**
 * Whether anything answers at a peer's direct address, found with a short TCP connect. Only
 * used when a relay could reach the peer instead: a black-holed address (an offline Tailscale
 * host drops packets) would otherwise make every request wait out its full timeout.
 */
function directReachable(url: URL): Promise<boolean> {
  const cached = probes.get(url.origin);
  if (cached?.pending) return cached.pending;
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.ok);
  const pending = new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    const finish = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  }).then((ok) => {
    probes.set(url.origin, { ok, until: Date.now() + DIRECT_RETRY_MS });
    if (!ok) markDirectFailed(url.origin);
    return ok;
  });
  probes.set(url.origin, { ok: true, until: 0, pending });
  return pending;
}

/** A failure before any byte of the request left this machine; safe to try another path. */
export function isConnectFailure(error: unknown): boolean {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause = (error as { cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } }).cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === "string" && CONNECT_FAILURES.has(code);
}

function replayable(body: unknown): boolean {
  return body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams;
}

/** `fetch` to a peer machine. `peerId` is the node the caller means to reach. */
export async function peerFetch(input: string | URL, init: RequestInit = {}, peerId?: string): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") return fetch(input, init);
  const route = chooseRoute(url, peerId);
  if (route.kind === "relay") return relayFetch(route.nodeId, url, init, 0);
  if (route.kind === "unreachable") throw new TypeError("fetch failed", { cause: Object.assign(new Error("No relay can reach that machine right now"), { code: "ERELAYUNREACHABLE" }) });
  const relayed = route.nodeId && runtime?.hasRoute(route.nodeId) ? route.nodeId : undefined;
  if (relayed && !await directReachable(url)) return relayFetch(relayed, url, init, 0);
  try {
    const response = await fetch(input, init);
    if (route.nodeId) markDirectWorked(url.origin);
    return response;
  } catch (error) {
    const nodeId = route.nodeId;
    if (!nodeId || !runtime?.hasRoute(nodeId)) throw error;
    // A timeout before any answer also means the direct path is not working right now.
    if (isConnectFailure(error) || (error instanceof Error && error.name === "TimeoutError")) markDirectFailed(url.origin);
    if (init.signal?.aborted || !isConnectFailure(error) || !replayable(init.body)) throw error;
    return relayFetch(nodeId, url, init, 0);
  }
}

class RelayAgent extends http.Agent {
  constructor(private readonly nodeId: string) {
    // Node's server closes idle connections after 5 s; give pooled channels back before that.
    super({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 4_000 });
  }
  override createConnection(): Socket {
    if (!runtime) throw new Error("Relays are not running");
    return runtime.openStream(this.nodeId, "peer") as unknown as Socket;
  }
}

function agentFor(nodeId: string): http.Agent {
  let agent = agents.get(nodeId);
  if (!agent) { agent = new RelayAgent(nodeId); agents.set(nodeId, agent); }
  return agent;
}

async function relayFetch(nodeId: string, url: URL, init: RequestInit, hops: number): Promise<Response> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw signal.reason;
  const method = (init.method ?? "GET").toUpperCase();
  // Request normalises every body type and its content type the way fetch would.
  const normalized = new Request(url, { method, headers: init.headers, body: init.body, duplex: "half" } as RequestInit & { duplex: "half" });
  const headers: Record<string, string> = {};
  normalized.headers.forEach((value, key) => { headers[key] = value; });
  headers.host = url.host;
  let buffered: Buffer | undefined;
  if (typeof init.body === "string") buffered = Buffer.from(init.body);
  else if (init.body instanceof Uint8Array) buffered = Buffer.from(init.body);
  else if (init.body instanceof ArrayBuffer) buffered = Buffer.from(new Uint8Array(init.body));
  if (buffered) headers["content-length"] = String(buffered.length);

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = http.request({ agent: agentFor(nodeId), host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), method, path: `${url.pathname}${url.search}`, headers });
    const abort = (): void => { request.destroy(signal?.reason); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("response", (answer) => {
      resolve(answer);
      answer.once("close", () => signal?.removeEventListener("abort", abort));
    });
    request.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.aborted ? signal.reason : new TypeError("fetch failed", { cause: error }));
    });
    if (buffered) request.end(buffered);
    else if (normalized.body) Readable.fromWeb(normalized.body as import("node:stream/web").ReadableStream).pipe(request);
    else request.end();
  });

  const status = response.statusCode ?? 502;
  const location = response.headers.location;
  if (REDIRECTS.has(status) && location && init.redirect !== "manual") {
    response.resume();
    if (init.redirect === "error" || hops >= 5) throw new TypeError("fetch failed", { cause: new Error("Unexpected redirect") });
    const next = new URL(location, url);
    const switchToGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
    const nextInit: RequestInit = { ...init, ...(switchToGet ? { method: "GET", body: undefined } : {}) };
    // A redirect never leaves the peer it was meant for.
    if (next.origin !== url.origin) throw new TypeError("fetch failed", { cause: new Error("Cross-origin redirect from a peer") });
    return relayFetch(nodeId, next, nextInit, hops + 1);
  }
  const responseHeaders = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  const empty = NULL_BODY.has(status) || method === "HEAD";
  if (empty) response.resume();
  return new Response(empty ? null : Readable.toWeb(response) as ReadableStream, { status, statusText: response.statusMessage, headers: responseHeaders });
}

/** `new WebSocket(url, options)` for a peer, through a relay when that is the way to reach it. */
export function peerWebSocket(address: string | URL, options: ClientOptions = {}, peerId?: string): WebSocket {
  const url = new URL(address);
  const httpUrl = new URL(url);
  httpUrl.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const route = chooseRoute(httpUrl, peerId);
  const cachedProbe = probes.get(httpUrl.origin);
  const probedDown = Boolean(cachedProbe && !cachedProbe.pending && cachedProbe.until > Date.now() && !cachedProbe.ok);
  if (route.kind === "direct" && !(route.nodeId && probedDown && runtime?.hasRoute(route.nodeId))) {
    const socket = new WebSocket(url, options);
    if (route.nodeId && runtime?.hasRoute(route.nodeId)) {
      // The caller retries a failed socket; make the retry use the relay if the direct path is down.
      socket.once("error", (error) => { if (CONNECT_FAILURES.has(String((error as { code?: unknown }).code))) markDirectFailed(httpUrl.origin); });
      void directReachable(httpUrl);
    }
    return socket;
  }
  // An unreachable peer fails the way an unreachable host does, through the socket's error event.
  const nodeId = route.nodeId!;
  return new WebSocket(url, {
    ...options,
    createConnection: () => {
      if (!runtime) throw new Error("Relays are not running");
      return runtime.openStream(nodeId, "peer") as unknown as Socket;
    },
  });
}

/** Whether a peer is reached through a relay right now (for Syncthing tunnels and the UI). */
export function peerUsesRelay(nodeId: string, peerUrl: string | undefined): boolean {
  if (!runtime || !runtime.hasRoute(nodeId)) return false;
  if (!peerUrl || virtualRelayNodeId(peerUrl)) return true;
  try { return directFailedRecently(new URL(peerUrl).origin); } catch { return true; }
}

export function resetDirectFailures(): void { directFailedUntil.clear(); probes.clear(); }

export { virtualRelayUrl };
export type { RelayStream };
