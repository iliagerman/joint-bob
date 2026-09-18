import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readActiveBackgroundTaskIdentities, readBackgroundTasks, type TaskCursor } from "../src/background-tasks.js";

const identity = "visible-session";

function createSupervisorDatabase(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "supervisor.db"));
  db.exec("CREATE TABLE supervisor_tasks(id TEXT PRIMARY KEY,identity TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,started_at TEXT NOT NULL,ended_at TEXT,exit_code INTEGER,signal TEXT)");
  return db;
}

function insertTask(db: DatabaseSync, id: string, startedAt: string, taskIdentity = identity): void {
  db.prepare("INSERT INTO supervisor_tasks VALUES(?,?,?,'completed',NULL,?,NULL,0,NULL)").run(id, taskIdentity, id, startedAt);
}

function insertLiveTask(db: DatabaseSync, id: string, status: string, taskIdentity = identity): void {
  db.prepare("INSERT INTO supervisor_tasks VALUES(?,?,?,?,NULL,?,NULL,NULL,NULL)").run(id, taskIdentity, id, status, "2026-01-01T00:00:00.000Z");
}

function createPolicyDatabase(directory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("CREATE TABLE supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)");
  return db;
}

test("background task visibility is filtered before keyset pagination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-task-visibility-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    const policy = createPolicyDatabase(directory);
    try {
      insertTask(supervisor, "explicit", "2026-01-01T00:00:01.000Z");
      insertTask(supervisor, "expired", "2026-01-01T00:00:02.000Z");
      insertTask(supervisor, "promoted", "2026-01-01T00:00:03.000Z");
      insertTask(supervisor, "wrong-session", "2026-01-01T00:00:04.000Z", "other-session");
      policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)").run("expired", "foreground", 1);
      policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)").run("promoted", "background", 0);
      for (let index = 0; index < 101; index++) {
        const id = `hidden-${index.toString().padStart(3, "0")}`;
        insertTask(supervisor, id, `2026-01-02T00:${Math.floor(index / 60).toString().padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`);
        policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)").run(id, index % 2 ? "returned" : "foreground", Date.now() + 60_000);
      }
    } finally {
      supervisor.close();
      policy.close();
    }

    const seen: string[] = [];
    let before: TaskCursor | undefined;
    do {
      const page = readBackgroundTasks(directory, [identity], 1, before);
      seen.push(...page.tasks.map((task) => task.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    assert.deepEqual(seen, ["promoted", "expired", "explicit"]);
    assert.equal(new Set(seen).size, seen.length, "pages must not duplicate visible tasks");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing policy database remains absent and explicit tasks are visible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-task-no-policy-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    try { insertTask(supervisor, "explicit", "2026-01-01T00:00:00.000Z"); } finally { supervisor.close(); }
    assert.equal(existsSync(path.join(directory, "node.db")), false);
    assert.deepEqual(readBackgroundTasks(directory, [identity], 10).tasks.map((task) => task.id), ["explicit"]);
    assert.equal(existsSync(path.join(directory, "node.db")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("foreground tasks become visible only when promoted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-task-promotion-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    const policy = createPolicyDatabase(directory);
    try {
      insertTask(supervisor, "shell-task", "2026-01-01T00:00:00.000Z");
      policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)").run("shell-task", "foreground", Date.now() + 60_000);
    } finally { supervisor.close(); policy.close(); }

    assert.deepEqual(readBackgroundTasks(directory, [identity], 10).tasks, []);
    const updates = new DatabaseSync(path.join(directory, "node.db"));
    try { updates.prepare("UPDATE supervised_shell_calls SET state=?,foreground_until=0 WHERE task_id=?").run("background", "shell-task"); } finally { updates.close(); }
    assert.deepEqual(readBackgroundTasks(directory, [identity], 10).tasks.map((task) => task.id), ["shell-task"]);
    const returned = new DatabaseSync(path.join(directory, "node.db"));
    try { returned.prepare("UPDATE supervised_shell_calls SET state=? WHERE task_id=?").run("returned", "shell-task"); } finally { returned.close(); }
    assert.deepEqual(readBackgroundTasks(directory, [identity], 10).tasks, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a conversation's live background commands are reported, foreground ones are not", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-task-active-"));
  try {
    const supervisor = createSupervisorDatabase(directory);
    const policy = createPolicyDatabase(directory);
    try {
      insertLiveTask(supervisor, "running-task", "running");
      insertLiveTask(supervisor, "starting-task", "starting", "other-session");
      insertTask(supervisor, "finished-task", "2026-01-01T00:00:00.000Z", "finished-session");
      insertLiveTask(supervisor, "foreground-task", "running", "foreground-session");
      policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)").run("foreground-task", "foreground", Date.now() + 60_000);
    } finally { supervisor.close(); policy.close(); }

    assert.deepEqual([...readActiveBackgroundTaskIdentities(directory)].sort(), [identity, "other-session"].sort());

    const promoted = new DatabaseSync(path.join(directory, "node.db"));
    try { promoted.prepare("UPDATE supervised_shell_calls SET state=?,foreground_until=0 WHERE task_id=?").run("background", "foreground-task"); } finally { promoted.close(); }
    assert.equal(readActiveBackgroundTaskIdentities(directory).has("foreground-session"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active background identities are empty without a supervisor database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "background-task-none-"));
  try {
    assert.deepEqual([...readActiveBackgroundTaskIdentities(directory)], []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
