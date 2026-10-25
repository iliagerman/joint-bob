import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorkerBridge, workerLaunch, type CrashInfo } from "../src/file-sync/bridge.js";
import type { CoreEvent } from "../src/file-sync/protocol.js";

const run = promisify(execFile);
const stub = workerLaunch(new URL("./fixtures/file-sync-stub-worker.js", import.meta.url));

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), `condition not met within ${timeoutMs} ms`);
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-file-sync-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the worker is looked up beside the bridge, through tsx in a checkout and as plain JavaScript once compiled", () => {
  assert.deepEqual(workerLaunch(), { url: new URL("../src/file-sync/worker.js", import.meta.url), tsx: import.meta.resolve("tsx/esm/api") });
  assert.deepEqual(workerLaunch(undefined, "file:///app/releases/r1/dist/file-sync/bridge.js"), { url: new URL("file:///app/releases/r1/dist/file-sync/worker.js") });
  assert.deepEqual(workerLaunch(undefined, "file:///repo/.test-build-abc/file-sync/bridge.js"), { url: new URL("file:///repo/.test-build-abc/file-sync/worker.js") });
});

test("a worker named worker.js runs its TypeScript source with the data directory it is given and none of this process's preloads", async (t) => {
  const dataDir = await temporaryDirectory(t);
  const bridge = new WorkerBridge({ nodeId: "node-a", dataDir, launch: stub });
  t.after(() => bridge.stop());
  bridge.start();
  const answer = await bridge.call("status", {}) as unknown as { workerData: { dataDir: string; nodeId: string }; dataDirFromEnv: string | null; execArgv: string[]; key: string };
  assert.equal(answer.workerData.dataDir, dataDir);
  assert.equal(answer.workerData.nodeId, "node-a");
  assert.equal(answer.key, "tickets:p1", "the worker resolved a .js import to TypeScript");
  assert.deepEqual(answer.execArgv, [], `the worker ran with ${JSON.stringify(answer.execArgv)}`);
  // test/setup.mjs gives every process that runs it a new data directory; the worker kept ours.
  assert.equal(answer.dataDirFromEnv, process.env.PI_WEB_DATA_DIR ?? null);
});

test("a worker that keeps crashing is restarted after growing delays and given up after five crashes", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => { warnings.push(String(message)); });
  const starts: number[] = [];
  const crashes: CrashInfo[] = [];
  const bridge = new WorkerBridge({
    nodeId: "node-a", dataDir: await temporaryDirectory(t), launch: stub, workerData: { mode: "crash" },
    restart: { initialMs: 20, maxMs: 50, crashes: 5, windowMs: 60_000 },
    onStart: () => starts.push(Date.now()), onCrash: (info) => crashes.push(info),
  });
  t.after(() => bridge.stop());
  bridge.start();
  await until(() => bridge.state === "failed");
  assert.deepEqual(crashes.map((crash) => crash.retryInMs), [20, 40, 50, 50, undefined]);
  assert.ok(crashes.every((crash) => crash.reason.includes("stub worker crashed")), `reasons: ${crashes.map((crash) => crash.reason).join(" | ")}`);
  assert.equal(starts.length, 5, `started ${starts.length} times`);
  for (let index = 1; index < starts.length; index++) {
    const gap = starts[index] - starts[index - 1];
    assert.ok(gap >= crashes[index - 1].retryInMs!, `restart ${index} came ${gap} ms after the previous start, before its ${crashes[index - 1].retryInMs} ms delay`);
  }
  assert.match(warnings.at(-1) ?? "", /File sync is off: its worker failed 5 times/);
  await assert.rejects(bridge.call("status", {}), /File sync worker is not running/);
});

test("worker events reach the listener, and only code-owned metric labels and fields are recorded", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => { warnings.push(String(message)); });
  const events: CoreEvent[] = [];
  const metrics: Array<[string, number, Record<string, unknown>]> = [];
  const bridge = new WorkerBridge({
    nodeId: "node-a", dataDir: await temporaryDirectory(t), launch: stub, workerData: { tag: "events" },
    onEvent: (event) => events.push(event), metrics: (operation, durationMs, fields) => metrics.push([operation, durationMs, fields]),
  });
  t.after(() => bridge.stop());
  bridge.start();
  await bridge.call("status", {});
  assert.deepEqual(events.map((event) => event.event), ["shareState", "metric", "metric", "log"]);
  assert.deepEqual(metrics, [["fileSync.scan", 12, { files: 3, scope: "full", thread: "worker" }]]);
  assert.deepEqual(warnings, ["stub warning events"]);
});

test("a call the worker refuses rejects with the worker's reason", async (t) => {
  const bridge = new WorkerBridge({ nodeId: "node-a", dataDir: await temporaryDirectory(t), launch: stub });
  t.after(() => bridge.stop());
  bridge.start();
  await assert.rejects(bridge.call("flush", { share: "project:missing" }), { message: "share not found" });
});

test("stop lets a worker that answered it finish closing, and returns as soon as it has ended", async (t) => {
  const dataDir = await temporaryDirectory(t);
  const bridge = new WorkerBridge({ nodeId: "node-a", dataDir, launch: stub });
  bridge.start();
  await bridge.call("status", {});
  const started = Date.now();
  await bridge.stop(2_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `stop took ${elapsed} ms of its 2,000 ms budget`);
  assert.equal(bridge.state, "stopped");
  assert.equal(await readFile(path.join(dataDir, "closed"), "utf8").catch(() => "terminated before closing"), "yes");
});

test("stop ends a worker that ignores the stop request within its budget", async (t) => {
  const bridge = new WorkerBridge({ nodeId: "node-a", dataDir: await temporaryDirectory(t), launch: stub, workerData: { mode: "hang" } });
  bridge.start();
  const started = Date.now();
  await bridge.stop(300);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_500, `stop took ${elapsed} ms`);
  assert.equal(bridge.state, "stopped");
  await assert.rejects(bridge.call("status", {}), /File sync worker is not running/);
});

async function runExitProbe(t: test.TestContext, action: "stop" | "leave"): Promise<{ state: string; stopMs: number }> {
  const dataDir = await temporaryDirectory(t);
  const started = Date.now();
  // A worker that kept the process alive would hit this timeout and fail the run.
  const { stdout } = await run(process.execPath, ["--import", "tsx", path.resolve("test/fixtures/file-sync-bridge-exit.ts"), action], { cwd: process.cwd(), env: { ...process.env, PROBE_DATA_DIR: dataDir }, timeout: 20_000 });
  assert.ok(Date.now() - started < 20_000);
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as { state: string; stopMs: number };
}

test("after stop the process exits on its own, even though the worker held its loop open", async (t) => {
  const result = await runExitProbe(t, "stop");
  assert.equal(result.state, "stopped");
  assert.ok(result.stopMs < 2_500, `stop took ${result.stopMs} ms`);
});

test("a running worker that was never called never keeps the process alive", async (t) => {
  const result = await runExitProbe(t, "leave");
  assert.equal(result.state, "running");
});
