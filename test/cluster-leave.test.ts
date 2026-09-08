import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let nodeA: SeededNode;
let nodeB: SeededNode;
let servers: ChildProcess[] = [];
let sessionA: SignedIn;
let sessionB: SignedIn;

test.before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-cluster-leave-"));
  environment = await seedDevEnvironment(root, 2);
  [nodeA, nodeB] = environment.nodes;
  for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
  [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
});

test.after(async () => {
  await Promise.all(servers.map((server) => stopDevNode(server)));
  if (root) await rm(root, { recursive: true, force: true });
});

async function untilHealthy(node: SeededNode): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await fetch(`${node.url}/api/health`)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${node.name} did not become healthy`);
}

/** Membership converges through the outbox, so a side effect on the peer is polled. */
async function untilPeerCount(node: SeededNode, session: SignedIn, expected: number, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let latest = -1;
  while (Date.now() < deadline) {
    const response = await api<{ peers: Array<{ id: string }> }>(node, session, "GET", "/cluster/peers");
    latest = response.body.peers.length;
    if (latest === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${what}; last saw ${latest} peers`);
}

test("a node cannot leave while a peer is unreachable", async () => {
  await stopDevNode(servers[0]);
  const left = await api(nodeB, sessionB, "POST", "/cluster/leave");
  assert.equal(left.status, 500);
  const after = await api<{ peers: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/cluster/peers");
  assert.equal(after.body.peers.length, 1, "the local pairing remains intact");
  servers[0] = await startDevNode(environment, nodeA);
  await untilHealthy(nodeA);
});

test("a node can leave the cluster on its own and both sides forget the pairing", async () => {
  const before = await api<{ peers: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/cluster/peers");
  assert.equal(before.body.peers.length, 1, "node B starts paired with node A");

  const left = await api<{ notified: number }>(nodeB, sessionB, "POST", "/cluster/leave");
  assert.equal(left.status, 200, JSON.stringify(left.body));

  const after = await api<{ peers: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/cluster/peers");
  assert.equal(after.body.peers.length, 0, "node B holds no peers after leaving");
  await untilPeerCount(nodeA, sessionA, 0, "node A should drop the departed node");
});

test("leaving again is a harmless no-op", async () => {
  const left = await api(nodeB, sessionB, "POST", "/cluster/leave");
  assert.equal(left.status, 200);
  const after = await api<{ peers: Array<{ id: string }> }>(nodeB, sessionB, "GET", "/cluster/peers");
  assert.equal(after.body.peers.length, 0);
});
