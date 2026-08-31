import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { TaskRecord } from "../src/types.js";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

async function withClusterStore(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-cluster-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await run(dataDir);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("cluster machine token is stable, high entropy, and encrypted", async () => {
  await withClusterStore(async (dataDir) => {
    const moduleUrl = new URL(`../src/cluster.ts?machine=${Date.now()}`, import.meta.url);
    const cluster = await import(moduleUrl.href);
    const first = await cluster.getClusterMachineToken();
    const second = await cluster.getClusterMachineToken();

    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch((await readFile(path.join(dataDir, "node.db"))).toString("utf8"), new RegExp(first));
  });
});

test("cluster rejects a sixth active member", async () => {
  await withClusterStore(async () => {
    const moduleUrl = new URL(`../src/cluster.ts?limit=${Date.now()}`, import.meta.url);
    const cluster = await import(moduleUrl.href);
    const node = await cluster.getClusterNode();
    for (let index = 1; index < 5; index += 1) {
      await cluster.saveClusterPeer(cluster.createClusterPeer({ ...node, id: `00000000-0000-4000-8000-00000000000${index}`, name: `Node ${index}`, url: `https://node-${index}.tailnet.ts.net` }, `token-${index}`));
    }
    await assert.rejects(
      cluster.saveClusterPeer(cluster.createClusterPeer({ ...node, id: "00000000-0000-4000-8000-000000000005", name: "Node 5", url: "https://node-5.tailnet.ts.net" }, "token-5")),
      /five nodes/,
    );
  });
});

test("cluster node and peers persist with a private peer token", async () => {
  await withClusterStore(async (dataDir) => {
    const moduleUrl = new URL(`../src/cluster.ts?test=${Date.now()}`, import.meta.url);
    const cluster = await import(moduleUrl.href);
    const node = await cluster.updateClusterNode("Mac", "https://mac.tailnet.ts.net");
    const peer = cluster.createClusterPeer({ ...node, id: "c8fc321e-bd7a-42ae-bbec-12b2c2c56afd", name: "Homeserver", url: "https://home.tailnet.ts.net", createdAt: node.createdAt, updatedAt: node.updatedAt }, "peer-token");
    await cluster.saveClusterPeer(peer);

    assert.equal((await cluster.getClusterNode()).name, "Mac");
    assert.deepEqual(await cluster.listClusterPeers(), [peer]);
    assert.doesNotMatch((await readFile(path.join(dataDir, "node.db"))).toString("utf8"), /peer-token/);
    const machineTokenBeforeRemoval = await cluster.getClusterMachineToken();
    const nodeBeforeRemoval = await cluster.getClusterNode();

    await cluster.removeClusterPeer(peer.id);
    assert.deepEqual(await cluster.listClusterPeers(), []);
    assert.notEqual(await cluster.getClusterMachineToken(), machineTokenBeforeRemoval);
    assert((await cluster.getClusterNode()).updatedAt > nodeBeforeRemoval.updatedAt);
    await assert.rejects(access(path.join(dataDir, "cluster.json")));
  });
});

function member(index: number, token = `token-${index}`, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    name: `Node ${index}`,
    url: `https://node-${index}.tailnet.ts.net`,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt,
    token,
  };
}

test("cluster membership merge is atomic and builds a full membership", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?membership=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1), member(2), member(3)] });
    assert.deepEqual((await cluster.listClusterPeers()).map(({ id, token, lastSeenAt }) => ({ id, token, lastSeenAt })), [
      { id: member(1).id, token: "token-1", lastSeenAt: null },
      { id: member(2).id, token: "token-2", lastSeenAt: null },
      { id: member(3).id, token: "token-3", lastSeenAt: null },
    ]);
    await assert.rejects(
      cluster.mergeClusterMembership({ members: [{ ...member(4), token: "" }] }),
      /token is required/,
    );
    assert.equal((await cluster.listClusterPeers()).length, 3);
  });
});

