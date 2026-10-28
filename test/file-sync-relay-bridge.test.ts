import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { signClusterRequest } from "../src/cluster-protocol.js";
import { ensureTwinSchema } from "../src/cluster-twins.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { servingBridge, WorkerBridge, workerLaunch } from "../src/file-sync/bridge.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, STREAM_WINDOW_BYTES } from "../src/file-sync/protocol.js";
import { verifyRequest } from "../src/file-sync/signing.js";
import { sharesAnswerSchema } from "../src/file-sync/wire.js";
import { systemClock } from "../src/file-sync/types.js";
import { createInThreadWorker } from "../src/file-sync/worker.js";
import { server } from "../src/server.js";

/* Main's half of the network layer against a worker thread running the real port adapter
   (fixtures/file-sync-net-worker.ts): relayRequest events signed by main and streamed back with
   flow control, and /api/cluster/v2/files/* on the main server forwarding to the serve op. */

const directory = mkdtempSync(path.join(os.tmpdir(), "jb-fs-relay-bridge-"));
const peerId = randomUUID();
const peerDb = new DatabaseSync(path.join(directory, "peer.db"));
const peerSockets = new Set<Socket>();
const peerSeen: Array<{ sender: string; method: string; target: string }> = [];
/** Answers the peer could not finish because the other side went away. */
let peerCutOff = 0;
let localId: string;
let localPublicKey: string;
let origin: string;
let peerOrigin: string;
let bridge: WorkerBridge | undefined;

/** The fixture worker's byte pattern: byte n of a body is n % 251. */
function patternChunk(offset: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (offset + index) % 251;
  return bytes;
}

function pattern(total: number, chunk = 64 * 1024): Buffer[] {
  const chunks: Buffer[] = [];
  for (let sent = 0; sent < total; sent += chunk) chunks.push(patternChunk(sent, Math.min(chunk, total - sent)));
  return chunks;
}

const sha256 = (chunks: Buffer[]) => chunks.reduce((hash, chunk) => hash.update(chunk), createHash("sha256")).digest("hex");

/** The peer: verifies main's signature with the pinned key, then answers 5 MiB as fast as the socket takes it. */
const peerServer = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", async () => {
    try {
      const envelope = verifyRequest(peerId, request.method!, request.url!, Buffer.concat(chunks), request.headers.authorization, (sender) => sender === localId ? localPublicKey : undefined);
      peerSeen.push({ sender: envelope.senderNodeId, method: request.method!, target: request.url! });
    } catch {
      response.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}');
      return;
    }
    response.once("close", () => { if (!response.writableFinished) peerCutOff++; });
    response.writeHead(200, { "content-type": "application/x-joint-bob-index+gzip", "set-cookie": "a=b" });
    const size = Number(new URL(request.url!, "http://peer.invalid").searchParams.get("bytes") ?? 5 * 1024 * 1024);
    for (let sent = 0; sent < size; sent += 64 * 1024) {
      if (response.destroyed) return;
      if (!response.write(patternChunk(sent, Math.min(64 * 1024, size - sent)))) await new Promise((resolve) => { response.once("drain", resolve); response.once("close", resolve); });
    }
    response.end();
  });
});

