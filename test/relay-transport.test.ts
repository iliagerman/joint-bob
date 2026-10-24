// The relay core in one process: a relay and three machines, each with its own node
// database and identity, talking over real WebSockets on loopback (RELAY-PLAN.md §9).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { FRAME_DATA, decodeFrame, encodeControl, pairingCode, virtualRelayUrl } from "../src/relay/protocol.js";
import { RelayServer } from "../src/relay/relay-server.js";
import { RelayRuntime } from "../src/relay/runtime.js";
import { createRelayToken, ensureRelaySchema, lastPeerRoutes, listMemberships, listRelayTransportEvents, recordRelayTransportEvent, relayMachine, saveServingSettings } from "../src/relay/store.js";
import { ChannelHub } from "../src/relay/hub.js";
import { RelayStream, relayPeerOf } from "../src/relay/stream.js";
import { peerFetch, peerWebSocket, setRelayTransport } from "../src/relay/transport.js";
import { WebSocketServer } from "ws";
import { SyncthingTunnels } from "../src/relay/syncthing-tunnels.js";
import { ensurePeerEndpointSchema } from "../src/cluster-peer-endpoints.js";
import net from "node:net";
import { clusterPublicKeyFingerprint } from "../src/cluster-identity.js";
import { setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { onRelayPeersChanged } from "../src/relay/events.js";

interface Machine {
  name: string;
  nodeId: string;
  db: DatabaseSync;
  server: Server;
  runtime: RelayRuntime;
  requests: Array<{ url: string; peer: string | undefined; transport: string | undefined; remoteAddress: string | undefined }>;
}

async function eventually(check: () => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

const root = await mkdtemp(path.join(os.tmpdir(), "relay-transport-"));
const relayDb = new DatabaseSync(path.join(root, "relay.db"));
const relayNodeId = randomUUID();
const relayHttp = http.createServer();
const relayPort = await listen(relayHttp);
const origin = `http://localhost:${relayPort}`;
ensureRelaySchema(relayDb);
saveServingSettings(relayDb, { enabled: true, origin, environment: "test", requestsEnabled: true, maxMachines: 100, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: false });
const relay = new RelayServer(relayDb, relayNodeId, () => "relay node", () => undefined);
relay.reload();
const sessionFrames: Buffer[] = [];
// Record every DATA payload the relay routes, to prove it only ever sees ciphertext.
const route = (relay as unknown as { handleSessionFrame(session: unknown, frame: Buffer): void });
const originalRoute = route.handleSessionFrame.bind(relay);
route.handleSessionFrame = (session, frame) => { if (frame[0] === FRAME_DATA) sessionFrames.push(Buffer.from(frame)); originalRoute(session, frame); };
relayHttp.on("request", (request, response) => { if (!relay.handleRequest(request, response)) response.writeHead(200).end("relay node itself"); });
relayHttp.on("upgrade", (request, socket, head) => { if (!relay.handleUpgrade(request, socket, head)) socket.destroy(); });

const machines: Machine[] = [];
const endlessClosed: string[] = [];
/** `/held` requests stay unanswered until a test lets them through, so a burst overlaps the way a phone's module requests do. */
const held = { now: 0, peak: 0, open: false, waiting: [] as Array<() => void> };
function letHeldThrough(): void {
  held.open = true;
  for (const answer of held.waiting.splice(0)) answer();
}
async function machine(name: string, known: () => string[], overrides: Partial<ConstructorParameters<typeof RelayRuntime>[3]> = {}): Promise<Machine> {
  const nodeId = randomUUID();
  const db = new DatabaseSync(path.join(root, `${nodeId}.db`));
  ensureRelaySchema(db);
  const requests: Machine["requests"] = [];
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url ?? "", peer: relayPeerOf(request.socket)?.nodeId, transport: (request.socket as RelayStream).relayTransport, remoteAddress: request.socket.remoteAddress });
    if (request.url === "/bad-status") {
      // A hostile machine answering its phone gateway with a status Node's server refuses to send.
      request.socket.write("HTTP/1.1 099 Broken\r\nContent-Length: 0\r\n\r\n");
      request.socket.end();
      return;
    }
    if (request.url === "/truncated") {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("partial");
      setImmediate(() => response.destroy());
      return;
    }
    if (request.url === "/endless") {
      request.resume();
      // Streams until the reader goes away; the test checks this side notices.
      const chunk = Buffer.alloc(64 * 1024, 0x62);
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.on("close", () => { endlessClosed.push(name); });
      const write = (): void => { while (!response.destroyed && response.write(chunk)) { /* fill until backpressure */ } if (!response.destroyed) response.once("drain", write); };
      write();
      return;
    }
    if (request.url?.startsWith("/held")) {
      held.now += 1;
      held.peak = Math.max(held.peak, held.now);
      const answer = (): void => { held.now -= 1; response.writeHead(200).end("held"); };
      if (held.open) answer(); else held.waiting.push(answer);
      return;
    }
    if (request.url === "/big") {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      const write = (): void => {
        while (sent < 40) { sent += 1; if (!response.write(chunk)) { response.once("drain", write); return; } }
        response.end();
      };
      write();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ from: name, echo: body, secret: "plaintext-marker-1234" })));
  });
  const ownRelay = new RelayServer(db, nodeId, () => name, () => undefined);
  const runtime = new RelayRuntime(db, nodeId, server, {
    acceptSyncthing: (stream) => stream.end(),
    syncthingAllowed: () => false,
    knownPeers: known,
    peerOnline: () => undefined,
    membershipsChanged: () => undefined,
    nodeName: () => name,
    ...overrides,
  }, ownRelay);
  runtime.start();
  const created = { name, nodeId, db, server, runtime, requests };
  machines.push(created);
  return created;
}

function token(label: string): string {
  const { secret } = createRelayToken(relayDb, { label, uses: 1, ttlMs: 60_000 });
  return `${origin}/enroll#${relay.fingerprint}.${secret}`;
}

