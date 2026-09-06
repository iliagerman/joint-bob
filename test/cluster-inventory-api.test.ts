// The Cluster tab in Settings is the only place a person can see whether the other
// machines are reachable. It draws one row per node from this endpoint, so an
// unreachable peer still has to arrive with the name it was paired under — a row
// that can only show an opaque peer id tells nobody which machine is missing.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface InventoryView {
  local: { id: string; name: string; url: string };
  remote: Array<{ peerId: string; name: string; url: string; lastSeenAt: string | null; reachable: boolean; error?: string }>;
}

let root: string;
let environment: DevEnvironment;
let nodeA: SeededNode;
let nodeB: SeededNode;
let server: ChildProcess;
let session: SignedIn;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-inventory-"));
  environment = await seedDevEnvironment(root, 2);
  [nodeA, nodeB] = environment.nodes;
  // Only node A runs, so its paired peer is genuinely unreachable.
  server = await startDevNode(environment, nodeA);
  session = await signIn(environment, nodeA);
}, { timeout: 120_000 });

after(async () => {
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("the inventory names an unreachable peer instead of returning only its id", async () => {
  const inventory = await api<InventoryView>(nodeA, session, "GET", "/cluster/inventory");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.local.name, nodeA.name);
  assert.equal(inventory.body.remote.length, 1, "node A lists its one paired peer");

  const [peer] = inventory.body.remote;
  assert.equal(peer.peerId, nodeB.nodeId);
  assert.equal(peer.reachable, false, "node B is not running");
  assert.equal(peer.name, nodeB.name, "an offline peer still carries the name it was paired under");
  assert.equal(peer.url, nodeB.url, "an offline peer still carries the address it was paired at");
  assert.ok(peer.error, "an offline peer explains why it could not be reached");
});
