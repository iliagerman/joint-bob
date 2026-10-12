import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { conversationLimits, createConversationLimiter } from "../scripts/conversation-limits.mjs";
import { startSupervisor } from "../scripts/joint-bob-supervisor.mjs";
import { requestSupervisor } from "../scripts/supervisor-client.mjs";
import { processTable, watchSubprocess } from "../scripts/subprocess-lifetime.mjs";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Row = { pid: number; parent: number; uid: number; birth: string; rssKb: number; cpuMs: number };
const row = (pid: number, cpuMs: number, rssKb = 1000): Row => ({ pid, parent: 1, uid: 501, birth: `born-${pid}`, rssKb, cpuMs });

/** A limiter over a made-up process table, polled by hand on a made-up clock. */
function fixture(limits: { cpuCores: number | null; memoryGb: number | null }) {
  const state = { limits, rows: [] as Row[], at: 0, signals: [] as string[] };
  const limiter = createConversationLimiter({
    limits: () => state.limits,
    observe: async () => new Map(state.rows.map(entry => [entry.pid, entry])),
    signal: (pid, name) => { state.signals.push(`${name}:${pid}`); },
    now: () => state.at,
    pollMs: 3_600_000, sliceMs: 20, memoryStrikes: 3,
  });
  const poll = async (rows: Row[], elapsedMs = 1000) => { state.rows = rows; state.at += elapsedMs; await limiter.poll(); };
  return { state, limiter, poll };
}

test("the stored limits are read per node and default to none", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-limits-"));
  try {
    assert.deepEqual(conversationLimits(root), { cpuCores: null, memoryGb: null }, "a node without settings has no limits");
    const db = new DatabaseSync(path.join(root, "node.db"));
    db.exec("CREATE TABLE node_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO node_settings VALUES('conversationCpuLimitCores','2.5'),('conversationMemoryLimitGb','unlimited')");
    assert.deepEqual(conversationLimits(root), { cpuCores: 2.5, memoryGb: null });
    db.exec("UPDATE node_settings SET value='-1' WHERE key='conversationCpuLimitCores'; UPDATE node_settings SET value='8' WHERE key='conversationMemoryLimitGb'");
    assert.deepEqual(conversationLimits(root), { cpuCores: null, memoryGb: 8 }, "a stored value outside the range is no limit");
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a conversation over its CPU limit is paused for part of each slice and released when it calms down", async () => {
  const { state, limiter, poll } = fixture({ cpuCores: 1, memoryGb: null });
  const first = limiter.add({ identity: "busy", id: "a", watch: { descendants: [row(11, 0), row(12, 0)] }, onMemoryExceeded: () => assert.fail("no memory limit is set") });
  limiter.add({ identity: "quiet", id: "b", watch: { descendants: [row(21, 0)] }, onMemoryExceeded: () => assert.fail("no memory limit is set") });
  try {
    await poll([row(11, 0), row(12, 0), row(21, 0)]);
    assert.equal(limiter.fractions.get("busy"), 1, "the first reading only sets the baseline");
    // Two processes of one conversation used four cores between them; the other used a tenth.
    await poll([row(11, 2000), row(12, 2000), row(21, 100)]);
    assert.equal(limiter.fractions.get("busy"), 0.25, "four cores of demand against one allowed runs a quarter of the time");
    assert.equal(limiter.fractions.get("quiet"), 1, "each conversation is measured against the limit on its own");
    await delay(120);
    assert.ok(state.signals.includes("SIGSTOP:11") && state.signals.includes("SIGSTOP:12"), "both processes of the busy conversation are paused");
    assert.ok(state.signals.includes("SIGCONT:11") && state.signals.includes("SIGCONT:12"), "and woken again every slice");
    assert.ok(!state.signals.some(entry => entry.endsWith(":21")), "the conversation under its limit is never touched");
    // Running a quarter of the time it used one core: the demand is still four, so it stays held.
    await poll([row(11, 2500), row(12, 2500), row(21, 200)]);
    assert.equal(limiter.fractions.get("busy"), 0.25);
    // Its work is done. A tenth of a core while held to a quarter is under the limit unpaused too.
    await poll([row(11, 2550), row(12, 2550), row(21, 300)]);
    assert.equal(limiter.fractions.get("busy"), 1);
    state.signals.length = 0;
    await delay(80);
    assert.ok(!state.signals.some(entry => entry.startsWith("SIGSTOP")), "a released conversation is not paused again");
    first.dispose();
    assert.equal(limiter.fractions.has("busy"), false);
  } finally { limiter.close(); }
});

