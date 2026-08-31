import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("SQLite name replication is atomic, idempotent, ordered, and retryable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-replication-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const suffix = Date.now();
    const cluster = await import(new URL(`../src/cluster.ts?replication=${suffix}`, import.meta.url).href);
    const store = await import(new URL(`../src/store.ts?replication=${suffix}`, import.meta.url).href);
    const names = await import(new URL(`../src/names.ts?replication=${suffix}`, import.meta.url).href);
    const replication = await import("../src/replication.ts");
    const tasks = await import(new URL(`../src/tasks.ts?replication=${suffix}`, import.meta.url).href);
    const node = await cluster.getClusterNode();
    const projectIds = ["project-atomic", "project-duplicate", "project-conflict"];
    for (const id of projectIds) {
      await store.importProject({ id, name: id, path: `/remote/${id}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, path.join(dataDir, id));
    }
    const canonicalProjectId = "project-conversation-canonical";
    const aliasProjectId = "project-conversation-alias";
    await store.importProject({ id: canonicalProjectId, name: canonicalProjectId, path: `/remote/${canonicalProjectId}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, path.join(dataDir, canonicalProjectId));
    await store.registerProjectAliases(canonicalProjectId, [aliasProjectId]);

    await names.setProjectName("project-atomic", "Atomic name");
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    const outbox = db.prepare("SELECT event_id, origin_node_id, payload FROM replication_outbox").all() as Array<{ event_id: string; origin_node_id: string; payload: string }>;
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].origin_node_id, node.id);
    assert.deepEqual(JSON.parse(outbox[0].payload), {
      scope: "projects", key: "project-atomic", name: "Atomic name", updatedAt: JSON.parse(outbox[0].payload).updatedAt, originNodeId: node.id,
    });
    await assert.rejects(access(path.join(dataDir, "names.json")));

    const duplicate = {
      id: randomUUID(), originNodeId: randomUUID(), entityType: "name.override", entityKey: "projects:project-duplicate", operation: "upsert" as const,
      payload: { scope: "projects" as const, key: "project-duplicate", name: "First", updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID() },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const duplicateBatch = { events: [duplicate] };
    assert.deepEqual(await replication.receiveReplicationBatch(duplicateBatch), [duplicate.id]);
    assert.deepEqual(await replication.receiveReplicationBatch(duplicateBatch), [duplicate.id]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_inbox WHERE event_id = ?").get(duplicate.id) as { count: number }).count, 1);
    assert.equal((await names.projectNameOverrides())["project-duplicate"], "First");

    const origin = randomUUID();
    const event = (id: string, name: string | null, updatedAt: string) => ({
      id, originNodeId: origin, entityType: "name.override", entityKey: "projects:project-conflict", operation: name === null ? "delete" as const : "upsert" as const,
      payload: { scope: "projects" as const, key: "project-conflict", name, updatedAt, originNodeId: origin }, createdAt: updatedAt,
    });
    const deleted = event(randomUUID(), null, "2026-02-02T00:00:00.000Z");
    await replication.receiveReplicationBatch({ events: [deleted] });
    await replication.receiveReplicationBatch({ events: [event(randomUUID(), "Older", "2026-02-01T00:00:00.000Z")] });
    assert.equal((await names.projectNameOverrides())["project-conflict"], undefined);
    await replication.receiveReplicationBatch({ events: [event(randomUUID(), "Newer", "2026-02-03T00:00:00.000Z")] });
    assert.equal((await names.projectNameOverrides())["project-conflict"], "Newer");

    const conversationOrigin = randomUUID();
    const conversationId = randomUUID();
    const conversationEvent = (operation: "upsert" | "delete", updatedAt: string) => ({
      id: randomUUID(), originNodeId: conversationOrigin, entityType: "conversation.record", entityKey: `${aliasProjectId}:pi:${conversationId}`, operation,
      payload: { projectId: aliasProjectId, engine: "pi", sessionId: conversationId, record: operation === "upsert" ? { projectId: aliasProjectId, engine: "pi", sessionId: conversationId, createdAt: "2026-02-01T00:00:00.000Z", updatedAt, originNodeId: conversationOrigin } : null, updatedAt, originNodeId: conversationOrigin }, createdAt: updatedAt,
    });
    const upsert = conversationEvent("upsert", "2026-02-02T00:00:00.000Z");
    await replication.receiveReplicationBatch({ events: [upsert] });
    await replication.receiveReplicationBatch({ events: [upsert] });
    const replicatedConversation = db.prepare("SELECT project_id, engine, session_id, origin_node_id FROM conversation_records WHERE session_id = ?").get(conversationId) as { project_id: string; engine: string; session_id: string; origin_node_id: string };
    assert.equal(replicatedConversation.project_id, canonicalProjectId);
    assert.equal(replicatedConversation.engine, "pi");
    assert.equal(replicatedConversation.session_id, conversationId);
    assert.equal(replicatedConversation.origin_node_id, conversationOrigin);
    await replication.receiveReplicationBatch({ events: [conversationEvent("delete", "2026-02-01T00:00:00.000Z")] });
    assert.ok(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId));
    await replication.receiveReplicationBatch({ events: [conversationEvent("delete", "2026-02-03T00:00:00.000Z")] });
    assert.equal(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId), undefined);
    const conversationTombstone = db.prepare("SELECT project_id, origin_node_id FROM conversation_record_tombstones WHERE session_id = ?").get(conversationId) as { project_id: string; origin_node_id: string };
    assert.equal(conversationTombstone.project_id, canonicalProjectId);
    assert.equal(conversationTombstone.origin_node_id, conversationOrigin);
    await replication.receiveReplicationBatch({ events: [conversationEvent("upsert", "2026-02-02T00:00:00.000Z")] });
    assert.equal(db.prepare("SELECT 1 FROM conversation_records WHERE session_id = ?").get(conversationId), undefined);

    const peerId = randomUUID();
    const due = await replication.eventsForPeer(peerId, new Date("2026-03-01T00:00:00.000Z"));
    await replication.recordPeerFailure(peerId, [due[0].id], "offline", new Date("2026-03-01T00:00:00.000Z"));
    const failed = db.prepare("SELECT attempts, next_attempt_at, delivered_at, last_error FROM replication_deliveries WHERE event_id = ? AND peer_id = ?").get(due[0].id, peerId) as { attempts: number; next_attempt_at: string; delivered_at: string | null; last_error: string | null };
    assert.equal(failed.attempts, 1);
    assert(Date.parse(failed.next_attempt_at) > Date.parse("2026-03-01T00:00:00.000Z"));
    assert.equal(failed.last_error, "offline");
    await replication.recordPeerReceipt(peerId, [due[0].id]);
    const delivered = db.prepare("SELECT delivered_at, last_error FROM replication_deliveries WHERE event_id = ? AND peer_id = ?").get(due[0].id, peerId) as { delivered_at: string | null; last_error: string | null };
    assert(delivered.delivered_at);
    assert.equal(delivered.last_error, null);

    const taskOrigin = randomUUID();
    const handoffTask = { id: "handoff-fence", title: "Source", description: "Task", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: taskOrigin, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: taskOrigin, createdAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" };
    const taskEvent = (operation: "upsert" | "delete", task: typeof handoffTask) => ({ id: randomUUID(), originNodeId: taskOrigin, entityType: "task", entityKey: `project-atomic:${task.id}`, operation, payload: { projectId: "project-atomic", task, originNodeId: taskOrigin }, createdAt: task.updatedAt });
    await replication.receiveReplicationBatch({ events: [taskEvent("upsert", handoffTask)] });
    db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(randomUUID(), "project-atomic", handoffTask.id);
    const newerTask = { ...handoffTask, title: "Newer source", updatedAt: "2026-04-02T00:00:00.000Z" };
    const activeUpsert = taskEvent("upsert", newerTask);
    assert.deepEqual(await replication.receiveReplicationBatch({ events: [activeUpsert] }), []);
    assert.equal(db.prepare("SELECT 1 FROM replication_inbox WHERE event_id = ?").get(activeUpsert.id), undefined);
    assert.equal((db.prepare("SELECT title FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", handoffTask.id) as { title: string }).title, "Source");
    db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ?").run("project-atomic", handoffTask.id);
    assert.deepEqual(await replication.receiveReplicationBatch({ events: [activeUpsert] }), [activeUpsert.id]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_inbox WHERE event_id = ?").get(activeUpsert.id) as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT title FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", handoffTask.id) as { title: string }).title, "Newer source");
    db.prepare("UPDATE tasks SET active_handoff_id = ? WHERE project_id = ? AND id = ?").run(randomUUID(), "project-atomic", handoffTask.id);
    const activeDelete = taskEvent("delete", { ...newerTask, updatedAt: "2026-04-03T00:00:00.000Z" });
    assert.deepEqual(await replication.receiveReplicationBatch({ events: [activeDelete] }), [activeDelete.id]);
    assert.equal((db.prepare("SELECT title FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", handoffTask.id) as { title: string }).title, "Newer source");
    const activeTombstone = db.prepare("SELECT updated_at, origin_node_id FROM task_tombstones WHERE project_id = ? AND task_id = ?").get("project-atomic", handoffTask.id) as { updated_at: string; origin_node_id: string };
    assert.equal(activeTombstone.updated_at, "2026-04-03T00:00:00.000Z");
    assert.equal(activeTombstone.origin_node_id, taskOrigin);
    await replication.receiveReplicationBatch({ events: [activeDelete] });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_inbox WHERE event_id = ?").get(activeDelete.id) as { count: number }).count, 1);
    db.prepare("UPDATE tasks SET active_handoff_id = NULL WHERE project_id = ? AND id = ?").run("project-atomic", handoffTask.id);
    assert.ok(db.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get("project-atomic", handoffTask.id));
    await replication.receiveReplicationBatch({ events: [taskEvent("delete", { ...newerTask, updatedAt: "2026-04-04T00:00:00.000Z" })] });
    assert.equal(db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", handoffTask.id), undefined);

    const leaseTask = (id: string) => ({ ...handoffTask, id, currentNodeId: node.id, originNodeId: node.id });
    const claimThenRelease = leaseTask("claim-then-release");
    const releaseThenClaim = leaseTask("release-then-claim");
    for (const task of [claimThenRelease, releaseThenClaim]) {
      await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: task.originNodeId, entityType: "task", entityKey: `project-atomic:${task.id}`, operation: "upsert", payload: { projectId: "project-atomic", task, originNodeId: task.originNodeId }, createdAt: task.updatedAt }] });
    }
    const firstClaim = await tasks.claimTaskLease("project-atomic", claimThenRelease.id, node.id);
    const firstRelease = await tasks.releaseTaskLease("project-atomic", claimThenRelease.id, node.id, firstClaim.leaseToken);
    const secondClaim = await tasks.claimTaskLease("project-atomic", releaseThenClaim.id, node.id);
    const secondRelease = await tasks.releaseTaskLease("project-atomic", releaseThenClaim.id, node.id, secondClaim.leaseToken);
    assert.notEqual(firstClaim.task.updatedAt, firstRelease.updatedAt);
    assert.notEqual(secondClaim.task.updatedAt, secondRelease.updatedAt);
    assert.equal(firstClaim.task.originNodeId, firstRelease.originNodeId);
    assert.equal(secondClaim.task.originNodeId, secondRelease.originNodeId);

    db.prepare("DELETE FROM tasks WHERE project_id = ? AND id IN (?, ?)").run("project-atomic", claimThenRelease.id, releaseThenClaim.id);
    const leaseEvent = (task: typeof firstRelease) => ({ id: randomUUID(), originNodeId: task.originNodeId, entityType: "task", entityKey: `project-atomic:${task.id}`, operation: "upsert" as const, payload: { projectId: "project-atomic", task, originNodeId: task.originNodeId }, createdAt: task.updatedAt });
    await replication.receiveReplicationBatch({ events: [leaseEvent(firstClaim.task)] });
    await replication.receiveReplicationBatch({ events: [leaseEvent(firstRelease)] });
    await replication.receiveReplicationBatch({ events: [leaseEvent(secondRelease)] });
    await replication.receiveReplicationBatch({ events: [leaseEvent(secondClaim.task)] });
    for (const id of [claimThenRelease.id, releaseThenClaim.id]) {
      const replicated = db.prepare("SELECT execution_state, lease_owner_node_id FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", id) as { execution_state: string; lease_owner_node_id: string | null };
      assert.equal(replicated.execution_state, "idle");
      assert.equal(replicated.lease_owner_node_id, null);
    }

    const tombstonedOwner = randomUUID();
    await cluster.mergeClusterMembership({ members: [], removed: [{ id: tombstonedOwner, removedAt: "2026-05-01T00:00:00.000Z", originNodeId: node.id }] });
    const tombstonedTask = { ...handoffTask, id: "tombstoned-owner-task", title: "Rejected", currentNodeId: tombstonedOwner, originNodeId: tombstonedOwner, createdAt: "2026-05-02T00:00:00.000Z", updatedAt: "2026-05-02T00:00:00.000Z" };
    const tombstonedTaskEvent = (task: typeof tombstonedTask) => ({
      id: randomUUID(), originNodeId: tombstonedOwner, entityType: "task", entityKey: `project-atomic:${task.id}`, operation: "upsert" as const,
      payload: { projectId: "project-atomic", task, originNodeId: tombstonedOwner }, createdAt: task.updatedAt,
    });
    const rejectedEvent = tombstonedTaskEvent(tombstonedTask);
    await replication.receiveReplicationBatch({ events: [rejectedEvent] });
    await replication.receiveReplicationBatch({ events: [rejectedEvent] });
    assert.equal(db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", tombstonedTask.id), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_inbox WHERE event_id = ?").get(rejectedEvent.id) as { count: number }).count, 1);

    await cluster.mergeClusterMembership({ members: [{ id: tombstonedOwner, name: "Re-paired", url: "https://repaired.tailnet.ts.net", token: "repaired-token", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }] });
    const acceptedTask = { ...tombstonedTask, title: "Accepted", updatedAt: "2026-06-02T00:00:00.000Z" };
    await replication.receiveReplicationBatch({ events: [tombstonedTaskEvent(acceptedTask)] });
    assert.equal((db.prepare("SELECT title FROM tasks WHERE project_id = ? AND id = ?").get("project-atomic", tombstonedTask.id) as { title: string }).title, "Accepted");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