function pin(from: Machine, to: Machine): void {
  pinClusterPublicKey(from.db, to.nodeId, getOrCreateClusterIdentity(to.db, to.nodeId).publicKey);
}

test.after(async () => {
  setRelayTransport(undefined);
  for (const item of machines) item.runtime.stop();
  relay.reload();
  relayHttp.close();
  await rm(root, { recursive: true, force: true });
});

let a: Machine;
let b: Machine;

test("machines join with a token, get unique names and see each other online", async () => {
  a = await machine("office mac", () => b ? [b.nodeId] : []);
  b = await machine("office mac", () => [a.nodeId]);
  a.runtime.addWithToken(token("a"));
  await eventually(() => assert.equal(listMemberships(a.db)[0]?.status, "admitted"));
  b.runtime.addWithToken(token("b"));
  await eventually(() => assert.equal(listMemberships(b.db)[0]?.status, "admitted"));
  assert.equal(listMemberships(a.db)[0].name, "office-mac");
  assert.equal(listMemberships(b.db)[0].name, "office-mac-2", "the second machine with the same name gets a suffix");
  assert.equal(listMemberships(a.db)[0].fingerprint, relay.fingerprint, "the relay key is pinned");
  a.runtime.refreshWatch();
  b.runtime.refreshWatch();
  await eventually(() => { assert.ok(a.runtime.hasRoute(b.nodeId)); assert.ok(b.runtime.hasRoute(a.nodeId)); });
});

test("relay transport errors survive reconnects and history stays bounded", async () => {
  const id = listMemberships(a.db)[0].id;
  recordRelayTransportEvent(a.db, id, "websocket", "error", "handshake timeout");
  for (let i = 0; i < 110; i++) recordRelayTransportEvent(a.db, id, "poll", "connected");
  const events = listRelayTransportEvents(a.db, id);
  assert.equal(events.length, 100);
  assert.equal(events[0].transport, "poll");
  assert.ok(!events.some((entry) => entry.detail === "handshake timeout"));
  recordRelayTransportEvent(a.db, id, "websocket", "error", "retry failed");
  assert.equal(listRelayTransportEvents(a.db, id)[0].detail, "retry failed");
});

test("a used token cannot admit another machine", async () => {
  const link = token("once");
  const first = await machine("first", () => []);
  first.runtime.addWithToken(link);
  await eventually(() => assert.equal(listMemberships(first.db)[0]?.status, "admitted"));
  const second = await machine("second", () => []);
  second.runtime.addWithToken(link);
  await eventually(() => assert.equal(listMemberships(second.db)[0]?.status, "denied"));
  assert.match(listMemberships(second.db)[0].lastError ?? "", /invalid, used or expired/);
});

test("peerFetch reaches a relay-only machine through an encrypted channel the relay cannot read", async () => {
  pin(a, b);
  pin(b, a);
  setRelayTransport(a.runtime);
  sessionFrames.length = 0;
  const response = await peerFetch(`${virtualRelayUrl(b.nodeId)}/hello`, { method: "POST", body: "ping-body-5678", headers: { "Content-Type": "text/plain" } });
  assert.equal(response.status, 200);
  const body = await response.json() as { from: string; echo: string; secret: string };
  assert.deepEqual(body, { from: "office mac", echo: "ping-body-5678", secret: "plaintext-marker-1234" });
  const seen = b.requests.at(-1)!;
  assert.equal(seen.peer, a.nodeId, "the receiver knows which machine proved itself on the channel");
  assert.equal(seen.transport, "peer");
  assert.ok(sessionFrames.length > 0, "the request went through the relay");
  const routed = Buffer.concat(sessionFrames.map((frame) => decodeFrame(frame).type === FRAME_DATA ? (decodeFrame(frame) as { payload: Buffer }).payload : Buffer.alloc(0)));
  assert.equal(routed.includes("ping-body-5678"), false, "the request body is not visible to the relay");
  assert.equal(routed.includes("plaintext-marker-1234"), false, "the response is not visible to the relay");
});

test("a large response flows through the channel's flow control intact", async () => {
  setRelayTransport(a.runtime);
  const response = await peerFetch(`${virtualRelayUrl(b.nodeId)}/big`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 40 * 64 * 1024);
  assert.ok(bytes.every((value) => value === 0x61));
});

function peerFailureLogs(context: TestContext): () => Array<Record<string, any>> {
  const messages: string[] = [];
  context.mock.method(console, "warn", (message: string) => { if (message.startsWith("{")) messages.push(message); });
  return () => messages.map((message) => JSON.parse(message)).filter((entry) => entry.event === "relay_peer_request_failed");
}

test("peer response timeouts log one private timing record and preserve the caller's error", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  Object.assign(held, { now: 0, peak: 0, open: false });
  const controller = new AbortController();
  const reason = new DOMException("SECRET_ABORT_REASON", "TimeoutError");
  const rejected = assert.rejects(peerFetch(`${virtualRelayUrl(b.nodeId)}/held/SECRET_PATH?token=SECRET_QUERY`, {
    method: "POST", body: "SECRET_BODY", headers: { Authorization: "SECRET_AUTH", Cookie: "SECRET_COOKIE" }, signal: controller.signal,
  }), (error) => error === reason);
  try {
    await eventually(() => assert.equal(held.waiting.length, 1));
    controller.abort(reason);
    await rejected;
    await eventually(() => assert.equal(failures().length, 1));
    const entry = failures()[0];
    assert.equal(entry.peerId, b.nodeId);
    assert.equal(entry.phase, "response");
    assert.equal(entry.code, "TIMEOUT");
    assert.equal(entry.transport, "websocket");
    assert.equal(entry.membershipId, listMemberships(a.db)[0].id);
    for (const key of ["durationMs", "queueMs", "channelMs", "sendMs", "responseMs"]) assert.ok(entry[key] >= 0, key);
    assert.equal(entry.bodyMs, null);
    assert.equal(entry.reusedSocket, false);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(entry).includes("SECRET_"), false, "no paths, queries, bodies, headers or error messages are logged");
  } finally { controller.abort(reason); letHeldThrough(); await rejected; }
});

