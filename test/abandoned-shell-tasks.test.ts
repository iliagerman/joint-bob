import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { abandonedShellReason, MISSING_CONVERSATION_GRACE_MS, readImplicitShellTasks, TOOL_CALL_SHELL_MAX_AGE_MS } from "../src/background-tasks.js";

const identity = JSON.stringify(["project-1", "conversation-1"]);

function createSupervisorDatabase(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "supervisor.db"));
  db.exec("CREATE TABLE supervisor_tasks(id TEXT PRIMARY KEY,identity TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,signal TEXT)");
  return db;
}

function insertTask(db: DatabaseSync, id: string, status: string, startedAt: string, taskIdentity = identity): void {
  db.prepare("INSERT INTO supervisor_tasks VALUES(?,?,?,?,NULL,?,NULL,NULL,NULL)").run(id, taskIdentity, id, status, startedAt);
}

function createPolicyDatabase(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("CREATE TABLE supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)");
  return db;
}

test("only active tool-call shells are reapable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abandoned-shell-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    const policy = createPolicyDatabase(directory);
    try {
      insertTask(supervisor, "background-shell", "running", "2026-01-01T00:00:01.000Z");
      insertTask(supervisor, "foreground-shell", "running", "2026-01-01T00:00:02.000Z");
      insertTask(supervisor, "starting-shell", "starting", "2026-01-01T00:00:03.000Z");
      insertTask(supervisor, "finished-shell", "completed", "2026-01-01T00:00:04.000Z");
      insertTask(supervisor, "explicit-job", "running", "2026-01-01T00:00:05.000Z");
      insertTask(supervisor, "other-conversation", "running", "2026-01-01T00:00:06.000Z", JSON.stringify(["project-1", "conversation-2"]));
      for (const [id, state] of [
        ["background-shell", "background"],
        ["foreground-shell", "foreground"],
        ["starting-shell", "foreground"],
        ["finished-shell", "returned"],
        ["other-conversation", "background"],
      ] as const) {
        policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,0)").run(id, state);
      }
    } finally {
      supervisor.close();
      policy.close();
    }

    const tasks = readImplicitShellTasks(directory);
    assert.deepEqual(
      tasks.map((task) => task.id).sort(),
      ["background-shell", "foreground-shell", "other-conversation", "starting-shell"],
      "explicitly started jobs and finished shells are never reapable",
    );
    const background = tasks.find((task) => task.id === "background-shell");
    assert.equal(background?.identity, identity);
    assert.equal(background?.startedAt, "2026-01-01T00:00:01.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a node without shell policy state reports no reapable shells", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abandoned-shell-no-policy-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    try {
      insertTask(supervisor, "explicit-job", "running", "2026-01-01T00:00:01.000Z");
    } finally {
      supervisor.close();
    }
    assert.deepEqual(readImplicitShellTasks(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a node without a supervisor database reports no reapable shells", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abandoned-shell-no-supervisor-"));
  try {
    assert.deepEqual(readImplicitShellTasks(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live conversation keeps its tool-call shell until the shell outlives the turn", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const now = Date.parse(started);
  assert.equal(abandonedShellReason(started, true, now), null);
  assert.equal(abandonedShellReason(started, true, now + TOOL_CALL_SHELL_MAX_AGE_MS), null);
  assert.equal(
    abandonedShellReason(started, true, now + TOOL_CALL_SHELL_MAX_AGE_MS + 1),
    `it started ${started} and outlived the tool call`,
  );
});

test("a shell whose conversation is gone is reaped once its record had time to land", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const now = Date.parse(started);
  assert.equal(abandonedShellReason(started, false, now), null, "a first turn may outrun its conversation record");
  assert.equal(abandonedShellReason(started, false, now + MISSING_CONVERSATION_GRACE_MS), null);
  assert.equal(abandonedShellReason(started, false, now + MISSING_CONVERSATION_GRACE_MS + 1), "its conversation is gone");
});