test("nothing stays paused when the limit is switched off, a task ends, or the limiter closes", async () => {
  const stillPaused = (signals: string[]) => {
    const paused = new Set<string>();
    for (const entry of signals) { const [name, pid] = entry.split(":"); if (name === "SIGSTOP") paused.add(pid); else paused.delete(pid); }
    return [...paused];
  };
  const throttled = async () => {
    const context = fixture({ cpuCores: 1, memoryGb: null });
    const task = context.limiter.add({ identity: "busy", id: "a", watch: { descendants: [row(11, 0)] }, onMemoryExceeded: () => undefined });
    await context.poll([row(11, 0)]);
    await context.poll([row(11, 8000)]);
    for (let waited = 0; waited < 500 && !stillPaused(context.state.signals).length; waited += 5) await delay(5);
    assert.deepEqual(stillPaused(context.state.signals), ["11"], "fixture must be caught paused");
    return { ...context, task };
  };
  const switchedOff = await throttled();
  switchedOff.state.limits = { cpuCores: null, memoryGb: null };
  await switchedOff.poll([row(11, 16000)]);
  assert.deepEqual(stillPaused(switchedOff.state.signals), []);
  await delay(60);
  assert.deepEqual(stillPaused(switchedOff.state.signals), [], "and it is not paused again with the limit off");
  switchedOff.limiter.close();

  const ended = await throttled();
  ended.task.dispose();
  assert.deepEqual(stillPaused(ended.state.signals), []);
  ended.limiter.close();

  const closed = await throttled();
  closed.limiter.close();
  assert.deepEqual(stillPaused(closed.state.signals), []);
});

test("a conversation over its memory limit for three readings has its largest command stopped", async () => {
  const { limiter, poll } = fixture({ cpuCores: null, memoryGb: 1 });
  const stopped: string[] = [];
  const megabytes = (value: number) => value * 1024;
  limiter.add({ identity: "hungry", id: "small", watch: { descendants: [row(11, 0)] }, onMemoryExceeded: reason => stopped.push(`small: ${reason}`) });
  limiter.add({ identity: "hungry", id: "large", watch: { descendants: [row(12, 0), row(13, 0)] }, onMemoryExceeded: reason => stopped.push(`large: ${reason}`) });
  limiter.add({ identity: "modest", id: "other", watch: { descendants: [row(21, 0)] }, onMemoryExceeded: reason => stopped.push(`other: ${reason}`) });
  try {
    const over = [row(11, 0, megabytes(300)), row(12, 0, megabytes(500)), row(13, 0, megabytes(400)), row(21, 0, megabytes(900))];
    await poll(over);
    await poll(over);
    assert.deepEqual(stopped, [], "a short spike is not enough");
    await poll([row(11, 0, megabytes(100)), row(12, 0, megabytes(100)), row(13, 0, megabytes(100)), row(21, 0, megabytes(900))]);
    await poll(over);
    await poll(over);
    assert.deepEqual(stopped, [], "the count starts again after a reading under the limit");
    await poll(over);
    assert.equal(stopped.length, 1, "one command is stopped, and only in the conversation over its limit");
    assert.match(stopped[0], /^large: Joint Bob stopped this command: its conversation was using 1\.2 GB of memory, over the 1 GB limit/);
    // The stopped command no longer counts, which leaves this conversation under its limit.
    await poll(over); await poll(over); await poll(over);
    assert.equal(stopped.length, 1);
  } finally { limiter.close(); }
});

