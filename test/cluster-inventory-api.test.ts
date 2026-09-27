// Settings > Updates draws one row per node from this endpoint: this node plus every
// active twin. An unreachable twin still has to arrive with the name it was paired
// under — a row that can only show an opaque peer id tells nobody which machine is missing.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface InventoryView {
  local: { id: string; name: string; url: string };
  remote: Array<{ peerId: string; name: string; url: string; lastSeenAt: string | null; reachable: boolean; error?: string }>;
}

let root: string;
let environment: DevEnvironment;
let nodeA: SeededNode;
let nodeB: SeededNode;
let servers: ChildProcess[] = [];
let session: SignedIn;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-inventory-"));
  environment = await seedDevEnvironment(root, 2);
  [nodeA, nodeB] = environment.nodes;
  servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  await pairTwinNodes(environment);
  session = await signIn(environment, nodeA);
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(servers.map((server) => stopDevNode(server)));
  if (root) await rm(root, { recursive: true, force: true });
});

test("the inventory names an unreachable twin instead of returning only its id", async () => {
  const online = await api<InventoryView>(nodeA, session, "GET", "/cluster/inventory");
  assert.equal(online.status, 200);
  assert.deepEqual(online.body.remote.map((peer) => [peer.peerId, peer.reachable]), [[nodeB.nodeId, true]], "a running twin is reachable");

  // Stop node B, so its twin row is genuinely unreachable.
  await stopDevNode(servers[1]);
  const inventory = await api<InventoryView>(nodeA, session, "GET", "/cluster/inventory");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.local.name, nodeA.name);
  assert.equal(inventory.body.remote.length, 1, "node A lists its one twin");

  const [peer] = inventory.body.remote;
  assert.equal(peer.peerId, nodeB.nodeId);
  assert.equal(peer.reachable, false, "node B is stopped");
  assert.equal(peer.name, nodeB.name, "an offline twin still carries the name it was paired under");
  assert.equal(peer.url, nodeB.url, "an offline twin still carries the address it was paired at");
  assert.ok(peer.error, "an offline twin explains why it could not be reached");
});
