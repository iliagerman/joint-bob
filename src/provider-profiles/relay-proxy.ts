import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import type { PoolProfileContext } from "./context.js";
import { PoolAttemptFailure } from "./pool-execution.js";
import type { ProviderProfile } from "./store.js";

/**
 * A relay pool's sign-ins never leave the relay. A turn on a member machine sends each provider
 * request to a loopback proxy here, which hands it to the relay over the signed machine channel.
 * The relay adds its own sign-in, sends it to the provider and streams the answer back.
 */
export const RELAY_PROXY_PATH = "/api/cluster/v2/subscription-pools/proxy";
/** Machine request bodies are JSON capped at 56 MB, and base64 grows a body by a third. */
export const MAX_PROXIED_BODY_BYTES = 40 * 1024 * 1024;
type ProxiedProvider = "claude" | "openai-codex";
/** Only the model routes a turn uses: never sign-in or account routes, which could mint a lasting key. */
const PROVIDER_ROUTES: Record<ProxiedProvider, { origin: string; paths: string[] }> = {
  claude: { origin: "https://api.anthropic.com", paths: ["/v1/messages", "/v1/messages/count_tokens"] },
  "openai-codex": { origin: "https://chatgpt.com", paths: ["/backend-api/codex/responses"] },
};
const CODEX_CLAIM = "https://api.openai.com/auth";
/** Headers that belong to one connection or carry credentials; neither crosses the proxy. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "host", "content-length",
  "proxy-authorization", "proxy-connection", "authorization", "x-api-key", "cookie", "set-cookie", "accept-encoding", "content-encoding", "chatgpt-account-id"]);

const idSchema = z.string().uuid();
export const relayProxyRequestSchema = z.object({
  clusterId: idSchema, poolId: idSchema, profileId: idSchema,
  /** Absent: only check that the relay would serve this member now. */
  request: z.object({
    path: z.string().startsWith("/").max(2048),
    headers: z.record(z.string(), z.string().max(16_384)).refine((headers) => Object.keys(headers).length <= 100),
    body: z.string().max(Math.ceil(MAX_PROXIED_BODY_BYTES / 3) * 4),
  }).strict().optional(),
}).strict();
export type RelayProxiedRequest = NonNullable<z.infer<typeof relayProxyRequestSchema>["request"]>;

export function isProxiedProvider(provider: string): provider is ProxiedProvider {
  return provider === "claude" || provider === "openai-codex";
}

function forwardedHeaders(source: Iterable<[string, string | string[] | undefined]>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of source) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_HEADERS.has(key) || key.startsWith("proxy-")) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function codexAccountId(access: string): string {
  const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
  const accountId = payload[CODEX_CLAIM]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) throw new Error("The ChatGPT sign-in names no account");
  return accountId;
}

/** Only a provider's model routes are sent on; sign-in and account routes never are. */
export function isModelRoute(provider: ProxiedProvider, path: string, origin = PROVIDER_ROUTES[provider].origin): boolean {
  const target = new URL(path, origin);
  return target.origin === new URL(origin).origin && PROVIDER_ROUTES[provider].paths.includes(target.pathname);
}

/** On the relay: one member request sent on to the provider with the relay's own sign-in. */
export async function forwardToProvider(provider: ProxiedProvider, access: string, request: RelayProxiedRequest, signal: AbortSignal,
  origin = PROVIDER_ROUTES[provider].origin): Promise<Response> {
  if (!isModelRoute(provider, request.path, origin)) throw new RelayRouteRefused(`${request.path} is not a model route the relay sends on`);
  const target = new URL(request.path, origin);
  const headers = { ...forwardedHeaders(Object.entries(request.headers)), authorization: `Bearer ${access}`,
    ...(provider === "openai-codex" ? { "chatgpt-account-id": codexAccountId(access) } : {}) };
  return fetch(target, { method: "POST", headers, body: Buffer.from(request.body, "base64"), redirect: "error", signal });
}
export class RelayRouteRefused extends Error {}

/** Copies a streamed answer, status and headers included, onto a waiting HTTP response. */
export async function streamAnswer(answer: Response, response: http.ServerResponse): Promise<void> {
  response.statusCode = answer.status;
  for (const [name, value] of Object.entries(forwardedHeaders(answer.headers))) response.setHeader(name, value);
  if (!answer.body) { response.end(); return; }
  try { await pipeline(Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream), response); }
  catch { response.destroy(); }
}

/** A placeholder lasts as long as one long Claude turn can; the relay also re-checks the machine on every request. */
const LEASE_MS = 6 * 60 * 60_000;
interface Lease { context: PoolProfileContext; provider: ProxiedProvider; expires: number }
/** Placeholder token → the pool member it stands for. A placeholder only works on this machine's loopback proxy. */
const leases = new Map<string, Lease>();
const memberLeases = new Map<string, string>();
let proxyPort: Promise<number> | undefined;

