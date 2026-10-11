// A worktree's own metadata reaches another node by file sync, behind every smaller file in
// the folder: on 2026-10-11 that took 35 minutes, and the node listed four running fix
// conversations as plain project conversations until it landed. The conversation's record
// replicates in seconds, so it carries the worktree.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

type Records = typeof import("../src/conversation-records.ts");
type Event = Parameters<Records["applyConversationRecordEvent"]>[1];

const PROJECT = "project";
const CONVERSATION = "123e4567-e89b-42d3-a456-426614174000";
const WORKTREE = { id: "41ab1391-dd48-4ca3-9398-c1be5a8f8a27", name: "audit-email-attachment-scope", color: "teal" as const };

function stored(db: DatabaseSync): { worktree: string | null; worktree_at: string | null } {
  return db.prepare("SELECT worktree, worktree_at FROM conversation_records WHERE project_id = ? AND engine = 'pi' AND session_id = ?").get(PROJECT, CONVERSATION) as { worktree: string | null; worktree_at: string | null };
}

test("a conversation's record carries its worktree to other nodes, through renames and deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-worktree-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const origin = randomUUID();
  try {
    // A database from before the worktree columns existed gains them on open.
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const legacy = new DatabaseSync(path.join(process.env.JOINT_BOB_DATA_DIR, "node.db"));
    legacy.exec(`CREATE TABLE conversation_records (project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      origin_node_id TEXT NOT NULL DEFAULT '', task_id TEXT, conversation_id TEXT, segment_index INTEGER NOT NULL DEFAULT 0, cron_task_id TEXT, silent_review_from TEXT, silent_review_until TEXT,
      PRIMARY KEY (project_id, engine, session_id))`);
    legacy.close();
    const records: Records = await import(`../src/conversation-records.ts?worktree=${Date.now()}`);

    // The node the conversation starts on: its events are what every other node receives.
    const local = new DatabaseSync(path.join(root, "data", "node.db"));
    const sent = (): Event[] => (local.prepare("SELECT * FROM replication_outbox WHERE entity_type = 'conversation.record' ORDER BY rowid").all() as Array<Record<string, string>>)
      .map((row) => ({ id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at }));

    await records.ensureConversationRecord(PROJECT, "pi", CONVERSATION, origin);
    assert.equal((await records.getConversationRecord(PROJECT, "pi", CONVERSATION))?.worktree, undefined);
    await delay(5);
    assert.equal(await records.setConversationWorktree(PROJECT, "pi", CONVERSATION, WORKTREE, origin), true);
    assert.deepEqual((await records.getConversationRecord(PROJECT, "pi", CONVERSATION))?.worktree, WORKTREE);
    assert.deepEqual([...await records.recordedConversationWorktrees(PROJECT)], [[`pi:${CONVERSATION}`, WORKTREE]]);
    const [created, marked] = sent();

    // Another node has neither the worktree's folder nor its metadata; the record is all it needs.
    const peer = new DatabaseSync(":memory:");
    records.ensureConversationRecordSchema(peer);
    records.applyConversationRecordEvent(peer, created);
    assert.equal(stored(peer).worktree, null);
    records.applyConversationRecordEvent(peer, marked);
    assert.deepEqual(JSON.parse(stored(peer).worktree ?? "null"), WORKTREE);

    // A node that had not heard of the worktree updates the record for its own reasons: the worktree stays.
    const elsewhere = randomUUID();
    const later = new Date(Date.now() + 60_000).toISOString();
    const base = (marked.payload as { record: Record<string, unknown> }).record;
    const { worktree: _worktree, worktreeAt: _worktreeAt, ...unaware } = base;
    records.applyConversationRecordEvent(peer, {
      id: randomUUID(), originNodeId: elsewhere, entityType: "conversation.record", entityKey: marked.entityKey, operation: "upsert", createdAt: later,
      payload: { projectId: PROJECT, engine: "pi", sessionId: CONVERSATION, updatedAt: later, originNodeId: elsewhere, record: { ...unaware, cronTaskId: "task", updatedAt: later, originNodeId: elsewhere } },
    });
    assert.deepEqual(JSON.parse(stored(peer).worktree ?? "null"), WORKTREE);
    assert.equal((peer.prepare("SELECT cron_task_id FROM conversation_records").get() as { cron_task_id: string }).cron_task_id, "task");

    // Opening the conversation again, here or on a node holding a stale copy of the worktree, changes nothing.
    assert.equal(await records.setConversationWorktree(PROJECT, "pi", CONVERSATION, { ...WORKTREE, name: "stale name" }, origin), false);

    // A rename follows the conversation to every node.
    await delay(5);
    const renamedTo = { ...WORKTREE, name: "email attachment scope", color: "violet" as const };
    assert.equal(await records.syncConversationWorktrees(PROJECT, WORKTREE.id, renamedTo, origin), 1);
    assert.equal(await records.syncConversationWorktrees(PROJECT, WORKTREE.id, renamedTo, origin), 0, "an unchanged worktree publishes nothing");
    assert.equal(await records.syncConversationWorktrees(PROJECT, randomUUID(), null, origin), 0, "another worktree's deletion leaves it alone");
    const renamed = sent().at(-1)!;
    records.applyConversationRecordEvent(peer, renamed);
    assert.deepEqual(JSON.parse(stored(peer).worktree ?? "null"), renamedTo);

    // Deleting the worktree clears it everywhere, and opening the conversation later does not bring it back.
    await delay(5);
    assert.equal(await records.syncConversationWorktrees(PROJECT, WORKTREE.id, null, origin), 1);
    const cleared = sent().at(-1)!;
    assert.equal((await records.getConversationRecord(PROJECT, "pi", CONVERSATION))?.worktree, null);
    assert.equal((await records.recordedConversationWorktrees(PROJECT)).size, 0);
    assert.equal(await records.setConversationWorktree(PROJECT, "pi", CONVERSATION, WORKTREE, origin), false);
    records.applyConversationRecordEvent(peer, cleared);
    assert.equal(stored(peer).worktree, null);

    // Events can arrive out of order: a late copy of the rename must not undo the deletion.
    const reordered = new DatabaseSync(":memory:");
    records.ensureConversationRecordSchema(reordered);
    for (const event of [cleared, renamed, marked, created]) records.applyConversationRecordEvent(reordered, event);
    assert.equal(stored(reordered).worktree, null);
    assert.equal(stored(reordered).worktree_at, (cleared.payload as { record: { worktreeAt: string } }).record.worktreeAt);

    // A colour this release does not know is left out; the record itself still applies.
    const future = new DatabaseSync(":memory:");
    records.ensureConversationRecordSchema(future);
    const markedPayload = marked.payload as { record: Record<string, unknown> };
    records.applyConversationRecordEvent(future, { ...marked, payload: { ...markedPayload, record: { ...markedPayload.record, worktree: { ...WORKTREE, color: "ultraviolet" } } } });
    assert.deepEqual({ ...stored(future) }, { worktree: null, worktree_at: null });
    for (const db of [local, peer, reordered, future]) db.close();
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
