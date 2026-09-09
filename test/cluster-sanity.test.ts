// Two-node sanity suite: seeds the paired dev cluster `npm run dev:cluster`
// starts, runs both nodes for real, and checks the cluster features a single
// node cannot exercise — pairing, shared project inventory, project aliasing,
// live node-to-node traffic, and continuing a conversation on the other
// node through ownership takeover.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
interface RecentSessionView { recentSessions: Array<{ projectId: string; engine: string; sessionId: string; title: string; openedAt: string }> }

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

// This verifies peer discovery from the harness's shared managed fixture, not Syncthing transport.
test("published external skills are discovered by a peer from the shared managed fixture", async () => {
  const source = path.join(root, "external-skills", "cluster-skill");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: cluster-skill\ndescription: first\n---\n");
  assert.equal((await api(nodeA, sessionA, "POST", "/settings/skills/sync", { paths: [source] })).status, 200);
  const project = nodeB.projects[0];
  const first = await api<{ skills: Array<{ name: string; description: string }> }>(nodeB, sessionB, "GET", `/projects/${project.id}/skills`);
  assert.ok(first.body.skills.some((skill) => skill.name === "cluster-skill" && skill.description === "first"));
  await writeFile(path.join(source, "SKILL.md"), "---\nname: cluster-skill\ndescription: second\n---\n");
  assert.equal((await api(nodeA, sessionA, "POST", "/settings/skills/sync", { paths: [source] })).status, 200);
  const second = await api<{ skills: Array<{ name: string; description: string }> }>(nodeB, sessionB, "GET", `/projects/${project.id}/skills`);
  assert.ok(second.body.skills.some((skill) => skill.name === "cluster-skill" && skill.description === "second"));
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

test("saving this node's identity updates every peer before the request completes", async () => {
  const renamedUrl = `http://localhost:${new URL(nodeA.url).port}`;
  const saved = await api<{ node: { name: string; url: string } }>(nodeA, sessionA, "PUT", "/cluster/node", {
    name: "Renamed node A",
    url: renamedUrl,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.node.name, "Renamed node A");
  assert.equal(saved.body.node.url, renamedUrl);

  const peersB = await api<{ peers: PeerView[] }>(nodeB, sessionB, "GET", "/cluster/peers");
  const nodeAOnB = peersB.body.peers.find((peer) => peer.id === nodeA.nodeId);
  assert.equal(nodeAOnB?.name, "Renamed node A");
  assert.equal(nodeAOnB?.url, renamedUrl);
});

test("workspace secret attachments replicate to the same workspace on a peer", async () => {
  const created = await api<{ account: { id: string } }>(nodeA, sessionA, "POST", "/secrets/accounts", {
    label: "Shared workspace secret",
    provider: "custom",
    replicate: true,
    variables: [{ name: "SHARED_TOKEN", kind: "value", value: "cluster-test-token" }],
  });
  assert.equal(created.status, 201);

  const attached = await api<{ accountIds: string[] }>(nodeA, sessionA, "PUT", "/secrets/scopes/workspace/personal", { accountIds: [created.body.account.id] });
  assert.equal(attached.status, 200);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const remote = await api<{ accountIds: string[] }>(nodeB, sessionB, "GET", "/secrets/scopes/workspace/personal");
    if (remote.body.accountIds.includes(created.body.account.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail("workspace attachment did not replicate to node B");
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

test("recent conversations merge concurrent opens, map project twins, and wake remote tabs", async () => {
  const projectA = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const projectB = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessions = (await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${projectA.id}/sessions`)).body.sessions.filter((entry) => entry.harnessId === "pi");
  const [first, second] = sessions;
  assert.ok(first && second, "seeded project has two Pi conversations");
  const watchUrl = new URL("/ws", nodeB.url.replace(/^http/, "ws"));
  watchUrl.searchParams.set("projectId", projectB.id);
  watchUrl.searchParams.set("sessionPath", "watch");
  const socket = new WebSocket(watchUrl, { headers: { Cookie: sessionB.cookie, Origin: nodeB.url } });
  const entry = (projectId: string, session: SessionView, openedAt: string) => ({ projectId, engine: "pi", sessionId: session.id, sessionPath: session.path, title: session.title, openedAt, updatedAt: null });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watch socket did not become ready")), 10_000);
      socket.on("message", (raw) => { if ((JSON.parse(raw.toString()) as { type?: string }).type === "watchReady") { clearTimeout(timeout); resolve(); } });
      socket.once("error", reject);
    });
    const remoteChanged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("remote tab did not receive recentsChanged")), 15_000);
      socket.on("message", (raw) => { if ((JSON.parse(raw.toString()) as { type?: string }).type === "recentsChanged") { clearTimeout(timeout); resolve(); } });
    });
    await Promise.all([
      api(nodeA, sessionA, "PUT", "/recents", entry(projectA.id, first, "2026-09-02T12:00:00.000Z")),
      api(nodeB, sessionB, "PUT", "/recents", entry(projectB.id, second, "2026-09-02T13:00:00.000Z")),
    ]);
    await remoteChanged;
    const deadline = Date.now() + 30_000;
    let recentsA: RecentSessionView = { recentSessions: [] };
    let recentsB: RecentSessionView = { recentSessions: [] };
    while (Date.now() < deadline) {
      const [a, b] = await Promise.all([api<RecentSessionView>(nodeA, sessionA, "GET", "/recents"), api<RecentSessionView>(nodeB, sessionB, "GET", "/recents")]);
      recentsA = a.body;
      recentsB = b.body;
      if (recentsA.recentSessions.some((row) => row.sessionId === first.id) && recentsA.recentSessions.some((row) => row.sessionId === second.id)
        && recentsB.recentSessions.some((row) => row.projectId === projectB.id && row.sessionId === first.id)
        && recentsB.recentSessions.some((row) => row.sessionId === second.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(recentsA.recentSessions.some((row) => row.sessionId === first.id), "node A received its first recent");
    assert.ok(recentsA.recentSessions.some((row) => row.sessionId === second.id), "node A received node B's concurrent recent");
    assert.ok(recentsB.recentSessions.some((row) => row.sessionId === second.id), "node B retained its concurrent recent");
    assert.ok(recentsB.recentSessions.some((row) => row.projectId === projectB.id && row.sessionId === first.id), "node B mapped node A's recent to its project twin");
    const removed = await api(nodeB, sessionB, "DELETE", "/recents", { projectId: projectB.id, engine: "pi", sessionId: first.id });
    assert.equal(removed.status, 200);
    while (Date.now() < deadline + 30_000) {
      const rows = (await api<RecentSessionView>(nodeA, sessionA, "GET", "/recents")).body.recentSessions;
      if (!rows.some((row) => row.sessionId === first.id)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail("recent delete did not replicate back to node A");
  } finally { socket.close(); }
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

test("taking over an empty conversation succeeds when its owner also has no transcript", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  await Promise.all([
    api(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`),
    api(nodeB, sessionB, "GET", `/projects/${twin.id}/sessions`),
  ]);
  for (const [node, projectId] of [[nodeA, project.id], [nodeB, twin.id]] as const) {
    const seed = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      seed.exec("PRAGMA busy_timeout = 5000;");
      seed.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'pi', ?, ?, ?, ?)")
        .run(projectId, sessionId, now, now, nodeA.nodeId);
      seed.prepare("INSERT INTO conversation_ownership (engine, session_id, owner_node_id, epoch, status, transfer_to_node_id) VALUES ('pi', ?, ?, 1, 'owned', NULL)")
        .run(sessionId, nodeA.nodeId);
    } finally { seed.close(); }
  }

  const takeover = await api<{ ownership?: { ownerNodeId?: string }; error?: string }>(nodeB, sessionB, "POST", `/projects/${twin.id}/sessions/take-ownership`, {
    peerId: nodeB.nodeId,
    sessionId,
    sessionPath: `draft:pi:${sessionId}`,
  });
  assert.equal(takeover.status, 200, `empty conversation takeover failed (${JSON.stringify(takeover.body)})`);
  assert.equal(takeover.body.ownership?.ownerNodeId, nodeB.nodeId);
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

test("cluster inventory reports each node's version and a peer update needs machine auth", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  interface InventoryEntry { peerId: string; reachable: boolean; inventory?: { version: string; updates?: { supported: boolean; activeJob: unknown } } }
  const inventory = await api<{ local: { id: string }; remote: InventoryEntry[] }>(nodeA, sessionA, "GET", "/cluster/inventory");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.remote.length, 1);
  const peer = inventory.body.remote[0];
  assert.ok(peer.reachable, "node B answers its inventory call");
  assert.equal(peer.inventory?.version, manifest.version, "the peer reports its running version");
  assert.equal(peer.inventory?.updates?.supported, false, "a dev node reports itself not update-capable");

  const installUrl = `${nodeB.url}/api/cluster/update/install`;
  const unauthenticated = await fetch(installUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: "9.9.9" }) });
  assert.equal(unauthenticated.status, 401, "the fleet install route rejects session-less callers");

  const { token } = (await api<{ token: string }>(nodeA, sessionA, "GET", "/cluster/invite")).body;
  const machineAuthenticated = await fetch(installUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ version: "9.9.9" }) });
  assert.equal(machineAuthenticated.status, 409, "a paired machine peer reaches the route and the dev checkout refuses");
  assert.match(((await machineAuthenticated.json()) as { error: string }).error, /development checkout/);
});