function placeholderToken(provider: ProxiedProvider): string {
  const secret = randomBytes(32).toString("base64url");
  if (provider === "claude") return `sk-ant-oat01-${secret}`;
  // Pi reads the ChatGPT account from the token; the relay replaces it with the real one.
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ [CODEX_CLAIM]: { chatgpt_account_id: "joint-bob-relay" } })}.${secret}`;
}

async function sendToRelay(context: PoolProfileContext, request: RelayProxiedRequest | undefined, signal: AbortSignal): Promise<Response> {
  const { signedFetch } = await import("../server/cluster-v2.js");
  const local = await getClusterNode(), db = await clusterV2Database();
  return signedFetch(db, local.id, context.poolOwnerNodeId!, context.clusterId!, RELAY_PROXY_PATH,
    { clusterId: context.clusterId, poolId: context.poolId, profileId: context.profileId, ...(request ? { request } : {}) }, signal);
}

async function readBody(request: http.IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PROXIED_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function refuse(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }));
}

async function proxyToRelay(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  // Claude checks it can reach its API before a turn.
  if (request.url === "/api/hello") { response.writeHead(200).end(); return; }
  const lease = leases.get(/^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "");
  if (!lease || lease.expires <= Date.now()) { refuse(response, 401, "Unknown or expired relay proxy token"); return; }
  if (request.method !== "POST") { refuse(response, 405, "Only model requests go through the relay"); return; }
  const body = await readBody(request);
  if (!body) {
    // The rest of the upload is never read, so the connection cannot be kept.
    response.setHeader("connection", "close");
    refuse(response, 413, "The request is too large to send through the relay");
    return;
  }
  const abort = new AbortController();
  response.on("close", () => abort.abort());
  let answer: Response;
  try {
    answer = await sendToRelay(lease.context, { path: request.url ?? "/", headers: forwardedHeaders(Object.entries(request.headers)), body: body.toString("base64") }, abort.signal);
  } catch {
    refuse(response, 503, `The relay holding ${lease.context.label} cannot be reached`);
    return;
  }
  await streamAnswer(answer, response);
}

function startProxy(): Promise<number> {
  proxyPort ??= new Promise<number>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      proxyToRelay(request, response).catch(() => { if (!response.headersSent) refuse(response, 502, "The relay proxy failed"); else response.destroy(); });
    });
    server.once("error", (error) => { proxyPort = undefined; reject(error); });
    server.listen(0, "127.0.0.1", () => { server.unref(); resolve((server.address() as AddressInfo).port); });
  });
  return proxyPort;
}

async function relayRefusal(answer: Response): Promise<string> {
  try { return String((await answer.json() as { error?: unknown }).error ?? answer.status); } catch { return String(answer.status); }
}

/**
 * The credential for a turn on a relay pool member this machine has no sign-in for: a placeholder
 * token and the loopback proxy that trades it for the relay's sign-in, request by request.
 * The relay is asked first, so an unusable member hands over to the next before the turn starts.
 */
export async function relayProxyCredential(profile: ProviderProfile, context: PoolProfileContext) {
  if (!context.clusterId || !context.poolOwnerNodeId) throw new Error("Cluster pool credential route is incomplete");
  if (!isProxiedProvider(profile.provider)) throw new PoolAttemptFailure("unavailable", false, `${profile.label} cannot be used through the relay`);
  let ready: Response;
  try { ready = await sendToRelay(context, undefined, AbortSignal.timeout(10_000)); }
  catch (error) { throw new PoolAttemptFailure("unavailable", false, `The relay holding ${profile.label} cannot be reached`, { cause: error }); }
  if (!ready.ok) {
    throw new PoolAttemptFailure(ready.status === 503 ? "unavailable" : "auth", false, `Could not use ${profile.label} through the relay: ${await relayRefusal(ready)}`);
  }
  await ready.arrayBuffer();
  const port = await startProxy();
  const key = JSON.stringify([context.clusterId, context.poolOwnerNodeId, context.poolId, context.profileId]);
  const held = memberLeases.has(key) ? leases.get(memberLeases.get(key)!) : undefined;
  let lease = held && held.expires > Date.now() ? held : undefined;
  if (!lease) {
    const access = placeholderToken(profile.provider);
    lease = { context: { ...context, profile: undefined }, provider: profile.provider, expires: Date.now() + LEASE_MS };
    leases.set(access, lease);
    memberLeases.set(key, access);
  }
  const access = memberLeases.get(key)!;
  const base = `http://127.0.0.1:${port}`;
  return { type: "oauth" as const, access, refresh: "" as const, expires: lease.expires,
    proxyBaseUrl: profile.provider === "claude" ? base : `${base}/backend-api` };
}
