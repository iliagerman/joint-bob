// Two-node sanity suite: seeds the paired dev cluster `npm run dev:cluster`
// starts, runs both nodes for real, and checks the cluster features a single
// node cannot exercise — pairing, shared project inventory, project aliasing,
// live node-to-node traffic, and handing a conversation to the other node.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface PeerView { id: string; name: string; url: string; online: boolean; lastSeenAt?: string; tokenConfigured: boolean }
interface InventoryView { node: { id: string }; projects: Array<{ project: { id: string; name: string }; aliases: string[] }> }
interface SessionView { id: string; path: string; title: string; harnessId: string; executionNodeId?: string }

let root: string;
let environment: DevEnvironment;
let nodeA: SeededNode;
let nodeB: SeededNode;
let servers: ChildProcess[] = [];
let sessionA: SignedIn;
let sessionB: SignedIn;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-cluster-"));
  environment = await seedDevEnvironment(root, 2);
  [nodeA, nodeB] = environment.nodes;
  servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(servers.map((server) => stopDevNode(server)));
  if (root) await rm(root, { recursive: true, force: true });
});

test("both nodes serve the same seeded projects to their own signed-in session", async () => {
  const [projectsA, projectsB] = await Promise.all([
    api<{ projects: Array<{ name: string }> }>(nodeA, sessionA, "GET", "/projects"),
    api<{ projects: Array<{ name: string }> }>(nodeB, sessionB, "GET", "/projects"),
  ]);
  assert.equal(projectsA.status, 200);
  assert.equal(projectsB.status, 200);
  assert.deepEqual(
    projectsA.body.projects.map((project) => project.name).sort(),
    projectsB.body.projects.map((project) => project.name).sort(),
  );
  assert.equal(projectsA.body.projects.length, 3);
});

test("each node is paired with the other and holds its machine token", async () => {
  const [peersA, peersB] = await Promise.all([
    api<{ peers: PeerView[] }>(nodeA, sessionA, "GET", "/cluster/peers"),
    api<{ peers: PeerView[] }>(nodeB, sessionB, "GET", "/cluster/peers"),
  ]);
  assert.equal(peersA.body.peers.length, 1, "node A has exactly one peer");
  assert.equal(peersB.body.peers.length, 1, "node B has exactly one peer");
  assert.equal(peersA.body.peers[0].id, nodeB.nodeId);
  assert.equal(peersA.body.peers[0].url, nodeB.url);
  assert.equal(peersB.body.peers[0].id, nodeA.nodeId);
  assert.equal(peersB.body.peers[0].url, nodeA.url);
  assert.ok(peersA.body.peers[0].tokenConfigured && peersB.body.peers[0].tokenConfigured, "both sides hold a machine token");
});

test("every project on one node is aliased to its twin on the other", async () => {
  const inventory = await api<InventoryView>(nodeA, sessionA, "GET", "/cluster/local-inventory");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.node.id, nodeA.nodeId);
  for (const entry of inventory.body.projects) {
    const twin = nodeB.projects.find((project) => project.name === entry.project.name);
    assert.ok(twin, `node B has a twin of ${entry.project.name}`);
    assert.ok(entry.aliases.includes(twin.id), `${entry.project.name} is aliased to node B's copy`);
  }
});

test("the two nodes reach each other over the network with their machine tokens", async () => {
  const lastSeen = async (): Promise<number> => {
    const peers = (await api<{ peers: PeerView[] }>(nodeA, sessionA, "GET", "/cluster/peers")).body.peers;
    const peer = peers.find((candidate) => candidate.id === nodeB.nodeId);
    assert.ok(peer, "node A still has node B as a peer");
    return new Date(peer.lastSeenAt ?? 0).getTime();
  };

  // Seeding stamps `lastSeenAt` once. Only a real call from the peer moves it on,
  // so a later timestamp proves the nodes are actually talking, not just paired
  // on paper. The running servers poll each other every few seconds.
  const before = await lastSeen();
  const deadline = Date.now() + 45_000;
  let latest = before;
  while (latest <= before && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    latest = await lastSeen();
  }
  assert.ok(latest > before, `node B checked in with node A (last seen moved from ${before} to ${latest})`);
});

