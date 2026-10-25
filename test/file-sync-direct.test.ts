import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FilesService } from "../src/file-sync/core.js";
import { FileSyncDb, fileSyncDbPath } from "../src/file-sync/db.js";
import { tailnetAddresses } from "../src/file-sync/control.js";
import { DirectListener, DirectTransport, MAX_BODY_BYTES, type NonceStore } from "../src/file-sync/direct.js";
import type { FilesEndpoint, RelayedRequest, ServeAnswer } from "../src/file-sync/protocol.js";
import { NONCE_TTL_MS, signRequest } from "../src/file-sync/signing.js";
import { systemClock } from "../src/file-sync/types.js";
import { createInThreadWorker } from "../src/file-sync/worker.js";

const PEER = randomUUID();
const SELF = randomUUID();
const STRANGER = randomUUID();
const peerKeys = generateKeyPairSync("ed25519");
const strangerKeys = generateKeyPairSync("ed25519");
const selfKeys = generateKeyPairSync("ed25519");
const pem = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jb-fs-direct-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** file-sync.db's real nonces table, as the worker uses it. */
function databaseNonces(t: TestContext): NonceStore {
  const db = new FileSyncDb(fileSyncDbPath(temporaryDirectory(t)), SELF);
  t.after(() => db.close());
  return { consume: (sender, nonce, now) => db.consumeNonce(sender, nonce, now, NONCE_TTL_MS) };
}

interface Served { peer: string; endpoint: FilesEndpoint; query: Record<string, string>; body: unknown; range?: string }

async function listener(t: TestContext, answer: (call: Served) => ServeAnswer | Promise<ServeAnswer> = () => ({ status: 200, headers: {}, json: { ok: true } }), now?: () => number) {
  const calls: Served[] = [];
  const service: FilesService = { serve: async (peer, endpoint, query, body, range) => { const call = { peer, endpoint, query, body, ...(range ? { range } : {}) }; calls.push(call); return answer(call); } };
  const direct = new DirectListener({ nodeId: SELF, service: () => service, nonces: (() => { const store = databaseNonces(t); return () => store; })(), publicKeyFor: (peer) => peer === PEER ? peerKeys.publicKey : undefined, ...(now ? { now } : {}) });
  t.after(() => direct.close());
  const [origin] = await direct.listen(["127.0.0.1"], 0);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  return { direct, origin, calls };
}

function signed(origin: string, method: "GET" | "POST", target: string, options: { json?: unknown; key?: KeyObject; sender?: string; recipient?: string; now?: number; headers?: Record<string, string>; authorization?: string } = {}): { send(): Promise<Response>; authorization: string } {
  const body = method === "POST" ? Buffer.from(JSON.stringify(options.json ?? {})) : Buffer.alloc(0);
  const authorization = options.authorization ?? signRequest(options.key ?? peerKeys.privateKey, options.sender ?? PEER, options.recipient ?? SELF, method, target, body, options.now ?? Date.now());
  return {
    authorization,
    send: () => fetch(new URL(target, origin), { method, headers: { ...options.headers, authorization, ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body } : {}) }),
  };
}

async function* bytes(total: number, chunk = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let sent = 0; sent < total; sent += chunk) yield new Uint8Array(Math.min(chunk, total - sent)).fill(sent / chunk % 251);
}

