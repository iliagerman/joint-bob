import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as supervisedShell from "../scripts/supervised-shell.mjs";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { mintTaskToken, readSupervisorControl, requestSupervisor } from "../scripts/supervisor-client.mjs";

const { completionDisposition, readCompletionDisposition, runSupervisedShell } = supervisedShell;

async function temporaryState(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "supervised-shell-"));
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  return state;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(25); }
  throw new Error(message);
}
async function fixture() {
  const state = await temporaryState();
  const root = path.dirname(state);
  const runtime = await startSupervisor({ dataDirectory: state, app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root } } });
  const control = readSupervisorControl(state)!;
  const token = mintTaskToken(state, JSON.stringify(["p", "c"]));
  const env = { PATH: process.env.PATH ?? "", HOME: root, NODE_NO_WARNINGS: "1", JOINT_BOB_TASK_DATA_DIR: state, JOINT_BOB_TASK_SOCKET: control.socketPath, JOINT_BOB_TASK_TOKEN: token };
  return { state, root, runtime, control, token, env };
}

test("completion disposition preserves explicit tasks and fences foreground returns", async () => {
  const state = await temporaryState();
  const db = new DatabaseSync(path.join(state, "node.db"));
  try {
    assert.equal(completionDisposition(db, "explicit"), "deliver");
    db.exec("CREATE TABLE supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)");
    insert.run("returned", "returned", 0);
    insert.run("background", "background", 0);
    insert.run("future", "foreground", 2000);
    insert.run("expired", "foreground", 999);
    assert.equal(completionDisposition(db, "returned", 1000), "suppress");
    assert.equal(completionDisposition(db, "background", 1000), "deliver");
    assert.equal(completionDisposition(db, "future", 1000), "pending");
    assert.equal(completionDisposition(db, "expired", 1000), "deliver");
    assert.equal(completionDisposition(db, "explicit", 1000), "deliver");
  } finally { db.close(); await rm(path.dirname(state), { recursive: true, force: true }); }
});

test("completion policies are read in a bounded batch", (t) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE supervised_shell_calls(task_id TEXT PRIMARY KEY,state TEXT NOT NULL,foreground_until INTEGER NOT NULL)");
    const insert = db.prepare("INSERT INTO supervised_shell_calls VALUES(?,?,?)");
    const ids = Array.from({ length: 100 }, (_, index) => `task-${index}`);
    const expected = new Map<string, "pending" | "suppress" | "deliver">();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const kind = index % 5;
      if (kind === 0) { insert.run(id, "returned", 0); expected.set(id, "suppress"); }
      else if (kind === 1) { insert.run(id, "background", 0); expected.set(id, "deliver"); }
      else if (kind === 2) { insert.run(id, "foreground", 2000); expected.set(id, "pending"); }
      else if (kind === 3) { insert.run(id, "foreground", 999); expected.set(id, "deliver"); }
      else expected.set(id, "deliver");
    }
    const originalPrepare = db.prepare.bind(db);
    let prepareCount = 0;
    t.mock.method(db, "prepare", (sql: string) => { prepareCount += 1; return originalPrepare(sql); });
    assert.deepEqual(supervisedShell.completionDispositions(db, ids, 1000), expected);
    assert.ok(prepareCount <= 2, `expected at most 2 prepared statements, got ${prepareCount}`);
    assert.deepEqual(supervisedShell.completionDispositions(db, [], 1000), new Map());
    assert.throws(() => supervisedShell.completionDispositions(db, [...ids, "overflow"], 1000), RangeError);
  } finally { db.close(); }
});

test("read-only completion lookup does not create node state", async () => {
  const state = await temporaryState();
  try {
    assert.equal(readCompletionDisposition(state, "missing"), "deliver");
    assert.deepEqual(supervisedShell.readCompletionDispositions(state, ["missing"]), new Map([["missing", "deliver"]]));
    await assert.rejects(access(path.join(state, "node.db")), /ENOENT/);
  } finally { await rm(path.dirname(state), { recursive: true, force: true }); }
});

test("actual shell wrapper returns short failures and suppresses their follow-up", async () => {
  const f = await fixture();
  try {
    const wrapper = path.resolve("bin/joint-bob-bash.mjs");
    const child = spawn(process.execPath, [wrapper, "-c", "-l", "printf short; exit 7"], { cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (part) => { stdout += part; }); child.stderr.on("data", (part) => { stderr += part; });
    const [code] = await new Promise<[number | null]>((resolve) => child.once("close", (value) => resolve([value])));
    assert.equal(code, 7, stderr); assert.equal(stdout, "short");
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, "failed");
    assert.equal(readCompletionDisposition(f.state, String(tasks[0].id)), "suppress");
    // Exercise the default production foreground window rather than a shortened test override.
    const kiro = await runSupervisedShell({ args: ["-lc", "exit 0"], cwd: f.root, env: f.env });
    assert.deepEqual({ exitCode: kiro.exitCode, background: kiro.background }, { exitCode: 0, background: false });
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("actual shell wrapper leaves one long process running and accepts another command", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const pidFile = path.join(f.root, "pid"); const launches = path.join(f.root, "launches");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('fs').appendFileSync(${JSON.stringify(launches)},'launch\\n');setInterval(()=>{},1000)`;
    const child = spawn(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-lc", `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`], { cwd: f.root, env: f.env, stdio: "ignore" });
    const [code] = await new Promise<[number | null]>((resolve) => child.once("close", (value) => resolve([value])));
    assert.equal(code, 0);
    const pid = Number(await eventually(() => readFile(pidFile, "utf8"), Boolean, "long command never wrote its pid"));
    process.kill(pid, 0);
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, "running");
    const taskPid = Number(tasks[0].pid); process.kill(taskPid, 0);
    const quick = await runSupervisedShell({ args: ["-lc", "exit 0"], cwd: f.root, env: f.env, waitMs: 500 }); assert.equal(quick.exitCode, 0);
    assert.equal(await readFile(launches, "utf8"), "launch\n"); process.kill(pid, 0); process.kill(taskPid, 0);
    await requestSupervisor(f.control.socketPath, f.token, { action: "stop", id: tasks[0].id });
    await eventually(async () => requestSupervisor(f.control.socketPath, f.token, { action: "task", id: tasks[0].id }) as Promise<Record<string, unknown>>, (task) => task.status === "stopped", "long task did not stop");
    const wrong = mintTaskToken(f.state, JSON.stringify(["wrong", "scope"]));
    await assert.rejects(requestSupervisor(f.control.socketPath, wrong, { action: "task", id: tasks[0].id }), /not found/i);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("missing supervisor credentials fail closed without executing a command", async () => {
  const state = await temporaryState();
  const marker = path.join(path.dirname(state), "marker");
  try {
    await assert.rejects(runSupervisedShell({ args: ["-lc", `touch ${marker}`], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state }, waitMs: 100 }), /supervision is unavailable/);
    await assert.rejects(access(marker), /ENOENT/);
  } finally { await rm(path.dirname(state), { recursive: true, force: true }); }
});

test("invalid and pre-aborted commands never contact the supervisor", async () => {
  const state = await temporaryState();
  try {
    await assert.rejects(runSupervisedShell({ args: ["--help"], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state }, waitMs: 100 }), /requires a bash -c command/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runSupervisedShell({ args: ["-lc", "echo no"], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state }, signal: controller.signal, waitMs: 100 }), /aborted/);
  } finally { await rm(path.dirname(state), { recursive: true, force: true }); }
});