test("a node opens new conversations while its peer is down, and the claim replicates when it returns", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  await stopDevNode(servers[1]);

  // Claims used to require the cluster coordinator, so a sleeping peer blocked
  // every new conversation. The node must claim locally and let replication
  // carry the claim across once the peer returns.
  const url = new URL("/ws", nodeA.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", project.id);
  url.searchParams.set("sessionPath", "claude:new");
  const socket = new WebSocket(url, { headers: { Cookie: sessionA.cookie, Origin: nodeA.url } });
  let sessionId: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("new conversation did not open while the peer was down")), 15_000);
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString()) as { type?: string; sessionId?: string };
        if (event.type !== "ready") return;
        clearTimeout(timeout);
        sessionId = event.sessionId;
        resolve();
      });
      socket.once("close", (code, reason) => reject(new Error(`socket closed while the peer was down: ${code} ${reason}`)));
      socket.once("error", reject);
    });
    assert.ok(sessionId && sessionId !== "claude:new", `ready reported a concrete session id, got ${sessionId}`);

    const local = new DatabaseSync(path.join(nodeA.dataDir, "node.db"));
    try {
      local.exec("PRAGMA busy_timeout = 5000;");
      const owner = local.prepare("SELECT owner_node_id, status FROM conversation_ownership WHERE engine = 'claude' AND session_id = ?").get(sessionId) as { owner_node_id: string; status: string } | undefined;
      assert.equal(owner?.owner_node_id, nodeA.nodeId, "the offline node owns the conversation it opened");
      assert.equal(owner?.status, "owned");
    } finally { local.close(); }
  } finally { socket.close(); }

  servers[1] = await startDevNode(environment, nodeB);

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const replicated = new DatabaseSync(path.join(nodeB.dataDir, "node.db"));
    try {
      replicated.exec("PRAGMA busy_timeout = 5000;");
      const owner = replicated.prepare("SELECT owner_node_id FROM conversation_ownership WHERE engine = 'claude' AND session_id = ?").get(sessionId) as { owner_node_id: string } | undefined;
      if (owner?.owner_node_id === nodeA.nodeId) return;
    } finally { replicated.close(); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail("the claim did not replicate to node B after it returned");
});

