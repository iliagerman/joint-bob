import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createWorkerCore } from "../src/file-sync/core.js";
import type { CoreEvent, ShareStatus } from "../src/file-sync/protocol.js";
import { systemClock, type Clock } from "../src/file-sync/types.js";
import { BurstMonitor, inotifyBurstLimit, ShareWatcher, SuppressionRegistry, type WatchBatch, type WatchState } from "../src/file-sync/watch.js";

function manualClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const clock: Clock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(run, ms) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at);
        next.cancelled = true;
        next.run();
      }
      now = end;
    },
  };
  return clock;
}

class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void { this.closed = true; }
}

interface Harness {
  watcher: ShareWatcher;
  batches: WatchBatch[];
  states: Array<{ state: WatchState; message?: string }>;
  clock: ReturnType<typeof manualClock>;
  opened: Array<{ target: string; options: unknown; fake: FakeWatcher }>;
}

function harness(options: { mode?: "recursive" | "directories"; ignored?: (key: string) => boolean; root?: string; burst?: BurstMonitor; clock?: ReturnType<typeof manualClock>; fail?: (target: string) => NodeJS.ErrnoException | undefined; suppression?: SuppressionRegistry } = {}): Harness {
  const clock = options.clock ?? manualClock();
  const batches: WatchBatch[] = [];
  const states: Array<{ state: WatchState; message?: string }> = [];
  const opened: Harness["opened"] = [];
  const watcher = new ShareWatcher({
    key: "project:p1",
    root: options.root ?? "/nowhere",
    clock,
    mode: options.mode ?? "recursive",
    ignored: options.ignored ?? ((key) => key.split("/").includes("node_modules")),
    suppression: options.suppression ?? new SuppressionRegistry(clock),
    burst: options.burst ?? new BurstMonitor(null, clock),
    onBatch: (batch) => batches.push(batch),
    onState: (state, message) => states.push({ state, message }),
    watch: ((target: string, watchOptions: unknown) => {
      const failure = options.fail?.(String(target));
      if (failure) throw failure;
      const fake = new FakeWatcher();
      opened.push({ target: String(target), options: watchOptions, fake });
      return fake;
    }) as never,
  });
  return { watcher, batches, states, clock, opened };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("a batch arrives 1 s after the last event", () => {
  const h = harness();
  h.watcher.start();
  h.watcher.handle("change", "a.txt");
  h.clock.advance(600);
  h.watcher.handle("change", "b.txt");
  h.clock.advance(900);
  assert.equal(h.batches.length, 0, "still within a second of the last event");
  h.clock.advance(150);
  assert.equal(h.batches.length, 1);
  assert.deepEqual(h.batches[0].paths.sort(), ["a.txt", "b.txt"]);
  assert.equal(h.batches[0].full, false);
});

test("a steady stream of events is delivered 5 s after the first one", () => {
  const h = harness();
  h.watcher.start();
  for (let at = 0; at < 7000; at += 500) {
    h.watcher.handle("change", `f${at}.txt`);
    h.clock.advance(500);
    if (at < 4500) assert.equal(h.batches.length, 0, `delivered early at ${at} ms`);
  }
  assert.ok(h.batches.length >= 1, "never delivered while events kept coming");
  assert.ok(h.batches[0].paths.length >= 9 && h.batches[0].paths.length <= 11, `first batch: ${h.batches[0].paths.length} paths`);
});

test("watchers are opened non-persistent so they never keep the process alive", () => {
  const recursive = harness({ mode: "recursive" });
  recursive.watcher.start();
  assert.deepEqual(recursive.opened[0].options, { recursive: true, persistent: false });
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-fs-watch-"));
  try {
    const directories = harness({ mode: "directories", root });
    directories.watcher.start();
    directories.watcher.watchDirectory("src", "src", 42);
    assert.deepEqual(directories.opened.map((entry) => entry.options), [{ persistent: false }, { persistent: false }]);
    assert.deepEqual(directories.opened.map((entry) => entry.target), [root, path.join(root, "src")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignored paths are dropped before they count", () => {
  const h = harness();
  h.watcher.start();
  for (let index = 0; index < 6000; index++) h.watcher.handle("change", `node_modules/pkg/${index}.js`);
  h.clock.advance(2000);
  assert.equal(h.batches.length, 0);
  assert.equal(h.watcher.state, "watching", "ignored events must not degrade the share");
});

test("a rename event lists its parent folder", () => {
  const h = harness();
  h.watcher.start();
  h.watcher.handle("rename", "src/new.ts");
  h.watcher.handle("change", "docs/a.md");
  h.clock.advance(1000);
  assert.deepEqual(h.batches[0].shallow, ["src"]);
  assert.deepEqual(h.batches[0].paths.sort(), ["docs/a.md", "src/new.ts"]);
});

test("more than 100 events in one folder become one listing of it", () => {
  const h = harness();
  h.watcher.start();
  for (let index = 0; index < 150; index++) h.watcher.handle("change", `gen/${index}.txt`);
  h.watcher.handle("change", "other.txt");
  h.clock.advance(1000);
  assert.deepEqual(h.batches[0].shallow, ["gen"]);
  assert.deepEqual(h.batches[0].paths, ["other.txt"]);
});

test("too many events degrade the share; it comes back after a backoff with a full scan", () => {
  const h = harness();
  h.watcher.start();
  for (let index = 0; index < 5001; index++) h.watcher.handle("change", `d${index % 50}/f${index}.txt`);
  assert.equal(h.watcher.state, "degraded");
  assert.equal(h.opened[0].fake.closed, true, "a degraded share stops watching");
  assert.equal(h.batches.length, 0, "the pending paths are dropped: the full scan covers them");
  h.clock.advance(14_999);
  assert.equal(h.watcher.state, "degraded");
  h.clock.advance(1);
  assert.equal(h.watcher.state, "watching");
  assert.deepEqual(h.batches, [{ paths: [], shallow: [], full: true }]);
  for (let index = 0; index < 5001; index++) h.watcher.handle("change", `again/f${index}.txt`);
  h.clock.advance(15_000);
  assert.equal(h.watcher.state, "degraded", "the second backoff is longer");
  h.clock.advance(15_000);
  assert.equal(h.watcher.state, "watching");
});

test("a worker-wide burst near the inotify queue size degrades every share that had events", () => {
  const clock = manualClock();
  const burst = new BurstMonitor(100, clock);
  const one = harness({ clock, burst });
  const two = harness({ clock, burst });
  const quiet = harness({ clock, burst });
  for (const h of [one, two, quiet]) h.watcher.start();
  for (let index = 0; index < 60; index++) { one.watcher.handle("change", `a${index}`); two.watcher.handle("change", `b${index}`); }
  assert.equal(one.watcher.state, "degraded");
  assert.equal(two.watcher.state, "degraded");
  assert.equal(quiet.watcher.state, "watching");
  assert.match(one.states.at(-1)?.message ?? "", /inotify/);
});

test("the burst limit is half of the kernel's inotify queue on Linux only", () => {
  assert.equal(inotifyBurstLimit("linux", () => "16384\n"), 8192);
  assert.equal(inotifyBurstLimit("linux", () => { throw new Error("no /proc"); }), 8192);
  assert.equal(inotifyBurstLimit("darwin", () => "16384"), null);
});

test("the engine's own writes are suppressed without counting", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-fs-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = manualClock(Date.now());
  const suppression = new SuppressionRegistry(clock);
  const h = harness({ root, clock, suppression });
  h.watcher.start();
  writeFileSync(path.join(root, "applied.txt"), "from a peer");
  const stat = lstatSync(path.join(root, "applied.txt"));
  suppression.add("project:p1", "applied.txt", { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  h.watcher.handle("rename", "applied.txt");
  h.watcher.handle("change", "applied.txt");
  h.clock.advance(2000);
  assert.equal(h.batches.length, 0, "matching fingerprints are the engine's own write");
  writeFileSync(path.join(root, "applied.txt"), "edited by a person afterwards");
  h.watcher.handle("change", "applied.txt");
  h.clock.advance(1000);
  assert.deepEqual(h.batches[0]?.paths, ["applied.txt"]);
});

test("a suppressed delete matches only while the path is absent, and entries expire", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jb-fs-watch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = manualClock(Date.now());
  const suppression = new SuppressionRegistry(clock);
  suppression.add("s", "gone.txt", null, 1000);
  assert.equal(suppression.matches("s", "gone.txt", () => null), true);
  assert.equal(suppression.matches("s", "gone.txt", () => lstatSync(root)), false);
  clock.advance(1000);
  assert.equal(suppression.matches("s", "gone.txt", () => null), false, "expired");
});

test("running out of inotify watches degrades the share with a clear message", () => {
  const h = harness({ mode: "directories", root: os.tmpdir(), fail: (target) => target.endsWith("deep") ? errno("ENOSPC") : undefined });
  h.watcher.start();
  h.watcher.watchDirectory("deep", "deep", 7);
  assert.equal(h.watcher.state, "degraded");
  assert.match(h.states.at(-1)?.message ?? "", /max_user_watches/);
});

test("a watched folder that disappears only ends its own watch", () => {
  const h = harness({ mode: "directories", root: os.tmpdir() });
  h.watcher.start();
  h.watcher.watchDirectory("a", "a", 1);
  h.watcher.watchDirectory("a/b", "a/b", 2);
  h.watcher.watchDirectory("c", "c", 3);
  h.opened[1].fake.emit("error", errno("ENOENT"));
  assert.equal(h.watcher.state, "watching");
  assert.equal(h.opened[1].fake.closed, true);
  assert.equal(h.opened[2].fake.closed, true, "watches below it go too");
  assert.equal(h.opened[3].fake.closed, false);
  assert.equal(h.watcher.watchedDirectories, 2);
});

test("a replaced folder (new inode) is watched again", () => {
  const h = harness({ mode: "directories", root: os.tmpdir() });
  h.watcher.start();
  h.watcher.watchDirectory("a", "a", 1);
  h.watcher.watchDirectory("a", "a", 1);
  assert.equal(h.opened.length, 2, "the same folder is watched once");
  h.watcher.watchDirectory("a", "a", 9);
  assert.equal(h.opened.length, 3);
  assert.equal(h.opened[1].fake.closed, true);
});

test("a missing root leaves the watcher off instead of backing off", () => {
  const h = harness({ fail: () => errno("ENOENT") });
  h.watcher.start();
  assert.equal(h.watcher.state, "off");
  assert.equal(h.states.at(-1)?.message, "The folder is missing");
});

test("flush takes what is pending at once", () => {
  const h = harness();
  h.watcher.start();
  h.watcher.handle("change", "a.txt");
  const batch = h.watcher.takeDirty();
  assert.deepEqual(batch?.paths, ["a.txt"]);
  h.clock.advance(5000);
  assert.equal(h.batches.length, 0, "the debounce timer was cancelled");
  assert.equal(h.watcher.takeDirty(), null);
});

// ---- the real watcher through the core ----

interface Live { root: string; events: CoreEvent[]; close(): Promise<void>; core: ReturnType<typeof createWorkerCore> }

async function liveCore(t: TestContext): Promise<Live> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-live-"));
  const root = path.join(dir, "root");
  mkdirSync(root);
  writeFileSync(path.join(root, "first.txt"), "first");
  const events: CoreEvent[] = [];
  const core = createWorkerCore({ nodeId: "node-a", dataDir: path.join(dir, "data"), clock: systemClock, random: Math.random, watch: true, emit: (event) => events.push(event) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await core.close(); } };
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  await core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: "project:p1", projectId: "p1", kind: "project", root, phase: "syncthing", rules: {}, peers: [] }],
  });
  await waitFor(events, (status) => status.liveFiles === 1 && status.state === "idle", 10_000);
  return { root, events, close, core };
}