test("cluster membership rejects a snapshot with more than five nodes", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?membership-limit=${Date.now()}`, import.meta.url).href);
    await assert.rejects(cluster.mergeClusterMembership({ members: [member(1), member(2), member(3), member(4), member(5)] }), /five nodes/);
    assert.deepEqual(await cluster.listClusterPeers(), []);

    await cluster.mergeClusterMembership({ members: [member(1), member(2), member(3), member(4)] });
    const originalPeerIds = (await cluster.listClusterPeers()).map(({ id }) => id);
    await assert.rejects(cluster.mergeClusterMembership({ members: [member(5)] }), /five nodes/);
    assert.deepEqual((await cluster.listClusterPeers()).map(({ id }) => id), originalPeerIds);
  });
});

test("cluster membership refreshes peer tokens and ignores its local entry", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?membership-token=${Date.now()}`, import.meta.url).href);
    const node = await cluster.getClusterNode();
    const localToken = await cluster.getClusterMachineToken();
    await cluster.mergeClusterMembership({ members: [member(1, "old-token")] });
    await cluster.mergeClusterMembership({ members: [member(1, "new-token", "2026-02-01T00:00:00.000Z"), { ...node, name: "Wrong", token: "replacement-token" }] });
    assert.equal((await cluster.getClusterPeer(member(1).id))?.token, "new-token");
    assert.equal((await cluster.getClusterNode()).name, node.name);
    assert.equal(await cluster.getClusterMachineToken(), localToken);
  });
});

test("authenticated sender token overrides a newer stale local copy", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?membership-origin=${Date.now()}`, import.meta.url).href);
    // A locally stored copy of the sender with a NEWER version than the sender's own row pins
    // an outdated token under plain version comparison; the sender's authenticated declaration wins.
    await cluster.mergeClusterMembership({ members: [member(1, "stale-token", "2026-03-01T00:00:00.000Z")] });
    await cluster.mergeClusterMembership({ members: [member(1, "current-token", "2026-01-01T00:00:00.000Z")] }, member(1).id);
    assert.equal((await cluster.getClusterPeer(member(1).id))?.token, "current-token");
    // The heal keeps the local row's version, so an older stale snapshot cannot regress the token,
    // with or without an authenticated origin.
    await cluster.mergeClusterMembership({ members: [member(1, "stale-token", "2026-02-01T00:00:00.000Z")] });
    assert.equal((await cluster.getClusterPeer(member(1).id))?.token, "current-token");
    await cluster.mergeClusterMembership({ members: [member(1, "current-token")] }, member(1).id);
    assert.equal((await cluster.getClusterPeer(member(1).id))?.token, "current-token");
  });
});

test("cluster peer last seen persists", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?last-seen=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1)] });
    await cluster.markClusterPeerSeen(member(1).id, "2026-03-01T00:00:00.000Z");
    assert.equal((await cluster.getClusterPeer(member(1).id))?.lastSeenAt, "2026-03-01T00:00:00.000Z");
  });
});

test("unchanged membership merge does not queue a new delivery", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?unchanged=${Date.now()}`, import.meta.url).href);
    const snapshot = { members: [member(1)] };
    await cluster.mergeClusterMembership(snapshot);
    const [delivery] = await cluster.dueMembershipDeliveries();
    await cluster.recordMembershipDelivered(delivery.peerId, delivery.generation);
    await cluster.mergeClusterMembership(snapshot);
    assert.deepEqual(await cluster.dueMembershipDeliveries(), []);
  });
});

