import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("conversation records provide drafts until a transcript replaces them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-records-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const legacyId = "223e4567-e89b-42d3-a456-426614174000";
  const project = { id: "project", name: "Project", path: path.join(root, "project"), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const originNodeId = randomUUID();
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const legacy = new DatabaseSync(path.join(process.env.JOINT_BOB_DATA_DIR, "node.db"));
    legacy.exec(`CREATE TABLE cluster_node (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE conversation_records (project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, engine, session_id));`);
    legacy.prepare("INSERT INTO cluster_node VALUES (1, ?, 'node', '', ?, ?)").run(originNodeId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy.prepare("INSERT INTO conversation_records VALUES ('legacy-project', 'claude', ?, ?, ?)").run(legacyId, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    legacy.close();

    const records = await import(`../src/conversation-records.ts?test=${Date.now()}`);
    assert.equal((await records.getConversationRecord("legacy-project", "claude", legacyId))?.originNodeId, originNodeId);
    const first = await records.ensureConversationRecord(project.id, "pi", id, originNodeId);
    const second = await records.ensureConversationRecord(project.id, "pi", id, originNodeId);
    assert.equal((await records.listConversationRecords(project.id)).length, 1);
    assert.equal((await records.getConversationRecord(project.id, "pi", id))?.sessionId, id);
    assert.equal(first.originNodeId, originNodeId);
    assert.equal(second.originNodeId, originNodeId);
    const outbox = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.equal((outbox.prepare("SELECT COUNT(*) AS count FROM replication_outbox WHERE entity_type = 'conversation.record' AND operation = 'upsert'").get() as { count: number }).count, 2);
    outbox.close();
    assert.ok(second.updatedAt >= first.updatedAt);
    assert.deepEqual(records.parseConversationDraftPath(`draft:pi:${id}`), { engine: "pi", sessionId: id });
    assert.equal(records.parseConversationDraftPath("draft:pi:not-a-uuid"), undefined);
    assert.deepEqual(records.parseConversationDraftPath("draft:other:123e4567-e89b-42d3-a456-426614174000"), { engine: "other", sessionId: id });

    const { updateSettings } = await import("../src/settings.js");
    const sessionPath = path.join(root, "sessions");
    updateSettings({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" }, projects: { homePath: path.join(root, "home") } });
    const { listHarnessSessions } = await import("../src/harnesses.js");
    assert.equal((await listHarnessSessions(project)).filter((session) => session.id === id).length, 1);
    assert.ok((await listHarnessSessions(project)).some((session) => session.path === `draft:pi:${id}`));

    await mkdir(sessionPath, { recursive: true });
    await writeFile(path.join(sessionPath, `${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: project.path })}\n${JSON.stringify({ type: "message", id: "message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } })}\n`);
    const merged = (await listHarnessSessions(project)).filter((session) => session.id === id);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].draft, undefined);
    assert.equal(await records.deleteConversationRecord(project.id, "pi", id, originNodeId), true);
    assert.equal(await records.getConversationRecord(project.id, "pi", id), undefined);
    const db = new DatabaseSync(path.join(root, "data", "node.db"));
    assert.equal((db.prepare("SELECT origin_node_id FROM conversation_record_tombstones WHERE project_id = ? AND engine = ? AND session_id = ?").get(project.id, "pi", id) as { origin_node_id: string }).origin_node_id, originNodeId);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM replication_outbox WHERE entity_type = 'conversation.record' AND operation = 'delete'").get() as { count: number }).count, 1);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
