import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSupervisedShell } from "../scripts/supervised-shell.mjs";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { mintTaskToken, readSupervisorControl, requestSupervisor } from "../scripts/supervisor-client.mjs";
import { closeBackgroundCompletionStore, ingestBackgroundCompletions, pendingBackgroundCompletions } from "../src/background-completions.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try { last = await read(); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
    }
    if (last !== undefined && accept(last)) return last;
    await delay(25);
  }
  throw new Error(`${message}${last === undefined ? "" : `; last value: ${JSON.stringify(last)}`}`);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbsr-"));
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const runtime = await startSupervisor({
    dataDirectory: state,
    app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root } },
  });
  const control = readSupervisorControl(state)!;
  const token = mintTaskToken(state, JSON.stringify(["p", "c"]));
  const env = {
    PATH: process.env.PATH ?? "", HOME: root, NODE_NO_WARNINGS: "1",
    JOINT_BOB_TASK_DATA_DIR: state, JOINT_BOB_TASK_SOCKET: control.socketPath, JOINT_BOB_TASK_TOKEN: token,
  };
  return { root, state, runtime, control, token, env };
}

async function withCompletionStore<T>(state: string, action: () => Promise<T> | T): Promise<T> {
  const previous = process.env.JOINT_BOB_DATA_DIR;
  closeBackgroundCompletionStore();
  process.env.JOINT_BOB_DATA_DIR = state;
  try { return await action(); }
  finally {
    closeBackgroundCompletionStore();
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
  }
}

async function terminalTask(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return eventually(
    async () => requestSupervisor(f.control.socketPath, f.token, { action: "task", id }) as Promise<Record<string, unknown>>,
    (task) => ["completed", "failed", "stopped"].includes(String(task.status)),
    `task ${id} did not become terminal`,
  );
}

async function ingestCycles(state: string, count = 3) {
  for (let index = 0; index < count; index++) ingestBackgroundCompletions(state);
}