test("changed membership queues delivery and retries with capped backoff", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?retry=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1)] });
    const initial = (await cluster.dueMembershipDeliveries())[0];
    await cluster.recordMembershipDelivered(initial.peerId, initial.generation);
    await cluster.mergeClusterMembership({ members: [{ ...member(1, "new-token", "2026-02-01T00:00:00.000Z"), name: "Renamed" }] });
    const changed = (await cluster.dueMembershipDeliveries())[0];
    assert.equal(changed.peerId, member(1).id);
    assert.equal(changed.generation, initial.generation + 1);
    const now = new Date();
    await cluster.recordMembershipFailure(changed.peerId, changed.generation, "offline", now);
    assert.deepEqual(await cluster.dueMembershipDeliveries(new Date(now.getTime() + 1_999)), []);
    assert.deepEqual(await cluster.dueMembershipDeliveries(new Date(now.getTime() + 2_000)), [{ ...changed, attempts: 1 }]);
  });
});

test("stale membership delivery receipt cannot acknowledge a newer generation", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?stale-receipt=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1)] });
    const initial = (await cluster.dueMembershipDeliveries())[0];
    await cluster.mergeClusterMembership({ members: [{ ...member(1), name: "Renamed", updatedAt: "2026-02-01T00:00:00.000Z" }] });
    await cluster.recordMembershipDelivered(initial.peerId, initial.generation);
    const [current] = await cluster.dueMembershipDeliveries();
    assert.equal(current.generation, initial.generation + 1);
    await cluster.recordMembershipDelivered(current.peerId, current.generation);
    assert.deepEqual(await cluster.dueMembershipDeliveries(), []);
  });
});

test("removing a member removes its delivery and queues remaining peers", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?remove-delivery=${Date.now()}`, import.meta.url).href);
    const node = await cluster.getClusterNode();
    const first = cluster.createClusterPeer({ ...node, ...member(1) }, "token-1");
    const second = cluster.createClusterPeer({ ...node, ...member(2) }, "token-2");
    await cluster.saveClusterPeer(first);
    await cluster.saveClusterPeer(second);
    await cluster.removeClusterPeer(first.id);
    assert.deepEqual(await cluster.dueMembershipDeliveries(), [{ peerId: second.id, generation: 4, attempts: 0 }]);
    const [tombstone] = (await cluster.getClusterMembership()).removed ?? [];
    assert(tombstone);
    assert.equal(tombstone.id, first.id);
    assert.equal(tombstone.originNodeId, node.id);
    assert.equal("token" in tombstone, false);
  });
});

test("same-URL peer replacement revokes the displaced identity", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?url-replacement=${Date.now()}`, import.meta.url).href);
    const node = await cluster.getClusterNode();
    const oldPeer = cluster.createClusterPeer({ ...node, ...member(1), url: "https://shared.tailnet.ts.net" }, "old-token");
    const newPeer = cluster.createClusterPeer({ ...node, ...member(2), url: "https://shared.tailnet.ts.net/" }, "new-token");
    await cluster.saveClusterPeer(oldPeer);
    const machineTokenBeforeReplacement = await cluster.getClusterMachineToken();
    const nodeBeforeReplacement = await cluster.getClusterNode();

    await cluster.saveClusterPeer(newPeer);

    assert.equal(await cluster.getClusterPeer(oldPeer.id), undefined);
    assert.equal((await cluster.getClusterPeer(newPeer.id))?.url, "https://shared.tailnet.ts.net");
    const tombstone = (await cluster.getClusterMembership()).removed?.find((removed) => removed.id === oldPeer.id);
    assert(tombstone);
    assert.notEqual(await cluster.getClusterMachineToken(), machineTokenBeforeReplacement);
    assert((await cluster.getClusterNode()).updatedAt > nodeBeforeReplacement.updatedAt);
    assert.deepEqual(await cluster.dueMembershipDeliveries(), [{ peerId: newPeer.id, generation: 3, attempts: 0 }]);

    await cluster.mergeClusterMembership({ members: [oldPeer] });
    assert.equal(await cluster.getClusterPeer(oldPeer.id), undefined);
  });
});