test("an aborted request waiting for an HTTP pool slot reports queue time without inventing a channel", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  Object.assign(held, { now: 0, peak: 0, open: false });
  const occupied = Array.from({ length: 16 }, () => peerFetch(`${virtualRelayUrl(b.nodeId)}/held`).then((answer) => answer.text()));
  const controller = new AbortController();
  try {
    await eventually(() => assert.equal(held.waiting.length, 16));
    const rejected = assert.rejects(peerFetch(`${virtualRelayUrl(b.nodeId)}/queued`, { signal: controller.signal }), /SECRET_CANCEL/);
    controller.abort(new Error("SECRET_CANCEL"));
    await rejected;
    assert.equal(failures().length, 1);
    const entry = failures()[0];
    assert.equal(entry.phase, "queue");
    assert.equal(entry.code, "ABORTED");
    assert.ok(entry.queueMs >= 0);
    for (const key of ["channelMs", "sendMs", "responseMs", "bodyMs", "transport", "membershipId"]) assert.equal(entry[key], null, key);
    assert.equal(JSON.stringify(entry).includes("SECRET_CANCEL"), false);
  } finally { controller.abort(); letHeldThrough(); await Promise.all(occupied); }
});

test("a failed peer identity handshake reports channel setup and the actual polling route", async (context) => {
  const failures = peerFailureLogs(context);
  const client = await machine("diagnostic-unpinned", () => [b.nodeId], { preferPoll: true });
  try {
    client.runtime.addWithToken(token("diagnostic-unpinned"));
    await eventually(() => assert.ok(client.runtime.hasRoute(b.nodeId)));
    setRelayTransport(client.runtime);
    await assert.rejects(peerFetch(`${virtualRelayUrl(b.nodeId)}/private-path`), /fetch failed/);
    assert.equal(failures().length, 1);
    const entry = failures()[0];
    assert.equal(entry.phase, "channel");
    assert.equal(entry.code, "UNKNOWN", "the existing identity check throws an uncoded Error, whose message stays private");
    assert.equal(entry.transport, "poll");
    assert.equal(entry.membershipId, listMemberships(client.db)[0].id);
    assert.ok(entry.channelMs >= 0);
    assert.equal(entry.sendMs, null);
    assert.equal(entry.responseMs, null);
  } finally { setRelayTransport(undefined); client.runtime.stop(); }
});

test("a peer with no available relay reports channel failure with no invented route", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  await assert.rejects(peerFetch(`${virtualRelayUrl(randomUUID())}/absent`, { signal: AbortSignal.timeout(10_000) }), /fetch failed/);
  assert.equal(failures().length, 1);
  const entry = failures()[0];
  assert.equal(entry.phase, "channel");
  assert.equal(entry.code, "ERELAYCHANNEL");
  assert.equal(entry.membershipId, null);
  assert.equal(entry.transport, null);
  assert.equal(entry.responseMs, null);
});

test("successful peer requests stay quiet, clean up abort listeners and measure reused channels separately", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  const controller = new AbortController();
  for (let index = 0; index < 12; index++) {
    const answer = await peerFetch(`${virtualRelayUrl(b.nodeId)}/hello`, { signal: controller.signal });
    assert.equal(answer.status, 200);
    await answer.text();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(failures(), []);
  Object.assign(held, { now: 0, peak: 0, open: false });
  const rejected = assert.rejects(peerFetch(`${virtualRelayUrl(b.nodeId)}/held`, { signal: controller.signal }), /aborted/);
  try {
    await eventually(() => assert.equal(held.waiting.length, 1));
    controller.abort();
    await rejected;
    assert.equal(failures().length, 1);
    assert.equal(failures()[0].phase, "response");
    assert.equal(failures()[0].reusedSocket, true);
    assert.equal(failures()[0].channelMs, 0);
  } finally { controller.abort(); letHeldThrough(); await rejected; }
});

test("an abort after response headers reports body transfer once, without the abort reason", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  const controller = new AbortController();
  try {
    const answer = await peerFetch(`${virtualRelayUrl(b.nodeId)}/endless`, { signal: controller.signal });
    const rejected = assert.rejects(answer.arrayBuffer());
    controller.abort(new Error("SECRET_BODY_ABORT"));
    await rejected;
    assert.equal(failures().length, 1);
    assert.equal(failures()[0].phase, "body");
    assert.ok(failures()[0].bodyMs >= 0);
    assert.equal(JSON.stringify(failures()).includes("SECRET_BODY_ABORT"), false);
  } finally { controller.abort(); setRelayTransport(undefined); }
});

for (const finishUpload of [false, true]) {
  test(`an early response keeps body timing correct when upload ${finishUpload ? "finishes later" : "is unfinished"}`, async (context) => {
    const failures = peerFailureLogs(context);
    setRelayTransport(a.runtime);
    const controller = new AbortController();
    let upload!: ReadableStreamDefaultController;
    let uploadClosed = false;
    const body = new ReadableStream({ start(stream) { upload = stream; stream.enqueue(new Uint8Array([1, 2, 3])); } });
    const incoming = new Promise<IncomingMessage>((resolve) => b.server.once("request", resolve));
    try {
      const answer = await peerFetch(`${virtualRelayUrl(b.nodeId)}/endless`, { method: "POST", body, signal: controller.signal });
      const rejected = assert.rejects(answer.arrayBuffer());
      if (finishUpload) {
        const request = await incoming;
        const received = new Promise((resolve) => request.once("end", resolve));
        upload.close(); uploadClosed = true;
        await received;
      }
      controller.abort();
      await rejected;
      assert.equal(failures().length, 1);
      assert.equal(failures()[0].phase, "body");
      assert.ok(failures()[0].bodyMs >= 0);
      assert.equal(failures()[0].responseMs, finishUpload ? 0 : null, "an early answer never creates a negative response wait");
    } finally { if (!uploadClosed) upload.close(); controller.abort(); setRelayTransport(undefined); }
  });
}