before(async () => {
  const db = await clusterV2Database();
  localId = (await getClusterNode()).id;
  localPublicKey = getOrCreateClusterIdentity(db, localId).publicKey;
  pinClusterPublicKey(db, peerId, getOrCreateClusterIdentity(peerDb, peerId).publicKey);
  peerServer.on("connection", (socket) => { peerSockets.add(socket); socket.once("close", () => peerSockets.delete(socket)); });
  await new Promise<void>((resolve) => peerServer.listen(0, "127.0.0.1", resolve));
  peerOrigin = `http://127.0.0.1:${(peerServer.address() as AddressInfo).port}`;
  // An active twin: replicationPeers lists it with its replication URL, which the relay fallback uses.
  ensureTwinSchema(db);
  const relationship = randomUUID();
  db.prepare("INSERT INTO cluster_v2_twin_relationships VALUES (?, ?, ?, '{}', 'test', NULL, 'active', NULL)").run(relationship, localId, peerId);
  recordPeerEndpoint(db, { kind: "twin", id: relationship }, { nodeId: peerId, name: "Peer", url: peerOrigin });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await bridge?.stop();
  for (const socket of peerSockets) socket.destroy();
  await new Promise<void>((resolve) => peerServer.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  peerDb.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A request from the peer to this node, signed the way test/signed-node-request.ts does it. */
function fromPeer(method: "GET" | "POST", target: string, payload?: unknown, init: RequestInit = {}): Promise<Response> {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const authorization = signClusterRequest(peerDb, peerId, localId, method, target, Buffer.from(body));
  return fetch(new URL(target, origin), { ...init, method, headers: { ...init.headers as Record<string, string>, "content-type": "application/json", authorization }, ...(payload === undefined ? {} : { body }) });
}

async function startBridge(): Promise<WorkerBridge> {
  const started = new WorkerBridge({ nodeId: localId, dataDir: path.join(directory, "data"), launch: workerLaunch(new URL("./fixtures/file-sync-net-worker.js", import.meta.url)), workerData: { manual: true }, relayReaderIdleMs: 500 });
  started.start();
  return started;
}

test("with file sync off, main's files routes say so: shares answers enabled false and every other endpoint 503", async () => {
  assert.equal(servingBridge(), undefined);
  const shares = await fromPeer("GET", "/api/cluster/v2/files/shares");
  assert.equal(shares.status, 200);
  const off = await shares.json() as { hostId: string };
  assert.deepEqual(off, { fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: false }, nodeId: localId, hostId: off.hostId, origins: [], shares: [], engines: [], settings: [] });
  assert.doesNotThrow(() => sharesAnswerSchema.parse(off), "a capable peer can read the answer");
  for (const [method, target, payload] of [["GET", "/api/cluster/v2/files/index?projectId=p1&kind=project&since=0", undefined], ["POST", "/api/cluster/v2/files/changed", { shares: [] }], ["POST", "/api/cluster/v2/files/fetch", { items: [] }], ["POST", "/api/cluster/v2/files/file", {}], ["POST", "/api/cluster/v2/files/status", { projectId: "p1" }]] as const) {
    const response = await fromPeer(method, target, payload);
    assert.equal(response.status, 503, target);
    assert.deepEqual(await response.json(), { error: "File sync is off on this node" });
  }
  const unsigned = await fetch(new URL("/api/cluster/v2/files/shares", origin));
  assert.equal(unsigned.status, 401, "the routes sit behind cluster authentication");
});

// fix (P4+P5): the switch's own endpoint is main's, answered whether or not the worker runs, behind the same authentication.
test("the switch endpoint answers only signed peers the project is shared with, and checks its body", async () => {
  const notShared = await fromPeer("POST", "/api/cluster/v2/files/switch", { projectId: "nobody-shares-this" });
  assert.equal(notShared.status, 403);
  assert.deepEqual(await notShared.json(), { error: "Project is not shared with this node" });
  const malformed = await fromPeer("POST", "/api/cluster/v2/files/switch", { projectId: "p1", report: { phase: "elsewhere", error: null } });
  assert.equal(malformed.status, 400);
  const unsigned = await fetch(new URL("/api/cluster/v2/files/switch", origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "p1" }) });
  assert.equal(unsigned.status, 401);
});

test("switched on while its worker does not serve yet (starting, restarting), main's files routes say it is starting, never off", async () => {
  // A peer reading "off" here would have the owner move its built-in projects back to Syncthing (migration.ts).
  const saved = process.env.JOINT_BOB_FILE_SYNC;
  process.env.JOINT_BOB_FILE_SYNC = "1";
  try {
    assert.equal(servingBridge(), undefined);
    for (const [method, target, payload] of [["GET", "/api/cluster/v2/files/shares", undefined], ["POST", "/api/cluster/v2/files/status", { projectId: "p1" }]] as const) {
      const response = await fromPeer(method, target, payload);
      assert.equal(response.status, 503, target);
      assert.deepEqual(await response.json(), { error: "File sync is starting on this node" });
    }
  } finally { if (saved === undefined) delete process.env.JOINT_BOB_FILE_SYNC; else process.env.JOINT_BOB_FILE_SYNC = saved; }
});