test("cluster rejects removal while a peer owns tasks or unsettled handoffs", async () => {
  await withClusterStore(async () => {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?dependent-removal=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?dependent-removal=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?dependent-removal=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const peer = cluster.createClusterPeer({ ...local, ...member(1), url: "https://shared.tailnet.ts.net" }, "peer-token");
    const projectId = "dependent-removal";
    const task = (id: string, currentNodeId: string): TaskRecord => ({
      id,
      title: "Dependent task",
      description: "plaintext",
      status: "backlog",
      engine: "pi",
      planMode: false,
      reviewMode: false,
      phaseConfig: {},
      sessionPath: null,
      worktreePath: null,
      worktreeBranch: null,
      mergedAt: null,
      currentNodeId,
      leaseOwnerNodeId: null,
      leaseExpiresAt: null,
      executionState: "idle",
      handoffContext: null,
      originNodeId: currentNodeId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const inject = async (candidate: TaskRecord, operation: "upsert" | "delete" = "upsert") => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: candidate.originNodeId, entityType: "task", entityKey: `${projectId}:${candidate.id}`, operation, payload: { projectId, task: candidate, originNodeId: candidate.originNodeId, ...(operation === "delete" ? { updatedAt: candidate.updatedAt } : {}) }, createdAt: candidate.updatedAt }] });
    };

    await cluster.saveClusterPeer(peer);
    const owned = task("owned-by-peer", peer.id);
    await inject(owned);
    const peerBeforeOwnedRemoval = await cluster.getClusterPeer(peer.id);
    await assert.rejects(cluster.removeClusterPeer(peer.id), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`));
    assert.deepEqual(await cluster.getClusterPeer(peer.id), peerBeforeOwnedRemoval);
    assert.equal((await tasks.listTasks(projectId)).find((candidate) => candidate.id === owned.id)?.currentNodeId, peer.id);

    const replacement = cluster.createClusterPeer({ ...local, ...member(2), url: "https://shared.tailnet.ts.net/" }, "replacement-token");
    await assert.rejects(cluster.saveClusterPeer(replacement), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`));
    assert.deepEqual(await cluster.getClusterPeer(peer.id), peerBeforeOwnedRemoval);
    assert.equal(await cluster.getClusterPeer(replacement.id), undefined);

    await inject({ ...owned, updatedAt: "2026-01-01T00:00:01.000Z" }, "delete");
    const transferring = task("transferring-to-peer", local.id);
    await inject(transferring);
    const handoff = await tasks.beginOutgoingTaskHandoff(projectId, transferring, local.id, peer.id);
    const handoffBeforeRemoval = await tasks.getTaskHandoff(handoff.handoffId);
    await assert.rejects(cluster.removeClusterPeer(peer.id), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`));
    assert.deepEqual(await cluster.getClusterPeer(peer.id), peerBeforeOwnedRemoval);
    assert.deepEqual(await tasks.getTaskHandoff(handoff.handoffId), handoffBeforeRemoval);

    await tasks.abortOutgoingTaskHandoff(handoff.handoffId);
    await cluster.removeClusterPeer(peer.id);
    assert.equal(await cluster.getClusterPeer(peer.id), undefined);

    const restoredPeer = { ...peer, updatedAt: "3000-01-01T00:00:00.000Z" };
    await cluster.saveClusterPeer(restoredPeer);
    const tombstoneDependent = task("tombstone-dependent", peer.id);
    await inject(tombstoneDependent);
    const tokenBeforeTombstone = await cluster.getClusterMachineToken();
    const peerBeforeTombstone = await cluster.getClusterPeer(peer.id);
    await assert.rejects(
      cluster.mergeClusterMembership({ members: [], removed: [{ id: peer.id, removedAt: "3001-01-01T00:00:00.000Z", originNodeId: member(2).id }] }),
      new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`),
    );
    assert.deepEqual(await cluster.getClusterPeer(peer.id), peerBeforeTombstone);
    assert.equal((await tasks.listTasks(projectId)).find((candidate) => candidate.id === tombstoneDependent.id)?.currentNodeId, peer.id);
    assert.equal(await cluster.getClusterMachineToken(), tokenBeforeTombstone);
  });
});

