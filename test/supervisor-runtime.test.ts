import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { readSupervisorControl } from "../scripts/supervisor-client.mjs";

const UUID = "00000000-0000-4000-8000-000000000010";
const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function waitClosed(child: ChildProcess, timeout = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      new Promise<void>(resolve => child.once("close", () => resolve())),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("process close timeout")), timeout); }),
    ]);
  } finally { clearTimeout(timer!); }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  try { await waitClosed(child, 12000); } catch {
    child.kill("SIGKILL");
    await waitClosed(child);
  }
}

async function fixture(existingRoot?: string, appSource = "setInterval(() => {}, 1000)") {
  const root = existingRoot ?? await mkdtemp(path.join(os.tmpdir(), "jbs-"));
  const app = path.join(root, "app.mjs");
  await writeFile(app, appSource);
  const state = path.join(root, "state");
  const child = spawn(process.execPath, ["scripts/joint-bob-supervisor.mjs", "--data-dir", state, "--app", app, "--cwd", root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", value => stdout += value);
  child.stderr!.on("data", value => stderr += value);
  try {
    await waitFor(() => stdout.includes("\n") || child.exitCode !== null, `supervisor readiness timeout: ${stderr}`);
    if (child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${stderr}`);
    const readyOutput = JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as { socketPath: string };
    const persisted = readSupervisorControl(state);
    if (!persisted) throw new Error("supervisor control unavailable");
    const ready = { ...readyOutput, token: persisted.token };
    const control = (body: unknown, token = ready.token, raw = false) => new Promise<any>((resolve, reject) => {
      const request = http.request({ socketPath: ready.socketPath, path: "/control", method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
      } }, response => {
        let data = "";
        response.on("data", value => data += value);
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      request.setTimeout(3000, () => request.destroy(new Error("request timeout")));
      request.on("error", reject);
      request.end(raw ? String(body) : JSON.stringify(body));
    });
    return { root, state, app, child, ready, control, diagnostics: () => ({ stderr }) };
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  await stopChild(f.child);
  await rm(f.root, { recursive: true, force: true });
}

function startRequest(root: string, id = UUID, script = "task.mjs") {
  return { action: "start", id, identity: "c1", name: "task", executable: process.execPath,
    args: [path.join(root, script)], cwd: root, env: { PATH: process.env.PATH! } };
}

async function processExists(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === "EPERM"; }
}

test("racing the same UUID launches once and completed retries never rerun", async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.root, "launches");
    await writeFile(path.join(f.root, "task.mjs"), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');`);
    const request = startRequest(f.root);
    const [a, b] = await Promise.all([f.control(request), f.control(request)]);
    assert.equal(a.body.result.id, UUID);
    assert.equal(b.body.result.pid, a.body.result.pid);
    await waitFor(async () => (await f.control({ action: "task", id: UUID })).body.result.status === "completed", "task did not complete");
    await f.control(request);
    assert.equal(await readFile(marker, "utf8"), "x");
    assert.equal((await f.control({ ...request, name: "changed" })).status, 409);
  } finally { await cleanup(f); }
});

test("a live second supervisor is rejected without disturbing the first", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "task.mjs"), "setInterval(() => {}, 1000)");
    const started = await f.control(startRequest(f.root));
    const second = spawn(process.execPath, ["scripts/joint-bob-supervisor.mjs", "--data-dir", f.state, "--app", f.app, "--cwd", f.root], { stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    second.stderr!.on("data", value => error += value);
    await waitClosed(second);
    assert.match(error, /Supervisor already running/);
    const row = (await f.control({ action: "task", id: UUID })).body.result;
    assert.equal(row.status, "running");
    assert.equal(row.pid, started.body.result.pid);
  } finally { await cleanup(f); }
});