test("queue-transfer refuses a machine peer whose grant excludes the project", async () => {
  const project = nodeA.projects[0];
  const token = (await api<{ token: string }>(nodeB, sessionB, "GET", "/cluster/invite")).body.token;
  const db = new DatabaseSync(path.join(nodeA.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout = 5000;");
  assert.equal(db.prepare("SELECT 1 FROM cluster_project_grants WHERE node_id = ?").get(nodeB.nodeId), undefined);
  try {
    db.prepare("INSERT INTO cluster_project_grants VALUES (?, ?, ?, ?)").run(nodeB.nodeId, "[]", new Date().toISOString(), nodeA.nodeId);
    const response = await fetch(`${nodeA.url}/api/cluster/sessions/queue-transfer`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, engine: "claude", sessionId: "not-a-session" }),
    });
    assert.equal(response.status, 403, await response.clone().text());
    assert.deepEqual(await response.json(), { error: "Project is not shared with this node" });
  } finally {
    db.prepare("DELETE FROM cluster_project_grants WHERE node_id = ?").run(nodeB.nodeId);
    db.close();
  }
});

async function queueTransferFixture() {
  const projectA = nodeA.projects.find((project) => project.name === "Joint Bob")!;
  const projectB = nodeB.projects.find((project) => project.name === "Joint Bob")!;
  const settingsA = (await api<Record<string, unknown>>(nodeA, sessionA, "GET", "/settings")).body;
  const settingsB = (await api<Record<string, unknown>>(nodeB, sessionB, "GET", "/settings")).body;
  const fake = path.join(root, "queue-claude.mjs");
  const log = path.join(root, "queue-dispatch.log");
  await writeFile(fake, `#!/usr/bin/env node\nimport { appendFile } from 'node:fs/promises';\nif (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }\nlet text = ''; for await (const chunk of process.stdin) text += chunk;\nawait appendFile(${JSON.stringify(log)}, JSON.stringify({ text, args: process.argv.slice(2) }) + '\\n');\nconsole.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }));\nconsole.log(JSON.stringify({ type: 'result', is_error: false }));\n`);
  await chmod(fake, 0o755);
  await api(nodeA, sessionA, "PUT", "/settings", { ...settingsA, claude: { ...(settingsA.claude as object), executable: path.join(root, "missing-queue-claude") } });
  await api(nodeB, sessionB, "PUT", "/settings", { ...settingsB, claude: { ...(settingsB.claude as object), executable: fake } });
  const listed = (await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${projectA.id}/sessions`)).body.sessions;
  const conversation = listed.find((session) => session.harnessId === "claude")!;
  const opened = await openConversationSocket(nodeA, sessionA, projectA.id, conversation.path);
  const messages: Array<Record<string, unknown>> = [];
  opened.socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  return { projectA, projectB, settingsA, settingsB, conversation, opened, messages, log };
}

async function waitForQueueFrame(messages: Array<Record<string, unknown>>, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Queue frame timeout: ${JSON.stringify(messages)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("queue takeover retries a lost fenced response, copies pending settings and tombstones, and dispatches only on destination", async () => {
  const fixture = await queueTransferFixture();
  const { projectA, projectB, settingsA, settingsB, conversation, opened, messages, log } = fixture;
  let destination: Awaited<ReturnType<typeof openConversationSocket>> | undefined;
  try {
    opened.socket.send(JSON.stringify({ type: "prompt", message: "cancelled before transfer" }));
    await waitForQueueFrame(messages, () => messages.some((frame) => frame.type === "error"));
    const cancelledId = messages.find((frame) => frame.type === "userMessage")!.queueId;
    opened.socket.send(JSON.stringify({ type: "cancelQueuedPrompt", queueId: cancelledId, queueRevision: 1 }));
    await waitForQueueFrame(messages, () => messages.some((frame) => frame.type === "queuedPromptCancelled"));
    opened.socket.send(JSON.stringify({ type: "prompt", message: "run on destination", queueSettings: { provider: "claude", modelId: "haiku", reasoning: "high" } }));
    await waitForQueueFrame(messages, () => messages.filter((frame) => frame.type === "error").length === 2);
    const token = (await api<{ token: string }>(nodeB, sessionB, "GET", "/cluster/invite")).body.token;
    const fenced = await fetch(`${nodeA.url}/api/cluster/sessions/queue-transfer`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: projectA.id, engine: "claude", sessionId: conversation.id }) });
    assert.equal(fenced.status, 200, await fenced.clone().text());
    assert.equal(readOwnershipRow(nodeA, "claude", conversation.id)!.status, "transferring");
    // Discard the response, as if the network failed after the source fenced.
    const takeover = await api(nodeB, sessionB, "POST", `/projects/${projectB.id}/sessions/take-ownership`, { peerId: nodeB.nodeId, sessionId: conversation.id, sessionPath: conversation.path });
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    const db = new DatabaseSync(path.join(nodeB.dataDir, "node.db"));
    try {
      assert.ok(db.prepare("SELECT 1 FROM queued_prompt_tombstones WHERE id = ?").get(String(cancelledId)));
      const pending = db.prepare("SELECT prompt FROM queued_prompts WHERE queue_key = ?").all(`${projectB.id}:${conversation.id}`) as { prompt: string }[];
      assert.deepEqual(pending.map((row) => JSON.parse(row.prompt).settings), [{ provider: "claude", modelId: "haiku", reasoning: "high" }]);
    } finally { db.close(); }
    destination = await openConversationSocket(nodeB, sessionB, projectB.id, conversation.path);
    const frames: Array<Record<string, unknown>> = [];
    destination.socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await waitForQueueFrame(frames, () => frames.some((frame) => frame.type === "agent_end"));
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.text), ["run on destination"]);
    assert.ok(calls[0].args.includes("haiku") && calls[0].args.includes("high"));
    assert.equal(readOwnershipRow(nodeA, "claude", conversation.id)!.owner_node_id, nodeB.nodeId);
  } finally {
    opened.socket.close(); destination?.socket.close();
    await api(nodeA, sessionA, "PUT", "/settings", settingsA);
    await api(nodeB, sessionB, "PUT", "/settings", settingsB);
  }
});

interface ReadyFrame { ownership: { nodeId: string; status: string } | null }

function openConversationSocket(node: SeededNode, session: SignedIn, projectId: string, sessionPath: string): Promise<{ socket: WebSocket; ready: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("sessionPath", sessionPath);
    const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: node.url } });
    const timeout = setTimeout(() => reject(new Error("conversation socket did not become ready")), 15_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve({ socket, ready: event });
    });
    socket.once("close", (code, reason) => reject(new Error(`socket closed: ${code} ${reason}`)));
    socket.once("error", reject);
  });
}

function seedOwnershipRow(node: SeededNode, engine: string, sessionId: string, ownerNodeId: string, status: string, transferToNodeId: string | null): void {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.prepare("INSERT OR REPLACE INTO conversation_ownership (engine, session_id, owner_node_id, epoch, status, transfer_to_node_id) VALUES (?, ?, ?, 1, ?, ?)")
      .run(engine, sessionId, ownerNodeId, status, transferToNodeId);
  } finally { db.close(); }
}

function readOwnershipRow(node: SeededNode, engine: string, sessionId: string): { owner_node_id: string; epoch: number; status: string } | undefined {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return db.prepare("SELECT owner_node_id, epoch, status FROM conversation_ownership WHERE engine = ? AND session_id = ?").get(engine, sessionId) as { owner_node_id: string; epoch: number; status: string } | undefined;
  } finally { db.close(); }
}

test("a conflicted conversation is locked on both sides and recovers through takeover", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const conversation = (await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`)).body.sessions.find((candidate) => candidate.harnessId === "pi")!;
  const owners = [nodeA.nodeId, nodeB.nodeId].sort();

  // The exact state a partitioned double claim converges on: same epoch, two owners.
  seedOwnershipRow(nodeA, "pi", conversation.id, owners[0], "conflict", owners[1]);
  seedOwnershipRow(nodeB, "pi", conversation.id, owners[0], "conflict", owners[1]);

  // Both sides must report a lock, including the node the record names as owner.
  const openedA = await openConversationSocket(nodeA, sessionA, project.id, conversation.path);
  const openedB = await openConversationSocket(nodeB, sessionB, twin.id, conversation.path);
  try {
    const ownershipA = (openedA.ready as unknown as ReadyFrame).ownership;
    const ownershipB = (openedB.ready as unknown as ReadyFrame).ownership;
    const other = (local: string): string => (local === nodeA.nodeId ? nodeB.nodeId : nodeA.nodeId);
    assert.equal(ownershipA?.status, "conflict", "the listed owner side sees the conflict");
    assert.equal(ownershipA?.nodeId, other(nodeA.nodeId), "the listed owner side is told about the other node");
    assert.equal(ownershipB?.status, "conflict", "the transfer side sees the conflict");
    assert.equal(ownershipB?.nodeId, other(nodeB.nodeId), "the transfer side is told about the other node");
  } finally {
    openedA.socket.close();
    openedB.socket.close();
  }

  // Taking over must commit locally and converge both nodes instead of being
  // rejected by the conflicted peer.
  const taker = owners[0] === nodeA.nodeId ? nodeB : nodeA;
  const takerSession = taker === nodeA ? sessionA : sessionB;
  const takerProject = taker === nodeA ? project : twin;
  const takeover = await api<{ ownership?: { ownerNodeId?: string }; pendingPeerIds?: string[]; error?: string }>(taker, takerSession, "POST", `/projects/${takerProject.id}/sessions/take-ownership`, {
    peerId: taker.nodeId, sessionId: conversation.id, sessionPath: conversation.path,
  });
  assert.equal(takeover.status, 200, `conflict takeover failed (${JSON.stringify(takeover.body)})`);
  assert.equal(takeover.body.ownership?.ownerNodeId, taker.nodeId);
  assert.deepEqual(takeover.body.pendingPeerIds, [], "the conflicted peer accepted the takeover");

  for (const node of [nodeA, nodeB]) {
    const row = readOwnershipRow(node, "pi", conversation.id);
    assert.equal(row?.owner_node_id, taker.nodeId, `${node.key} converged on the taker`);
    assert.equal(row?.status, "owned");
    assert.equal(row?.epoch, 2, `${node.key} saw the takeover epoch`);
  }
});