test("committed unacknowledged handoffs block participant removal and displacement", async () => {
  await withClusterStore(async (dataDir) => {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?committed-removal=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?committed-removal=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const sourcePeer = cluster.createClusterPeer({ ...local, ...member(1), url: "https://source.tailnet.ts.net" }, "source-token");
    const destinationPeer = cluster.createClusterPeer({ ...local, ...member(2), url: "https://destination.tailnet.ts.net" }, "destination-token");
    await cluster.saveClusterPeer(sourcePeer);
    await cluster.saveClusterPeer(destinationPeer);
    await tasks.listTasks("committed-removal");
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const insert = db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, acknowledged_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', '{}', NULL, NULL, NULL, 0, NULL, ?, ?)");
    const now = "2026-06-01T00:00:00.000Z";
    const sourceHandoffId = randomUUID();
    const destinationHandoffId = randomUUID();
    insert.run(sourceHandoffId, "committed-removal", "committed-removal", "from-peer", sourcePeer.id, local.id, "incoming", now, now);
    insert.run(destinationHandoffId, "committed-removal", "committed-removal", "to-peer", local.id, destinationPeer.id, "outgoing", now, now);
    db.close();

    const assertBlocked = async (peer: typeof sourcePeer, replacement: typeof sourcePeer) => {
      const tokenBefore = await cluster.getClusterMachineToken();
      await assert.rejects(cluster.removeClusterPeer(peer.id), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`));
      assert.equal(await cluster.getClusterMachineToken(), tokenBefore);
      await assert.rejects(cluster.saveClusterPeer(replacement), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`));
      assert.equal(await cluster.getClusterMachineToken(), tokenBefore);
      await assert.rejects(
        cluster.mergeClusterMembership({ members: [], removed: [{ id: peer.id, removedAt: "2999-01-01T00:00:00.000Z", originNodeId: local.id }] }),
        new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${peer.id}`),
      );
      assert.equal(await cluster.getClusterMachineToken(), tokenBefore);
      assert.equal((await cluster.getClusterPeer(peer.id))?.token, peer.token);
      assert.equal(await cluster.getClusterPeer(replacement.id), undefined);
    };
    await assertBlocked(sourcePeer, cluster.createClusterPeer({ ...local, ...member(3), url: sourcePeer.url }, "source-replacement-token"));
    await assertBlocked(destinationPeer, cluster.createClusterPeer({ ...local, ...member(4), url: destinationPeer.url }, "destination-replacement-token"));

    const acknowledged = new DatabaseSync(path.join(dataDir, "node.db"));
    acknowledged.prepare("UPDATE task_handoffs SET acknowledged_at = ? WHERE handoff_id IN (?, ?)").run("2026-06-01T00:00:01.000Z", sourceHandoffId, destinationHandoffId);
    acknowledged.close();
    await cluster.removeClusterPeer(sourcePeer.id);
    await cluster.removeClusterPeer(destinationPeer.id);
    assert.equal(await cluster.getClusterPeer(sourcePeer.id), undefined);
    assert.equal(await cluster.getClusterPeer(destinationPeer.id), undefined);

    const legacyPeer = cluster.createClusterPeer({ ...local, ...member(5), url: "https://legacy.tailnet.ts.net" }, "legacy-token");
    await cluster.saveClusterPeer(legacyPeer);
    const legacy = new DatabaseSync(path.join(dataDir, "node.db"));
    legacy.exec("DROP TABLE task_handoffs; CREATE TABLE task_handoffs (handoff_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, source_node_id TEXT NOT NULL, destination_node_id TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL);");
    legacy.prepare("INSERT INTO task_handoffs (handoff_id, project_id, task_id, source_node_id, destination_node_id, direction, status) VALUES (?, 'committed-removal', 'legacy', ?, ?, 'incoming', 'committed')").run(randomUUID(), legacyPeer.id, local.id);
    legacy.close();
    await assert.rejects(cluster.removeClusterPeer(legacyPeer.id), new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${legacyPeer.id}`));
  });
});