async function waitFor(events: CoreEvent[], match: (status: ShareStatus) => boolean, timeoutMs: number): Promise<ShareStatus> {
  const started = Date.now();
  for (;;) {
    const found = [...events].reverse().find((event) => event.event === "shareState" && match(event.status));
    if (found && found.event === "shareState") return found.status;
    if (Date.now() - started > timeoutMs) throw new Error(`No matching share state within ${timeoutMs} ms; last: ${JSON.stringify([...events].reverse().find((event) => event.event === "shareState"))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Scans the watcher asked for (settle re-checks of just-written files have their own reason). */
function scans(events: CoreEvent[]): number {
  return events.filter((event) => event.event === "metric" && event.operation === "fileSync.scan" && event.fields?.reason === "watch").length;
}

test("a file written in a watched share is indexed within the debounce", async (t) => {
  const live = await liveCore(t);
  const started = Date.now();
  mkdirSync(path.join(live.root, "nested", "deeper"), { recursive: true });
  writeFileSync(path.join(live.root, "nested", "deeper", "new.txt"), "hello");
  const status = await waitFor(live.events, (candidate) => candidate.liveFiles === 2, 8000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6000, `took ${elapsed} ms`);
  assert.equal(status.watch, "watching");
});

test("writes inside ignored folders start no scan", async (t) => {
  const live = await liveCore(t);
  mkdirSync(path.join(live.root, "node_modules", "pkg"), { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const before = scans(live.events);
  for (let index = 0; index < 20; index++) writeFileSync(path.join(live.root, "node_modules", "pkg", `${index}.js`), String(index));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(scans(live.events), before, "an event under node_modules reached the scanner");
});

test("a core whose watchers were never closed lets the process exit", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-exit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "root", "sub"), { recursive: true });
  writeFileSync(path.join(dir, "root", "sub", "a.txt"), "a");
  const script = path.join(dir, "child.mts");
  writeFileSync(script, `
    import { createWorkerCore } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/file-sync/core.ts")).href)};
    import { systemClock } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/file-sync/types.ts")).href)};
    const core = createWorkerCore({ nodeId: "node-a", dataDir: ${JSON.stringify(path.join(dir, "data"))}, clock: systemClock, random: Math.random, watch: true, emit: () => undefined });
    await core.call("configure", { enabled: true, hostId: "h", peers: [], records: { engines: [], settings: [] },
      shares: [{ key: "project:p1", projectId: "p1", kind: "project", root: ${JSON.stringify(path.join(dir, "root"))}, phase: "syncthing", rules: {}, peers: [] }] });
    const result = await core.call("flush", { share: "project:p1" });
    console.log("scanned", result.files);
  `);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), script], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number | string>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 30 s"); }, 30_000);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode ?? "signal"); });
  });
  assert.equal(code, 0, output);
  assert.match(output, /scanned 2/);
});

test("the worker thread answers ops, sends events and ends after stop", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-thread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "root"));
  writeFileSync(path.join(dir, "root", "a.txt"), "a");
  // As bridge.ts does: before Node 22.23 (the homeserver runs 22.21.1) `execArgv: ["--import", tsx]` is not in place when a worker's entry resolves.
  const entry = new URL("../src/file-sync/worker.ts", import.meta.url);
  const worker = new Worker(`import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}).then(({ register }) => { register(); return import(${JSON.stringify(entry.href)}); });`, {
    eval: true,
    workerData: { nodeId: "node-a", dataDir: path.join(dir, "data"), watch: true },
  });
  worker.unref();
  // A failed assertion must not leave the thread (and its watchers) keeping this process alive.
  t.after(() => worker.terminate());
  const answers = new Map<number, { ok: boolean; result?: unknown; error?: { message: string } }>();
  const events: CoreEvent[] = [];
  worker.on("message", (message) => {
    if (typeof message?.id === "number") answers.set(message.id, message);
    else events.push(message);
  });
  const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
  const ask = async (id: number, op: string, args: unknown) => {
    worker.postMessage({ id, op, args });
    for (let waited = 0; !answers.has(id); waited += 20) {
      if (waited > 20_000) throw new Error(`no answer to ${op}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return answers.get(id)!;
  };
  const configured = await ask(1, "configure", {
    enabled: true, hostId: "h", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: "project:p1", projectId: "p1", kind: "project", root: path.join(dir, "root"), phase: "syncthing", rules: {}, peers: [] }],
  });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  const scanned = await ask(2, "scan", { share: "project:p1", scope: "full", reason: "test" });
  assert.equal(scanned.ok, true, JSON.stringify(scanned));
  assert.equal((scanned.result as { files: number }).files, 1);
  const invalid = await ask(3, "scan", { share: "project:p1", scope: "everything", reason: "test" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error!.message, /Invalid request/);
  // The thread brings its network layer: announce answers (no peers to ask); a later phase's op does not.
  const network = await ask(4, "announce", { slept: false });
  assert.equal(network.ok, true, JSON.stringify(network));
  const later = await ask(6, "prioritize", { share: "project:p1", untilMs: 1000 });
  assert.equal(later.ok, false);
  assert.match(later.error!.message, /cannot prioritize yet/);
  assert.ok(events.some((event) => event.event === "ready"), "ready is sent after the first configure");
  assert.ok(events.some((event) => event.event === "shareState" && event.status.liveFiles === 1));
  const stopped = await ask(5, "stop", {});
  assert.equal(stopped.ok, true);
  const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 10_000).unref())]);
  assert.equal(code, 0, "the thread ends by itself once stopped (watchers closed, database closed)");
});
