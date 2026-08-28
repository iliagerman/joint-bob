import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { TaskRecord } from "../src/types.js";

test("task handoff start atomically blocks mutations and source completion stays local", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-ownership-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?ownership=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?ownership=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?ownership=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const peer = randomUUID();
    const projectId = "project";
    const task: TaskRecord = {
      id: "task-ownership",
      title: "Replicated",
      description: "plaintext",
      status: "backlog" as const,
      engine: "pi" as const,
      planMode: false,
      reviewMode: false,
      phaseConfig: {},
      sessionPath: "/source/.pi/agent/sessions/session.jsonl",
      worktreePath: "/source/worktree",
      worktreeBranch: "pi-ticket/task-ownership-replicated",
      mergedAt: null,
      currentNodeId: local.id,
      leaseOwnerNodeId: null,
      leaseExpiresAt: null,
      executionState: "idle" as const,
      handoffContext: "source context",
      originNodeId: local.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const inject = async (candidate: TaskRecord, targetProjectId = projectId) => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: candidate.originNodeId, entityType: "task", entityKey: `${targetProjectId}:${candidate.id}`, operation: "upsert", payload: { projectId: targetProjectId, task: candidate, originNodeId: candidate.originNodeId }, createdAt: candidate.updatedAt }] });
    };

    await inject(task);
    const outgoing = await tasks.beginOutgoingTaskHandoff(projectId, task, local.id, peer);
    assert.equal(outgoing.status, "pending");
    assert.equal(outgoing.task.executionState, "idle");
    const pending = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === task.id);
    assert.equal(pending?.currentNodeId, local.id);
    assert.equal(pending?.executionState, "handoff_pending");
    assert.equal(outgoing.createdAt, pending?.updatedAt);
    assert.ok(outgoing.createdAt > task.updatedAt);
    assert.equal(pending?.sessionPath, task.sessionPath);
    await assert.rejects(tasks.updateTask(projectId, task.id, { title: "Blocked" }), /awaiting destination commit/);
    await assert.rejects(tasks.deleteTask(projectId, task.id), /awaiting destination commit/);
    await assert.rejects(tasks.claimTaskLease(projectId, task.id, local.id), /owned or leased/);

    const replicatedPending = { ...pending!, title: "Newer pending title", updatedAt: "2099-01-01T00:00:00.000Z" };
    await inject(replicatedPending);
    await tasks.markOutgoingTaskHandoff(outgoing.handoffId, "prepared");
    const handed = await tasks.completeTaskHandoff(outgoing.handoffId, projectId, task.id, local.id, peer);
    assert.equal(handed.title, task.title);
    assert.equal(handed.currentNodeId, peer);
    assert.equal(handed.executionState, "idle");
    assert.equal(handed.sessionPath, null);
    assert.equal(handed.worktreePath, null);
    assert.equal(handed.worktreeBranch, null);
    assert.equal(handed.handoffContext, null);
    assert.equal(handed.updatedAt, pending?.updatedAt);
    assert.equal(handed.originNodeId, task.originNodeId);
    assert.equal((await tasks.getTaskHandoff(outgoing.handoffId))?.status, "committed");
    const repeated = await tasks.completeTaskHandoff(outgoing.handoffId, projectId, task.id, local.id, peer);
    assert.deepEqual(repeated, handed);

    const abortedTask = { ...task, id: "task-ownership-abort", updatedAt: "2026-01-02T00:00:00.000Z" };
    await inject(abortedTask);
    const abortedOutgoing = await tasks.beginOutgoingTaskHandoff(projectId, abortedTask, local.id, peer);
    await tasks.abortOutgoingTaskHandoff(abortedOutgoing.handoffId);
    const restored = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === abortedTask.id);
    assert.equal(restored?.executionState, "idle");
    assert.equal(restored?.sessionPath, abortedTask.sessionPath);
    assert.equal(restored?.worktreePath, abortedTask.worktreePath);
    assert.equal(restored?.worktreeBranch, abortedTask.worktreeBranch);
    assert.equal(restored?.handoffContext, abortedTask.handoffContext);

    const rejectedIncoming = { ...task, id: "task-ownership-rejected", title: "Rejected incoming", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
    await inject(rejectedIncoming);
    const rejectedHandoffId = randomUUID();
    await tasks.rejectTaskHandoff(rejectedHandoffId);
    await assert.rejects(tasks.prepareTaskHandoff(rejectedHandoffId, projectId, projectId, rejectedIncoming, local.id, null, "", "2026-01-02T00:00:01.000Z"), /rejected/);
    const fencedRejected = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === rejectedIncoming.id);
    assert.equal(fencedRejected?.title, rejectedIncoming.title);
    assert.equal(fencedRejected?.executionState, "idle");

    const oldIncoming = { ...task, id: "task-ownership-generation", title: "Old destination", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" };
    const oldHandoffId = randomUUID();
    const newHandoffId = randomUUID();
    await tasks.prepareTaskHandoff(oldHandoffId, projectId, projectId, oldIncoming, local.id, null, "", "2026-01-03T00:00:01.000Z");
    await assert.rejects(tasks.prepareTaskHandoff(newHandoffId, projectId, projectId, { ...oldIncoming, title: "New destination" }, local.id, null, "", "2026-01-03T00:00:02.000Z"), /another active handoff/);
    await tasks.abortPreparedTaskHandoff(oldHandoffId, local.id);
    const abortedGeneration = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === oldIncoming.id)!;
    const newerIncoming = { ...oldIncoming, title: "New destination", createdAt: "2026-01-03T00:00:02.000Z", updatedAt: tasks.nextTaskUpdatedAt(abortedGeneration.updatedAt) };
    await tasks.prepareTaskHandoff(newHandoffId, projectId, projectId, newerIncoming, local.id, null, "", "2026-01-03T00:00:02.000Z");
    await tasks.commitPreparedTaskHandoff(newHandoffId, local.id);
    await assert.rejects(tasks.prepareTaskHandoff(oldHandoffId, projectId, projectId, oldIncoming, local.id, null, "", "2026-01-03T00:00:01.000Z"), /aborted/);
    await assert.rejects(tasks.commitPreparedTaskHandoff(oldHandoffId, local.id), /aborted/);
    assert.equal(await tasks.abortPreparedTaskHandoff(oldHandoffId, local.id), undefined);
    const destinationOwned = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === oldIncoming.id);
    assert.equal(destinationOwned?.title, newerIncoming.title);
    assert.equal(destinationOwned?.currentNodeId, local.id);
    assert.equal(destinationOwned?.executionState, "idle");

    const fencedIncoming = { ...task, id: "task-ownership-fenced", title: "Source snapshot", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-03T00:00:03.000Z", updatedAt: "2026-01-03T00:00:03.000Z" };
    await inject(fencedIncoming);
    const fencedHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(fencedHandoffId, projectId, projectId, fencedIncoming, local.id, "destination context", "2026-01-03T00:00:04.000Z");
    await tasks.prepareTaskHandoff(fencedHandoffId, projectId, projectId, fencedIncoming, local.id, { path: "/destination/worktree", branch: "pi-ticket/task-ownership-fenced-destination", created: false }, "destination context", "2026-01-03T00:00:04.000Z");
    await inject({ ...fencedIncoming, worktreePath: "/source/newer-worktree", worktreeBranch: "pi-ticket/task-ownership-fenced-source", handoffContext: "source newer context", executionState: "handoff_pending", updatedAt: "2099-01-01T00:00:00.000Z" });
    const preparedFenced = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === fencedIncoming.id);
    assert.equal(preparedFenced?.worktreePath, "/destination/worktree");
    assert.equal(preparedFenced?.worktreeBranch, "pi-ticket/task-ownership-fenced-destination");
    assert.equal(preparedFenced?.handoffContext, "destination context");
    const committedFenced = await tasks.commitPreparedTaskHandoff(fencedHandoffId, local.id);
    assert.equal(committedFenced.worktreePath, "/destination/worktree");
    assert.equal(committedFenced.worktreeBranch, "pi-ticket/task-ownership-fenced-destination");
    assert.equal(committedFenced.handoffContext, "destination context");
    const ownershipDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((ownershipDb.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, fencedIncoming.id) as { active_handoff_id: string | null }).active_handoff_id, null);
    ownershipDb.close();

    const missingIncoming = { ...task, id: "task-ownership-missing", title: "Missing before reserve", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-03T00:00:05.000Z", updatedAt: "2026-01-03T00:00:05.000Z" };
    const missingHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(missingHandoffId, projectId, projectId, missingIncoming, local.id, "missing destination context", "2026-01-03T00:00:06.000Z");
    const missingDb = new DatabaseSync(path.join(dataDir, "node.db"));
    missingDb.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ?").run(projectId, missingIncoming.id);
    missingDb.close();
    await tasks.reserveTaskHandoff(missingHandoffId, projectId, projectId, missingIncoming, local.id, "missing destination context", "2026-01-03T00:00:06.000Z");
    await inject(missingIncoming);
    const fencedDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((fencedDb.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, missingIncoming.id) as { active_handoff_id: string | null }).active_handoff_id, missingHandoffId);
    fencedDb.close();
    const fencedPlaceholder = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === missingIncoming.id);
    assert.equal(fencedPlaceholder?.executionState, "handoff_pending");
    assert.equal(fencedPlaceholder?.worktreePath, null);
    const preparedMissing = await tasks.prepareTaskHandoff(missingHandoffId, projectId, projectId, missingIncoming, local.id, { path: "/destination/missing", branch: "pi-ticket/task-ownership-missing", created: false }, "missing destination context", "2026-01-03T00:00:06.000Z");
    assert.equal(preparedMissing.worktreePath, "/destination/missing");
    const committedMissing = await tasks.commitPreparedTaskHandoff(missingHandoffId, local.id);
    assert.equal(committedMissing.currentNodeId, local.id);
    assert.equal(committedMissing.worktreePath, "/destination/missing");

    const reusedIncoming = { ...task, id: "task-ownership-reused", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-03T00:00:07.000Z", updatedAt: "2026-01-03T00:00:07.000Z" };
    const reusedHandoffId = randomUUID();
    await tasks.prepareTaskHandoff(reusedHandoffId, projectId, projectId, reusedIncoming, local.id, { path: "/destination/reused", branch: "pi-ticket/task-ownership-reused", created: false }, "", "2026-01-03T00:00:08.000Z");
    assert.equal((await tasks.getTaskHandoff(reusedHandoffId))?.worktreeCreated, false);
    await tasks.abortPreparedTaskHandoff(reusedHandoffId, local.id);
    const abortedReused = await tasks.getTaskHandoff(reusedHandoffId);
    assert.equal(abortedReused?.status, "aborted");
    assert.equal(abortedReused?.worktreeCreated, false);

    const createdIncoming = { ...task, id: "task-ownership-created", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-03T00:00:09.000Z", updatedAt: "2026-01-03T00:00:09.000Z" };
    const createdHandoffId = randomUUID();
    await tasks.prepareTaskHandoff(createdHandoffId, projectId, projectId, createdIncoming, local.id, { path: "/destination/created", branch: "pi-ticket/task-ownership-created", created: true }, "", "2026-01-03T00:00:10.000Z");
    assert.equal((await tasks.getTaskHandoff(createdHandoffId))?.worktreeCreated, true);

    const destinationTask = { ...task, id: "task-ownership-incoming-owner", title: "Destination task", sessionPath: "/destination/session.jsonl", worktreePath: "/destination/worktree", worktreeBranch: "pi-ticket/task-ownership-incoming-owner", currentNodeId: local.id, originNodeId: local.id, createdAt: "2026-01-03T00:00:11.000Z", updatedAt: "2026-01-03T00:00:11.000Z" };
    await inject(destinationTask);
    const wrongOwnerIncoming = { ...destinationTask, title: "Source snapshot", sessionPath: "/source/session.jsonl", worktreePath: "/source/worktree", worktreeBranch: "pi-ticket/task-ownership-source", currentNodeId: peer, originNodeId: peer };
    await assert.rejects(tasks.reserveTaskHandoff(randomUUID(), projectId, projectId, wrongOwnerIncoming, local.id, "", "2026-01-03T00:00:12.000Z"), /Task ownership or version is newer on this node/);
    const unchangedDestination = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === destinationTask.id);
    assert.equal(unchangedDestination?.currentNodeId, local.id);
    assert.equal(unchangedDestination?.title, destinationTask.title);
    assert.equal(unchangedDestination?.sessionPath, destinationTask.sessionPath);
    assert.equal(unchangedDestination?.worktreePath, destinationTask.worktreePath);
    const ownerDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((ownerDb.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, destinationTask.id) as { active_handoff_id: string | null }).active_handoff_id, null);
    ownerDb.close();

    const staleIncoming = { ...task, id: "task-ownership-stale", title: "Stale source task", currentNodeId: peer, originNodeId: "source-a", createdAt: "2026-01-03T00:00:13.000Z", updatedAt: "2026-01-03T00:00:13.000Z" };
    await inject({ ...staleIncoming, title: "Newer source task", updatedAt: "2026-01-03T00:00:14.000Z" });
    await assert.rejects(tasks.reserveTaskHandoff(randomUUID(), projectId, projectId, staleIncoming, local.id, "", "2026-01-03T00:00:15.000Z"), /Task ownership or version is newer on this node/);
    const equalVersionIncoming = { ...staleIncoming, id: "task-ownership-stale-origin", updatedAt: "2026-01-03T00:00:16.000Z" };
    await inject({ ...equalVersionIncoming, title: "Lexically newer source task", originNodeId: "source-z" });
    await assert.rejects(tasks.reserveTaskHandoff(randomUUID(), projectId, projectId, equalVersionIncoming, local.id, "", "2026-01-03T00:00:17.000Z"), /Task ownership or version is newer on this node/);
    const progressedHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(progressedHandoffId, projectId, projectId, { ...staleIncoming, title: "Newest source task", updatedAt: "2026-01-03T00:00:18.000Z" }, local.id, "", "2026-01-03T00:00:19.000Z");
    assert.equal((await tasks.getTaskHandoff(progressedHandoffId))?.status, "pending");

    const pendingReplicaIncoming = { ...task, id: "task-ownership-pending-replica", title: "Pending source task", currentNodeId: peer, originNodeId: "source-a", createdAt: "2026-01-03T00:00:20.000Z", updatedAt: "2026-01-03T00:00:20.000Z" };
    const pendingReplicaHandoffId = randomUUID();
    const pendingReplicaVersion = "2026-01-03T00:00:21.000Z";
    await inject(pendingReplicaIncoming);
    await inject({ ...pendingReplicaIncoming, executionState: "handoff_pending", updatedAt: pendingReplicaVersion });
    await tasks.reserveTaskHandoff(pendingReplicaHandoffId, projectId, projectId, pendingReplicaIncoming, local.id, "", pendingReplicaVersion);
    const preparedPendingReplica = await tasks.prepareTaskHandoff(pendingReplicaHandoffId, projectId, projectId, pendingReplicaIncoming, local.id, null, "", pendingReplicaVersion);
    assert.equal(preparedPendingReplica.executionState, "handoff_pending");

    const laterPendingReplicaIncoming = { ...task, id: "task-ownership-later-pending-replica", title: "Later pending source task", currentNodeId: peer, originNodeId: "source-a", createdAt: "2026-01-03T00:00:22.000Z", updatedAt: "2026-01-03T00:00:22.000Z" };
    const laterPendingReplicaVersion = "2026-01-03T00:00:23.000Z";
    await inject(laterPendingReplicaIncoming);
    await inject({ ...laterPendingReplicaIncoming, executionState: "handoff_pending", updatedAt: "2026-01-03T00:00:23.001Z" });
    const laterPendingReplica = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === laterPendingReplicaIncoming.id);
    assert.equal(laterPendingReplicaIncoming.updatedAt, "2026-01-03T00:00:22.000Z");
    assert.equal(laterPendingReplica?.executionState, "handoff_pending");
    assert.equal(laterPendingReplica?.updatedAt, "2026-01-03T00:00:23.001Z");
    await assert.rejects(tasks.reserveTaskHandoff(randomUUID(), projectId, projectId, laterPendingReplicaIncoming, local.id, "", laterPendingReplicaVersion), /Task ownership or version is newer on this node/);

    const prepareIncoming = { ...task, id: "task-ownership-prepare-revalidation", title: "Prepared source task", currentNodeId: peer, originNodeId: "source-a", createdAt: "2026-01-03T00:00:20.000Z", updatedAt: "2026-01-03T00:00:20.000Z" };
    await inject(prepareIncoming);
    const prepareHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(prepareHandoffId, projectId, projectId, prepareIncoming, local.id, "", "2026-01-03T00:00:21.000Z");
    const prepareDb = new DatabaseSync(path.join(dataDir, "node.db"));
    prepareDb.prepare("UPDATE tasks SET title = ?, session_path = ?, worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE project_id = ? AND id = ?").run("Advanced source task", "/advanced/session.jsonl", "/advanced/worktree", "pi-ticket/task-ownership-advanced", "2026-01-03T00:00:22.000Z", projectId, prepareIncoming.id);
    prepareDb.close();
    await assert.rejects(tasks.prepareTaskHandoff(prepareHandoffId, projectId, projectId, prepareIncoming, local.id, null, "", "2026-01-03T00:00:21.000Z"), /Task ownership or version is newer on this node/);
    const advancedPrepared = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === prepareIncoming.id);
    assert.equal(advancedPrepared?.title, "Advanced source task");
    assert.equal(advancedPrepared?.sessionPath, "/advanced/session.jsonl");
    assert.equal(advancedPrepared?.worktreePath, "/advanced/worktree");
    assert.equal(advancedPrepared?.updatedAt, "2026-01-03T00:00:22.000Z");
    const revalidationDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((revalidationDb.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, prepareIncoming.id) as { active_handoff_id: string | null }).active_handoff_id, prepareHandoffId);
    revalidationDb.close();

    const raceTask = { ...task, id: "task-ownership-race", title: "Original title", updatedAt: "2026-01-03T00:00:00.000Z" };
    await inject(raceTask);
    const [beginResult, updateResult] = await Promise.allSettled([
      tasks.beginOutgoingTaskHandoff(projectId, raceTask, local.id, peer),
      tasks.updateTask(projectId, raceTask.id, { title: "Updated title" }),
    ]);
    assert.equal([beginResult, updateResult].filter((result) => result.status === "fulfilled").length, 1);
    const raced = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === raceTask.id);
    if (beginResult.status === "fulfilled") {
      assert.equal(updateResult.status, "rejected");
      assert.equal(raced?.executionState, "handoff_pending");
      assert.equal(raced?.title, "Original title");
    } else {
      assert.match((beginResult.reason as Error).message, /Task changed before handoff started/);
      assert.equal(updateResult.status, "fulfilled");
      assert.equal(raced?.executionState, "idle");
      assert.equal(raced?.title, "Updated title");
    }

    const tombstoneIncoming = { ...task, id: "task-ownership-tombstone-newer", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" };
    const tombstoneHandoffId = randomUUID();
    const tombstoneVersion = "2026-01-04T00:00:01.000Z";
    const tombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    tombstoneDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(projectId, tombstoneIncoming.id, "2026-01-04T00:00:02.000Z", peer);
    tombstoneDb.close();
    await assert.rejects(tasks.reserveTaskHandoff(tombstoneHandoffId, projectId, projectId, tombstoneIncoming, local.id, "", tombstoneVersion), /Task was deleted after handoff started/);
    let verifiedTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.ok(verifiedTombstoneDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, tombstoneIncoming.id));
    assert.equal(verifiedTombstoneDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, tombstoneIncoming.id), undefined);
    verifiedTombstoneDb.close();
    await assert.rejects(tasks.reserveTaskHandoff(tombstoneHandoffId, projectId, projectId, tombstoneIncoming, local.id, "", tombstoneVersion), /Task was deleted after handoff started/);
    verifiedTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.ok(verifiedTombstoneDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, tombstoneIncoming.id));
    assert.equal(verifiedTombstoneDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, tombstoneIncoming.id), undefined);
    verifiedTombstoneDb.close();

    const olderTombstoneIncoming = { ...tombstoneIncoming, id: "task-ownership-tombstone-older" };
    const olderTombstoneHandoffId = randomUUID();
    const olderTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    olderTombstoneDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(projectId, olderTombstoneIncoming.id, "2026-01-03T23:59:59.000Z", peer);
    olderTombstoneDb.close();
    await tasks.reserveTaskHandoff(olderTombstoneHandoffId, projectId, projectId, olderTombstoneIncoming, local.id, "", tombstoneVersion);
    verifiedTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal(verifiedTombstoneDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, olderTombstoneIncoming.id), undefined);
    assert.equal((verifiedTombstoneDb.prepare("SELECT execution_state, active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, olderTombstoneIncoming.id) as { execution_state: string; active_handoff_id: string }).execution_state, "handoff_pending");
    assert.equal((verifiedTombstoneDb.prepare("SELECT execution_state, active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, olderTombstoneIncoming.id) as { execution_state: string; active_handoff_id: string }).active_handoff_id, olderTombstoneHandoffId);
    verifiedTombstoneDb.close();

    const retryTombstoneIncoming = { ...tombstoneIncoming, id: "task-ownership-tombstone-retry" };
    const retryTombstoneHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(retryTombstoneHandoffId, projectId, projectId, retryTombstoneIncoming, local.id, "", tombstoneVersion);
    const retryTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    const placeholderBeforeRetry = retryTombstoneDb.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, retryTombstoneIncoming.id);
    retryTombstoneDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(projectId, retryTombstoneIncoming.id, "2026-01-04T00:00:02.000Z", peer);
    retryTombstoneDb.close();
    await assert.rejects(tasks.reserveTaskHandoff(retryTombstoneHandoffId, projectId, projectId, retryTombstoneIncoming, local.id, "", tombstoneVersion), /Task was deleted after handoff started/);
    verifiedTombstoneDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.deepEqual(verifiedTombstoneDb.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, retryTombstoneIncoming.id), placeholderBeforeRetry);
    verifiedTombstoneDb.close();

    const outgoingProjectId = "project-outgoing-delete";
    const outgoingProjectTask = { ...task, id: "task-ownership-project-outgoing", updatedAt: "2026-01-04T00:00:03.000Z" };
    await inject({ ...outgoingProjectTask, currentNodeId: local.id, originNodeId: local.id }, outgoingProjectId);
    const outgoingProjectHandoff = await tasks.beginOutgoingTaskHandoff(outgoingProjectId, outgoingProjectTask, local.id, peer);
    await assert.rejects(tasks.deleteProjectTasks(outgoingProjectId), (error: Error) => error.message === "Settle task handoffs before deleting project");
    let projectDeleteDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.ok(projectDeleteDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(outgoingProjectId, outgoingProjectTask.id));
    assert.equal((await tasks.getTaskHandoff(outgoingProjectHandoff.handoffId))?.status, "pending");
    projectDeleteDb.close();
    await tasks.abortOutgoingTaskHandoff(outgoingProjectHandoff.handoffId);
    await tasks.deleteProjectTasks(outgoingProjectId);
    projectDeleteDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal(projectDeleteDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(outgoingProjectId, outgoingProjectTask.id), undefined);
    projectDeleteDb.close();
    assert.equal(await tasks.getTaskHandoff(outgoingProjectHandoff.handoffId), undefined);

    const incomingProjectId = "project-incoming-delete";
    const incomingProjectTask = { ...tombstoneIncoming, id: "task-ownership-project-incoming", updatedAt: "2026-01-04T00:00:04.000Z" };
    const incomingProjectHandoffId = randomUUID();
    await tasks.reserveTaskHandoff(incomingProjectHandoffId, incomingProjectId, incomingProjectId, incomingProjectTask, local.id, "", "2026-01-04T00:00:05.000Z");
    await assert.rejects(tasks.deleteProjectTasks(incomingProjectId), (error: Error) => error.message === "Settle task handoffs before deleting project");
    projectDeleteDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.ok(projectDeleteDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(incomingProjectId, incomingProjectTask.id));
    assert.equal((await tasks.getTaskHandoff(incomingProjectHandoffId))?.status, "pending");
    projectDeleteDb.close();
    await tasks.abortPreparedTaskHandoff(incomingProjectHandoffId, local.id);
    await tasks.deleteProjectTasks(incomingProjectId);
    assert.equal(await tasks.getTaskHandoff(incomingProjectHandoffId), undefined);

    const deletedOutgoingTask = { ...task, id: "task-ownership-committed-delete", updatedAt: "2026-01-05T00:00:00.000Z" };
    await inject(deletedOutgoingTask);
    const deletedOutgoing = await tasks.beginOutgoingTaskHandoff(projectId, deletedOutgoingTask, local.id, peer);
    await tasks.markOutgoingTaskHandoff(deletedOutgoing.handoffId, "prepared");
    const deletion = { updatedAt: "2099-01-05T00:00:02.000Z", originNodeId: peer };
    const deletionDb = new DatabaseSync(path.join(dataDir, "node.db"));
    deletionDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(projectId, deletedOutgoingTask.id, deletion.updatedAt, deletion.originNodeId);
    deletionDb.close();
    assert.equal(await tasks.completeTaskHandoff(deletedOutgoing.handoffId, projectId, deletedOutgoingTask.id, local.id, peer, deletion), null);
    assert.equal((await tasks.listTasks(projectId)).find((candidate) => candidate.id === deletedOutgoingTask.id), undefined);
    assert.equal((await tasks.getTaskHandoff(deletedOutgoing.handoffId))?.status, "committed");
    assert.equal(await tasks.completeTaskHandoff(deletedOutgoing.handoffId, projectId, deletedOutgoingTask.id, local.id, peer), null);
    assert.equal((await tasks.getTaskHandoff(deletedOutgoing.handoffId))?.status, "committed");

    const deletedIncomingTask = { ...task, id: "task-ownership-idempotent-delete", currentNodeId: peer, originNodeId: peer, createdAt: "2026-01-05T00:00:03.000Z", updatedAt: "2026-01-05T00:00:03.000Z" };
    const deletedIncomingHandoffId = randomUUID();
    await tasks.prepareTaskHandoff(deletedIncomingHandoffId, projectId, projectId, deletedIncomingTask, local.id, null, "", "2026-01-05T00:00:04.000Z");
    assert.ok(await tasks.commitPreparedTaskHandoff(deletedIncomingHandoffId, local.id));
    const deletedIncomingVersion = { updatedAt: "2026-01-05T00:00:05.000Z", originNodeId: peer };
    const idempotentDeletionDb = new DatabaseSync(path.join(dataDir, "node.db"));
    idempotentDeletionDb.prepare("DELETE FROM tasks WHERE project_id = ? AND id = ?").run(projectId, deletedIncomingTask.id);
    idempotentDeletionDb.prepare("INSERT INTO task_tombstones (project_id, task_id, updated_at, origin_node_id) VALUES (?, ?, ?, ?)").run(projectId, deletedIncomingTask.id, deletedIncomingVersion.updatedAt, deletedIncomingVersion.originNodeId);
    idempotentDeletionDb.close();
    assert.equal(await tasks.commitPreparedTaskHandoff(deletedIncomingHandoffId, local.id), null);
    assert.deepEqual(await tasks.taskHandoffDeletion(deletedIncomingHandoffId), deletedIncomingVersion);

    const deleteTask = { ...task, id: "task-ownership-delete", updatedAt: "2026-01-04T00:00:00.000Z" };
    await inject(deleteTask);
    await tasks.beginOutgoingTaskHandoff(projectId, deleteTask, local.id, peer);
    await assert.rejects(tasks.deleteTask(projectId, deleteTask.id), /awaiting destination commit/);
    await assert.rejects(access(path.join(dataDir, "tasks", `${projectId}.json`)));
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task lease claims are exclusive for the same node and permit expired leases", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-lease-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?lease=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?lease=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?lease=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const projectId = "task-lease-project";
    const taskFor = (id: string, leaseOwnerNodeId: string | null, leaseExpiresAt: string | null): TaskRecord => ({
      id, title: id, description: "task", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {},
      sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: local.id,
      leaseOwnerNodeId, leaseExpiresAt, executionState: leaseOwnerNodeId ? "running" : "idle", handoffContext: null, originNodeId: local.id,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const inject = async (task: TaskRecord) => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: local.id, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: local.id }, createdAt: task.updatedAt }] });
    };

    const idle = taskFor("same-node-concurrent", null, null);
    await inject(idle);
    const claims = await Promise.allSettled([
      tasks.claimTaskLease(projectId, idle.id, local.id),
      tasks.claimTaskLease(projectId, idle.id, local.id),
    ]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = claims.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") assert.match((rejected.reason as Error).message, /owned or leased/);
    const claimed = (await tasks.listTasks(projectId)).find((task) => task.id === idle.id);
    assert.equal(claimed?.executionState, "running");
    assert.equal(claimed?.leaseOwnerNodeId, local.id);
    assert.ok(claimed?.leaseExpiresAt);
    const successfulClaim = claims.find((result): result is PromiseFulfilledResult<{ task: TaskRecord; leaseToken: string }> => result.status === "fulfilled");
    if (!successfulClaim) throw new Error("Expected a successful lease claim");
    const sessionPath = "/tmp/task-session.jsonl";
    const attached = await tasks.updateTaskSessionPath(projectId, idle.id, local.id, successfulClaim.value.leaseToken, sessionPath);
    assert.equal(attached?.sessionPath, sessionPath);
    assert.equal(attached?.executionState, "running");
    assert.equal(await tasks.updateTaskSessionPath(projectId, idle.id, local.id, "stale-token", "/tmp/stale-session.jsonl"), undefined);
    const released = await tasks.releaseTaskLease(projectId, idle.id, local.id, successfulClaim.value.leaseToken);
    assert(Date.parse(released.updatedAt) > Date.parse(successfulClaim.value.task.updatedAt));

    const future = { ...taskFor("future-version", null, null), updatedAt: "2099-01-01T00:00:00.000Z" };
    assert.equal(tasks.nextTaskUpdatedAt(future.updatedAt, 0), "2099-01-01T00:00:00.001Z");
    assert.throws(() => tasks.nextTaskUpdatedAt("invalid"), /Stored task version is invalid/);
    await inject(future);
    const futureClaim = await tasks.claimTaskLease(projectId, future.id, local.id);
    assert(Date.parse(futureClaim.task.updatedAt) >= Date.parse(future.updatedAt) + 1);
    await tasks.releaseTaskLease(projectId, future.id, local.id, futureClaim.leaseToken);

    const expired = taskFor("expired-lease", randomUUID(), new Date(Date.now() - 60_000).toISOString());
    await inject(expired);
    const reclaimed = await tasks.claimTaskLease(projectId, expired.id, local.id);
    assert.equal(reclaimed.task.executionState, "running");
    assert.equal(reclaimed.task.leaseOwnerNodeId, local.id);

    const fenced = taskFor("fenced-lease", null, null);
    await inject(fenced);
    const first = await tasks.claimTaskLease(projectId, fenced.id, local.id, 1);
    const leaseDb = new DatabaseSync(path.join(dataDir, "node.db"));
    leaseDb.prepare("UPDATE tasks SET lease_expires_at = ? WHERE project_id = ? AND id = ?").run(new Date(Date.now() - 1_000).toISOString(), projectId, fenced.id);
    leaseDb.close();
    const second = await tasks.claimTaskLease(projectId, fenced.id, local.id);
    assert.notEqual(second.leaseToken, first.leaseToken);
    await assert.rejects(tasks.releaseTaskLease(projectId, fenced.id, local.id, first.leaseToken), /owned or leased/);
    await assert.rejects(tasks.completeTaskLease(projectId, fenced.id, local.id, first.leaseToken, { title: "Stale title", status: "done" }), /owned or leased/);
    const stale = (await tasks.listTasks(projectId)).find((task) => task.id === fenced.id);
    assert.equal(stale?.title, fenced.title);
    assert.equal(stale?.status, fenced.status);
    assert.equal(stale?.executionState, "running");
    const fencedDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((fencedDb.prepare("SELECT lease_token FROM tasks WHERE project_id = ? AND id = ?").get(projectId, fenced.id) as { lease_token: string }).lease_token, second.leaseToken);
    fencedDb.close();
    const completed = await tasks.completeTaskLease(projectId, fenced.id, local.id, second.leaseToken, { title: "Current title", status: "done" });
    assert.equal(completed.title, "Current title");
    assert.equal(completed.status, "done");
    assert.equal(completed.executionState, "idle");
    assert(Date.parse(completed.updatedAt) > Date.parse(second.task.updatedAt));
    const completedDb = new DatabaseSync(path.join(dataDir, "node.db"));
    const clearedLease = completedDb.prepare("SELECT lease_owner_node_id, lease_expires_at, lease_token FROM tasks WHERE project_id = ? AND id = ?").get(projectId, fenced.id) as { lease_owner_node_id: string | null; lease_expires_at: string | null; lease_token: string | null };
    assert.equal(clearedLease.lease_owner_node_id, null);
    assert.equal(clearedLease.lease_expires_at, null);
    assert.equal(clearedLease.lease_token, null);
    completedDb.close();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task startup recovers locally owned running tasks once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-recovery-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const bootstrapCluster = await import(new URL(`../src/cluster.ts?recovery=${suffix}`, import.meta.url).href);
    const cluster = await import("../src/cluster.ts");
    const replication = await import(new URL(`../src/replication.ts?recovery=${suffix}`, import.meta.url).href);
    await bootstrapCluster.getClusterNode();
    const local = await cluster.getClusterNode();
    const remote = randomUUID();
    const projectId = "task-recovery-project";
    const runningTask = (id: string, currentNodeId: string, originNodeId: string): TaskRecord => ({
      id, title: id, description: "task", status: "in_progress", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {},
      sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId,
      leaseOwnerNodeId: currentNodeId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), executionState: "running", handoffContext: null, originNodeId,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const localRunning = runningTask("local-running", local.id, local.id);
    const remoteRunning = runningTask("remote-running", remote, remote);
    for (const task of [localRunning, remoteRunning]) {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: task.originNodeId, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: task.originNodeId }, createdAt: task.updatedAt }] });
    }

    const recoveryDb = new DatabaseSync(path.join(dataDir, "node.db"));
    recoveryDb.prepare("UPDATE tasks SET lease_token = ? WHERE project_id = ? AND id = ?").run("recovery-token", projectId, localRunning.id);
    recoveryDb.close();

    const recoveredTasks = await import(new URL(`../src/tasks.ts?recovery=${suffix}`, import.meta.url).href);
    const recovered = await recoveredTasks.listTasks(projectId);
    const localTask = recovered.find((task) => task.id === localRunning.id)!;
    const remoteTask = recovered.find((task) => task.id === remoteRunning.id)!;
    assert.equal(localTask.executionState, "failed");
    assert.equal(localTask.leaseOwnerNodeId, null);
    assert.equal(localTask.leaseExpiresAt, null);
    assert.equal(localTask.originNodeId, local.id);
    assert.notEqual(localTask.updatedAt, localRunning.updatedAt);
    assert.equal(remoteTask.executionState, "running");
    assert.equal(remoteTask.leaseOwnerNodeId, remote);
    assert.equal(remoteTask.leaseExpiresAt, remoteRunning.leaseExpiresAt);

    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const recoveredOutbox = db.prepare("SELECT payload FROM replication_outbox WHERE entity_type = 'task'").all() as Array<{ payload: string }>;
    assert.equal(recoveredOutbox.filter(({ payload }) => {
      const event = JSON.parse(payload) as { task: TaskRecord };
      return event.task.id === localRunning.id && event.task.executionState === "failed";
    }).length, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'task.run.recovered' AND entity_id = ?").get(localRunning.id) as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT lease_token FROM tasks WHERE project_id = ? AND id = ?").get(projectId, localRunning.id) as { lease_token: string | null }).lease_token, null);
    db.close();

    const reloadedTasks = await import(new URL(`../src/tasks.ts?recovery-reload=${suffix}`, import.meta.url).href);
    await reloadedTasks.listTasks(projectId);
    const reloadedDb = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((reloadedDb.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'task.run.recovered' AND entity_id = ?").get(localRunning.id) as { count: number }).count, 1);
    reloadedDb.close();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("exact outgoing handoff IDs fence retained round-cycle receipts", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-round-cycle-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?round-cycle=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?round-cycle=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?round-cycle=${suffix}`, import.meta.url).href);
    const source = await cluster.getClusterNode();
    const destination = randomUUID();
    const projectId = "round-cycle-project";
    const task: TaskRecord = {
      id: "round-cycle-task", title: "Round cycle", description: "task", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {},
      sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: source.id, leaseOwnerNodeId: null, leaseExpiresAt: null,
      executionState: "idle", handoffContext: null, originNodeId: source.id, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
    };
    await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: source.id, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: source.id }, createdAt: task.updatedAt }] });

    const first = await tasks.beginOutgoingTaskHandoff(projectId, task, source.id, destination);
    await tasks.markOutgoingTaskHandoff(first.handoffId, "prepared");
    const firstArrival = await tasks.completeTaskHandoff(first.handoffId, projectId, task.id, source.id, destination);
    await tasks.acknowledgeOutgoingTaskHandoff(first.handoffId);
    const firstReceipt = await tasks.getTaskHandoff(first.handoffId);
    assert.equal(firstReceipt?.status, "committed");
    assert.ok(firstReceipt?.acknowledgedAt);

    const returned = await tasks.beginOutgoingTaskHandoff(projectId, firstArrival!, destination, source.id);
    await tasks.markOutgoingTaskHandoff(returned.handoffId, "prepared");
    const returnedTask = await tasks.completeTaskHandoff(returned.handoffId, projectId, task.id, destination, source.id);
    assert.equal(returnedTask?.currentNodeId, source.id);
    assert.equal(returnedTask?.executionState, "idle");

    const second = await tasks.beginOutgoingTaskHandoff(projectId, returnedTask!, source.id, destination);
    await tasks.markOutgoingTaskHandoff(second.handoffId, "prepared");
    await assert.rejects(tasks.completeTaskHandoff(first.handoffId, projectId, task.id, source.id, destination), /Task handoff does not match completion request/);
    assert.equal((await tasks.getTaskHandoff(second.handoffId))?.status, "prepared");
    const pending = (await tasks.listTasks(projectId)).find((candidate) => candidate.id === task.id);
    assert.equal(pending?.executionState, "handoff_pending");

    const finalTask = await tasks.completeTaskHandoff(second.handoffId, projectId, task.id, source.id, destination);
    assert.equal(finalTask?.currentNodeId, destination);
    assert.equal(finalTask?.executionState, "idle");
    assert.deepEqual(await tasks.getTaskHandoff(first.handoffId), firstReceipt);
    assert.equal((await tasks.getTaskHandoff(second.handoffId))?.status, "committed");
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    assert.equal((db.prepare("SELECT active_handoff_id FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id) as { active_handoff_id: string | null }).active_handoff_id, null);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("task deletion preserves active task records and permits stale failed leases", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-delete-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?task-delete=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?task-delete=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?task-delete=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const projectId = "task-delete-project";
    const taskFor = (id: string, executionState: TaskRecord["executionState"], leaseOwnerNodeId: string | null, leaseExpiresAt: string | null): TaskRecord => ({
      id, title: id, description: "task", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {},
      sessionPath: null, worktreePath: "/task-worktree", worktreeBranch: "pi-ticket/task-delete", mergedAt: null, currentNodeId: local.id,
      leaseOwnerNodeId, leaseExpiresAt, executionState, handoffContext: null, originNodeId: local.id,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const inject = async (task: TaskRecord) => {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: local.id, entityType: "task", entityKey: `${projectId}:${task.id}`, operation: "upsert", payload: { projectId, task, originNodeId: local.id }, createdAt: task.updatedAt }] });
    };

    const running = taskFor("running", "running", null, null);
    await inject(running);
    await assert.rejects(tasks.deleteTask(projectId, running.id), (error: Error) => error.message === "Wait for task agent to finish before deleting");
    assert.deepEqual((await tasks.listTasks(projectId)).find((task) => task.id === running.id), running);

    const liveLease = taskFor("live-lease", "idle", local.id, new Date(Date.now() + 60_000).toISOString());
    await inject(liveLease);
    await assert.rejects(tasks.deleteTask(projectId, liveLease.id), (error: Error) => error.message === "Wait for task agent to finish before deleting");
    assert.deepEqual((await tasks.listTasks(projectId)).find((task) => task.id === liveLease.id), liveLease);

    const staleFailed = taskFor("stale-failed", "failed", local.id, new Date(Date.now() - 60_000).toISOString());
    await inject(staleFailed);
    await tasks.deleteTask(projectId, staleFailed.id);
    assert.equal((await tasks.listTasks(projectId)).find((task) => task.id === staleFailed.id), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("committed handoffs retain settlement evidence until acknowledged", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-settlement-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?settlement=${suffix}`, import.meta.url).href);
    const replication = await import(new URL(`../src/replication.ts?settlement=${suffix}`, import.meta.url).href);
    const tasks = await import(new URL(`../src/tasks.ts?settlement=${suffix}`, import.meta.url).href);
    const local = await cluster.getClusterNode();
    const source = randomUUID();
    const incomingTask: TaskRecord = { id: "incoming-settlement", title: "Incoming", description: "task", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: source, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: source, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
    const incomingId = randomUUID();
    await tasks.prepareTaskHandoff(incomingId, "incoming-project", "incoming-project", incomingTask, local.id, null, "", "2026-06-01T00:00:01.000Z");
    await tasks.commitPreparedTaskHandoff(incomingId, local.id);
    assert.equal((await tasks.getTaskHandoff(incomingId))?.acknowledgedAt, null);
    const onwardDestination = randomUUID();
    await assert.rejects(
      tasks.beginOutgoingTaskHandoff("incoming-project", (await tasks.listTasks("incoming-project"))[0], local.id, onwardDestination),
      (error: Error) => error.message === "Wait for incoming task handoff settlement before handing off again",
    );
    const unsettledIncomingTask = (await tasks.listTasks("incoming-project"))[0];
    assert.equal(unsettledIncomingTask.currentNodeId, local.id);
    assert.equal(unsettledIncomingTask.executionState, "idle");
    await assert.rejects(tasks.deleteProjectTasks("incoming-project"), (error: Error) => error.message === "Wait for task handoff settlement before deleting project");
    await tasks.acknowledgeIncomingTaskHandoff(incomingId, local.id);
    const onward = await tasks.beginOutgoingTaskHandoff("incoming-project", unsettledIncomingTask, local.id, onwardDestination);
    assert.equal(onward.status, "pending");
    await tasks.abortOutgoingTaskHandoff(onward.handoffId);
    const incomingAcknowledgedAt = (await tasks.getTaskHandoff(incomingId))?.acknowledgedAt;
    assert.ok(incomingAcknowledgedAt);
    await tasks.acknowledgeIncomingTaskHandoff(incomingId, local.id);
    assert.equal((await tasks.getTaskHandoff(incomingId))?.acknowledgedAt, incomingAcknowledgedAt);
    await tasks.deleteProjectTasks("incoming-project");

    const outgoingTask = { ...incomingTask, id: "outgoing-settlement", currentNodeId: local.id, originNodeId: local.id };
    await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: local.id, entityType: "task", entityKey: `outgoing-project:${outgoingTask.id}`, operation: "upsert", payload: { projectId: "outgoing-project", task: outgoingTask, originNodeId: local.id }, createdAt: outgoingTask.updatedAt }] });
    const outgoing = await tasks.beginOutgoingTaskHandoff("outgoing-project", outgoingTask, local.id, source);
    await tasks.markOutgoingTaskHandoff(outgoing.handoffId, "prepared");
    await tasks.completeTaskHandoff(outgoing.handoffId, "outgoing-project", outgoingTask.id, local.id, source);
    await tasks.markOutgoingTaskHandoff(outgoing.handoffId, "committed");
    assert.deepEqual((await tasks.listUnfinishedOutgoingTaskHandoffs()).map((record) => record.handoffId), [outgoing.handoffId]);
    await assert.rejects(tasks.deleteProjectTasks("outgoing-project"), (error: Error) => error.message === "Wait for task handoff settlement before deleting project");
    assert.equal((await tasks.getTaskHandoff(outgoing.handoffId))?.status, "committed");
    await tasks.acknowledgeOutgoingTaskHandoff(outgoing.handoffId);
    assert.equal((await tasks.listUnfinishedOutgoingTaskHandoffs()).find((record) => record.handoffId === outgoing.handoffId), undefined);
    await tasks.deleteProjectTasks("outgoing-project");
    assert.equal(await tasks.getTaskHandoff(outgoing.handoffId), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
