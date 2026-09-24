import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { supervisorRequest } from "../scripts/supervisor-client.mjs";
import { abandonedShellReason, MISSING_CONVERSATION_GRACE_MS, readImplicitShellTasks } from "../src/background-tasks.js";
import { CONVERSATION_INACTIVITY_TIMEOUT_MS } from "../src/conversation-watchdog.js";
import { reapInactiveConversations } from "../src/server/maintenance.js";

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
      const log = path.join(directory, "background-tasks", "background-shell.log");
      await mkdir(path.dirname(log));
      await writeFile(log, "working");
      await utimes(log, new Date("2026-01-01T00:01:00.000Z"), new Date("2026-01-01T00:01:00.000Z"));
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
    assert.equal(background?.lastOutputAt, "2026-01-01T00:01:00.000Z");
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

test("a live conversation keeps its tool-call shell while output remains active", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const output = "2026-01-01T05:59:00.000Z";
  const now = Date.parse(output);
  assert.equal(abandonedShellReason(started, output, true, now + CONVERSATION_INACTIVITY_TIMEOUT_MS), null);
  assert.equal(
    abandonedShellReason(started, output, true, now + CONVERSATION_INACTIVITY_TIMEOUT_MS + 1),
    `it had no input or output since ${output}`,
  );
});

test("a silent shell uses its start as its last activity", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const now = Date.parse(started);
  assert.equal(abandonedShellReason(started, undefined, true, now + CONVERSATION_INACTIVITY_TIMEOUT_MS), null);
  assert.equal(abandonedShellReason(started, undefined, true, now + CONVERSATION_INACTIVITY_TIMEOUT_MS + 1), `it had no input or output since ${started}`);
});

test("a shell whose conversation is gone is reaped once its record had time to land", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const now = Date.parse(started);
  assert.equal(abandonedShellReason(started, undefined, false, now), null, "a first turn may outrun its conversation record");
  assert.equal(abandonedShellReason(started, undefined, false, now + MISSING_CONVERSATION_GRACE_MS), null);
  assert.equal(abandonedShellReason(started, undefined, false, now + MISSING_CONVERSATION_GRACE_MS + 1), "its conversation is gone");
});

test("the maintenance watcher stops an abandoned shell process group", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "abandoned-shell-runtime-"));
  const runtime = await startSupervisor({
    dataDirectory: directory,
    app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: directory, env: {} },
  });
  const id = randomUUID();
  try {
    const started = await supervisorRequest(directory, {
      action: "start", id, identity: JSON.stringify(["missing-project", randomUUID()]), name: "stale shell",
      executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: directory, env: {},
    }) as { pid: number };
    const policy = createPolicyDatabase(directory);
    policy.prepare("INSERT INTO supervised_shell_calls VALUES(?,'background',0)").run(id);
    policy.close();
    const old = "2026-01-01T00:00:00.000Z";
    const supervisor = new DatabaseSync(path.join(directory, "supervisor.db"));
    supervisor.prepare("UPDATE supervisor_tasks SET started_at=? WHERE id=?").run(old, id);
    supervisor.close();

    const now = Date.parse(old) + MISSING_CONVERSATION_GRACE_MS + 1;
    const caller = new DatabaseSync(path.join(directory, "node.db"));
    try {
      for (const state of ["foreground", "background"]) {
        caller.prepare("UPDATE supervised_shell_calls SET state=?,foreground_until=? WHERE task_id=?").run(state, now + 20_000, id);
        await reapInactiveConversations(now, directory);
        assert.equal((await supervisorRequest(directory, { action: "task", id }) as { status: string }).status, "running", "a live caller protects even a silent shell, before and after Tasks visibility");
      }
    } finally { caller.close(); }
    await reapInactiveConversations(now + 20_000, directory);
    let status = "stopping";
    for (let attempt = 0; attempt < 100 && status === "stopping"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await supervisorRequest(directory, { action: "task", id }) as { status: string }).status;
    }
    assert.equal(status, "stopped");
    let groupExists = true;
    for (let attempt = 0; attempt < 100 && groupExists; attempt += 1) {
      try { process.kill(-started.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        groupExists = false;
      }
      if (groupExists) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(groupExists, false, "the stopped task process group must be gone");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
