import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { workerLaunch } from "../src/file-sync/bridge.js";
import { forgetPeerFileSync, peerFileSync } from "../src/file-sync/peers.js";
import { app } from "../src/server/state.js";

/* /hello carries what each side's file sync engine can do (design §1 Capability): the body says it
   about the sender, the answer about the receiver. Older nodes send {} and answer {ok: true}, and
   ignore what they do not know; both mean "no engine" here. The engine runs against a stand-in
   worker (test/fixtures/file-sync-control-worker.ts) that logs the ops it gets. */

const NEW_SENDER = "00000000-0000-4000-8000-0000000000a1";
const OLD_SENDER = "00000000-0000-4000-8000-0000000000a2";
const OLD_RECEIVER = "00000000-0000-4000-8000-0000000000b1";
const NEW_RECEIVER = "00000000-0000-4000-8000-0000000000b2";
const CLUSTER = "10000000-0000-4000-8000-0000000000c1";
const OWN_ORIGIN = "http://127.0.0.1:22766";

const saved = Object.fromEntries(["JOINT_BOB_FILE_SYNC", "JOINT_BOB_FILE_SYNC_LISTEN", "JOINT_BOB_FILE_SYNC_PORT"].map((name) => [name, process.env[name]]));
// Loopback stands in for the tailnet: with a listen address chosen, private and loopback origins count.
Object.assign(process.env, { JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1", JOINT_BOB_FILE_SYNC_PORT: "22766" });
const work = await mkdtemp(path.join(os.tmpdir(), "jb-file-sync-hello-"));
const log = path.join(work, "ops.jsonl");

app.use(express.json());
// requireHttpAuth's part: a verified signature names the sending machine.
app.use((request, response, next) => {
  const node = request.header("x-test-node");
  if (node) { response.locals.machineAuth = true; response.locals.machineNodeId = node; }
  next();
});
await import("../src/server/routes/cluster.js");
const { announceReturn } = await import("../src/server/peer-return.js");
const index = await import("../src/file-sync/index.js");
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const helloUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cluster/v2/hello`;

index.useFileSyncWorkerForTests({ launch: workerLaunch(new URL("./fixtures/file-sync-control-worker.js", import.meta.url)), workerData: { log, origins: [OWN_ORIGIN] } });

const peers: Server[] = [];
test.after(async () => {
  await index.stopFileSync();
  index.useFileSyncWorkerForTests(undefined);
  forgetPeerFileSync();
  await Promise.all([server, ...peers].map((listening) => new Promise((resolve) => listening.close(resolve))));
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(work, { recursive: true, force: true });
});

async function stubOps(): Promise<Array<{ op: string; args: Record<string, unknown> }>> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${timeoutMs} ms: ${JSON.stringify(value).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function hello(sender: string | undefined, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(helloUrl, { method: "POST", headers: { "Content-Type": "application/json", ...(sender ? { "x-test-node": sender } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const runningAnswer = { ok: true, fileSync: { protocol: 1, minProtocol: 1, origins: [OWN_ORIGIN], enabled: true } };

test("the engine starts against the stand-in worker", { timeout: 30_000 }, async () => {
  // A node that did cluster work has its identity; the worker gets its signing key.
  getOrCreateClusterIdentity(await clusterV2Database(), (await getClusterNode()).id);
  await index.startFileSync();
  await until(stubOps, (ops) => ops.some((entry) => entry.op === "announce"), "the worker's first configure and announce");
});

test("a hello from a new sender is noted, starts a catch-up with it, and is answered with this node's engine", { timeout: 30_000 }, async () => {
  const answer = await hello(NEW_SENDER, { fileSync: { protocol: 1, minProtocol: 1, enabled: true, origins: ["http://127.0.0.1:23001", "http://169.254.169.254:80"], addedLater: { x: 1 } } });
  assert.deepEqual(answer, { status: 200, body: runningAnswer });
  const { at, ...known } = peerFileSync(NEW_SENDER)!;
  assert.deepEqual(known, { protocol: 1, minProtocol: 1, enabled: true, origins: ["http://127.0.0.1:23001"], via: "hello" }, "a link-local origin is never used");
  assert.ok(Date.now() - at < 10_000);
  const presence = await until(stubOps, (ops) => ops.some((entry) => entry.op === "peerPresence"), "peerPresence");
  assert.deepEqual(presence.filter((entry) => entry.op === "peerPresence").map((entry) => entry.args), [{ peer: NEW_SENDER, present: true, origins: ["http://127.0.0.1:23001"] }]);
  // Its relay's "back online" usually comes with it: the same peer and origins within seconds are one catch-up.
  assert.deepEqual(await hello(NEW_SENDER, { fileSync: { protocol: 1, origins: ["http://127.0.0.1:23001"] } }), { status: 200, body: runningAnswer });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await stubOps()).filter((entry) => entry.op === "peerPresence").length, 1);
});

test("an old sender's empty hello gets the same answer and marks the sender as having no engine", async () => {
  assert.deepEqual(await hello(OLD_SENDER, {}), { status: 200, body: runningAnswer });
  const { at: _at, ...known } = peerFileSync(OLD_SENDER)!;
  assert.deepEqual(known, { protocol: 0, origins: [], via: "hello" });
  assert.deepEqual(await hello(OLD_SENDER, [1, 2]), { status: 200, body: runningAnswer }, "whatever the body, the hello itself never fails");
  assert.deepEqual(await hello(undefined, {}), { status: 401, body: { error: "Unauthorized" } }, "an unsigned hello is refused as before");
});

interface Received { target: string; body: unknown; signed: boolean }

/** A peer's /hello: an old node ignores the body and answers {ok: true}; a new one adds its own part. */
async function fakePeer(answer: unknown): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const peer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/cluster/v2/hello") {
        received.push({ target: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"), signed: Boolean(request.headers.authorization) });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answer));
        return;
      }
      // Quick-note and hub catch-ups that follow a return are not this test's business.
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
    });
  });
  peers.push(peer);
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(peer.address() as AddressInfo).port}`, received };
}

