// Project sharing across cluster invitations: the invitation freezes a project
// selection server-side, the joining node's grant is enforced everywhere data
// can move (inventory, replication delivery, replication receipt), and leaving
// or being removed clears the grant. Unit-level against the real node database.
//
// replication.ts statically imports cluster.ts, whose singleton pins to the
// first data dir it sees — so every test in this file shares one store, and
// each test works on its own peers and projects inside it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let dataDir = "";
const previousDataDir = process.env.PI_WEB_DATA_DIR;

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-sharing-"));
  process.env.PI_WEB_DATA_DIR = dataDir;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
  else process.env.PI_WEB_DATA_DIR = previousDataDir;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function loadModules(tag: string) {
  const suffix = `${tag}=${Date.now()}-${Math.random()}`;
  return {
    cluster: await import(`../src/cluster.js?${suffix}`),
    replication: await import(`../src/replication.js?${suffix}`),
  };
}

function peerFixture(cluster: typeof import("../src/cluster.js"), index: number, invitedBy: string | null = null) {
  const now = new Date().toISOString();
  const node = { id: `00000000-0000-4000-8000-00000000000${index}`, name: `Node ${index}`, url: `https://node-${index}.tailnet.ts.net`, createdAt: now, updatedAt: now, invitedByNodeId: invitedBy };
  return cluster.createClusterPeer(node, `token-${index}`);
}

test("invitations store their project selection, and only the newest selection survives", async () => {
  const { cluster } = await loadModules("invitation-selection");
  const first = await cluster.createClusterInvitation(["project-a", "project-b", "project-a"]);
  assert.deepEqual(first.projectIds, ["project-a", "project-b"]);
  assert.deepEqual(await cluster.clusterInvitationProjects(first.id), ["project-a", "project-b"]);

  const second = await cluster.createClusterInvitation(["project-c"]);
  assert.deepEqual(await cluster.clusterInvitationProjects(second.id), ["project-c"]);
  assert.deepEqual(await cluster.clusterInvitationProjects(first.id), [], "generating a new link wipes the old selection");

  await assert.rejects(cluster.createClusterInvitation([]), /at least one project/);
});

test("a saved grant rides the membership snapshot and a new invitation replaces it", async () => {
  const { cluster } = await loadModules("grant-snapshot");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 1);
  await cluster.saveClusterPeer(peer);
  await cluster.saveClusterProjectGrant(peer.id, ["project-a"], local.id);
  assert.deepEqual(await cluster.clusterProjectGrantFor(peer.id), ["project-a"]);

  const snapshot = await cluster.getClusterMembership();
  assert.equal(snapshot.projectGrants?.length, 1);
  assert.equal(snapshot.projectGrants![0].nodeId, peer.id);
  assert.deepEqual(snapshot.projectGrants![0].projectIds, ["project-a"]);

  // A second invitation replaces the whole selection rather than widening it.
  await cluster.saveClusterProjectGrant(peer.id, ["project-b", "project-c"], local.id);
  assert.deepEqual(await cluster.clusterProjectGrantFor(peer.id), ["project-b", "project-c"]);

  // A node with no grant row is unrestricted (legacy pairing).
  const legacy = peerFixture(cluster, 2);
  await cluster.saveClusterPeer(legacy);
  assert.equal(await cluster.clusterProjectGrantFor(legacy.id), undefined);
});

test("membership merges carry grants and removal deletes the removed member's grant", async () => {
  const { cluster } = await loadModules("grant-merge");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 3, local.id);
  await cluster.saveClusterPeer(peer);

  await cluster.mergeClusterMembership({
    members: [{ ...peer, token: peer.token }, { ...(await cluster.getClusterNode()), token: "self" }],
    removed: [],
    projectGrants: [{ nodeId: peer.id, projectIds: ["project-a"], updatedAt: new Date().toISOString(), originNodeId: local.id }],
  });
  assert.deepEqual(await cluster.clusterProjectGrantFor(peer.id), ["project-a"]);

  await cluster.removeClusterPeer(peer.id);
  assert.equal(await cluster.clusterProjectGrantFor(peer.id), undefined);
});

test("leaving clears peers, grants, inviter, and rotates the machine credential", async () => {
  const { cluster } = await loadModules("leave");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 4, local.id);
  await cluster.saveClusterPeer(peer);
  await cluster.saveClusterProjectGrant(peer.id, ["project-a"], local.id);
  await cluster.setClusterInviter(peer.id);
  assert.equal((await cluster.getClusterNode()).invitedByNodeId, peer.id);

  const tokenBefore = await cluster.getClusterMachineToken();
  await cluster.leaveCluster();

  assert.deepEqual(await cluster.listClusterPeers(), []);
  assert.equal(await cluster.clusterProjectGrantFor(peer.id), undefined);
  assert.equal((await cluster.getClusterNode()).invitedByNodeId, null);
  assert.notEqual(await cluster.getClusterMachineToken(), tokenBefore);
  const membership = await cluster.getClusterMembership();
  assert.ok(!membership.removed?.some((tombstone) => tombstone.id === peer.id), "the leaver writes no tombstones; its former peers record the departure");
  assert.deepEqual(membership.projectGrants, []);
});