test("a signed request from a configured peer reaches the FilesService with the verified sender, endpoint, query, body and range", async (t) => {
  const { origin, calls } = await listener(t, (call) => call.endpoint === "file"
    ? { status: 206, headers: { "content-type": "application/octet-stream", "content-range": "bytes 10-200009/300000", "content-length": "200000" }, body: bytes(200_000) }
    : { status: 200, headers: {}, json: { endpoint: call.endpoint } });
  const index = await signed(origin, "GET", "/api/cluster/v2/files/index?projectId=p1&kind=project&since=7&since=8").send();
  assert.equal(index.status, 200);
  assert.deepEqual(await index.json(), { endpoint: "index" });
  const file = await signed(origin, "POST", "/api/cluster/v2/files/file", { json: { projectId: "p1", kind: "project", path: ".env.example", sha256: "a".repeat(64) }, headers: { range: "bytes=10-" } }).send();
  assert.equal(file.status, 206);
  assert.equal(file.headers.get("content-range"), "bytes 10-200009/300000");
  assert.equal((await file.arrayBuffer()).byteLength, 200_000);
  assert.deepEqual(calls, [
    { peer: PEER, endpoint: "index", query: { projectId: "p1", kind: "project", since: "7" }, body: undefined },
    { peer: PEER, endpoint: "file", query: {}, body: { projectId: "p1", kind: "project", path: ".env.example", sha256: "a".repeat(64) }, range: "bytes=10-" },
  ]);
});

test("a request that fails authentication is answered 401 and never reaches the service", async (t) => {
  const { origin, calls } = await listener(t);
  const target = "/api/cluster/v2/files/status";
  const unauthorized = async (response: Promise<Response>, why: string) => {
    const answer = await response;
    assert.equal(answer.status, 401, why);
    assert.deepEqual(await answer.json(), { error: "Unauthorized" }, why);
  };
  await unauthorized(signed(origin, "POST", target, { key: strangerKeys.privateKey }).send(), "signed with another key");
  await unauthorized(signed(origin, "POST", target, { recipient: STRANGER }).send(), "signed for another node");
  await unauthorized(signed(origin, "POST", target, { now: Date.now() - 61_000 }).send(), "signed 61 s ago");
  await unauthorized(signed(origin, "POST", target, { key: strangerKeys.privateKey, sender: STRANGER }).send(), "from a node that is not a configured peer");
  await unauthorized(fetch(new URL(target, origin), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), "unsigned");
  const tampered = signed(origin, "POST", target, { json: { projectId: "p1" } });
  await unauthorized(fetch(new URL(target, origin), { method: "POST", headers: { authorization: tampered.authorization, "content-type": "application/json" }, body: JSON.stringify({ projectId: "p2" }) }), "body changed after signing");
  assert.equal(calls.length, 0);
  const once = signed(origin, "POST", target, { json: { projectId: "p1" } });
  assert.equal((await once.send()).status, 200);
  await unauthorized(once.send(), "the same request replayed");
  assert.equal(calls.length, 1);
});

test("only the files endpoints exist on the direct listener, each with its own method", async (t) => {
  const { origin, calls } = await listener(t);
  for (const [method, target] of [["GET", "/api/health"], ["GET", "/api/cluster/v2/hello"], ["POST", "/api/cluster/v2/files/enroll"], ["POST", "/api/cluster/v2/files/shares"], ["GET", "/api/cluster/v2/files/fetch"], ["GET", "/api/cluster/v2/files/"]] as const) {
    const response = await signed(origin, method, target).send();
    assert.equal(response.status, 404, `${method} ${target}`);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
  assert.equal(calls.length, 0);
});

test("a body over 1 MiB is refused with 413 before anything else is done with it", async (t) => {
  const { origin, calls } = await listener(t);
  const target = "/api/cluster/v2/files/changed";
  const body = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
  const response = await fetch(new URL(target, origin), { method: "POST", headers: { "content-type": "application/json", authorization: signRequest(peerKeys.privateKey, PEER, SELF, "POST", target, body) }, body });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "File sync request body is too large" });
  assert.equal(calls.length, 0);
  // At the limit it is read and checked as usual.
  const fits = Buffer.from(JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES - 20) }));
  assert.ok(fits.length <= MAX_BODY_BYTES);
  const accepted = await fetch(new URL(target, origin), { method: "POST", headers: { "content-type": "application/json", authorization: signRequest(peerKeys.privateKey, PEER, SELF, "POST", target, fits) }, body: fits });
  assert.equal(accepted.status, 200);
  assert.equal(calls.length, 1);
});