test("a truncated peer response logs its body failure without a caller abort", async (context) => {
  const failures = peerFailureLogs(context);
  setRelayTransport(a.runtime);
  // A fast close can arrive before the HTTP response has been wrapped as a fetch Response.
  await assert.rejects(async () => {
    const answer = await peerFetch(`${virtualRelayUrl(b.nodeId)}/truncated`);
    await answer.arrayBuffer();
  });
  assert.equal(failures().length, 1);
  assert.equal(failures()[0].phase, "body");
  assert.equal(failures()[0].code, "ECONNRESET");
  assert.ok(failures()[0].bodyMs >= 0);
});

test("a machine refuses to talk to a peer whose key it has not pinned", async () => {
  const c = await machine("unpinned", () => [b.nodeId]);
  c.runtime.addWithToken(token("c"));
  await eventually(() => assert.equal(listMemberships(c.db)[0]?.status, "admitted"));
  c.runtime.refreshWatch();
  await eventually(() => assert.ok(c.runtime.hasRoute(b.nodeId)));
  const stream = c.runtime.openStream(b.nodeId, "peer");
  const error = await new Promise<Error>((resolve) => stream.once("error", resolve));
  assert.match(error.message, /no pinned key/);
});

test("access requests wait for the operator, who sees the same pairing code", async () => {
  const d = await machine("requester", () => []);
  d.runtime.requestAccess(origin);
  await eventually(() => assert.equal(listMemberships(d.db)[0]?.status, "pending"));
  const shown = listMemberships(d.db)[0].pairingCode;
  const pending = relayMachine(relayDb, d.nodeId)!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.pairingCode, shown, "both sides show the same code");
  const nonce = listMemberships(d.db)[0].requestNonce!;
  assert.equal(shown, pairingCode(clusterPublicKeyFingerprint(getOrCreateClusterIdentity(d.db, d.nodeId).publicKey), relay.fingerprint, d.nodeId, nonce), "the machine computes its own code");
  relay.approve(d.nodeId, "test operator");
  await eventually(() => assert.equal(listMemberships(d.db)[0]?.status, "admitted"));
  assert.equal(listMemberships(d.db)[0].name, "requester");
});

test("the phone gateway proxies a named machine's UI and marks the request as a gateway request", async () => {
  const name = listMemberships(a.db)[0].name!;
  const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: relayPort, path: "/api/health", headers: { Host: `${name}.localhost:${relayPort}`, "X-Forwarded-For": "203.0.113.9" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(answer.status, 200, answer.body);
  const seen = a.requests.at(-1)!;
  assert.equal(seen.transport, "gateway");
  assert.equal(seen.peer, undefined, "a gateway request carries no machine identity");
  assert.equal(seen.remoteAddress, "203.0.113.9", "behind a loopback proxy the phone's forwarded address is used");
});

test("phone sign-in off makes the machine's name answer 404", async () => {
  const membershipId = listMemberships(b.db)[0].id;
  b.runtime.setPhoneSignIn(membershipId, false);
  const name = listMemberships(b.db)[0].name!;
  await eventually(async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: relayPort, path: "/", headers: { Host: `${name}.localhost:${relayPort}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 404);
  });
  b.runtime.setPhoneSignIn(membershipId, true);
});

test("revoking a machine disconnects it and keeps its name reserved", async () => {
  const e = await machine("revoked", () => []);
  e.runtime.addWithToken(token("e"));
  await eventually(() => assert.equal(listMemberships(e.db)[0]?.status, "admitted"));
  const name = listMemberships(e.db)[0].name!;
  relay.setStatus(e.nodeId, "revoked", "test operator");
  await eventually(() => assert.equal(listMemberships(e.db)[0]?.status, "revoked"));
  assert.equal(relay.isOnline(e.nodeId), false);
  const f = await machine("revoked", () => []);
  f.runtime.addWithToken(token("f"));
  await eventually(() => assert.equal(listMemberships(f.db)[0]?.status, "admitted"));
  assert.notEqual(listMemberships(f.db)[0].name, name, "a revoked machine's name is not handed out again");
});

test("a peer whose direct URL is down is reached through a shared relay", async () => {
  // A knows B by a direct URL that nothing listens on, as when a Tailscale address is unreachable.
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  ensurePeerEndpointSchema(a.db);
  a.db.prepare("INSERT OR REPLACE INTO cluster_v2_peer_endpoints(context_kind,context_id,node_id,name,url) VALUES('twin',?,?,?,?)").run(randomUUID(), b.nodeId, "b", `http://127.0.0.1:${deadPort}`);
  setRelayTransport(a.runtime);
  const response = await peerFetch(`http://127.0.0.1:${deadPort}/fallback`, { method: "POST", body: "via-relay" }, b.nodeId);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { echo: string }).echo, "via-relay");
  assert.equal(b.requests.at(-1)?.transport, "peer", "the request arrived on a relay channel");
});

test("a Syncthing tunnel carries bytes to the peer's own Syncthing listener", async () => {
  // A stand-in for B's Syncthing: echoes what it receives, prefixed.
  const syncthing = net.createServer((socket) => socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk]))));
  const syncthingPort = await new Promise<number>((resolve) => syncthing.listen(0, "127.0.0.1", () => resolve((syncthing.address() as AddressInfo).port)));
  const enroll = (db: DatabaseSync, peer: string): void => {
    db.exec("CREATE TABLE IF NOT EXISTS cluster_v2_file_enrollments(peer_id TEXT NOT NULL,device_id TEXT NOT NULL,folder_id TEXT NOT NULL,project_id TEXT,PRIMARY KEY(peer_id,device_id,folder_id))");
    db.prepare("INSERT OR IGNORE INTO cluster_v2_file_enrollments VALUES(?,?,?,NULL)").run(peer, "DEVICE-" + peer.slice(0, 4), "folder");
  };
  let receiving: SyncthingTunnels | undefined;
  const g = await machine("sync-source", () => []);
  const h = await machine("sync-target", () => [], {
    syncthingAllowed: (from) => receiving!.allowed(from),
    acceptSyncthing: (stream) => receiving!.accept(stream),
  });
  receiving = new SyncthingTunnels(h.db, h.runtime, async () => syncthingPort);
  for (const item of [g, h]) item.runtime.addWithToken(token(item.name));
  await eventually(() => { assert.equal(listMemberships(g.db)[0]?.status, "admitted"); assert.equal(listMemberships(h.db)[0]?.status, "admitted"); });
  pin(g, h);
  enroll(g.db, h.nodeId);
  ensurePeerEndpointSchema(g.db);
  g.db.prepare("INSERT OR REPLACE INTO cluster_v2_peer_endpoints(context_kind,context_id,node_id,name,url) VALUES('twin',?,?,?,?)").run(randomUUID(), h.nodeId, "h", virtualRelayUrl(h.nodeId));
  setRelayTransport(g.runtime);
  const sending = new SyncthingTunnels(g.db, g.runtime);
  g.runtime.ensureWatched(h.nodeId);
  await eventually(() => assert.ok(g.runtime.hasRoute(h.nodeId)));

  // H shares no files with G yet, so it refuses the tunnel.
  await sending.update();
  const port = sending.ports()[h.nodeId];
  assert.ok(port, "a tunnel listens for the relay-only peer");
  const refused = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => refused.once("close", resolve));

  enroll(h.db, g.nodeId);
  const client = net.connect(port, "127.0.0.1");
  client.write("hello-sync");
  const reply = await new Promise<string>((resolve) => client.once("data", (chunk) => resolve(String(chunk))));
  assert.equal(reply, "echo:hello-sync");
  client.destroy();
  sending.close();
  syncthing.close();
});