async function isMissing(file: string): Promise<boolean> {
  try { await access(file); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("short supervised commands complete without queuing a follow-up", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  try {
    const result = await runSupervisedShell({ args: ["-lc", "exit 0"], cwd: f.root, env: f.env, waitMs: 5_000 });
    assert.deepEqual({ exitCode: result.exitCode, background: result.background }, { exitCode: 0, background: false });
    const task = await requestSupervisor(f.control.socketPath, f.token, { action: "task", id: result.taskId }) as Record<string, unknown>;
    assert.equal(task.status, "completed");
    await withCompletionStore(f.state, async () => {
      await ingestCycles(f.state, 4); // Includes an empty scan, which resets the ingestion cursor.
      assert.equal(pendingBackgroundCompletions().length, 0);
    });
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("fast builtin commands complete without false background promotion", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 6; index++) {
      const chunks: Buffer[] = [];
      const result = await runSupervisedShell({
        args: ["-lc", "printf matched"], cwd: f.root, env: f.env, waitMs: 5_000,
        onData: (chunk: Buffer) => chunks.push(chunk),
      });
      assert.equal(Buffer.concat(chunks).toString(), "matched");
      assert.equal(result.background, false);
      const task = await requestSupervisor(f.control.socketPath, f.token, { action: "task", id: result.taskId }) as Record<string, unknown>;
      assert.equal(task.status, "completed");
    }
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("worker refuses to launch before a valid task registration", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  const marker = path.join(f.root, "invalid-task-marker");
  try {
    const worker = path.resolve("scripts/supervised-shell-worker.mjs");
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [worker, "-lc", `touch ${JSON.stringify(marker)}`], {
        cwd: f.root, stdio: "ignore",
        env: { ...f.env, JOINT_BOB_SUPERVISED_SHELL_ID: randomUUID() },
      });
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.notEqual(code, 0);
    assert.equal(await isMissing(marker), true);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const style of ["ordinary", "nohup"] as const) {
  test(`shell background children remain tracked (${style})`, { timeout: 25_000, concurrency: false }, async () => {
    const f = await fixture();
    const pidFile = path.join(f.root, `${style}.pid`);
    const launchFile = path.join(f.root, `${style}.launch`);
    const heartbeatFile = path.join(f.root, `${style}.heartbeat`);
    const logFile = path.join(f.root, `${style}.log`);
    let pid = 0;
    let wrapper: ReturnType<typeof spawn> | undefined;
    try {
      const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));fs.appendFileSync(${JSON.stringify(launchFile)},'launch\\n');let n=0;setInterval(()=>{const line=String(++n)+'\\n';fs.appendFileSync(${JSON.stringify(heartbeatFile)},line);process.stdout.write(line)},100)`;
      const background = style === "nohup"
        ? `nohup ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} > ${JSON.stringify(logFile)} 2>&1 &`
        : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)} &`;
      const command = `${background} while [ ! -s ${JSON.stringify(pidFile)} ]; do sleep .01; done`;
      const wrapperPath = path.resolve("bin/joint-bob-bash.mjs");
      wrapper = spawn(process.execPath, [wrapperPath, "-lc", command], { cwd: f.root, env: f.env, stdio: "ignore" });
      const wrapperCode = await new Promise<number | null>((resolve, reject) => {
        wrapper!.once("error", reject); wrapper!.once("close", resolve);
      });
      assert.equal(wrapperCode, 0);

      pid = Number(await eventually(() => readFile(pidFile, "utf8"), (value) => Number(value) > 0, "background child did not write its pid"));
      const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "running");
      assert.equal(processAlive(pid), true);
      const firstHeartbeat = Number((await readFile(heartbeatFile, "utf8")).trim().split("\n").at(-1));
      await eventually(
        async () => Number((await readFile(heartbeatFile, "utf8")).trim().split("\n").at(-1)),
        (value) => value > firstHeartbeat,
        "background child heartbeat did not progress",
      );
      assert.equal((await readFile(launchFile, "utf8")).trim().split("\n").length, 1);
      if (style === "nohup") assert.ok((await readFile(logFile, "utf8")).length > 0, "nohup output did not reach its log");

      await requestSupervisor(f.control.socketPath, f.token, { action: "stop", id: String(tasks[0].id) });
      const stopped = await terminalTask(f, String(tasks[0].id));
      assert.equal(stopped.status, "stopped");
      await eventually(async () => processAlive(pid), (alive) => !alive, `background child ${pid} survived task stop`);
    } finally {
      if (wrapper && wrapper.exitCode === null) wrapper.kill("SIGKILL");
      if (pid && processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await f.runtime.close(); await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("promoted commands produce exactly one durable completion", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  try {
    const result = await runSupervisedShell({ args: ["-lc", `exec ${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`], cwd: f.root, env: f.env, waitMs: 100 });
    assert.equal(result.background, true);
    const running = await requestSupervisor(f.control.socketPath, f.token, { action: "task", id: result.taskId }) as Record<string, unknown>;
    assert.equal(running.status, "running");
    await requestSupervisor(f.control.socketPath, f.token, { action: "stop", id: result.taskId });
    await terminalTask(f, result.taskId);
    await withCompletionStore(f.state, async () => {
      await ingestCycles(f.state, 3);
      assert.deepEqual(pendingBackgroundCompletions().map((item) => item.taskId), [result.taskId]);
      await ingestCycles(f.state, 4);
      assert.deepEqual(pendingBackgroundCompletions().map((item) => item.taskId), [result.taskId]);
    });
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an expired foreground lease recovers a completion after caller loss", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  try {
    const result = await runSupervisedShell({ args: ["-lc", "exit 0"], cwd: f.root, env: f.env, waitMs: 5_000 });
    // Simulate the durable precondition left by a caller crash before it can mark the return.
    const db = new DatabaseSync(path.join(f.state, "node.db"));
    try { db.prepare("UPDATE supervised_shell_calls SET state='foreground',foreground_until=? WHERE task_id=?").run(Date.now() + 60_000, result.taskId); }
    finally { db.close(); }
    await withCompletionStore(f.state, async () => {
      await ingestCycles(f.state, 3);
      assert.equal(pendingBackgroundCompletions().length, 0);
      const update = new DatabaseSync(path.join(f.state, "node.db"));
      try { update.prepare("UPDATE supervised_shell_calls SET foreground_until=0 WHERE task_id=?").run(result.taskId); }
      finally { update.close(); }
      await ingestCycles(f.state, 3);
      assert.deepEqual(pendingBackgroundCompletions().map((item) => item.taskId), [result.taskId]);
      assert.deepEqual(pendingBackgroundCompletions().map((item) => item.taskId), [result.taskId]);
      closeBackgroundCompletionStore();
      assert.deepEqual(pendingBackgroundCompletions().map((item) => item.taskId), [result.taskId]);
    });
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("aborting a foreground call stops its supervised process", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  const ready = path.join(f.root, "ready");
  const controller = new AbortController();
  let pid = 0;
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
    const running = runSupervisedShell({ args: ["-lc", `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`], cwd: f.root, env: f.env, signal: controller.signal, waitMs: 5_000 });
    const rejected = assert.rejects(running, /aborted/i);
    pid = Number(await eventually(() => readFile(ready, "utf8"), (value) => Number(value) > 0, "command did not become ready"));
    controller.abort();
    await rejected;
    const tasks = await requestSupervisor(f.control.socketPath, f.token, { action: "list" }) as Array<Record<string, unknown>>;
    assert.equal(tasks.length, 1);
    await terminalTask(f, String(tasks[0].id));
    await eventually(async () => processAlive(pid), (alive) => !alive, `command process ${pid} survived stop`);
  } finally {
    if (pid && processAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await f.runtime.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test("foreground output is bounded while the task retains complete output", { timeout: 20_000, concurrency: false }, async () => {
  const f = await fixture();
  try {
    const chunks: Buffer[] = [];
    const gate = path.join(f.root, "output-gate");
    const script = `const fs=require('fs');process.stdout.write('x'.repeat(17));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.stdout.write('x'.repeat(196608));}},10)`;
    let released = false;
    const result = await runSupervisedShell({
      args: ["-lc", `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`], cwd: f.root, env: f.env,
      onData: (chunk: Buffer) => {
        chunks.push(chunk);
        if (!released && chunks.length === 1 && chunk.length === 17 && chunk.every((byte) => byte === 120)) {
          released = true;
          writeFileSync(gate, "");
        }
      },
      waitMs: 5_000,
    });
    assert.equal(result.exitCode, 0); assert.equal(result.background, false);
    const shown = Buffer.concat(chunks);
    assert.equal(shown.filter((byte) => byte === 120).length, 131_072);
    assert.match(shown.toString(), /output truncated; inspect it in Tasks/);
    let offset = 0; let total = 0; let eof = false;
    while (!eof) {
      const output = await requestSupervisor(f.control.socketPath, f.token, { action: "output", id: result.taskId, offset, limit: 65_536 }) as { chunk: string; nextOffset: number; eof: boolean };
      total += Buffer.from(output.chunk, "base64").length; offset = output.nextOffset; eof = output.eof;
    }
    assert.ok(total >= 196_625, `task retained only ${total} output bytes`);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an unreachable supervisor rejects once without executing locally", { timeout: 20_000, concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbsu-"));
  const state = path.join(root, "state"); const marker = path.join(root, "marker");
  await mkdir(state, { mode: 0o700 });
  try {
    const missingSocket = path.join(root, "missing.sock");
    await assert.rejects(runSupervisedShell({
      args: ["-lc", `touch ${JSON.stringify(marker)}`], cwd: root, waitMs: 100,
      env: { PATH: process.env.PATH ?? "", HOME: root, NODE_NO_WARNINGS: "1", JOINT_BOB_TASK_DATA_DIR: state, JOINT_BOB_TASK_SOCKET: missingSocket, JOINT_BOB_TASK_TOKEN: randomUUID() },
    }), /task [0-9a-f-]{36}; do not retry it/i);
    assert.equal(await isMissing(marker), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