test("a real process tree over its CPU limit is slowed and left running", { timeout: 60_000 }, async () => {
  // The limiter never pauses the root it is given, as the supervisor's task worker must stay
  // awake; so the busy loop is the root's child.
  const root = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'for(;;);'], { stdio: 'ignore' }); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  const watch = watchSubprocess(root, { lifetimeMs: () => 3_600_000, pollMs: 100 });
  const sent: string[] = [];
  const limiter = createConversationLimiter({
    limits: () => ({ cpuCores: 0.2, memoryGb: null }),
    signal: (pid, name) => { sent.push(name); process.kill(pid, name); },
    pollMs: 600, sliceMs: 100,
  });
  const cpuMs = async () => {
    const rows = await processTable();
    return watch.descendants.reduce((total, known) => total + (rows.get(known.pid)?.cpuMs ?? 0), 0);
  };
  try {
    for (let waited = 0; waited < 10_000 && !watch.descendants.length; waited += 50) await delay(50);
    assert.equal(watch.descendants.length, 1, "fixture must have one busy child");
    limiter.add({ identity: "busy", id: "a", watch, onMemoryExceeded: () => assert.fail("no memory limit is set") });
    for (let waited = 0; waited < 20_000 && limiter.fractions.get("busy") === 1; waited += 100) await delay(100);
    assert.ok(limiter.fractions.get("busy")! < 1, "a busy loop above a fifth of a core must be held back");
    await delay(1500);
    const before = await cpuMs();
    const startedAt = Date.now();
    await delay(3000);
    const cores = (await cpuMs() - before) / (Date.now() - startedAt);
    assert.ok(sent.includes("SIGSTOP") && sent.includes("SIGCONT"), "the tree is paused and woken");
    // A loaded machine gives the loop less than it asks for, so only an upper bound holds.
    assert.ok(cores < 0.6, `a loop held to 0.2 cores used ${cores.toFixed(2)}`);
    limiter.close();
    await delay(700);
    const [child] = watch.descendants;
    const after = await cpuMs();
    await delay(1500);
    assert.ok(child && await cpuMs() > after, "after the limiter closes the loop runs again");
  } finally {
    limiter.close();
    watch.dispose();
    for (const known of watch.descendants) try { process.kill(known.pid, "SIGKILL"); } catch { /* already gone */ }
    root.kill("SIGKILL");
  }
});

test("the supervisor stops a task whose conversation is over the memory limit and says why", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-limits-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  db.exec("CREATE TABLE node_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO node_settings VALUES('conversationMemoryLimitGb','unlimited')");
  let supervisor: Awaited<ReturnType<typeof startSupervisor>> | undefined;
  try {
    const idle = { executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: { PATH: process.env.PATH! } };
    // The worker's child holds about 300 MB that it has really written to.
    const hungry = { ...idle, args: ["-e", "const held = Buffer.alloc(300 * 1024 * 1024, 1); console.log('holding'); setInterval(() => held[0], 1000)"] };
    supervisor = await startSupervisor({
      dataDirectory: root, app: idle,
      taskLifetimeOptions: { pollMs: 50 },
      conversationLimitOptions: { pollMs: 100, memoryStrikes: 2 },
    });
    const request = (body: unknown) => requestSupervisor(supervisor!.socketPath, supervisor!.token, body);
    const hungryId = "00000000-0000-4000-8000-0000000000a1";
    const otherId = "00000000-0000-4000-8000-0000000000a2";
    await request({ action: "start", id: hungryId, name: "hungry", identity: "conversation-one", ...hungry });
    await request({ action: "start", id: otherId, name: "other", identity: "conversation-two", ...hungry });
    await delay(2500);
    assert.equal((await request({ action: "task", id: hungryId })).status, "running", "with no limit set nothing is stopped");
    // 0.2 GB: one task's 300 MB is over it, and each conversation is counted on its own.
    db.prepare("UPDATE node_settings SET value='0.2'").run();
    const deadline = Date.now() + 15_000;
    let task;
    do { task = await request({ action: "task", id: hungryId }); if (task.status === "stopped") break; await delay(50); } while (Date.now() < deadline);
    assert.equal(task.status, "stopped");
    assert.match(task.error, /^Joint Bob stopped this command: its conversation was using 0\.\d GB of memory, over the 0\.2 GB limit for one conversation/);
    const log = await readFile(path.join(root, "background-tasks", `${hungryId}.log`), "utf8");
    assert.match(log, /^holding\n\nJoint Bob stopped this command: its conversation was using/, "the command's output ends with the reason");
    do { task = await request({ action: "task", id: otherId }); if (task.status === "stopped") break; await delay(50); } while (Date.now() < deadline);
    assert.equal(task.status, "stopped", "the other conversation is over the limit as well, on its own count");
  } finally {
    await supervisor?.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
