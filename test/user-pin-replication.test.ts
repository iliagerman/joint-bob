import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function freshPins(dataDir: string) {
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    return await import(`../src/user-pins.ts?pins=${Date.now()}-${Math.random()}`);
  } finally {
    delete process.env.PI_WEB_DATA_DIR;
  }
}

function createNode(dataDir: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  db.exec(`
    CREATE TABLE cluster_node (id TEXT NOT NULL, name TEXT NOT NULL, singleton INTEGER NOT NULL, url TEXT NOT NULL, paired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO cluster_node VALUES ('node-a', 'A', 1, 'http://127.0.0.1:1', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  db.close();
}

test("project and conversation pin changes enqueue separate stable replication events", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pins-outbox-"));
  try {
    createNode(dataDir);
    const pins = await freshPins(dataDir);
    pins.setUserPin("ilia", { kind: "project", projectId: "project-1" }, true, "node-a");
    pins.setUserPin("ilia", { kind: "conversation", projectId: "project-1", engine: "claude", sessionId: "session-1" }, true, "node-a");
    pins.setUserPin("ilia", { kind: "conversation", projectId: "project-1", engine: "claude", sessionId: "session-1" }, false, "node-a");

    assert.deepEqual(pins.listUserPins("ilia"), {
      projectIds: ["project-1"],
      conversations: [],
    });

    const db = new DatabaseSync(path.join(dataDir, "node.db"), { readOnly: true });
    const events = db.prepare("SELECT entity_type, operation, payload FROM replication_outbox ORDER BY created_at, rowid").all() as Array<{ entity_type: string; operation: string; payload: string }>;
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.entity_type === "user.pin"));
    assert.deepEqual(events.map((event) => event.operation), ["upsert", "upsert", "delete"]);
    const conversation = JSON.parse(events[1].payload) as Record<string, unknown>;
    assert.deepEqual({ username: conversation.username, projectId: conversation.projectId, engine: conversation.engine, sessionId: conversation.sessionId }, {
      username: "ilia", projectId: "project-1", engine: "claude", sessionId: "session-1",
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pin replication is last-write-wins per item and resolves project aliases", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pins-merge-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    createNode(dataDir);
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL); INSERT INTO project_aliases VALUES ('remote-project', 'local-project')");
    db.close();
    const { receiveReplicationBatch } = await import(`../src/replication.ts?pins-merge=${Date.now()}`);
    const event = (id: string, operation: "upsert" | "delete", updatedAt: string) => ({
      id, originNodeId: "node-b", entityType: "user.pin", entityKey: "ilia:conversation:remote-project:pi:session-2", operation,
      payload: { username: "ilia", kind: "conversation", projectId: "remote-project", engine: "pi", sessionId: "session-2", pinned: operation === "upsert", updatedAt, originNodeId: "node-b" },
      createdAt: updatedAt,
    });
    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000001", "delete", "2026-09-02T12:00:00.000Z")] });
    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000002", "upsert", "2026-09-02T11:00:00.000Z")] });

    const pins = await freshPins(dataDir);
    assert.deepEqual(pins.listUserPins("ilia"), { projectIds: [], conversations: [] });

    await receiveReplicationBatch({ events: [event("00000000-0000-4000-8000-000000000003", "upsert", "2026-09-02T13:00:00.000Z")] });
    assert.deepEqual(pins.listUserPins("ilia"), {
      projectIds: [],
      conversations: [{ projectId: "local-project", engine: "pi", sessionId: "session-2" }],
    });
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("every durable entity maps to the browser data it invalidates", async () => {
  const { replicationInvalidations } = await import(`../src/replication.ts?invalidations=${Date.now()}`);
  const event = (entityType: string) => ({ entityType } as never);
  assert.deepEqual(replicationInvalidations([event("name.override")]).sort(), ["projectsChanged", "sessionsChanged"]);
  assert.deepEqual(replicationInvalidations([event("project.lock")]), ["projectsChanged"]);
  assert.deepEqual(replicationInvalidations([event("task")]).sort(), ["sessionsChanged", "tasksChanged"]);
  for (const entityType of ["conversation.ownership", "conversation.record", "conversation.review"]) {
    assert.deepEqual(replicationInvalidations([event(entityType)]), ["sessionsChanged"], entityType);
  }
  assert.deepEqual(replicationInvalidations([event("canvas.shortcut")]), ["shortcutsChanged"]);
  assert.deepEqual(replicationInvalidations([event("user.pin")]), ["pinsChanged"]);
  assert.deepEqual(replicationInvalidations([event("unknown")]), []);
});