test("a relayRequest is signed by main, fetched from the peer's replication URL and streamed back to the worker within the 4 MiB window", async () => {
  bridge = await startBridge();
  const target = "/api/cluster/v2/files/index?projectId=p1&kind=project&since=0&limit=5000";
  const result = await bridge.call("status", { shares: [peerId, target, "15"] }) as unknown as { status: number; contentType: string; bytes: number; sha256: string; route: string };
  const expected = pattern(5 * 1024 * 1024);
  assert.deepEqual(result, { status: 200, contentType: "application/x-joint-bob-index+gzip", bytes: 5 * 1024 * 1024, sha256: sha256(expected), route: "relay" });
  assert.deepEqual(peerSeen, [{ sender: localId, method: "GET", target }]);
  assert.ok(bridge.relayPeak <= STREAM_WINDOW_BYTES + 256 * 1024, `main had ${bridge.relayPeak} bytes unacknowledged`);
  assert.ok(bridge.relayPeak > 2 * 1024 * 1024, `the slow reader should have filled the window (peak ${bridge.relayPeak})`);
});

test("a relayed answer the worker never reads is given up once the window has been full for a while", async () => {
  assert.ok(bridge);
  const cutOff = peerCutOff;
  const target = "/api/cluster/v2/files/index?projectId=p1&kind=project&since=1&bytes=268435456";
  const result = await bridge.call("status", { shares: [peerId, target, "never"] }) as unknown as { status: number };
  assert.equal(result.status, 200);
  const deadline = Date.now() + 10_000;
  while (peerCutOff === cutOff && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(peerCutOff, cutOff + 1, "main dropped the peer's answer");
  peerSeen.length = 1;
});

test("a relayRequest main cannot carry fails in the worker with main's reason", async () => {
  assert.ok(bridge);
  const unknownPeer = randomUUID();
  const missing = await bridge.call("status", { shares: [unknownPeer, "/api/cluster/v2/files/shares", "0"] }) as unknown as { error: string; code: string | null; route: string };
  assert.deepEqual(missing, { error: "This node has no address for that peer", code: "unreachable", route: "none" });
  const outside = await bridge.call("status", { shares: [peerId, "/api/cluster/v2/runtime/x", "0"] }) as unknown as { error: string };
  assert.equal(outside.error, "File sync relays only /api/cluster/v2/files/ requests");
  assert.equal(peerSeen.length, 1, "nothing outside the files API was signed or sent");
});

test("main's files routes forward a signed peer request to the worker's serve op and stream its answer", async () => {
  assert.ok(bridge);
  assert.equal(servingBridge(), bridge);
  const status = await fromPeer("POST", "/api/cluster/v2/files/status?x=1&x=2", { projectId: "p1", shares: [] });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { peer: peerId, body: { projectId: "p1", shares: [] }, query: { x: "1" } });
  const changed = await fromPeer("POST", "/api/cluster/v2/files/changed", { shares: [] });
  assert.equal(changed.status, 202);
  const size = 3 * 1024 * 1024 + 123;
  const file = await fromPeer("POST", "/api/cluster/v2/files/file", { projectId: "p1", kind: "project", path: ".gitignore", sha256: "a".repeat(64), size }, { headers: { range: "bytes=0-" } });
  assert.equal(file.status, 206);
  assert.equal(file.headers.get("content-range"), `bytes 0-${size - 1}/${size}`);
  assert.equal(file.headers.get("x-range"), "bytes=0-", "the Range header reached the service");
  const received = Buffer.from(await file.arrayBuffer());
  assert.equal(received.length, size);
  assert.equal(createHash("sha256").update(received).digest("hex"), sha256(pattern(size)));
  const index = await fromPeer("GET", "/api/cluster/v2/files/index?projectId=p1&kind=project&since=0&bytes=70000");
  assert.equal(index.headers.get("content-type"), "application/x-joint-bob-index+gzip");
  assert.equal(index.headers.get("content-encoding"), null);
  assert.equal((await index.arrayBuffer()).byteLength, 70_000);
  const refused = await fromPeer("POST", "/api/cluster/v2/files/fetch", { projectId: "p1", kind: "project", items: [] });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "Project is not shared with this node" });
  const shares = await fromPeer("GET", "/api/cluster/v2/files/shares");
  assert.equal(((await shares.json()) as { fileSync: { enabled: boolean } }).fileSync.enabled, true);
});

