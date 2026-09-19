import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSupervisedShell } from "../scripts/supervised-shell.mjs";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { mintTaskToken, readSupervisorControl, requestSupervisor } from "../scripts/supervisor-client.mjs";
import { readBackgroundTasks } from "../src/background-tasks.js";

const identity = JSON.stringify(["p", "c"]);

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
  const token = mintTaskToken(state, identity);
  const env = { PATH: process.env.PATH ?? "", HOME: root, NODE_NO_WARNINGS: "1", JOINT_BOB_TASK_DATA_DIR: state, JOINT_BOB_TASK_SOCKET: control.socketPath, JOINT_BOB_TASK_TOKEN: token };
  return { state, root, runtime, control, token, env };
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function wrapper(f: Awaited<ReturnType<typeof fixture>>, command: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [path.resolve("bin/joint-bob-bash.mjs"), "-c", "-l", command], { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", (part) => { stdout += part; }); child.stderr.on("data", (part) => { stderr += part; });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

test("actual shell wrapper returns short failures and keeps them out of Tasks", async () => {
  const f = await fixture();
  try {
    const { code, stdout, stderr } = await wrapper(f, "printf short; exit 7");
    assert.equal(code, 7, stderr); assert.equal(stdout, "short");
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, "failed");
    assert.deepEqual(readBackgroundTasks(f.state, [identity], 10).tasks, [], "a short command is tracked by the supervisor but hidden from the Tasks view");
    const kiro = await runSupervisedShell({ args: ["-lc", "exit 0"], cwd: f.root, env: f.env });
    assert.equal(kiro.exitCode, 0);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("actual shell wrapper waits past five seconds and returns the command's real exit code and output", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const started = Date.now();
    const { code, stdout, stderr } = await wrapper(f, "sleep 6; printf done; exit 3");
    assert.ok(Date.now() - started >= 6_000, "the wrapper must not return before the command finishes");
    assert.equal(code, 3, stderr);
    assert.equal(stdout, "done");
    assert.doesNotMatch(stderr + stdout, /still running/);
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].status, "failed"); assert.equal(tasks[0].exitCode, 3);
    // A long command stays visible in Tasks with its output after it finishes.
    assert.deepEqual(readBackgroundTasks(f.state, [identity], 10).tasks.map((task) => task.id), [tasks[0].id]);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a long command becomes visible in Tasks while it is still running", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let pid = 0;
  try {
    const pidFile = path.join(f.root, "pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const running = runSupervisedShell({ args: ["-lc", `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`], cwd: f.root, env: f.env });
    running.catch(() => {}); // awaited below; this only keeps an early failure from surfacing as an unhandled rejection
    pid = Number(await eventually(async () => { try { return await readFile(pidFile, "utf8"); } catch { return ""; } }, Boolean, "long command never wrote its pid"));
    assert.deepEqual(readBackgroundTasks(f.state, [identity], 10).tasks, [], "a fresh command is not yet listed");
    const listed = await eventually(async () => readBackgroundTasks(f.state, [identity], 10).tasks, (tasks) => tasks.length === 1, "long command was never promoted into Tasks");
    assert.equal(listed[0].status, "running");
    const wrong = mintTaskToken(f.state, JSON.stringify(["wrong", "scope"]));
    await assert.rejects(requestSupervisor(f.control.socketPath, wrong, { action: "task", id: listed[0].id }), /not found/i);
    await requestSupervisor(f.control.socketPath, f.token, { action: "stop", id: listed[0].id });
    const result = await running;
    assert.equal(result.exitCode, 130);
    await eventually(async () => processAlive(pid), (alive) => !alive, `command process ${pid} survived stop`);
  } finally {
    if (pid && processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await f.runtime.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test("a configured time limit stops an overlong command and says so", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let pid = 0;
  try {
    const pidFile = path.join(f.root, "pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const { code, stdout } = await wrapper(f, `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, { JOINT_BOB_SHELL_TIMEOUT_MS: "1000" });
    pid = Number(await readFile(pidFile, "utf8"));
    assert.equal(code, 124);
    assert.match(stdout, /stopped .* after 1 second/);
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    await eventually(async () => requestSupervisor(f.control.socketPath, f.token, { action: "task", id: tasks[0].id }) as Promise<Record<string, unknown>>, (task) => task.status === "stopped", "limited command did not stop");
    await eventually(async () => processAlive(pid), (alive) => !alive, `command process ${pid} survived the limit`);
    assert.deepEqual(readBackgroundTasks(f.state, [identity], 10).tasks.map((task) => task.id), [tasks[0].id], "a stopped command stays visible");
  } finally {
    if (pid && processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await f.runtime.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test("an invalid time limit is ignored rather than cutting commands short", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    for (const limit of ["0", "-5", "abc"]) {
      const { code, stdout } = await wrapper(f, "sleep 1; printf ok", { JOINT_BOB_SHELL_TIMEOUT_MS: limit });
      assert.equal(code, 0, `limit ${limit}`); assert.equal(stdout, "ok");
    }
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("missing supervisor credentials fail closed without executing a command", async () => {
  const state = await temporaryState();
  const marker = path.join(path.dirname(state), "marker");
  try {
    await assert.rejects(runSupervisedShell({ args: ["-lc", `touch ${marker}`], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state } }), /supervision is unavailable/);
    await assert.rejects(access(marker), /ENOENT/);
  } finally { await rm(path.dirname(state), { recursive: true, force: true }); }
});

test("invalid and pre-aborted commands never contact the supervisor", async () => {
  const state = await temporaryState();
  try {
    await assert.rejects(runSupervisedShell({ args: ["--help"], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state } }), /requires a bash -c command/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runSupervisedShell({ args: ["-lc", "echo no"], cwd: path.dirname(state), env: { JOINT_BOB_TASK_DATA_DIR: state }, signal: controller.signal }), /aborted/);
  } finally { await rm(path.dirname(state), { recursive: true, force: true }); }
});