test("a conversation hands over to the other node", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessions = await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`);
  const conversation = sessions.body.sessions.find((candidate) => candidate.harnessId === "pi");
  assert.ok(conversation, "node A lists a Pi conversation to hand over");

  const transfer = await api<{ error?: string }>(nodeA, sessionA, "POST", `/projects/${project.id}/sessions/transfer`, {
    peerId: nodeB.nodeId,
    sessionId: conversation.id,
    sessionPath: conversation.path,
  });
  assert.equal(transfer.status, 200, `transfer succeeded (${JSON.stringify(transfer.body)})`);

  // The receiving node now owns the run, which is what the UI shows as the
  // conversation's execution node.
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const afterTransfer = await api<{ sessions: SessionView[] }>(nodeB, sessionB, "GET", `/projects/${twin.id}/sessions`);
  const moved = afterTransfer.body.sessions.find((candidate) => candidate.id === conversation.id);
  assert.ok(moved, "node B lists the conversation after the handover");
  assert.equal(moved.executionNodeId, nodeB.nodeId, "node B is now the execution node");
});

interface ShortcutView { binding: string; projectId: string; engine: string; sessionId: string }

/** The outbox flushes on a timer, so cluster state is polled rather than awaited. */
async function untilShortcuts(
  node: SeededNode,
  session: SignedIn,
  matches: (shortcuts: ShortcutView[]) => boolean,
  what: string,
): Promise<ShortcutView[]> {
  const deadline = Date.now() + 30_000;
  let latest: ShortcutView[] = [];
  while (Date.now() < deadline) {
    const response = await api<{ shortcuts: ShortcutView[] }>(node, session, "GET", "/canvas/shortcuts");
    latest = response.body.shortcuts;
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what}; last saw ${JSON.stringify(latest)}`);
}

test("a canvas shortcut assigned on one node reaches the same account on the other", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessions = await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`);
  const conversation = sessions.body.sessions.find((candidate) => candidate.harnessId === "pi")!;
  // Each node knows the project under its own id, so each speaks its own alias.
  const twinProject = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const target = { projectId: project.id, engine: "pi", sessionId: conversation.id };
  const targetOnB = { projectId: twinProject.id, engine: "pi", sessionId: conversation.id };

  const assigned = await api<{ shortcuts: ShortcutView[] }>(nodeA, sessionA, "PUT", "/canvas/shortcuts/3", target);
  assert.equal(assigned.status, 200);
  assert.deepEqual(assigned.body.shortcuts.map((row) => row.binding), ["3"]);

  const onB = await untilShortcuts(nodeB, sessionB, (rows) => rows.some((row) => row.binding === "3"),
    "node B never received the binding");
  assert.equal(onB.find((row) => row.binding === "3")!.sessionId, conversation.id);

  // Moving the binding on the other node leaves exactly one key for the conversation.
  const moved = await api<{ shortcuts: ShortcutView[] }>(nodeB, sessionB, "PUT", "/canvas/shortcuts/K", targetOnB);
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.shortcuts.map((row) => row.binding), ["K"]);
  const backOnA = await untilShortcuts(nodeA, sessionA, (rows) => rows.length === 1 && rows[0].binding === "K",
    "node A still shows the displaced binding");
  assert.deepEqual(backOnA.map((row) => row.binding), ["K"]);

  // Closing the conversation on either node gives the key back everywhere.
  const released = await api<{ shortcuts: ShortcutView[] }>(nodeA, sessionA, "POST", "/canvas/shortcuts/release", target);
  assert.equal(released.status, 200);
  assert.deepEqual(released.body.shortcuts, []);
  await untilShortcuts(nodeB, sessionB, (rows) => rows.length === 0, "node B still holds the released binding");
});