test("a peer that hangs up mid-answer stops the worker's stream instead of leaving it to run", async () => {
  assert.ok(bridge);
  const before = await bridge.call("repair", { share: "project:p1", peer: peerId }) as unknown as { produced: number; finalized: number };
  const controller = new AbortController();
  const response = await fromPeer("GET", "/api/cluster/v2/files/index?projectId=p1&kind=project&since=0&bytes=4000000000", undefined, { signal: controller.signal });
  const reader = response.body!.getReader();
  let read = 0;
  while (read < 2 * 1024 * 1024) read += (await reader.read()).value!.byteLength;
  controller.abort();
  let now = before;
  const deadline = Date.now() + 10_000;
  while (now.finalized === before.finalized && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = await bridge.call("repair", { share: "project:p1", peer: peerId }) as unknown as typeof now;
  }
  assert.equal(now.finalized, before.finalized + 1, "the service's body was closed");
  assert.ok(now.produced - before.produced < 64 * 1024 * 1024, `the worker produced ${now.produced - before.produced} bytes for a reader that took ${read}`);
});

test("once the engine stops, the routes are off again", async () => {
  assert.ok(bridge);
  await bridge.stop();
  bridge = undefined;
  assert.equal(servingBridge(), undefined);
  const status = await fromPeer("POST", "/api/cluster/v2/files/status", { projectId: "p1" });
  assert.equal(status.status, 503);
});

test("in-thread, a serve answer streams with flow control, and service failures become answers", async (t) => {
  const worker = createInThreadWorker({ nodeId: localId, dataDir: path.join(directory, "in-thread"), clock: systemClock, random: Math.random, watch: false });
  t.after(() => worker.stop());
  const service = worker.core.service as { serve: unknown };
  service.serve = async (_peer: string, endpoint: string) => {
    if (endpoint === "fetch") throw Object.assign(new Error("Not available yet"), { code: "unavailable" });
    if (endpoint === "file") throw Object.assign(new Error("Project is not shared with this node"), { statusCode: 403 });
    throw new Error("disk on fire at /home/someone/secret");
  };
  assert.deepEqual(await worker.serve({ peer: peerId, endpoint: "fetch", body: {} }), { status: 501, headers: {}, json: { error: "Not available in this phase" } });
  assert.deepEqual(await worker.serve({ peer: peerId, endpoint: "file", body: {} }), { status: 403, headers: {}, json: { error: "Project is not shared with this node" } });
  assert.deepEqual(await worker.serve({ peer: peerId, endpoint: "status", body: {} }), { status: 500, headers: {}, json: { error: "File sync could not answer" } }, "no internal detail reaches the peer");
  let produced = 0;
  let consumed = 0;
  let ahead = 0;
  service.serve = async () => ({
    status: 200, headers: { "content-type": "application/octet-stream" },
    body: (async function* () { for (const chunk of pattern(6 * 1024 * 1024)) { produced += chunk.length; ahead = Math.max(ahead, produced - consumed); yield chunk; } })(),
  });
  const answer = await worker.serve({ peer: peerId, endpoint: "index", query: { projectId: "p1" } });
  assert.equal(answer.status, 200);
  const hash = createHash("sha256");
  for await (const chunk of answer.body!) {
    hash.update(chunk);
    consumed += chunk.byteLength;
    if (consumed % (512 * 1024) === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(consumed, 6 * 1024 * 1024);
  assert.equal(hash.digest("hex"), sha256(pattern(6 * 1024 * 1024)));
  assert.ok(ahead <= STREAM_WINDOW_BYTES + 2 * 64 * 1024, `the worker ran ${ahead} bytes ahead of its reader`);
});