test("a machine that cannot use WebSockets connects by long-polling and still reaches peers both ways", async () => {
  const polled = await machine("behind-proxy", () => [b.nodeId], { preferPoll: true });
  polled.runtime.addWithToken(token("polled"));
  await eventually(() => assert.equal(listMemberships(polled.db)[0]?.status, "admitted"));
  pin(polled, b);
  pin(b, polled);
  polled.runtime.refreshWatch();
  await eventually(() => assert.ok(polled.runtime.hasRoute(b.nodeId)));
  setRelayTransport(polled.runtime);
  const outbound = await peerFetch(`${virtualRelayUrl(b.nodeId)}/from-poll`, { method: "POST", body: "over-long-poll" });
  assert.equal((await outbound.json() as { echo: string }).echo, "over-long-poll");
  const big = await peerFetch(`${virtualRelayUrl(b.nodeId)}/big`);
  assert.equal(Buffer.from(await big.arrayBuffer()).length, 40 * 64 * 1024, "flow control works over long-polling too");
  b.runtime.ensureWatched(polled.nodeId);
  await eventually(() => assert.ok(b.runtime.hasRoute(polled.nodeId)));
  setRelayTransport(b.runtime);
  const inbound = await peerFetch(`${virtualRelayUrl(polled.nodeId)}/to-poll`, { method: "POST", body: "pushed-to-poller" });
  assert.equal((await inbound.json() as { echo: string; from: string }).echo, "pushed-to-poller");
});

