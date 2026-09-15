import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(message);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: NodeJS.Timeout;
  await Promise.race([
    new Promise<void>(resolve => child.once("close", () => resolve())),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 12000); }),
  ]);
  clearTimeout(timer!);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbc-"));
  const state = path.join(root, "state");
  const app = path.join(root, "app.mjs");
  await writeFile(app, "setInterval(()=>{},1000)");
  const child = spawn(process.execPath, ["scripts/joint-bob-supervisor.mjs", "--data-dir", state, "--app", app, "--cwd", root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", part => stdout += part);
  child.stderr!.on("data", part => stderr += part);
  try {
    await waitFor(() => stdout.includes("\n") || child.exitCode !== null, `supervisor unavailable: ${stderr}`);
    if (child.exitCode !== null) throw new Error(stderr);
    return { root, state, child, ready: JSON.parse(stdout.slice(0, stdout.indexOf("\n"))), stdout: () => stdout };
  } catch (error) {
    await stop(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: any) => error.status === status);
}

test("private discovery reconnects and scoped capabilities enforce identity", async () => {
  const f = await fixture();
  try {
    const client = await import("../scripts/supervisor-client.mjs");
    assert.deepEqual(Object.keys(f.ready).sort(), ["protocolVersion", "socketPath"]);
    assert.equal(f.stdout().includes("token"), false);
    const control = client.readSupervisorControl(f.state);
    assert.equal(control!.socketPath, f.ready.socketPath);
    assert.equal((await client.supervisorRequest<any>(f.state, { action: "status" })).protocolVersion, 1);
    const tokenA = client.mintTaskToken(f.state, "projectA/conversationA");
    const tokenB = client.mintTaskToken(f.state, "projectB/conversationB");
    const id = "00000000-0000-4000-8000-000000000021";
    const task = await client.supervisorRequest<any>(f.state, { action: "start", id, identity: "projectB/conversationB", name: "a", executable: process.execPath, args: ["-e", "console.log('scope')"], cwd: f.root, env: {} }, { token: tokenA });
    assert.equal(task.identity, "projectA/conversationA");
    await expectStatus(client.supervisorRequest(f.state, { action: "task", id }, { token: tokenB }), 404);
    await expectStatus(client.supervisorRequest(f.state, { action: "output", id, offset: 0, limit: 20 }, { token: tokenB }), 404);
    await expectStatus(client.supervisorRequest(f.state, { action: "stop", id }, { token: tokenB }), 404);
    await expectStatus(client.supervisorRequest(f.state, { action: "status" }, { token: tokenA }), 403);
    await expectStatus(client.supervisorRequest(f.state, { action: "replace-app", app: {} }, { token: tokenA }), 403);
    await expectStatus(client.requestSupervisor(f.ready.socketPath, "invalid", { action: "list" }), 401);
    assert.equal((await client.supervisorRequest<any[]>(f.state, { action: "list" }, { token: tokenA })).length, 1);
    assert.equal((await client.supervisorRequest<any[]>(f.state, { action: "list" }, { token: tokenB })).length, 0);
  } finally { await stop(f.child); await rm(f.root, { recursive: true, force: true }); }
});

test("task CLI launches once, survives CLI exit, and supports status/output/stop", async () => {
  const f = await fixture();
  try {
    const { mintTaskToken } = await import("../scripts/supervisor-client.mjs");
    const token = mintTaskToken(f.state, "project/conversation");
    const marker = path.join(f.root, "marker"), release = path.join(f.root, "release"), task = path.join(f.root, "task.mjs");
    await writeFile(task, `import fs from'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'x');console.log('fixture-output');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20))`);
    const id = "00000000-0000-4000-8000-000000000022";
    const env = { ...process.env, JOINT_BOB_TASK_SOCKET: f.ready.socketPath, JOINT_BOB_TASK_TOKEN: token };
    const cli = path.resolve("bin/joint-bob-task.mjs");
    const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, env, encoding: "utf8" });
    const command = ["start", "--id", id, "--name", "fixture", "--", process.execPath, task];
    assert.equal(run(command).status, 0);
    await waitFor(async () => { try { return await readFile(marker, "utf8") === "x"; } catch { return false; } }, "task did not survive CLI");
    assert.equal(run(command).status, 0);
    assert.equal(await readFile(marker, "utf8"), "x");
    assert.equal(JSON.parse(run(["status", id]).stdout).id, id);
    await waitFor(() => run(["output", id]).stdout.includes("fixture-output"), "output unavailable");
    assert.equal(run(["stop", id]).status, 0);
  } finally { await stop(f.child); await rm(f.root, { recursive: true, force: true }); }
});

test("unavailable discovery and CLI validation do not create supervisor state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbc-"));
  try {
    const client = await import("../scripts/supervisor-client.mjs");
    assert.equal(client.readSupervisorControl(root), null);
    assert.throws(() => client.mintTaskToken(root, "identity"), /Joint Bob supervisor is unavailable/);
    await assert.rejects(client.supervisorRequest(root, { action: "status" }), /Joint Bob supervisor is unavailable/);
    await assert.rejects(client.requestSupervisor("https://example.com", "x", {}, 10), /socket path/);
    const missing = spawnSync(process.execPath, ["bin/joint-bob-task.mjs", "status"], { env: {}, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Background tasks require the Joint Bob supervisor/);
    await assert.rejects(access(path.join(root, "supervisor.db")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