test("membership tombstones reject absent identities with task or handoff dependencies", async () => {
  await withClusterStore(async () => {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?absent-dependent-removal=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?absent-dependent-removal=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?absent-dependent-removal=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const projectId = "absent-dependent-removal";
    const task = (id: string, currentNodeId: string): TaskRecord => ({
      id,
      title: "Dependent task",
      description: "plaintext",
      status: "backlog",
      engine: "pi",
      planMode: false,
      reviewMode: false,
      phaseConfig: {},
      sessionPath: null,
      worktreePath: null,
      worktreeBranch: null,
      mergedAt: null,
      currentNodeId,
      leaseOwnerNodeId: null,
      leaseExpiresAt: null,
      executionState: "idle",
      handoffContext: null,
      originNodeId: currentNodeId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const inject = async (candidate: TaskRecord, operation: "upsert" | "delete" = "upsert") => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: candidate.originNodeId, entityType: "task", entityKey: `${projectId}:${candidate.id}`, operation, payload: { projectId, task: candidate, originNodeId: candidate.originNodeId, ...(operation === "delete" ? { updatedAt: candidate.updatedAt } : {}) }, createdAt: candidate.updatedAt }] });
    };
    const absentTaskOwner = randomUUID();
    const owned = task("owned-by-absent-node", absentTaskOwner);
    await inject(owned);
    const tokenBeforeRejectedTaskTombstone = await cluster.getClusterMachineToken();

    await assert.rejects(
      cluster.mergeClusterMembership({ members: [], removed: [{ id: absentTaskOwner, removedAt: "2026-02-01T00:00:00.000Z", originNodeId: local.id }] }),
      new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${absentTaskOwner}`),
    );
    assert.equal((await tasks.listTasks(projectId)).find((candidate) => candidate.id === owned.id)?.currentNodeId, absentTaskOwner);
    assert.equal(await cluster.getClusterMachineToken(), tokenBeforeRejectedTaskTombstone);
    assert.equal((await cluster.getClusterMembership()).removed?.find((tombstone) => tombstone.id === absentTaskOwner), undefined);

    await inject({ ...owned, updatedAt: "2026-01-01T00:00:01.000Z" }, "delete");
    const absentHandoffParticipant = randomUUID();
    const transferring = task("transferring-to-absent-node", local.id);
    await inject(transferring);
    const handoff = await tasks.beginOutgoingTaskHandoff(projectId, transferring, local.id, absentHandoffParticipant);

    await assert.rejects(
      cluster.mergeClusterMembership({ members: [], removed: [{ id: absentHandoffParticipant, removedAt: "2026-02-01T00:00:00.000Z", originNodeId: local.id }] }),
      new RegExp(`Transfer owned tasks and settle handoffs before removing cluster member ${absentHandoffParticipant}`),
    );
    assert.equal((await cluster.getClusterMembership()).removed?.find((tombstone) => tombstone.id === absentHandoffParticipant), undefined);

    await tasks.abortOutgoingTaskHandoff(handoff.handoffId);
    const absentTombstone = { id: absentHandoffParticipant, removedAt: "2026-02-01T00:00:00.000Z", originNodeId: local.id };
    const absentTombstoneSnapshot = { members: [], removed: [absentTombstone] };
    const tokenBeforeAbsentTombstone = await cluster.getClusterMachineToken();
    const nodeBeforeAbsentTombstone = await cluster.getClusterNode();

    await cluster.mergeClusterMembership(absentTombstoneSnapshot);
    assert((await cluster.getClusterMembership()).removed?.find((tombstone) => tombstone.id === absentHandoffParticipant));
    const tokenAfterAbsentTombstone = await cluster.getClusterMachineToken();
    const nodeAfterAbsentTombstone = await cluster.getClusterNode();
    assert.notEqual(tokenAfterAbsentTombstone, tokenBeforeAbsentTombstone);
    assert(nodeAfterAbsentTombstone.updatedAt > nodeBeforeAbsentTombstone.updatedAt);

    await cluster.mergeClusterMembership(absentTombstoneSnapshot);
    assert.equal(await cluster.getClusterMachineToken(), tokenAfterAbsentTombstone);
    assert.equal((await cluster.getClusterNode()).updatedAt, nodeAfterAbsentTombstone.updatedAt);
  });
});

test("removing a future-version peer creates a newer tombstone", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?future-removal=${Date.now()}`, import.meta.url).href);
    const node = await cluster.getClusterNode();
    const peer = { ...member(1, "future-token", "2999-01-01T00:00:00.000Z"), pairedAt: "2999-01-01T00:00:00.000Z", lastSeenAt: null };
    await cluster.saveClusterPeer(peer);
    const nodeBeforeRemoval = await cluster.getClusterNode();

    await cluster.removeClusterPeer(peer.id);

    const tombstone = (await cluster.getClusterMembership()).removed?.find((removed) => removed.id === peer.id);
    assert(tombstone);
    assert(tombstone.removedAt > peer.updatedAt);
    assert(tombstone.removedAt > nodeBeforeRemoval.updatedAt);
    await cluster.mergeClusterMembership({ members: [peer] });
    assert.equal(await cluster.getClusterPeer(peer.id), undefined);
  });
});