test("the listener takes the next free port when its own is in use, and never binds a wildcard address", async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const taken = (blocker.address() as net.AddressInfo).port;
  const direct = new DirectListener({ nodeId: SELF, service: () => undefined, nonces: () => ({ consume: () => true }), publicKeyFor: () => undefined, log: () => undefined });
  t.after(() => direct.close());
  const [origin] = await direct.listen(["127.0.0.1"], taken);
  const port = Number(new URL(origin).port);
  assert.ok(port > taken && port < taken + 10, `bound ${port} after ${taken}`);
  const answer = await fetch(new URL("/api/cluster/v2/files/shares", origin));
  assert.equal(answer.status, 401, "the listener on the fallback port answers");
  assert.deepEqual(await direct.listen(["127.0.0.1"], taken), [origin], "the same request keeps the bound server");
  assert.deepEqual(await direct.listen(["0.0.0.0", "::"], 22_700), []);
  await assert.rejects(fetch(new URL("/api/cluster/v2/files/shares", origin)), "the old server is closed");
});

test("listen addresses are this machine's Tailscale IPv4 addresses only", () => {
  const info = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as os.NetworkInterfaceInfo;
  assert.deepEqual(tailnetAddresses({
    lo0: [info("127.0.0.1", "IPv4", true)],
    en0: [info("192.168.1.20"), info("fe80::1", "IPv6")],
    utun4: [info("100.101.102.103"), info("fd7a:115c:a1e0::1", "IPv6")],
    tailscale0: [info("100.64.0.1"), info("100.127.255.254")],
    other: [info("100.63.255.255"), info("100.128.0.1"), info("10.0.0.1")],
  }), ["100.101.102.103", "100.127.255.254", "100.64.0.1"]);
});

