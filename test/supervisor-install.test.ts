import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSupervisorControl, supervisorRequest } from "../scripts/supervisor-client.mjs";
import { assertSupervisorCompatible, readInstallation, releaseAppSpec, supervisorComponentsMatch } from "../scripts/supervisor-release.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const components = ["joint-bob-supervisor.mjs", "supervisor-worker.mjs", "supervisor-store.mjs", "supervisor-client.mjs", "supervisor-service.mjs", "supervisor-release.mjs", "supervisor-install.mjs"];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(operation: () => Promise<T>, description: string, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (error) { last = error; }
    await delay(40);
  }
  throw new Error(`${description}: ${last instanceof Error ? last.message : last}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback port unavailable");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function serverSource(root: string, fail = false) {
  if (fail) return "process.exit(3)\n";
  return `import http from'node:http';import fs from'node:fs';const release=process.env.JOINT_BOB_RELEASE;const server=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'ok',release}))});server.listen(Number(process.env.PORT),'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(path.join(root, "boot-"))}+release,String(process.pid)));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(path.join(root, "graceful-"))}+release,'yes');server.close(()=>process.exit(0))});`;
}

async function makeRelease(root: string, fixtureRoot: string, commit: string, version: string, fail = false) {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await cp(path.join(repo, "bin/joint-bob.mjs"), path.join(root, "bin/joint-bob.mjs"));
  for (const file of components) await cp(path.join(repo, "scripts", file), path.join(root, "scripts", file));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version }));
  await writeFile(path.join(root, ".joint-bob-release"), `name=fixture\ncommit=${commit}\nchannel=test\n`);
  await writeFile(path.join(root, "dist/server.js"), serverSource(fixtureRoot, fail));
  await writeFile(path.join(root, "scripts/install-service.sh"), `#!/usr/bin/env bash\ncase "$1" in\n--build-only) exit 0;;\n--prepare-only) echo prepared >> "$PREPARED_MARKER"; exit 0;;\n*) echo native > "$NATIVE_MARKER"; exit 9;;\nesac\n`);
}

async function health(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json() as Promise<{ status: string; release: string }>;
}