test("polling retries WebSocket and returns only after in-flight channels finish", async () => {
  const client = await machine("poll-recovery", () => [b.nodeId], { preferPoll: true, websocketRetryMs: 75 });
  client.runtime.addWithToken(token("poll-recovery"));
  await eventually(() => assert.equal(listMemberships(client.db)[0]?.status, "admitted"));
  client.runtime.refreshWatch();
  await eventually(() => assert.equal(client.runtime.hasRoute(b.nodeId), true));
  pin(client, b);
  const id = listMemberships(client.db)[0].id;
  // A held HTTP request prevents the transport switch, even when the retry is due.
  const stream = client.runtime.openStream(b.nodeId, "peer");
  await new Promise<void>((resolve) => stream.once("relay-ready", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((client.runtime as any).connections.get(id).ws.constructor.name, "PollClient");
  stream.destroy();
  await eventually(() => assert.equal((client.runtime as any).connections.get(id).ws?.constructor.name, "WebSocket"));
  await eventually(() => assert.ok(listRelayTransportEvents(client.db, id).some((entry) => entry.transport === "websocket" && entry.event === "connected")));
  assert.ok(listRelayTransportEvents(client.db, id).some((entry) => entry.event === "retry"));
});

test("failed WebSocket re-probe restores polling and tries again later", async () => {
  const other = await secondRelay();
  const original = other.server.handleUpgrade;
  let blockWebSocket = true;
  other.server.handleUpgrade = function (request, socket, head) {
    if (blockWebSocket) { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); return true; }
    return original.call(this, request, socket, head);
  };
  const client = await machine("retry-failure", () => [], { preferPoll: true, websocketRetryMs: 150 });
  try {
    client.runtime.addWithToken(other.token("retry-failure"));
    const id = listMemberships(client.db)[0].id;
    await eventually(() => assert.equal((client.runtime as any).connections.get(id).connected, true));
    await eventually(() => assert.ok(listRelayTransportEvents(client.db, id).some((entry) => entry.transport === "websocket" && entry.event === "error")));
    await eventually(() => assert.equal((client.runtime as any).connections.get(id).ws?.constructor.name, "PollClient"));
    blockWebSocket = false;
    await eventually(() => assert.ok(listRelayTransportEvents(client.db, id).some((entry) => entry.transport === "websocket" && entry.event === "connected")));
    const events = listRelayTransportEvents(client.db, id);
    assert.ok(events.some((entry) => entry.transport === "poll" && entry.event === "connected"), "polling reconnected after failed re-probe");
    assert.equal(events.filter((entry) => entry.transport === "websocket" && entry.event === "error").length, 1, "one failed probe returns straight to polling");
    assert.ok(events.some((entry) => entry.event === "fallback" && entry.detail === "WebSocket retry failed"));
  } finally { client.runtime.stop(); other.close(); }
});

test("peerWebSocket opens a WebSocket to a relay-only peer through the relay", async () => {
  const sockets = new WebSocketServer({ server: b.server, path: "/ws" });
  sockets.on("connection", (socket, request) => {
    const peer = relayPeerOf(request.socket)?.nodeId;
    socket.on("message", (data) => socket.send(`${peer}:${String(data)}`));
  });
  setRelayTransport(a.runtime);
  const client = peerWebSocket(`wss://${b.nodeId}.relay.invalid/ws?mode=test`, { headers: { Authorization: "unused" } });
  await new Promise<void>((resolve, reject) => { client.once("open", () => resolve()); client.once("error", reject); });
  client.send("hello-socket");
  const reply = await new Promise<string>((resolve) => client.once("message", (data) => resolve(String(data))));
  assert.equal(reply, `${a.nodeId}:hello-socket`, "the receiving side sees the proven machine on the socket's channel");
  client.close();
  sockets.close();
});

test("when the reader aborts mid-transfer, the sending side's response closes instead of hanging", async () => {
  setRelayTransport(a.runtime);
  endlessClosed.length = 0;
  const controller = new AbortController();
  const response = await peerFetch(`${virtualRelayUrl(b.nodeId)}/endless`, { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await eventually(() => assert.deepEqual(endlessClosed, ["office mac"]), 10_000);
});

test("a refused machine on long-polling learns why instead of retrying forever", async () => {
  const link = token("spent");
  const first = await machine("first-poll", () => []);
  first.runtime.addWithToken(link);
  await eventually(() => assert.equal(listMemberships(first.db)[0]?.status, "admitted"));
  const refused = await machine("refused-poll", () => [], { preferPoll: true });
  refused.runtime.addWithToken(link);
  await eventually(() => assert.equal(listMemberships(refused.db)[0]?.status, "denied"));
  assert.match(listMemberships(refused.db)[0].lastError ?? "", /invalid, used or expired/);
});

test("a direct address that silently drops packets falls back to the relay quickly", async () => {
  ensurePeerEndpointSchema(a.db);
  // TEST-NET-1 is never routed: a connect either hangs or fails, like an offline Tailscale host.
  const blackHole = "http://192.0.2.1:9";
  a.db.prepare("INSERT OR REPLACE INTO cluster_v2_peer_endpoints(context_kind,context_id,node_id,name,url) VALUES('twin',?,?,?,?)").run(randomUUID(), b.nodeId, "b", blackHole);
  setRelayTransport(a.runtime);
  a.runtime.ensureWatched(b.nodeId);
  await eventually(() => assert.ok(a.runtime.hasRoute(b.nodeId)));
  const started = Date.now();
  const response = await peerFetch(`${blackHole}/probe`, { method: "POST", body: "around-the-hole" }, b.nodeId);
  assert.equal((await response.json() as { echo: string }).echo, "around-the-hole");
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms; the direct connect timeout was waited out`);
});

test("a request reaches only the peer the caller named, whatever URL it was given", async () => {
  setRelayTransport(a.runtime);
  // A relay-only URL naming a different node than the intended peer is refused, not followed.
  await assert.rejects(peerFetch(`${virtualRelayUrl(b.nodeId)}/hello`, {}, randomUUID()), /fetch failed/);
  // Without a named peer, a direct URL is only ever tried directly: no relay fallback by URL lookup.
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(peerFetch(`http://127.0.0.1:${deadPort}/hello`), /fetch failed/);
});

test("an access request filed under someone else's node ID cannot lock that machine out", async () => {
  const victim = await machine("victim", () => []);
  const squatterDb = new DatabaseSync(path.join(root, `squatter-${randomUUID()}.db`));
  const squatterKey = getOrCreateClusterIdentity(squatterDb, randomUUID()).publicKey;
  // A pending request with the victim's node ID but another key, as an attacker could file.
  const { upsertPendingMachine } = await import("../src/relay/store.js");
  upsertPendingMachine(relayDb, victim.nodeId, squatterKey, "victim", "000000");
  victim.runtime.addWithToken(token("victim"));
  await eventually(() => assert.equal(listMemberships(victim.db)[0]?.status, "admitted"));
  assert.equal(relayMachine(relayDb, victim.nodeId)?.publicKey, getOrCreateClusterIdentity(victim.db, victim.nodeId).publicKey, "the token holder's key wins");
});

test("a removed key cannot come back under a new node ID", async () => {
  const removed = await machine("comeback", () => []);
  removed.runtime.addWithToken(token("comeback"));
  await eventually(() => assert.equal(listMemberships(removed.db)[0]?.status, "admitted"));
  relay.setStatus(removed.nodeId, "revoked", "test operator");
  await eventually(() => assert.equal(listMemberships(removed.db)[0]?.status, "revoked"));
  // Same key, new node ID: copy the identity row under a fresh ID.
  const otherId = randomUUID();
  const cloneDb = new DatabaseSync(path.join(root, `${otherId}.db`));
  const row = removed.db.prepare("SELECT public_key, private_key_encrypted FROM cluster_v2_identity WHERE singleton=1").get() as { public_key: string; private_key_encrypted: string };
  cloneDb.exec("CREATE TABLE cluster_v2_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), node_id TEXT UNIQUE NOT NULL, public_key TEXT NOT NULL, private_key_encrypted TEXT NOT NULL)");
  cloneDb.prepare("INSERT INTO cluster_v2_identity VALUES (1, ?, ?, ?)").run(otherId, row.public_key, row.private_key_encrypted);
  ensureRelaySchema(cloneDb);
  const clone = new RelayRuntime(cloneDb, otherId, http.createServer(), {
    acceptSyncthing: () => undefined, syncthingAllowed: () => false, knownPeers: () => [],
    peerOnline: () => undefined, membershipsChanged: () => undefined, nodeName: () => "comeback",
  }, new RelayServer(cloneDb, otherId, () => "comeback", () => undefined));
  clone.start();
  try {
    clone.addWithToken(token("comeback-again"));
    await eventually(() => assert.equal(listMemberships(cloneDb)[0]?.status, "revoked"));
  } finally { clone.stop(); }
});

test("a machine answering its gateway with an invalid status gets a 502, and the relay keeps running", async () => {
  const name = listMemberships(a.db)[0].name!;
  const ask = (target: string): Promise<number> => new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: relayPort, path: target, headers: { Host: `${name}.localhost:${relayPort}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", reject);
    request.end();
  });
  const warnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
  try {
    assert.equal(await ask("/bad-status"), 502);
    assert.equal(await ask("/api/health"), 200, "the relay still serves");
  } finally { console.warn = warn; }
  assert.deepEqual(warnings, [], "the bad answer is handled, not thrown");
});

/** One phone request to machine A's `/held` from a fixed address; `abandon` hangs up without waiting for the answer. */
function heldRequest(address: string): { status: Promise<number>; abandon: () => void } {
  const name = listMemberships(a.db)[0].name!;
  const request = http.request({ host: "127.0.0.1", port: relayPort, path: "/held", agent: false, headers: { Host: `${name}.localhost:${relayPort}`, "X-Forwarded-For": address } });
  const status = new Promise<number>((resolve, reject) => {
    request.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", reject);
  });
  request.end();
  return { status, abandon: () => { status.catch(() => undefined); request.destroy(); } };
}

const gatewayQueue = relay as unknown as { gatewayByIp: Map<string, number>; gatewayWaiting: Map<string, unknown[]>; gatewayWaitMs: number };

test("a phone loading more modules at once than its share gets every one, the extra ones in turn", async () => {
  Object.assign(held, { now: 0, peak: 0, open: false });
  const requests = Array.from({ length: 70 }, () => heldRequest("203.0.113.70"));
  await eventually(() => assert.equal(held.waiting.length, 32));
  await eventually(() => assert.equal(gatewayQueue.gatewayWaiting.get("203.0.113.70")?.length, 38));
  letHeldThrough();
  const statuses = await Promise.all(requests.map((request) => request.status));
  assert.deepEqual(statuses.filter((status) => status !== 200), [], "a refused module would leave the app on its loading screen");
  assert.equal(held.peak, 32, "one address still reaches the machine with at most its share at once");
  await eventually(() => assert.equal(gatewayQueue.gatewayByIp.has("203.0.113.70"), false, "every slot is given back"));
});

test("a waiting phone request that hangs up gives up its place, and one that waits too long is refused", async () => {
  Object.assign(held, { now: 0, peak: 0, open: false });
  const running = Array.from({ length: 32 }, () => heldRequest("203.0.113.71"));
  await eventually(() => assert.equal(held.waiting.length, 32));
  const impatient = heldRequest("203.0.113.71");
  await eventually(() => assert.equal(gatewayQueue.gatewayWaiting.get("203.0.113.71")?.length, 1));
  impatient.abandon();
  await eventually(() => assert.equal(gatewayQueue.gatewayWaiting.has("203.0.113.71"), false));

  const patience = gatewayQueue.gatewayWaitMs;
  gatewayQueue.gatewayWaitMs = 50;
  try { assert.equal(await heldRequest("203.0.113.71").status, 429, "it is told to come back, not left hanging"); } finally { gatewayQueue.gatewayWaitMs = patience; }
  assert.equal(gatewayQueue.gatewayWaiting.has("203.0.113.71"), false);
  const neighbour = heldRequest("203.0.113.72");
  await eventually(() => assert.equal(held.waiting.length, 33, "another address is not held back"));

  letHeldThrough();
  assert.deepEqual((await Promise.all([...running, neighbour].map((request) => request.status))).filter((status) => status !== 200), []);
  await eventually(() => assert.equal(gatewayQueue.gatewayByIp.size, 0, "every slot is given back"));
});

/** A second relay in the same process, for routing between relays. */
async function secondRelay(options: { ownMachinesOnly?: boolean } = {}): Promise<{ server: RelayServer; db: DatabaseSync; origin: string; port: number; token: (label: string) => string; close: () => void }> {
  const db = new DatabaseSync(path.join(root, `relay-${randomUUID()}.db`));
  const nodeId = randomUUID();
  const httpServer = http.createServer();
  const port = await listen(httpServer);
  const relayOrigin = `http://localhost:${port}`;
  ensureRelaySchema(db);
  saveServingSettings(db, { enabled: true, origin: relayOrigin, environment: "second", requestsEnabled: true, maxMachines: 100, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: options.ownMachinesOnly ?? false });
  const server = new RelayServer(db, nodeId, () => "second relay", () => undefined);
  server.reload();
  httpServer.on("request", (request, response) => { if (!server.handleRequest(request, response)) response.writeHead(200).end("second relay"); });
  httpServer.on("upgrade", (request, socket, head) => { if (!server.handleUpgrade(request, socket, head)) socket.destroy(); });
  return {
    server, db, origin: relayOrigin, port,
    token: (label) => `${relayOrigin}/enroll#${server.fingerprint}.${createRelayToken(db, { label, uses: 1, ttlMs: 60_000 }).secret}`,
    close: () => { saveServingSettings(db, { enabled: false, origin: relayOrigin, environment: "", requestsEnabled: true, maxMachines: 100, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: false }); server.reload(); httpServer.close(); },
  };
}

test("the relay that last worked is tried first, and a peer that leaves it is reached through another relay", async () => {
  const other = await secondRelay();
  let p!: Machine;
  let q!: Machine;
  p = await machine("route-p", () => q ? [q.nodeId] : []);
  q = await machine("route-q", () => p ? [p.nodeId] : []);
  try {
    for (const item of [p, q]) { item.runtime.addWithToken(token(item.name)); item.runtime.addWithToken(other.token(item.name)); }
    await eventually(() => {
      for (const item of [p, q]) assert.deepEqual(listMemberships(item.db).map((entry) => entry.status), ["admitted", "admitted"]);
    });
    pin(p, q);
    p.runtime.refreshWatch();
    await eventually(() => assert.equal(p.runtime.routes(q.nodeId).length, 2, "both relays report the peer"));
    setRelayTransport(p.runtime);
    assert.equal((await peerFetch(`${virtualRelayUrl(q.nodeId)}/first`, {}, q.nodeId)).status, 200);
    const [first, second] = listMemberships(p.db);
    const remembered = lastPeerRoutes(p.db).get(q.nodeId);
    assert.ok(remembered === first.id || remembered === second.id, "the working relay is remembered");
    assert.equal(p.runtime.routes(q.nodeId)[0].membershipId, remembered, "and tried first");
    // The peer leaves the remembered relay, as when that relay is replaced or gone.
    const qOnRemembered = listMemberships(q.db).find((entry) => entry.origin === listMemberships(p.db).find((item) => item.id === remembered)!.origin)!;
    q.runtime.leave(qOnRemembered.id);
    await eventually(() => assert.equal(p.runtime.routes(q.nodeId).length, 1));
    assert.equal((await peerFetch(`${virtualRelayUrl(q.nodeId)}/second`, {}, q.nodeId)).status, 200, "reached through the remaining relay");
    assert.notEqual(lastPeerRoutes(p.db).get(q.nodeId), remembered, "the new working relay is remembered");
  } finally { other.close(); }
});

test("a relay that cannot reach the peer after all hands the channel to the next relay", async () => {
  const sent: Buffer[] = [];
  const hub = new ChannelHub({ send: (frame) => sent.push(frame), onIncoming: () => "no" });
  const stream = new RelayStream("peer", undefined);
  let retried = 0;
  stream.retryOpen = () => { retried += 1; return true; };
  hub.openWith(stream, randomUUID(), "peer");
  hub.handleFrame(encodeControl({ t: "open-failed", ref: 1, error: "That machine is not connected to this relay" }));
  assert.equal(retried, 1);
  assert.equal(stream.destroyed, false, "the stream survives for the next relay");
  stream.destroy();
});

test("connected machines see phone addresses for themselves, the relay, and only the peers they already know", async () => {
  let p!: Machine;
  let q!: Machine;
  p = await machine("phone-p", () => q ? [q.nodeId] : []);
  q = await machine("phone-q", () => p ? [p.nodeId] : []);
  const stranger = await machine("phone-stranger", () => []);
  for (const item of [p, q, stranger]) item.runtime.addWithToken(token(item.name));
  await eventually(() => { for (const item of [p, q, stranger]) assert.equal(listMemberships(item.db)[0]?.status, "admitted"); });
  p.runtime.refreshWatch();
  const membershipId = listMemberships(p.db)[0].id;
  await eventually(() => {
    const directory = p.runtime.phoneDirectory(membershipId);
    assert.deepEqual(directory.map((entry) => entry.kind).sort(), ["peer", "relay", "this"]);
    assert.equal(directory.find((entry) => entry.kind === "this")?.name, listMemberships(p.db)[0].name);
    assert.equal(directory.find((entry) => entry.kind === "peer")?.name, listMemberships(q.db)[0].name);
    assert.equal(directory.find((entry) => entry.kind === "relay")?.nodeId, relayNodeId);
  });
  assert.equal(p.runtime.phoneDirectory(membershipId).some((entry) => entry.nodeId === stranger.nodeId), false, "machines this one does not know are never listed");
  // A relay that reports a machine nobody asked about is ignored, so it cannot add rows or routes.
  const connection = (p.runtime as unknown as { connections: Map<string, { handleControl(message: unknown): void }> }).connections.get(membershipId)!;
  connection.handleControl({ t: "presence", online: [stranger.nodeId], offline: [], listings: { [stranger.nodeId]: { name: "forged", phone: true } } });
  assert.equal(p.runtime.phoneDirectory(membershipId).some((entry) => entry.nodeId === stranger.nodeId || entry.name === "forged"), false, "a relay cannot add machines to the phone list");
  assert.equal(p.runtime.hasRoute(stranger.nodeId), false, "nor routes to machines this one never asked about");
  // A peer that turns phone sign-in off shows as such right away.
  q.runtime.setPhoneSignIn(listMemberships(q.db)[0].id, false);
  await eventually(() => assert.equal(p.runtime.phoneDirectory(membershipId).find((entry) => entry.kind === "peer")?.phone, false));
});

test("a relay limited to its owner's machines admits its twins and refuses everyone else", async () => {
  const limited = await secondRelay({ ownMachinesOnly: true });
  try {
    const twin = await machine("owner-twin", () => []);
    const outsider = await machine("outsider", () => []);
    limited.db.exec("CREATE TABLE IF NOT EXISTS sharing_twins(left_node_id TEXT NOT NULL, right_node_id TEXT NOT NULL, PRIMARY KEY(left_node_id,right_node_id), CHECK(left_node_id < right_node_id))");
    const [left, right] = [limited.server.nodeId, twin.nodeId].sort();
    limited.db.prepare("INSERT INTO sharing_twins VALUES(?,?)").run(left, right);
    twin.runtime.addWithToken(limited.token("twin"));
    outsider.runtime.addWithToken(limited.token("outsider"));
    await eventually(() => {
      assert.equal(listMemberships(twin.db)[0]?.status, "admitted");
      assert.equal(listMemberships(outsider.db)[0]?.status, "denied");
    });
    assert.match(listMemberships(outsider.db)[0].lastError ?? "", /owner's machines/);
    // Removing the twin raises the peers-changed signal, and the relay then drops the former twin.
    let signalled = false;
    const stopListening = onRelayPeersChanged(() => { signalled = true; });
    try { setTrustedTwin(limited.db, limited.server.nodeId, twin.nodeId, false); } finally { stopListening(); }
    assert.equal(signalled, true, "removing a twin tells the relay that its peers changed");
    limited.server.enforceOwnMachinesOnly();
    assert.equal(limited.server.isOnline(twin.nodeId), false, "a machine that is no longer a twin is disconnected at once");
    // When it reconnects it is refused.
    await eventually(() => assert.equal(listMemberships(twin.db)[0]?.status, "denied"));
  } finally { limited.close(); }
});
