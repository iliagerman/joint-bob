import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSupervisorStore } from "../scripts/supervisor-store.mjs";

const task = (id: string) => ({ id, identity: "conversation-1", name: "fixture", executable: process.execPath, args: ["fixture.mjs"], cwd: os.tmpdir() });

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