async function waitClosed(child: ChildProcess, timeout = 12000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      new Promise<void>(resolve => child.once("close", () => resolve())),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child close timeout")), timeout); }),
    ]);
  } finally { clearTimeout(timer!); }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitClosed(child);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitClosed(child);
    throw error;
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jbi-"));
  const app = path.join(root, "app");
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  const port = await freePort();
  await makeRelease(app, root, "a".repeat(40), "1.0.0");
  await makeRelease(source, root, "b".repeat(40), "2.0.0");
  await writeFile(path.join(app, "OLD"), "old-generation");
  const env = { HOME: root, JOINT_BOB_DATA_DIR: state, PI_WEB_DATA_DIR: state, JOINT_BOB_INSTALL_DIR: app, PORT: String(port), PATH: process.env.PATH!, PREPARED_MARKER: path.join(root, "prepared"), NATIVE_MARKER: path.join(root, "native-called") };
  let stderr = "";
  const start = () => {
    const child = spawn(process.execPath, [path.join(app, "scripts/supervisor-service.mjs"), app, state], { env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", chunk => stderr += chunk);
    return child;
  };
  let supervisor = start();
  try {
    await waitFor(async () => {
      if (supervisor.exitCode !== null) throw new Error(`supervisor exited ${supervisor.exitCode}: ${stderr}`);
      if (!readSupervisorControl(state)) throw new Error("control unavailable");
      const value = await health(port);
      assert.deepEqual(value, { status: "ok", release: "a".repeat(40) });
      return value;
    }, "initial supervisor readiness");
    return { root, app: await realpath(app), source, state, port, env, get supervisor() { return supervisor; }, set supervisor(value) { supervisor = value; }, start, diagnostics: () => stderr };
  } catch (error) {
    await stop(supervisor);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function install(f: Fixture) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => execFile(process.execPath, [path.join(f.source, "bin/joint-bob.mjs"), "install"], { env: f.env, timeout: 20000 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
}
async function absent(file: string) { await assert.rejects(access(file), (error: NodeJS.ErrnoException) => error.code === "ENOENT"); }

async function startHeldTask(f: Fixture, id: string) {
  const ready = path.join(f.root, `task-ready-${id}`);
  const release = path.join(f.root, `task-release-${id}`);
  const launches = path.join(f.root, `task-launches-${id}`);
  const script = path.join(f.root, `task-${id}.mjs`);
  await writeFile(script, `import fs from'node:fs';fs.appendFileSync(${JSON.stringify(launches)},'x');console.log('before');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));console.log(fs.readFileSync('OLD','utf8'));console.log('after')`);
  const row = await supervisorRequest(f.state, { action: "start", id, identity: "fixture", name: "held", executable: process.execPath, args: [script], cwd: f.app, env: { PATH: process.env.PATH! } });
  await waitFor(() => readFile(ready, "utf8"), "held task readiness");
  return { pid: row.pid as number, release, launches };
}

async function cleanup(f: Fixture) {
  try { await stop(f.supervisor); } finally { await rm(f.root, { recursive: true, force: true }); }
}

test("release specifications accept one commit field and detect changed supervisor components", async () => {
  const f = await createFixture();
  try {
    const spec = releaseAppSpec(f.app, f.app, f.state);
    assert.equal(spec.env.JOINT_BOB_RELEASE, "a".repeat(40));
    assert.equal(supervisorComponentsMatch(f.app, f.source), true);
    assertSupervisorCompatible(f.app, f.source);
    await appendFile(path.join(f.source, "scripts/supervisor-worker.mjs"), "\n// mismatch\n");
    assert.equal(supervisorComponentsMatch(f.app, f.source), false);
    assert.throws(() => assertSupervisorCompatible(f.app, f.source), /maintenance activation/);
  } finally { await cleanup(f); }
});

test("changed supervisor components prepare sessions, activate, swap scripts, and restart the supervisor", async () => {
  const f = await createFixture();
  try {
    await appendFile(path.join(f.source, "scripts/supervisor-worker.mjs"), "\n// incompatible\n");
    await install(f);
    // Running work is paused through the ordinary preparation step, not refused.
    assert.equal((await readFile(path.join(f.root, "prepared"), "utf8")).trim(), "prepared");
    assert.deepEqual(await health(f.port), { status: "ok", release: "b".repeat(40) });
    assert.equal(readInstallation(f.state)!.activeRelease.startsWith(path.join(f.app, "releases")), true);
    // The install root now carries the new supervisor, so the next update compares equal.
    assert.equal(
      await readFile(path.join(f.app, "scripts/supervisor-worker.mjs"), "utf8"),
      await readFile(path.join(f.source, "scripts/supervisor-worker.mjs"), "utf8"),
    );
    assert.equal(supervisorComponentsMatch(f.app, f.source), true);
    await absent(path.join(f.app, "scripts.incoming"));
    await absent(path.join(f.app, "scripts.previous"));
    // The supervisor stands down so the service manager restarts it on the new code.
    await waitClosed(f.supervisor, 20000);
    assert.equal(f.supervisor.exitCode, 0);
    await absent(path.join(f.root, "native-called"));
    f.supervisor = f.start();
    await waitFor(async () => { assert.equal((await health(f.port)).release, "b".repeat(40)); return true; }, "release after supervisor restart");
  } finally { await cleanup(f); }
});

test("actual installer preserves a held task, activates the candidate, and native restart boots the commit", async () => {
  const f = await createFixture();
  const id = "00000000-0000-4000-8000-000000000101";
  try {
    const instance = (await supervisorRequest(f.state, { action: "status" })).instanceId;
    const task = await startHeldTask(f, id);
    await install(f);
    const installed = readInstallation(f.state)!;
    assert.match(installed.activeRelease, new RegExp(`^${f.app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${path.sep}releases${path.sep}`));
    assert.deepEqual(await health(f.port), { status: "ok", release: "b".repeat(40) });
    const status = await supervisorRequest(f.state, { action: "status" });
    assert.equal(status.instanceId, instance);
    assert.equal((await supervisorRequest(f.state, { action: "task", id })).pid, task.pid);
    assert.equal(await readFile(path.join(f.app, "OLD"), "utf8"), "old-generation");
    await access(path.join(f.root, `graceful-${"a".repeat(40)}`));
    await absent(path.join(f.root, "native-called"));
    await writeFile(task.release, "go");
    await waitFor(async () => { const row = await supervisorRequest(f.state, { action: "task", id }); assert.equal(row.status, "completed"); return row; }, "task completion");
    const output = await supervisorRequest(f.state, { action: "output", id, offset: 0, limit: 65536 });
    assert.equal(Buffer.from(output.chunk, "base64").toString(), "before\nold-generation\nafter\n");
    assert.deepEqual(await supervisorRequest(f.state, { action: "completions" }), await supervisorRequest(f.state, { action: "completions" }));
    await stop(f.supervisor);
    f.supervisor = f.start();
    await waitFor(async () => { assert.equal((await health(f.port)).release, "b".repeat(40)); return true; }, "committed release after native restart");
  } finally { await cleanup(f); }
});

test("failed candidate rolls back without replacing the active pointer or held task", async () => {
  const f = await createFixture();
  const id = "00000000-0000-4000-8000-000000000102";
  try {
    await install(f);
    const committed = readInstallation(f.state)!.activeRelease;
    const task = await startHeldTask(f, id);
    await writeFile(path.join(f.source, "dist/server.js"), serverSource(f.root, true));
    await assert.rejects(install(f), /Candidate app exited before becoming healthy/);
    assert.equal(readInstallation(f.state)!.activeRelease, committed);
    assert.equal((await health(f.port)).release, "b".repeat(40));
    assert.equal((await supervisorRequest(f.state, { action: "task", id })).pid, task.pid);
    await writeFile(task.release, "go");
  } finally { await cleanup(f); }
});

test("interrupted candidate before commit restarts last good app and never replays tasks", async () => {
  const f = await createFixture();
  const id = "00000000-0000-4000-8000-000000000104";
  let workerPid: number | undefined;
  let interrupted = false;
  try {
    await install(f);
    const committed = readInstallation(f.state)!.activeRelease;
    const task = await startHeldTask(f, id);
    workerPid = task.pid;
    const candidate = path.join(f.app, "releases", "c".repeat(40));
    const ready = path.join(f.root, "candidate-ready");
    await makeRelease(candidate, f.root, "c".repeat(40), "3.0.0");
    await writeFile(path.join(candidate, "dist/server.js"), `import http from'node:http';import fs from'node:fs';const release=process.env.JOINT_BOB_RELEASE;const server=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({status:'updating',release}))});server.listen(Number(process.env.PORT),'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)));setInterval(()=>{},1000);`);

    const activation = supervisorRequest(f.state, { action: "activate-release", releaseRoot: candidate }, { timeoutMs: 30000 }).then(
      value => ({ value }),
      error => ({ error }),
    );
    await waitFor(async () => { await access(ready); return true; }, "candidate readiness");
    await waitFor(async () => { assert.equal((await supervisorRequest(f.state, { action: "status" })).installing, true); return true; }, "candidate installation state");
    assert.equal(readInstallation(f.state)!.activeRelease, committed);

    const oldInstance = (await supervisorRequest(f.state, { action: "status" })).instanceId;
    f.supervisor.kill("SIGKILL");
    await waitClosed(f.supervisor, 6000);
    interrupted = true;
    const activationResult = await activation;
    assert.match(String("error" in activationResult ? activationResult.error : ""), /Supervisor request failed/);

    f.supervisor = f.start();
    await waitFor(async () => {
      assert.deepEqual(await health(f.port), { status: "ok", release: "b".repeat(40) });
      const status = await supervisorRequest(f.state, { action: "status" });
      assert.notEqual(status.instanceId, oldInstance);
      return status;
    }, "last good app after interrupted activation");
    assert.equal(readInstallation(f.state)!.activeRelease, committed);
    const row = await supervisorRequest(f.state, { action: "task", id });
    assert.equal(row.status, "unknown");
    const completions = await supervisorRequest(f.state, { action: "completions" });
    assert.equal(completions.filter((completion: { taskId: string }) => completion.taskId === id).length, 1);
    assert.equal(await readFile(task.launches, "utf8"), "x");
    const output = await supervisorRequest(f.state, { action: "output", id, offset: 0, limit: 65536 });
    assert.equal(Buffer.from(output.chunk, "base64").toString(), "before\n");
    await waitFor(async () => {
      assert.throws(() => process.kill(task.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      return true;
    }, "interrupted task exit");
    workerPid = undefined;
  } finally {
    if (!interrupted && f.supervisor.exitCode === null && f.supervisor.signalCode === null) {
      f.supervisor.kill("SIGKILL");
      await waitClosed(f.supervisor, 6000);
    }
    if (workerPid !== undefined) {
      try { process.kill(workerPid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await cleanup(f);
  }
});

test("installed app crash restarts the app without replacing supervisor or held task", async () => {
  const f = await createFixture();
  const id = "00000000-0000-4000-8000-000000000103";
  try {
    const task = await startHeldTask(f, id);
    const before = await supervisorRequest(f.state, { action: "status" });
    process.kill(before.app.pid, "SIGKILL");
    const after = await waitFor(async () => {
      const value = await supervisorRequest(f.state, { action: "status" });
      assert.notEqual(value.app.pid, null);
      assert.notEqual(value.app.pid, before.app.pid);
      return value;
    }, "installed app restart", 4000);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal((await supervisorRequest(f.state, { action: "task", id })).pid, task.pid);
    await writeFile(task.release, "go");
  } finally { await cleanup(f); }
});

test("repeated installs keep only the newest releases so the disk does not grow forever", async () => {
  const f = await createFixture();
  try {
    await install(f);
    await install(f);
    await install(f);
    const active = readInstallation(f.state)!.activeRelease;
    const releases = path.join(f.app, "releases");
    const kept = (await readdir(releases, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(releases, entry.name));
    assert.equal(kept.length, 2, `expected 2 retained releases, found ${kept.length}`);
    assert.equal(kept.map(entry => path.resolve(entry)).includes(path.resolve(active)), true, "the active release must survive pruning");
    assert.deepEqual(await health(f.port), { status: "ok", release: "b".repeat(40) });
  } finally { await cleanup(f); }
});