function taskFixture(projectId: string, id: string, originNodeId: string) {
  return {
    id, title: "Task", description: "", status: "backlog", engine: "pi", planMode: false, reviewMode: false,
    phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", currentNodeId: originNodeId,
    leaseOwnerNodeId: null, leaseExpiresAt: null, handoffContext: null,
    executionState: "idle", originNodeId,
  };
}

test("replication delivery only carries events inside the peer's grant", async () => {
  const { cluster, replication } = await loadModules("delivery-grant");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 5);
  await cluster.saveClusterPeer(peer);
  await cluster.saveClusterProjectGrant(peer.id, ["project-allowed"], local.id);

  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    replication.ensureReplicationSchema(database);
    const taskEvent = (projectId: string, id: string) => ({
      originNodeId: local.id, entityType: "task", entityKey: `${projectId}:${id}`, operation: "upsert" as const,
      payload: { projectId, task: taskFixture(projectId, id, local.id), originNodeId: local.id },
    });
    replication.enqueueReplicationEvent(database, taskEvent("project-allowed", "task-1"));
    replication.enqueueReplicationEvent(database, taskEvent("project-blocked", "task-2"));
    replication.enqueueReplicationEvent(database, { originNodeId: local.id, entityType: "project.lock", entityKey: "any", operation: "upsert", payload: { global: true } });
  } finally {
    database.close();
  }

  const delivered = await replication.eventsForPeer(peer.id);
  const keys = delivered.map((event) => event.entityKey);
  assert.ok(keys.includes("project-allowed:task-1"), "granted project event is delivered");
  assert.ok(keys.includes("any"), "events without a project are user-global and still delivered");
  assert.ok(!keys.includes("project-blocked:task-2"), "unselected project event is withheld");

  // Blocked events drain: a second pull does not resurrect them.
  const again = await replication.eventsForPeer(peer.id);
  assert.ok(!again.map((event) => event.entityKey).includes("project-blocked:task-2"));
});

test("a received batch naming an ungranted project is dropped, not applied", async () => {
  const { cluster, replication } = await loadModules("receive-grant");
  const local = await cluster.getClusterNode();
  await cluster.saveClusterProjectGrant(local.id, ["project-allowed"], local.id);

  const origin = randomUUID();
  const event = (projectId: string, id: string) => ({
    id: randomUUID(), originNodeId: origin, entityType: "task", entityKey: `${projectId}:${id}`, operation: "upsert" as const,
    payload: { projectId, task: taskFixture(projectId, id, origin), originNodeId: origin }, createdAt: new Date().toISOString(),
  });
  const allowed = event("project-allowed", "task-1");
  const blocked = event("project-blocked", "task-2");
  const received = await replication.receiveReplicationBatch({ events: [allowed, blocked] });
  assert.deepEqual([...received].sort(), [allowed.id, blocked.id].sort());

  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    const rows = (database.prepare("SELECT project_id, id FROM tasks ORDER BY id").all() as Array<{ project_id: string; id: string }>).map((row) => ({ ...row }));
    assert.deepEqual(rows, [{ project_id: "project-allowed", id: "task-1" }], "only the granted project's task was applied");
  } finally {
    database.close();
  }
});

test("a stale grant snapshot never overwrites a newer grant", async () => {
  const { cluster } = await loadModules("grant-lww");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 6);
  await cluster.saveClusterPeer(peer);
  const member = { ...peer, token: peer.token };

  await cluster.mergeClusterMembership({
    members: [member, { ...(await cluster.getClusterNode()), token: "self" }],
    projectGrants: [{ nodeId: peer.id, projectIds: ["project-new"], updatedAt: "2026-02-01T00:00:00.000Z", originNodeId: local.id }],
  });
  assert.deepEqual(await cluster.clusterProjectGrantFor(peer.id), ["project-new"]);

  // An older relay carrying different ids loses the version race and must not land.
  await cluster.mergeClusterMembership({
    members: [member, { ...(await cluster.getClusterNode()), token: "self" }],
    projectGrants: [{ nodeId: peer.id, projectIds: ["project-old", "project-wider"], updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: local.id }],
  });
  assert.deepEqual(await cluster.clusterProjectGrantFor(peer.id), ["project-new"]);
});

test("departure is refused while a peer still owns a local task", async () => {
  const { cluster } = await loadModules("departure-check");
  const local = await cluster.getClusterNode();
  const peer = peerFixture(cluster, 7);
  await cluster.saveClusterPeer(peer);
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.prepare("INSERT INTO tasks (id, project_id, title, description, status, engine, plan_mode, review_mode, phase_config, created_at, updated_at, current_node_id) VALUES ('departure-task', 'project-x', 'T', '', 'backlog', 'pi', 0, 0, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)").run(peer.id);
  } finally {
    database.close();
  }

  const peersBefore = (await cluster.listClusterPeers()).length;
  await assert.rejects(cluster.assertClusterDepartureAllowed(), /Transfer owned tasks/);
  await assert.rejects(cluster.leaveCluster(), /Transfer owned tasks/);
  assert.equal((await cluster.listClusterPeers()).length, peersBefore, "a refused leave keeps the cluster");

  const cleanup = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    cleanup.prepare("DELETE FROM tasks WHERE current_node_id = ?").run(peer.id);
  } finally {
    cleanup.close();
  }
  await cluster.leaveCluster();
  assert.deepEqual(await cluster.listClusterPeers(), []);
});