test("a returning node says hello with its engine, reads old and new answers, then has its worker ask peers what changed", { timeout: 60_000 }, async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const oldReceiver = await fakePeer({ ok: true });
  const newReceiver = await fakePeer({ ok: true, fileSync: { protocol: 1, minProtocol: 1, enabled: true, origins: ["http://127.0.0.1:23002"] } });
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  createSharingCluster(db, { id: CLUSTER, name: "hello" }, local);
  for (const [node, peer] of [[OLD_RECEIVER, oldReceiver], [NEW_RECEIVER, newReceiver]] as const) {
    addSharingMember(db, CLUSTER, local, node, getSharingCluster(db, CLUSTER).managerEpoch);
    recordPeerEndpoint(db, { kind: "cluster", id: CLUSTER }, { nodeId: node, name: `node ${node.slice(-2)}`, url: peer.url });
  }
  const announcesBefore = (await stubOps()).filter((entry) => entry.op === "announce").length;
  await announceReturn(true);
  const sent = { fileSync: { protocol: 1, minProtocol: 1, origins: [OWN_ORIGIN], enabled: true } };
  assert.deepEqual(oldReceiver.received, [{ target: "/api/cluster/v2/hello", body: sent, signed: true }], "an old receiver gets the same body and ignores it");
  assert.deepEqual(newReceiver.received, [{ target: "/api/cluster/v2/hello", body: sent, signed: true }]);
  const { at: _old, ...fromOld } = peerFileSync(OLD_RECEIVER)!;
  const { at: _new, ...fromNew } = peerFileSync(NEW_RECEIVER)!;
  assert.deepEqual(fromOld, { protocol: 0, origins: [], via: "answer" }, "{ok: true} alone: no engine there");
  assert.deepEqual(fromNew, { protocol: 1, minProtocol: 1, enabled: true, origins: ["http://127.0.0.1:23002"], via: "answer" });
  const ops = await until(stubOps, (list) => list.filter((entry) => entry.op === "announce").length > announcesBefore, "the announce after the hellos");
  assert.deepEqual(ops.filter((entry) => entry.op === "announce").slice(announcesBefore).map((entry) => entry.args), [{ slept: true }]);
});

test("with file sync off a node still answers and sends its part of /hello, saying so", { timeout: 30_000 }, async () => {
  await index.stopFileSync();
  process.env.JOINT_BOB_FILE_SYNC = "0";
  const presenceBefore = (await stubOps()).filter((entry) => entry.op === "peerPresence").length;
  const offAnswer = { ok: true, fileSync: { protocol: 1, minProtocol: 1, origins: [], enabled: false } };
  assert.deepEqual(await hello(NEW_SENDER, { fileSync: { protocol: 1, origins: ["http://127.0.0.1:23003"] } }), { status: 200, body: offAnswer });
  assert.deepEqual(peerFileSync(NEW_SENDER)?.origins, ["http://127.0.0.1:23003"], "what peers say is kept for when the engine starts");
  assert.deepEqual(await index.fileSyncHelloBody(), { fileSync: offAnswer.fileSync });
  assert.equal((await stubOps()).filter((entry) => entry.op === "peerPresence").length, presenceBefore, "no worker, no catch-up");
});
