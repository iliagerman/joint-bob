import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openSupervisorStore } from "../scripts/supervisor-store.mjs";

const task = (id: string) => ({ id, identity: "conversation-1", name: "fixture", executable: process.execPath, args: ["fixture.mjs"], cwd: os.tmpdir() });

test("opening a populated legacy store preserves rows and indexes active queries and descending pagination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-store-indexes-"));
  let database = new DatabaseSync(path.join(root, "supervisor.db"));
  try {
    // Pre-index schema, populated without going through the current initializer.
    database.exec(`
      CREATE TABLE supervisor_tasks (
        id TEXT PRIMARY KEY, identity TEXT NOT NULL, name TEXT NOT NULL,
        executable TEXT NOT NULL, args_json TEXT NOT NULL, cwd TEXT NOT NULL,
        status TEXT NOT NULL, pid INTEGER, started_at TEXT NOT NULL,
        ended_at TEXT, exit_code INTEGER, signal TEXT, error TEXT
      );
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<15000)
      INSERT INTO supervisor_tasks
      SELECT printf('task-%05d',i), 'conversation-' || (i%3), 'fixture', 'node', '[]', '/tmp',
        CASE WHEN i>14994 THEN CASE i%3 WHEN 0 THEN 'starting' WHEN 1 THEN 'running' ELSE 'stopping' END
          WHEN i%2=0 THEN 'completed' ELSE 'failed' END,
        NULL, '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL FROM n;
    `);
    const before = database.prepare("SELECT * FROM supervisor_tasks ORDER BY id").all();
    const activeSql = "SELECT DISTINCT identity FROM supervisor_tasks WHERE status IN ('starting','running','stopping')";
    assert.match(JSON.stringify(database.prepare(`EXPLAIN QUERY PLAN ${activeSql}`).all()), /SCAN supervisor_tasks/);
    database.close();

    // Reopening also proves CREATE INDEX is idempotent.
    for (let pass = 0; pass < 2; pass++) {
      const store = openSupervisorStore(root);
      database = store.database;
      assert.deepEqual(database.prepare("SELECT * FROM supervisor_tasks ORDER BY id").all(), before);
      const assertPlan = (sql: string, values: SQLInputValue[], index: string, noSort = false) => {
        const details = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail).join("\n");
        assert.match(details, new RegExp(`USING (?:COVERING )?INDEX ${index}\\b`), details);
        assert.doesNotMatch(details, /SCAN supervisor_tasks(?:$|\n)/, details);
        if (noSort) assert.doesNotMatch(details, /USE TEMP B-TREE/, details);
      };
      assertPlan(activeSql, [], "supervisor_tasks_active_identity", true);
      assertPlan("SELECT id,identity FROM supervisor_tasks WHERE status IN ('starting','running','stopping')", [], "supervisor_tasks_active_identity");
      assertPlan("UPDATE supervisor_tasks SET status='unknown' WHERE status IN ('starting','running','stopping')", [], "supervisor_tasks_active_identity");
      assert.deepEqual(database.prepare(activeSql).all().map(row => row.identity).sort(), ["conversation-0", "conversation-1", "conversation-2"]);
      assert.equal(database.prepare("SELECT count(*) AS count FROM supervisor_tasks WHERE status IN ('starting','running','stopping')").get()?.count, 6);
      assertPlan("SELECT * FROM supervisor_tasks WHERE identity=? ORDER BY started_at DESC LIMIT ?", ["conversation-0", 10], "supervisor_tasks_identity_started_id", true);
      const listing = "SELECT id,name,status,pid,started_at,ended_at,exit_code,signal FROM supervisor_tasks WHERE identity IN (?)";
      const order = " ORDER BY started_at DESC,id DESC LIMIT ?";
      assertPlan(listing + order, ["conversation-0", 10], "supervisor_tasks_identity_started_id", true);
      const pageSql = listing + " AND (started_at < ? OR (started_at = ? AND id < ?))" + order;
      const values = ["conversation-0", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "task-14997", 3];
      assertPlan(pageSql, values, "supervisor_tasks_identity_started_id", true);
      assert.deepEqual(database.prepare(pageSql).all(...values).map(row => row.id), ["task-14994", "task-14991", "task-14988"]);
      if (pass === 0) store.close();
    }
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("terminal updates and completion insertion are atomic and idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-store-"));
  const store = openSupervisorStore(root);
  try {
    store.reserveTask(task("00000000-0000-4000-8000-000000000001"));
    store.database.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON supervisor_completions BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
    assert.throws(() => store.completeTask(task("00000000-0000-4000-8000-000000000001").id, { status: "completed", exitCode: 0, signal: null, error: null }), /fixture rejection/);
    assert.equal(store.getTask(task("00000000-0000-4000-8000-000000000001").id)?.status, "starting");
    store.database.exec("DROP TRIGGER reject_completion");
    store.completeTask(task("00000000-0000-4000-8000-000000000001").id, { status: "completed", exitCode: 0, signal: null, error: null });
    store.completeTask(task("00000000-0000-4000-8000-000000000001").id, { status: "failed", exitCode: 2, signal: null, error: null });
    assert.equal(store.listCompletions(10).length, 1);
    assert.equal(store.getTask(task("00000000-0000-4000-8000-000000000001").id)?.status, "completed");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("startup reconciliation marks active work unknown once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-store-"));
  let store = openSupervisorStore(root);
  try {
    store.reserveTask(task("00000000-0000-4000-8000-000000000002"));
    store.markRunning(task("00000000-0000-4000-8000-000000000002").id, 12345);
    store.close();
    store = openSupervisorStore(root);
    store.reconcileActive();
    assert.equal(store.getTask(task("00000000-0000-4000-8000-000000000002").id)?.status, "unknown");
    assert.equal(store.listCompletions(10).length, 1);
    store.reconcileActive();
    assert.equal(store.listCompletions(10).length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
