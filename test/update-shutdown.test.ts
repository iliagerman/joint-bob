import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { abortPiForUpdate, terminateClaudeForUpdate, prepareForUpdate } from "../src/server/realtime.js";
import { flags, sharedSessions, type SharedPiSession } from "../src/server/state.js";
import { completeUpdateRecovery, listPendingUpdateRecoveries, saveUpdateRecoveries } from "../src/update-recovery.js";

function piSession(abort: () => Promise<void>): SharedPiSession {
  return { projectId: "shutdown-test", cwd: "/tmp", handle: { session: {
    sessionId: "shutdown-test", sessionFile: "/tmp/shutdown-test.jsonl", isStreaming: true,
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, abortBash() {}, abort,
    clearQueue() {}, getSteeringMessages: () => ["queued"], getFollowUpMessages: () => [],
  } } } as unknown as SharedPiSession;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("Pi abort deadline refuses readiness instead of waiting forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome = "waiting";
  const pending = abortPiForUpdate(piSession(() => new Promise(() => {})))
    .then(() => { outcome = "ready"; }, (error) => { outcome = error.message; });
  t.mock.timers.tick(60_001);
  await flush();
  assert.match(outcome, /Pi.*did not stop/);
  await pending;
});

test("already signaled Claude child does not wait for a past close event", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "pipe" });
  await once(child, "spawn");
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([terminateClaudeForUpdate(child), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("waited for a past close event")), 500);
    })]);
  } finally { clearTimeout(timer!); }
});

test("stubborn Claude process group is gone before readiness", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: "pipe" });
  await once(child.stdout, "data");
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([terminateClaudeForUpdate(child), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("stubborn process was not stopped")), 15_000);
    })]);
    assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(timer!);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      process.kill(-child.pid!, "SIGKILL");
      await closed;
    }
  }
});

test("already exited Claude leader still stops its surviving tool group", { timeout: 20_000 }, async () => {
  const script = `const { spawn } = require("node:child_process");
    const tool = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    tool.on("message", () => console.log(tool.pid));`;
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "pipe" });
  await once(child.stdout, "data");
  try {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(process.kill(-child.pid!, 0), true, "tool must outlive its leader for this regression");
    await terminateClaudeForUpdate(child);
    assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

test("Claude launch owns a process group rather than sharing the server group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-stop-group-"));
  const { getSettings, updateSettings } = await import("../src/settings.js");
  const { runClaudePrompt } = await import("../src/claude-service.js");
  const previous = getSettings();
  const executable = path.join(root, "claude");
  await writeFile(executable, `#!${process.execPath}\nconsole.log("ready"); setInterval(() => {}, 1000);\n`);
  await chmod(executable, 0o755);
  updateSettings({ ...previous, claude: { ...previous.claude, executable } });
  const run = runClaudePrompt({ cwd: root, projectId: "shutdown-test", prompt: "test", onEvent() {} });
  try {
    await once(run.child.stdout, "data");
    const group = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(run.child.pid)], { encoding: "utf8" }).trim());
    assert.equal(group, run.child.pid, "Claude must own the group used by update shutdown");
  } finally {
    run.child.kill("SIGKILL");
    await run.done;
    updateSettings(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude stop refuses if the process group cannot be confirmed gone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const kill = t.mock.method(process, "kill", () => true);
  const child = { pid: 12345, exitCode: null, signalCode: "SIGTERM" } as ReturnType<typeof spawn>;
  let outcome = "waiting";
  const pending = terminateClaudeForUpdate(child as Parameters<typeof terminateClaudeForUpdate>[0])
    .then(() => { outcome = "ready"; }, (error) => { outcome = error.message; });
  t.mock.timers.tick(60_001);
  await flush();
  assert.match(outcome, /Claude.*did not stop/);
  await pending;
  assert.ok(kill.mock.calls.every((call) => call.arguments[0] === -12345));
});

test("pending recovery refuses preparation without discarding records", async () => {
  const record = { id: "pending-shutdown", kind: "chat" as const, engine: "pi" as const, projectId: "shutdown-test", cwd: "/tmp", sessionId: "s", sessionPath: "/tmp/s.jsonl", taskId: null, phase: null, queuedPrompts: ["keep"], model: null, effort: null, createdAt: new Date().toISOString() };
  await saveUpdateRecoveries([record]);
  try {
    await assert.rejects(prepareForUpdate(), /still recovering/);
    assert.equal(flags.updatePreparing, false);
    assert.deepEqual(await listPendingUpdateRecoveries(), [record]);
  } finally {
    for (const pending of await listPendingUpdateRecoveries()) await completeUpdateRecovery(pending.id);
    flags.updatePreparing = false;
    flags.updatePreparation = null;
  }
});

test("failed Pi stop preserves recovery and fence without unsafe watchdog restart", async (t) => {
  const exit = t.mock.method(process, "exit", () => { throw new Error("unsafe watchdog restart"); });
  const shared = piSession(() => new Promise(() => {}));
  sharedSessions.set("shutdown-test", shared);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome = "waiting";
  const pending = prepareForUpdate().then(() => { outcome = "ready"; }, (error) => { outcome = error.message; });
  try {
    t.mock.timers.tick(501);
    await flush();
    t.mock.timers.tick(60_001);
    await flush();
    assert.match(outcome, /Pi.*did not stop/);
    await pending;
    assert.equal(flags.updatePreparing, true);
    const records = await listPendingUpdateRecoveries();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].queuedPrompts, ["queued"]);
    t.mock.timers.tick(300_000);
    assert.equal(exit.mock.callCount(), 0);
    await assert.rejects(prepareForUpdate(), /Pi.*did not stop/);
  } finally {
    sharedSessions.clear();
    flags.updatePreparing = false;
    flags.updatePreparation = null;
    for (const record of await listPendingUpdateRecoveries()) await completeUpdateRecovery(record.id);
  }
});