test("a stale foreign two-phase claim stays locked instead of being stolen on open", async () => {
  const project = nodeA.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const conversation = (await api<{ sessions: SessionView[] }>(nodeA, sessionA, "GET", `/projects/${project.id}/sessions`)).body.sessions.filter((candidate) => candidate.harnessId === "pi")[1]!;

  // A claiming record owned by the peer may belong to a live old-version
  // protocol, so opening here must report the lock, not claim over it.
  seedOwnershipRow(nodeB, "pi", conversation.id, nodeA.nodeId, "claiming", null);
  const opened = await openConversationSocket(nodeB, sessionB, twin.id, conversation.path);
  try {
    const ownership = (opened.ready as unknown as ReadyFrame).ownership;
    assert.equal(ownership?.nodeId, nodeA.nodeId, "the foreign claim is reported");
    assert.equal(ownership?.status, "claiming");
  } finally { opened.socket.close(); }
  assert.equal(readOwnershipRow(nodeB, "pi", conversation.id)?.owner_node_id, nodeA.nodeId, "ownership was not stolen");
});

test("a stale two-phase claim by the local node heals when the conversation opens", async () => {
  const twin = nodeB.projects.find((candidate) => candidate.name === "Internal Assistant")!;
  const listed = (await api<{ sessions: SessionView[] }>(nodeB, sessionB, "GET", `/projects/${twin.id}/sessions`)).body.sessions.filter((candidate) => candidate.harnessId === "pi");
  const target = listed[listed.length - 1]!;
  seedOwnershipRow(nodeB, "pi", target.id, nodeB.nodeId, "claiming", null);

  const opened = await openConversationSocket(nodeB, sessionB, twin.id, target.path);
  try {
    assert.equal((opened.ready as unknown as ReadyFrame).ownership, null, "a healed claim shows no lock");
  } finally { opened.socket.close(); }
  const healed = readOwnershipRow(nodeB, "pi", target.id);
  assert.equal(healed?.owner_node_id, nodeB.nodeId, "the local node still owns it");
  assert.equal(healed?.status, "owned", "the stale claim healed to owned");
  assert.equal(healed?.epoch, 2, "healing bumps the epoch");
});
