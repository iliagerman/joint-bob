// Two-node sanity suite: seeds the paired dev cluster `npm run dev:cluster`
// starts, runs both nodes for real, and checks the cluster features a single
// node cannot exercise — pairing, shared project inventory, project aliasing,
// live node-to-node traffic, and continuing a conversation on the other
// node through ownership takeover.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface PeerView { id: string; name: string; url: string; online: boolean; lastSeenAt?: string; tokenConfigured: boolean }
interface InventoryView { node: { id: string }; projects: Array<{ project: { id: string; name: string }; aliases: string[] }> }
interface SessionView { id: string; path: string; title: string; harnessId: string; executionNodeId?: string }
interface PinsView { projectIds: string[]; conversations: Array<{ projectId: string; engine: string; sessionId: string }> }

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

test("pin and unpin events replicate by stable conversation identity and wake remote tabs", async () => {
  const projectA = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const projectB = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessions = await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${projectA.id}/sessions`);
  const conversation = sessions.body.sessions.find((candidate) => candidate.harnessId === "pi")!;
  const watchUrl = new URL("/ws", nodeB.url.replace(/^http/, "ws"));
  watchUrl.searchParams.set("projectId", projectB.id);
  watchUrl.searchParams.set("sessionPath", "watch");
  const socket = new WebSocket(watchUrl, { headers: { Cookie: sessionB.cookie, Origin: nodeB.url } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watch socket did not become ready")), 10_000);
      socket.on("message", (raw) => {
        if ((JSON.parse(raw.toString()) as { type?: string }).type !== "watchReady") return;
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", reject);
    });
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("remote tab did not receive pinsChanged")), 15_000);
      socket.on("message", (raw) => {
        if ((JSON.parse(raw.toString()) as { type?: string }).type !== "pinsChanged") return;
        clearTimeout(timeout);
        resolve();
      });
    });
    const pinned = await api<PinsView>(nodeA, sessionA, "PUT", "/pins", {
      kind: "conversation", projectId: projectA.id, engine: "pi", sessionId: conversation.id, pinned: true,
    });
    assert.equal(pinned.status, 200);
    await changed;

    const deadline = Date.now() + 15_000;
    let remote: PinsView = { projectIds: [], conversations: [] };
    while (Date.now() < deadline) {
      remote = (await api<PinsView>(nodeB, sessionB, "GET", "/pins")).body;
      if (remote.conversations.some((pin) => pin.projectId === projectB.id && pin.engine === "pi" && pin.sessionId === conversation.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.deepEqual(remote.conversations, [{ projectId: projectB.id, engine: "pi", sessionId: conversation.id }]);

    const unpinned = await api<PinsView>(nodeB, sessionB, "PUT", "/pins", {
      kind: "conversation", projectId: projectB.id, engine: "pi", sessionId: conversation.id, pinned: false,
    });
    assert.equal(unpinned.status, 200);
    while (Date.now() < deadline + 15_000) {
      const local = (await api<PinsView>(nodeA, sessionA, "GET", "/pins")).body;
      if (!local.conversations.length) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("unpin did not replicate back to node A");
  } finally {
    socket.close();
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

test("a conversation continues on the other node through takeover", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessions = await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`);
  const conversation = sessions.body.sessions.find((candidate) => candidate.harnessId === "pi");
  assert.ok(conversation, "node A lists a Pi conversation to take over");

  // Takeover assumes Syncthing already replicated the transcript, so the
  // destination continues from its own filesystem instead of receiving a copy.
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const takeover = await api<{ ownership?: { ownerNodeId?: string } }>(nodeB, sessionB, "POST", `/projects/${twin.id}/sessions/take-ownership`, {
    peerId: nodeB.nodeId,
    sessionId: conversation.id,
    sessionPath: conversation.path,
  });
  assert.equal(takeover.status, 200, `takeover succeeded (${JSON.stringify(takeover.body)})`);
  assert.equal(takeover.body.ownership?.ownerNodeId, nodeB.nodeId, "node B now owns the conversation");

  // The new owner lists itself as the execution node, and the replication
  // push fences the previous owner's copy without deleting it.
  const untilOwnedBy = async (node: SeededNode, session: SignedIn): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const listing = await api<{ sessions: SessionView[] }>(node, session, "GET", `/projects/${node === nodeB ? twin.id : project.id}/sessions`);
      const entry = listing.body.sessions.find((candidate) => candidate.id === conversation.id);
      assert.ok(entry, `the conversation is still listed on ${node.key}`);
      if (entry.executionNodeId === nodeB.nodeId) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("timed out waiting for both nodes to agree node B owns the conversation");
  };
  await untilOwnedBy(nodeB, sessionB);
  await untilOwnedBy(nodeA, sessionA);
});

test("taking over a conversation whose transcript never synchronized fails instead of owning an empty card", async () => {
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  // A record replicated from the owner while the transcript file itself never
  // arrived (stalled synchronization) lists as a draft card with no content.
  // The takeover must refuse it instead of committing ownership of a
  // conversation this node cannot actually open.
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const seed = new DatabaseSync(path.join(nodeB.dataDir, "node.db"));
  try {
    seed.exec("PRAGMA busy_timeout = 5000;");
    seed.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'pi', ?, ?, ?, ?)")
      .run(twin.id, sessionId, now, now, nodeA.nodeId);
    seed.prepare("INSERT INTO conversation_ownership (engine, session_id, owner_node_id, epoch, status, transfer_to_node_id) VALUES ('pi', ?, ?, 1, 'owned', NULL)")
      .run(sessionId, nodeA.nodeId);
  } finally { seed.close(); }

  const listing = await api<{ sessions: SessionView[] }>(nodeB, sessionB, "GET", `/projects/${twin.id}/sessions`);
  const card = listing.body.sessions.find((candidate) => candidate.id === sessionId);
  assert.ok(card, "the replicated record lists a draft card on node B");

  const takeover = await api<{ error?: string }>(nodeB, sessionB, "POST", `/projects/${twin.id}/sessions/take-ownership`, {
    peerId: nodeB.nodeId,
    sessionId,
    sessionPath: card.path,
  });
  assert.equal(takeover.status, 409, `takeover of a transcript-less draft must fail, got ${JSON.stringify(takeover.body)}`);
  assert.match(takeover.body.error ?? "", /synchroniz/i);

  const verify = new DatabaseSync(path.join(nodeB.dataDir, "node.db"));
  try {
    const owner = verify.prepare("SELECT owner_node_id FROM conversation_ownership WHERE engine = 'pi' AND session_id = ?").get(sessionId) as { owner_node_id: string } | undefined;
    assert.equal(owner?.owner_node_id, nodeA.nodeId, "ownership must not move without the transcript");
  } finally { verify.close(); }
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