test("failed startup and unsafe socket paths release every resource", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbs-"));
  const state = path.join(root, "state");
  try {
    await assert.rejects(startSupervisor({ dataDirectory: state, app: { executable: path.join(root, "missing"), args: [], cwd: root, env: {} } }));
    const app = path.join(root, "app.mjs");
    await writeFile(app, "setInterval(() => {}, 1000)");
    const runtime = await startSupervisor({ dataDirectory: state, app: { executable: process.execPath, args: [app], cwd: root, env: {} } });
    await runtime.close();
    await writeFile(path.join(state, "supervisor.sock"), "occupied");
    await assert.rejects(startSupervisor({ dataDirectory: state, app: { executable: process.execPath, args: [app], cwd: root, env: {} } }), /not a socket/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stop removes a SIGTERM-ignoring grandchild and records stopped", async () => {
  const f = await fixture();
  let grandchildPid = 0;
  try {
    const pidFile = path.join(f.root, "grandchild");
    await writeFile(path.join(f.root, "grand.mjs"), `import fs from'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`);
    await writeFile(path.join(f.root, "task.mjs"), `import{spawn}from'node:child_process';spawn(process.execPath,[${JSON.stringify(path.join(f.root, "grand.mjs"))}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`);
    await f.control(startRequest(f.root));
    await waitFor(async () => { try { grandchildPid = Number(await readFile(pidFile, "utf8")); return grandchildPid > 0; } catch { return false; } }, "grandchild did not start");
    await f.control({ action: "stop", id: UUID });
    await waitFor(async () => !(await processExists(grandchildPid)), "grandchild survived stop", 15000);
    await waitFor(async () => (await f.control({ action: "task", id: UUID })).body.result.status === "stopped", "task stop was not persisted");
    assert.equal((await f.control({ action: "task", id: UUID })).body.result.status, "stopped");
  } finally {
    if (grandchildPid && await processExists(grandchildPid)) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
    await cleanup(f);
  }
});

test("app status records the command exit while its worker remains alive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbs-"));
  const acknowledged = path.join(root, "acknowledged");
  const f = await fixture(root, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(acknowledged)},'ready');process.exit(7)`);
  try {
    await waitFor(async () => {
      try { await access(acknowledged); } catch { return false; }
      return (await f.control({ action: "status" })).body.result.app.pid === null;
    }, "app terminal status was not reported");
    const app = (await f.control({ action: "status" })).body.result.app;
    assert.equal(app.exitCode, 7);
    assert.equal(app.signal, null);
  } finally { await cleanup(f); }
});

test("repeated stop escalates a SIGTERM-ignoring owned worker", async () => {
  const id = "00000000-0000-4000-8000-000000000011";
  const f = await fixture();
  let workerPid = 0;
  try {
    const ready = path.join(f.root, "task-ready");
    await writeFile(path.join(f.root, "task.mjs"), `import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`);
    const started = await f.control(startRequest(f.root, id));
    workerPid = started.body.result.pid;
    await waitFor(async () => { try { await access(ready); return true; } catch { return false; } }, "task did not become ready");
    await f.control({ action: "stop", id });
    await f.control({ action: "stop", id });
    await waitFor(async () => (await f.control({ action: "task", id })).body.result.status === "stopped", "task was not force stopped", 8000);
    const row = (await f.control({ action: "task", id })).body.result;
    assert.equal(row.exitCode, null);
    assert.equal(row.signal, "SIGKILL");
    assert.equal(await processExists(workerPid), false);
  } finally {
    if (workerPid && await processExists(workerPid)) { try { process.kill(-workerPid, "SIGKILL"); } catch {} }
    await cleanup(f);
  }
});

test("app replacement rollback preserves a live task and its output", async () => {
  const id = "00000000-0000-4000-8000-000000000012";
  const f = await fixture();
  try {
    const startedMarker = path.join(f.root, "task-started");
    const releaseMarker = path.join(f.root, "task-release");
    const appReady = path.join(f.root, "replacement-ready");
    await writeFile(path.join(f.root, "task.mjs"), `import fs from 'node:fs';console.log('before');fs.writeFileSync(${JSON.stringify(startedMarker)},'ready');while(!fs.existsSync(${JSON.stringify(releaseMarker)}))await new Promise(r=>setTimeout(r,20));console.log('after')`);
    const started = await f.control(startRequest(f.root, id));
    await waitFor(async () => { try { await access(startedMarker); return true; } catch { return false; } }, "held task did not start");
    const missing = await f.control({ action: "replace-app", app: { executable: path.join(f.root, "missing"), args: [], cwd: f.root, env: {} } });
    assert.equal(missing.status, 500);
    assert.equal((await f.control({ action: "task", id })).body.result.pid, started.body.result.pid);
    const replacement = path.join(f.root, "replacement.mjs");
    await writeFile(replacement, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(appReady)},'ready');setInterval(()=>{},1000)`);
    await f.control({ action: "replace-app", app: { executable: process.execPath, args: [replacement], cwd: f.root, env: { PATH: process.env.PATH! } } });
    await waitFor(async () => { try { await access(appReady); return true; } catch { return false; } }, "replacement app did not start");
    assert.equal((await f.control({ action: "task", id })).body.result.pid, started.body.result.pid);
    await writeFile(releaseMarker, "release");
    await waitFor(async () => (await f.control({ action: "task", id })).body.result.status === "completed", "held task did not complete");
    const output = (await f.control({ action: "output", id, offset: 0, limit: 65536 })).body.result;
    const text = Buffer.from(output.chunk, "base64").toString();
    assert.equal((text.match(/before/g) ?? []).length, 1);
    assert.equal((text.match(/after/g) ?? []).length, 1);
    const completions = (await f.control({ action: "completions" })).body.result;
    assert.equal(completions.filter((event: any) => event.taskId === id).length, 1);
  } finally { await cleanup(f); }
});

test("malformed input is a bounded client error", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.control("{", f.ready.token, true)).status, 400);
    assert.equal((await f.control({ action: "start", ...startRequest(f.root), cwd: path.join(f.root, "missing") })).status, 400);
    assert.equal((await f.control({ ...startRequest(f.root), env: { "BAD=KEY": "x" } })).status, 400);
    assert.equal((await f.control({ action: "stop", id: "bad" })).status, 400);
    assert.equal((await f.control({ action: "status" }, "wrong")).status, 401);
    assert.equal((await f.control({ action: "output", id: UUID, offset: 0, limit: 65537 })).status, 400);
  } finally { await cleanup(f); }
});

test("nonzero exit and completion delivery are preserved", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "task.mjs"), "process.exit(7)");
    await f.control(startRequest(f.root));
    await waitFor(async () => (await f.control({ action: "task", id: UUID })).body.result.status === "failed", "exit not recorded");
    const row = (await f.control({ action: "task", id: UUID })).body.result;
    assert.equal(row.exitCode, 7);
    assert.equal(row.signal, null);
    const first = (await f.control({ action: "completions" })).body.result;
    const second = (await f.control({ action: "completions" })).body.result;
    assert.equal(first.filter((event: any) => event.taskId === UUID).length, 1);
    assert.deepEqual(second, first);
  } finally { await cleanup(f); }
});

test("state symlinks are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbs-"));
  try {
    const target = path.join(root, "target");
    await writeFile(target, "protected");
    await symlink(target, path.join(root, "state"));
    await assert.rejects(startSupervisor({ dataDirectory: path.join(root, "state"), app: { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: {} } }));
    assert.equal(lstatSync(target).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