test("the transport signs for the peer, prefers the origin that answered and leaves a failed one alone for five minutes", async (t) => {
  let now = Date.now();
  // The listener shares the transport's clock, so moving it past the backoff keeps signatures fresh.
  const { origin: good, calls } = await listener(t, undefined, () => now);
  const closed = await freeOrigin();
  const tried: string[] = [];
  const relayed: RelayedRequest[] = [];
  const transport = new DirectTransport({
    nodeId: PEER, now: () => now, relay: async (_peer, request) => { relayed.push(request); throw new Error("no relay in this test"); },
    fetch: (input, init) => { tried.push(new URL(String(input)).origin); return fetch(input, init); },
  });
  transport.setSigningKey(peerKeys.privateKey);
  transport.setPeers([{ nodeId: SELF, publicKey: pem(selfKeys.publicKey), origins: [closed, good], present: true }]);
  assert.equal(transport.route(SELF), "none");
  const first = await transport.request(SELF, { method: "POST", target: "/api/cluster/v2/files/status", json: { projectId: "p1" }, purpose: "status" });
  assert.equal(first.status, 200);
  for await (const _chunk of first.body) { /* drain */ }
  assert.deepEqual(tried, [closed, good]);
  assert.equal(transport.route(SELF), "direct");
  assert.deepEqual(calls.map((call) => [call.peer, call.endpoint, call.body]), [[PEER, "status", { projectId: "p1" }]]);
  tried.length = 0;
  await drain(await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" }));
  assert.deepEqual(tried, [good], "the origin that worked goes first and the failed one is not retried");
  now += 5 * 60_000 + 1;
  tried.length = 0;
  await drain(await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" }));
  assert.deepEqual(tried, [good], "a working origin stays first after the backoff");
  assert.equal(relayed.length, 0);
});

test("with no direct origin answering, the request goes through the worker's relay channel to main and its answer streams back", async (t) => {
  const dir = temporaryDirectory(t);
  const relayRequests: Array<{ id: number; peer: string; request: RelayedRequest }> = [];
  const worker = createInThreadWorker({
    nodeId: SELF, dataDir: path.join(dir, "data"), clock: systemClock, random: Math.random, watch: false,
    onEvent: (event) => { if (event.event === "relayRequest") relayRequests.push(event); },
  });
  t.after(() => worker.stop());
  const closed = await freeOrigin();
  const port = Number(new URL(await freeOrigin()).port);
  const configured = await worker.call("configure", {
    enabled: true, hostId: "host", signingKey: selfKeys.privateKey, listen: { addresses: ["127.0.0.1"], port }, shares: [],
    // Away: the core's own sync layer leaves the peer alone, so only this test's requests are relayed.
    peers: [{ nodeId: PEER, publicKey: pem(peerKeys.publicKey), origins: [closed], present: false }], records: { engines: [], settings: [] },
  });
  assert.equal(configured.origins.length, 1, "configure reports the listener's origin");
  assert.ok(Number(new URL(configured.origins[0]).port) >= port);
  assert.deepEqual(worker.events.find((event) => event.event === "ready"), { event: "ready", origins: configured.origins });
  const transport = worker.adapter.network.transport;
  const relayed = (target: string) => relayRequests.find((event) => event.request.target === target);
  const pending = transport.request(PEER, { method: "POST", target: "/api/cluster/v2/files/changed?test=notice", json: { shares: [] }, purpose: "notice" });
  await until(() => relayed("/api/cluster/v2/files/changed?test=notice") !== undefined);
  const notice = relayed("/api/cluster/v2/files/changed?test=notice")!;
  assert.deepEqual(notice, { event: "relayRequest", id: notice.id, peer: PEER, request: { method: "POST", target: "/api/cluster/v2/files/changed?test=notice", json: { shares: [] }, purpose: "notice" } });
  const id = notice.id;
  worker.deliver({ relayResponse: id, status: 202, headers: { "content-type": "application/json" } });
  const response = await pending;
  assert.equal(response.status, 202);
  assert.equal(transport.route(PEER), "relay");
  const first = new TextEncoder().encode('{"ok"').buffer as ArrayBuffer;
  const second = new TextEncoder().encode(":true}").buffer as ArrayBuffer;
  const reader = response.body[Symbol.asyncIterator]();
  worker.deliver({ relayChunk: id, chunk: first }, [first]);
  assert.equal(first.byteLength, 0, "the chunk was transferred, not copied");
  const head = await reader.next();
  assert.deepEqual(worker.relayControls.filter((message) => "relayAck" in message && message.relayAck === id), [{ relayAck: id, bytes: 5 }], "the reader acknowledged what it took");
  worker.deliver({ relayChunk: id, chunk: second }, [second]);
  worker.deliver({ relayEnd: id });
  const rest = await reader.next();
  assert.equal((await reader.next()).done, true);
  assert.deepEqual(JSON.parse(Buffer.concat([Buffer.from(head.value!), Buffer.from(rest.value!)]).toString()), { ok: true });
  // A relay failure reaches the caller as the transport's error.
  const failing = transport.request(PEER, { method: "GET", target: "/api/cluster/v2/files/shares?test=failing", purpose: "shares" });
  await until(() => relayed("/api/cluster/v2/files/shares?test=failing") !== undefined);
  worker.deliver({ relayError: relayed("/api/cluster/v2/files/shares?test=failing")!.id, message: "Cluster peer is unreachable", code: "unreachable" });
  await assert.rejects(failing, (error: Error & { code?: string }) => error.message === "Cluster peer is unreachable" && error.code === "unreachable");
  assert.equal(transport.route(PEER), "none");
});

test("the stall guard gives up a body that stops moving, and an origin that never answers falls back to the relay", async (t) => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    if (request.url?.includes("since=hang")) return;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(1000));
  });
  server.on("connection", (socket) => { sockets.add(socket); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const relayed: RelayedRequest[] = [];
  const transport = new DirectTransport({ nodeId: PEER, stallMs: 300, relay: async (_peer, request) => { relayed.push(request); return { status: 200, headers: {}, body: (async function* () { yield new Uint8Array([1]); })() }; } });
  transport.setSigningKey(peerKeys.privateKey);
  transport.setOrigins(SELF, [origin]);
  const response = await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/index?since=0", purpose: "index" });
  const started = Date.now();
  let received = 0;
  await assert.rejects(async () => { for await (const chunk of response.body) received += chunk.byteLength; }, (error: Error) => error.name === "TimeoutError" && /stalled/.test(error.message));
  assert.equal(received, 1000);
  assert.ok(Date.now() - started < 5_000, "gave up soon after the bytes stopped");
  assert.equal(transport.route(SELF), "direct");
  transport.resetBackoff();
  const fallback = await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/index?since=hang", purpose: "index" });
  assert.equal(fallback.status, 200);
  assert.deepEqual(relayed.map((request) => request.target), ["/api/cluster/v2/files/index?since=hang"]);
  assert.equal(transport.route(SELF), "relay");
});