test("membership tombstones prevent stale resurrection and accept newer re-pairing", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?tombstone-winner=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1, "old-token", "2020-01-01T00:00:00.000Z")] });
    await cluster.removeClusterPeer(member(1).id);
    const removed = (await cluster.getClusterMembership()).removed?.[0];
    assert(removed);

    await cluster.mergeClusterMembership({ members: [member(1, "stale-token", "2020-01-01T00:00:00.000Z")] });
    assert.equal(await cluster.getClusterPeer(member(1).id), undefined);

    await cluster.mergeClusterMembership({ members: [member(1, "new-token", "2999-01-01T00:00:00.000Z")] });
    assert.equal((await cluster.getClusterPeer(member(1).id))?.token, "new-token");
    assert.deepEqual((await cluster.getClusterMembership()).removed, []);
  });
});

test("incoming tombstones converge deletion, rotate local credentials once, and active winners permit replacement", async () => {
  await withClusterStore(async () => {
    const cluster = await import(new URL(`../src/cluster.ts?tombstone-convergence=${Date.now()}`, import.meta.url).href);
    await cluster.mergeClusterMembership({ members: [member(1), member(2), member(3), member(4)] });
    const machineTokenBeforeRemoval = await cluster.getClusterMachineToken();
    const nodeBeforeRemoval = await cluster.getClusterNode();
    const snapshot = {
      members: [member(5)],
      removed: [{ id: member(1).id, removedAt: "2999-01-01T00:00:00.000Z", originNodeId: member(2).id }],
    };
    await cluster.mergeClusterMembership(snapshot);
    assert.deepEqual((await cluster.listClusterPeers()).map((peer) => peer.id).sort(), [member(2).id, member(3).id, member(4).id, member(5).id].sort());
    assert.deepEqual((await cluster.getClusterMembership()).removed?.map((tombstone) => tombstone.id), [member(1).id]);
    const machineTokenAfterRemoval = await cluster.getClusterMachineToken();
    const nodeAfterRemoval = await cluster.getClusterNode();
    assert.notEqual(machineTokenAfterRemoval, machineTokenBeforeRemoval);
    assert(nodeAfterRemoval.updatedAt > nodeBeforeRemoval.updatedAt);

    await cluster.mergeClusterMembership(snapshot);
    assert.equal(await cluster.getClusterMachineToken(), machineTokenAfterRemoval);
    assert.equal((await cluster.getClusterNode()).updatedAt, nodeAfterRemoval.updatedAt);
  });
});
