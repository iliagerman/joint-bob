import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { replicationInvalidations } from "../src/replication.ts";

async function freshRecents(dataDir: string) {
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    return await import(`../src/recent-sessions.ts?recents=${Date.now()}-${Math.random()}`);
  } finally {
    delete process.env.PI_WEB_DATA_DIR;
  }
}

function createNode(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  db.exec(`CREATE TABLE cluster_node (id TEXT NOT NULL, name TEXT NOT NULL, singleton INTEGER NOT NULL, url TEXT NOT NULL, paired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO cluster_node VALUES ('node-a', 'A', 1, 'http://127.0.0.1:1', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
  db.close();
}

const recent = (projectId = "project-1", sessionId = "session-1", openedAt = "2026-09-02T12:00:00.000Z") => ({
  projectId, engine: "pi" as const, sessionId, sessionPath: `/node/${sessionId}.jsonl`, title: sessionId, openedAt, updatedAt: null,
});

test("recent upserts and deletes publish stable per-conversation events", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recents-outbox-"));
  try {
    createNode(dataDir);
    const recents = await freshRecents(dataDir);
    recents.setUserRecentSession("ilia", recent(), "node-a");
    recents.removeUserRecentSession("ilia", { projectId: "project-1", engine: "pi", sessionId: "session-1" }, "node-a");
    assert.deepEqual(recents.listUserRecentSessions("ilia"), []);
    assert.deepEqual(recents.listUserRecentSessions("other"), []);
    const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
    const events = db.prepare("SELECT entity_type, entity_key, operation, payload FROM replication_outbox ORDER BY rowid").all() as Array<{ entity_type: string; entity_key: string; operation: string; payload: string }>;
    assert.deepEqual(events.map(({ entity_type, entity_key, operation }) => ({ entity_type, entity_key, operation })), [
      { entity_type: "user.recent", entity_key: "ilia:project-1:pi:session-1", operation: "upsert" },
      { entity_type: "user.recent", entity_key: "ilia:project-1:pi:session-1", operation: "delete" },
    ]);
    assert.equal((JSON.parse(events[0].payload) as { recent: unknown }).recent !== null, true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("recent replication resolves aliases and converges out-of-order stamps", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recents-merge-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    createNode(dataDir);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL); INSERT INTO project_aliases VALUES ('remote', 'local')");
    db.close();
    const { receiveReplicationBatch } = await import(`../src/replication.ts?recents=${Date.now()}`);
    const event = (id: string, operation: "upsert" | "delete", updatedAt: string, originNodeId = "node-b") => ({
      id, originNodeId, entityType: "user.recent", entityKey: "ilia:remote:pi:session-1", operation, createdAt: updatedAt,
      payload: { username: "ilia", projectId: "remote", engine: "pi", sessionId: "session-1", recent: operation === "upsert" ? recent("remote", "session-1", updatedAt) : null, updatedAt, originNodeId },
    });
    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000001", "delete", "2026-09-02T12:00:00.000Z")] });
    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000002", "upsert", "2026-09-02T11:00:00.000Z")] });
    const recents = await freshRecents(dataDir);
    assert.deepEqual(recents.listUserRecentSessions("ilia"), []);
    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000003", "upsert", "2026-09-02T13:00:00.000Z")] });
    assert.deepEqual(recents.listUserRecentSessions("ilia").map((entry: { projectId: string }) => entry.projectId), ["local"]);
    await assert.rejects(() => receiveReplicationBatch({ events: [{ ...event("00000000-0000-4000-8000-000000000004", "upsert", "2026-09-02T14:00:00.000Z"), entityKey: "wrong" }] }), /Malformed recent session replication payload/);
  } finally { if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous; await rm(dataDir, { recursive: true, force: true }); }
});

test("same-conversation upserts converge monotonic data and operation stamps", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recents-converge-"));
  try {
    createNode(dataDir);
    const recents = await freshRecents(dataDir);
    const laterOpen = { ...recent("project-1", "session-1", "2026-09-02T14:00:00.000Z"), sessionPath: "/later.jsonl", title: "Later opening" };
    const activityRefresh = { ...recent("project-1", "session-1", "2026-09-02T12:00:00.000Z"), sessionPath: "/older.jsonl", title: "Older opening", updatedAt: "2026-09-02T16:00:00.000Z" };
    const event = (id: string, originNodeId: string, updatedAt: string, value: typeof laterOpen) => ({
      id, originNodeId, entityType: "user.recent", entityKey: "ilia:project-1:pi:session-1", operation: "upsert", createdAt: updatedAt,
      payload: { username: "ilia", projectId: "project-1", engine: "pi", sessionId: "session-1", recent: value, updatedAt, originNodeId },
    });
    const opening = event("00000000-0000-4000-8000-000000000011", "node-a", "2026-09-02T13:00:00.000Z", laterOpen);
    const activity = event("00000000-0000-4000-8000-000000000012", "node-b", "2026-09-02T15:00:00.000Z", activityRefresh);
    const first = new DatabaseSync(path.join(dataDir, "first.db"));
    const second = new DatabaseSync(path.join(dataDir, "second.db"));
    recents.applyUserRecentSessionEvent(first, opening);
    recents.applyUserRecentSessionEvent(first, activity);
    recents.applyUserRecentSessionEvent(second, activity);
    recents.applyUserRecentSessionEvent(second, opening);
    const row = (db: DatabaseSync) => ({ ...db.prepare("SELECT session_path, title, opened_at, activity_updated_at, updated_at, origin_node_id FROM user_recent_sessions").get() });
    assert.deepEqual(row(first), row(second));
    assert.deepEqual(row(first), {
      session_path: "/later.jsonl", title: "Later opening", opened_at: "2026-09-02T14:00:00.000Z",
      activity_updated_at: "2026-09-02T16:00:00.000Z", updated_at: "2026-09-02T15:00:00.000Z", origin_node_id: "node-b",
    });

    const tiedFirst = new DatabaseSync(path.join(dataDir, "tied-first.db"));
    const tiedSecond = new DatabaseSync(path.join(dataDir, "tied-second.db"));
    const timestamp = "2026-09-02T17:00:00.000Z";
    const fromZ = event("00000000-0000-4000-8000-000000000013", "node-z", timestamp, { ...laterOpen, sessionPath: "/z.jsonl", title: "Z" });
    const fromA = event("00000000-0000-4000-8000-000000000014", "node-a", timestamp, { ...laterOpen, sessionPath: "/a.jsonl", title: "A" });
    recents.applyUserRecentSessionEvent(tiedFirst, fromZ);
    recents.applyUserRecentSessionEvent(tiedFirst, fromA);
    recents.applyUserRecentSessionEvent(tiedSecond, fromA);
    recents.applyUserRecentSessionEvent(tiedSecond, fromZ);
    assert.deepEqual(row(tiedFirst), row(tiedSecond));
    assert.deepEqual(row(tiedFirst), {
      session_path: "/z.jsonl", title: "Z", opened_at: laterOpen.openedAt,
      activity_updated_at: null, updated_at: timestamp, origin_node_id: "node-z",
    });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("different recents merge and legacy migration publishes stable rows once", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recents-migration-"));
  try {
    createNode(dataDir);
    const recents = await freshRecents(dataDir);
    recents.setUserRecentSession("ilia", recent("project-1", "older", "2026-09-02T11:00:00.000Z"), "node-a");
    recents.setUserRecentSession("ilia", recent("project-1", "newer", "2026-09-02T12:00:00.000Z"), "node-a");
    assert.deepEqual(recents.listUserRecentSessions("ilia").map((entry: { sessionId: string }) => entry.sessionId), ["newer", "older"]);
    const newestLegacy = { ...recent("project-2", "legacy", "2021-01-01T00:00:00.000Z"), title: "Newest legacy" };
    const olderLegacy = { ...recent("project-2", "legacy", "2020-01-01T00:00:00.000Z"), title: "Older legacy" };
    recents.migrateLegacyRecentSessions("other", [newestLegacy, olderLegacy], "node-a");
    recents.migrateLegacyRecentSessions("other", [newestLegacy, olderLegacy], "node-a");
    const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
    const events = db.prepare("SELECT payload FROM replication_outbox WHERE entity_type = 'user.recent' AND entity_key = 'other:project-2:pi:legacy'").all() as Array<{ payload: string }>;
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].payload), {
      username: "other", projectId: "project-2", engine: "pi", sessionId: "legacy", recent: newestLegacy,
      updatedAt: "2021-01-01T00:00:00.000Z", originNodeId: "node-a",
    });
    assert.deepEqual(replicationInvalidations([{ entityType: "user.recent" } as never]), ["recentsChanged"]);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