test("an origin answering 401 or 404 is not the peer: the request goes through the relay and the origin rests", async (t) => {
  // Another node's listener (it does not know our key) and some other service on a stale address.
  const { origin: stranger } = await listener(t);
  const other = http.createServer((_request, response) => { response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"Not found"}'); });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => other.close(() => resolve())));
  const elsewhere = `http://127.0.0.1:${(other.address() as net.AddressInfo).port}`;
  const relayed: RelayedRequest[] = [];
  const tried: string[] = [];
  const transport = new DirectTransport({
    nodeId: STRANGER, relay: async (_peer, request) => { relayed.push(request); return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode("{}"); })() }; },
    fetch: (input, init) => { tried.push(new URL(String(input)).origin); return fetch(input, init); },
  });
  transport.setSigningKey(peerKeys.privateKey);
  transport.setOrigins(SELF, [stranger, elsewhere]);
  const response = await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" });
  assert.equal(response.status, 200);
  assert.equal(response.route, "relay");
  await drain(response);
  assert.deepEqual(tried, [stranger, elsewhere]);
  assert.equal(relayed.length, 1);
  assert.equal(transport.route(SELF), "relay");
  tried.length = 0;
  await drain(await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" }));
  assert.deepEqual(tried, [], "both origins rest for five minutes");
});

test("a relay failure main marks as away stops direct attempts until the peer is reported back; via relay never tries an origin", async (t) => {
  const { origin, calls } = await listener(t);
  let away = true;
  const relayed: RelayedRequest[] = [];
  const tried: string[] = [];
  const transport = new DirectTransport({
    nodeId: PEER, retryMs: 0,
    relay: async (_peer, request) => {
      relayed.push(request);
      if (away) throw Object.assign(new Error("Cluster peer is unreachable"), { code: "unreachable", away: true });
      return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode("{}"); })() };
    },
    fetch: (input, init) => { tried.push(new URL(String(input)).origin); if (away) return Promise.reject(new TypeError("fetch failed")); return fetch(input, init); },
  });
  transport.setSigningKey(peerKeys.privateKey);
  transport.setOrigins(SELF, [origin]);
  await assert.rejects(transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" }), (error: Error & { away?: boolean }) => error.away === true);
  assert.deepEqual(tried, [origin]);
  tried.length = 0;
  await assert.rejects(transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" }));
  assert.deepEqual(tried, [], "no connection attempt to a peer main has as away, even with its origin's backoff over");
  away = false;
  transport.resetBackoff(SELF);
  const back = await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares" });
  assert.equal(back.route, "direct");
  await drain(back);
  assert.deepEqual(tried, [origin]);
  tried.length = 0;
  const viaRelay = await transport.request(SELF, { method: "GET", target: "/api/cluster/v2/files/shares", purpose: "shares", via: "relay" });
  assert.equal(viaRelay.route, "relay");
  await drain(viaRelay);
  assert.deepEqual(tried, [], "an answer that must be authenticated never comes from a direct origin");
  assert.equal(calls.length, 1);
});

async function freeOrigin(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function drain(response: { body: AsyncIterable<Uint8Array> }): Promise<void> {
  for await (const _chunk of response.body) { /* drain */ }
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `condition not met within ${timeoutMs} ms`);
}
