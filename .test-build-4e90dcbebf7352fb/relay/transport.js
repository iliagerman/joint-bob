import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { virtualRelayNodeId, virtualRelayUrl } from "./protocol.js";
const DIRECT_RETRY_MS = 5 * 6e4;
const PROBE_TIMEOUT_MS = 3e3;
const CONNECT_FAILURES = /* @__PURE__ */ new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const REDIRECTS = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
const NULL_BODY = /* @__PURE__ */ new Set([101, 103, 204, 205, 304]);
let runtime;
const directFailedUntil = /* @__PURE__ */ new Map();
const agents = /* @__PURE__ */ new Map();
function setRelayTransport(active) {
  runtime = active;
  directFailedUntil.clear();
  probes.clear();
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}
function activeRelayRuntime() {
  return runtime;
}
function chooseRoute(url, peerId) {
  const virtual = virtualRelayNodeId(url);
  if (virtual) {
    if (peerId && peerId !== virtual) return { kind: "unreachable", nodeId: peerId };
    return runtime ? { kind: "relay", nodeId: virtual } : { kind: "unreachable", nodeId: virtual };
  }
  if (!peerId || !runtime?.hasAnyRelay()) return { kind: "direct" };
  runtime.ensureWatched(peerId);
  if (directFailedRecently(url.origin) && runtime.hasRoute(peerId)) return { kind: "relay", nodeId: peerId };
  return { kind: "direct", nodeId: peerId };
}
function directFailedRecently(origin) {
  return (directFailedUntil.get(origin) ?? 0) > Date.now();
}
function markDirectFailed(origin) {
  const fresh = !directFailedRecently(origin);
  directFailedUntil.set(origin, Date.now() + DIRECT_RETRY_MS);
  if (fresh) runtime?.changed();
}
function markDirectWorked(origin) {
  if (directFailedUntil.delete(origin)) runtime?.changed();
  probes.set(origin, { ok: true, until: Date.now() + DIRECT_RETRY_MS });
}
const probes = /* @__PURE__ */ new Map();
function directReachable(url) {
  const cached = probes.get(url.origin);
  if (cached?.pending) return cached.pending;
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.ok);
  const pending = new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
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
function isConnectFailure(error) {
  if (!(error instanceof TypeError) || error.message !== "fetch failed") return false;
  const cause = error.cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === "string" && CONNECT_FAILURES.has(code);
}
function replayable(body) {
  return body === void 0 || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof URLSearchParams;
}
async function peerFetch(input, init = {}, peerId) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") return fetch(input, init);
  const route = chooseRoute(url, peerId);
  if (route.kind === "relay") return relayFetch(route.nodeId, url, init, 0);
  if (route.kind === "unreachable") throw new TypeError("fetch failed", { cause: Object.assign(new Error("No relay can reach that machine right now"), { code: "ERELAYUNREACHABLE" }) });
  const relayed = route.nodeId && runtime?.hasRoute(route.nodeId) ? route.nodeId : void 0;
  if (relayed && !await directReachable(url)) return relayFetch(relayed, url, init, 0);
  try {
    const response = await fetch(input, init);
    if (route.nodeId) markDirectWorked(url.origin);
    return response;
  } catch (error) {
    const nodeId = route.nodeId;
    if (!nodeId || !runtime?.hasRoute(nodeId)) throw error;
    if (isConnectFailure(error) || error instanceof Error && error.name === "TimeoutError") markDirectFailed(url.origin);
    if (init.signal?.aborted || !isConnectFailure(error) || !replayable(init.body)) throw error;
    return relayFetch(nodeId, url, init, 0);
  }
}
class RelayAgent extends http.Agent {
  constructor(nodeId) {
    super({ keepAlive: true, maxSockets: 16, maxFreeSockets: 4, timeout: 4e3 });
    this.nodeId = nodeId;
  }
  nodeId;
  createConnection() {
    if (!runtime) throw new Error("Relays are not running");
    return runtime.openStream(this.nodeId, "peer");
  }
}
function agentFor(nodeId) {
  let agent = agents.get(nodeId);
  if (!agent) {
    agent = new RelayAgent(nodeId);
    agents.set(nodeId, agent);
  }
  return agent;
}
async function relayFetch(nodeId, url, init, hops) {
  const signal = init.signal ?? void 0;
  if (signal?.aborted) throw signal.reason;
  const method = (init.method ?? "GET").toUpperCase();
  const normalized = new Request(url, { method, headers: init.headers, body: init.body, duplex: "half" });
  const headers = {};
  normalized.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers.host = url.host;
  let buffered;
  if (typeof init.body === "string") buffered = Buffer.from(init.body);
  else if (init.body instanceof Uint8Array) buffered = Buffer.from(init.body);
  else if (init.body instanceof ArrayBuffer) buffered = Buffer.from(new Uint8Array(init.body));
  if (buffered) headers["content-length"] = String(buffered.length);
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ agent: agentFor(nodeId), host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), method, path: `${url.pathname}${url.search}`, headers });
    const abort = () => {
      request.destroy(signal?.reason);
      reject(signal?.reason);
    };
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
    else if (normalized.body) Readable.fromWeb(normalized.body).pipe(request);
    else request.end();
  });
  const status = response.statusCode ?? 502;
  const location = response.headers.location;
  if (REDIRECTS.has(status) && location && init.redirect !== "manual") {
    response.resume();
    if (init.redirect === "error" || hops >= 5) throw new TypeError("fetch failed", { cause: new Error("Unexpected redirect") });
    const next = new URL(location, url);
    const switchToGet = status === 303 || (status === 301 || status === 302) && method === "POST";
    const nextInit = { ...init, ...switchToGet ? { method: "GET", body: void 0 } : {} };
    if (next.origin !== url.origin) throw new TypeError("fetch failed", { cause: new Error("Cross-origin redirect from a peer") });
    return relayFetch(nodeId, next, nextInit, hops + 1);
  }
  const responseHeaders = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  const empty = NULL_BODY.has(status) || method === "HEAD";
  if (empty) response.resume();
  return new Response(empty ? null : Readable.toWeb(response), { status, statusText: response.statusMessage, headers: responseHeaders });
}
function peerWebSocket(address, options = {}, peerId) {
  const url = new URL(address);
  const httpUrl = new URL(url);
  httpUrl.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const route = chooseRoute(httpUrl, peerId);
  const cachedProbe = probes.get(httpUrl.origin);
  const probedDown = Boolean(cachedProbe && !cachedProbe.pending && cachedProbe.until > Date.now() && !cachedProbe.ok);
  if (route.kind === "direct" && !(route.nodeId && probedDown && runtime?.hasRoute(route.nodeId))) {
    const socket = new WebSocket(url, options);
    if (route.nodeId && runtime?.hasRoute(route.nodeId)) {
      socket.once("error", (error) => {
        if (CONNECT_FAILURES.has(String(error.code))) markDirectFailed(httpUrl.origin);
      });
      void directReachable(httpUrl);
    }
    return socket;
  }
  const nodeId = route.nodeId;
  return new WebSocket(url, {
    ...options,
    createConnection: () => {
      if (!runtime) throw new Error("Relays are not running");
      return runtime.openStream(nodeId, "peer");
    }
  });
}
function peerUsesRelay(nodeId, peerUrl) {
  if (!runtime || !runtime.hasRoute(nodeId)) return false;
  if (!peerUrl || virtualRelayNodeId(peerUrl)) return true;
  try {
    return directFailedRecently(new URL(peerUrl).origin);
  } catch {
    return true;
  }
}
function resetDirectFailures() {
  directFailedUntil.clear();
  probes.clear();
}
export {
  activeRelayRuntime,
  isConnectFailure,
  peerFetch,
  peerUsesRelay,
  peerWebSocket,
  resetDirectFailures,
  setRelayTransport,
  virtualRelayUrl
};
