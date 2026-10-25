import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { FileSyncDb, HOT_QUERIES, SCHEMA_VERSION } from "../src/file-sync/db.js";
import type { ConfigureArgs, ShareStatus } from "../src/file-sync/protocol.js";
import { systemClock, type Clock, type ShareKind } from "../src/file-sync/types.js";
import { createInThreadWorker, type InThreadWorker } from "../src/file-sync/worker.js";

const NODE = "node-a";

function movableClock(start = Date.now() + 3_600_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, setTimeout: () => ({ cancel() {} }), advance(ms) { now += ms; } };
}

interface Setup { dir: string; root: string; worker: InThreadWorker; clock: ReturnType<typeof movableClock>; configure(overrides?: Partial<ConfigureArgs>, share?: Record<string, unknown>): Promise<unknown> }

function setup(t: TestContext, kind: ShareKind = "project"): Setup {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-core-"));
  const root = path.join(dir, "root");
  mkdirSync(root);
  const clock = movableClock();
  let seed = 7;
  const worker = createInThreadWorker({ nodeId: NODE, dataDir: path.join(dir, "data"), clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false });
  t.after(async () => { await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  const configure = (overrides: Partial<ConfigureArgs> = {}, share: Record<string, unknown> = {}) => worker.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: `${kind}:p1`, projectId: "p1", kind, root, phase: "syncthing", rules: {}, peers: [], ...share }],
    ...overrides,
  });
  return { dir, root, worker, clock, configure };
}

function lastState(worker: InThreadWorker, share = "project:p1"): ShareStatus | undefined {
  for (let index = worker.events.length - 1; index >= 0; index--) {
    const event = worker.events[index];
    if (event.event === "shareState" && event.status.share === share) return event.status;
  }
  return undefined;
}

test("configure creates the share, reports ready once and a starting state", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.configure(), { origins: [] });
  await s.configure();
  assert.equal(s.worker.events.filter((event) => event.event === "ready").length, 1);
  const state = lastState(s.worker);
  assert.equal(state?.state, "starting");
  assert.equal(state?.phase, "syncthing");
  assert.match(state?.indexId ?? "", /^[A-Za-z0-9_-]{22}$/);
});

test("a scan through the adapter returns a plain result and reports the share idle", async (t) => {
  const s = setup(t);
  writeFileSync(path.join(s.root, "a.txt"), "hello");
  await s.configure();
  const result = await s.worker.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  assert.equal(result.share, "project:p1");
  assert.equal(result.files, 1);
  assert.equal(result.newGeneration, true);
  const [status] = await s.worker.call("status", {});
  assert.equal(status.state, "idle");
  assert.equal(status.liveFiles, 1);
  assert.equal(status.liveBytes, 5);
  assert.equal(status.maxSeq, 1);
  assert.equal(status.watch, "off");
  assert.deepEqual(lastState(s.worker), status, "the event carries the same status");
});

test("invalid arguments are refused before the core sees them", async (t) => {
  const s = setup(t);
  await s.configure();
  await assert.rejects(s.worker.call("scan", { share: "project:p1", scope: "everything" as never, reason: "x" }), (error: Error & { code?: string }) => {
    assert.match(error.message, /^Invalid request: scope/);
    assert.equal(error.code, "invalid");
    return true;
  });
});

test("network ops answer that this phase does not have them", async (t) => {
  const s = setup(t);
  await s.configure();
  for (const [op, args] of [["announce", { slept: false }], ["peerPresence", { peer: "x", present: true }], ["differences", { share: "project:p1", peer: "x", offset: 0, limit: 10 }]] as const) {
    await assert.rejects(s.worker.call(op, args as never), (error: Error & { code?: string }) => {
      assert.equal(error.code, "unavailable", `${op}: ${error.message}`);
      assert.match(error.message, /no network part/);
      return true;
    });
  }
});

test("an unknown share is a clear error", async (t) => {
  const s = setup(t);
  await s.configure();
  await assert.rejects(s.worker.call("flush", { share: "project:nope" }), /File sync share not found: project:nope/);
});

test("configure refuses a share whose key does not match it, or a relative root", async (t) => {
  const s = setup(t);
  await assert.rejects(s.configure({}, { key: "tickets:p1" }), /does not match project:p1/);
  await assert.rejects(s.configure({}, { root: "relative/root" }), /must be absolute/);
});

test("a share left out of configure keeps its rows; dropShares removes them", async (t) => {
  const s = setup(t);
  writeFileSync(path.join(s.root, "a.txt"), "a");
  await s.configure();
  await s.worker.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  await s.configure({ shares: [] });
  assert.ok(s.worker.events.some((event) => event.event === "shareRemoved" && event.share === "project:p1"));
  assert.equal(s.worker.core.db.entries("project:p1").length, 1, "transient ineligibility keeps the index");
  await s.configure();
  const [status] = await s.worker.call("status", {});
  assert.equal(status.liveFiles, 1);
  await s.configure({ shares: [], dropShares: ["project:p1"] });
  assert.equal(s.worker.core.db.share("project:p1"), undefined);
  assert.equal(s.worker.core.db.entries("project:p1").length, 0);
});

test("a rules change in configure drops what the new rules ignore at the next scan", async (t) => {
  const s = setup(t);
  writeFileSync(path.join(s.root, "keep.txt"), "k");
  writeFileSync(path.join(s.root, "secret.txt"), "s");
  await s.configure();
  await s.worker.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  await s.configure({}, { rules: { userRules: ["secret.txt"] } });
  const result = await s.worker.call("scan", { share: "project:p1", scope: { paths: [] }, reason: "test" });
  assert.equal(result.tombstones, 0);
  assert.deepEqual(s.worker.core.db.entries("project:p1").map((row) => row.path), ["keep.txt"]);
});

test("held deletes make the share an error until releaseHeld", async (t) => {
  const s = setup(t);
  for (let index = 0; index < 520; index++) writeFileSync(path.join(s.root, `f${index}.txt`), String(index));
  await s.configure();
  await s.worker.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  for (let index = 0; index < 520; index++) unlinkSync(path.join(s.root, `f${index}.txt`));
  const held = await s.worker.call("scan", { share: "project:p1", scope: "full", reason: "test" });
  assert.equal(held.held, 520);
  const [status] = await s.worker.call("status", {});
  assert.equal(status.state, "error");
  assert.equal(status.held, 520);
  assert.match(status.message ?? "", /520 deletions are held/);
  const released = await s.worker.call("releaseHeld", { share: "project:p1" });
  assert.equal(released.tombstones, 520);
  const [after] = await s.worker.call("status", {});
  assert.equal(after.state, "idle");
  assert.equal(after.held, 0);
});

test("expectDeletes through the op lets an announced worktree delete pass the guard", async (t) => {
  const s = setup(t, "worktrees");
  mkdirSync(path.join(s.root, "w1"));
  for (let index = 0; index < 520; index++) writeFileSync(path.join(s.root, "w1", `f${index}.txt`), String(index));
  await s.configure();
  await s.worker.call("scan", { share: "worktrees:p1", scope: "full", reason: "test" });
  assert.deepEqual(await s.worker.call("expectDeletes", { share: "worktrees:p1", prefix: "w1", ttlMs: 60_000 }), {});
  rmSync(path.join(s.root, "w1"), { recursive: true });
  const result = await s.worker.call("scan", { share: "worktrees:p1", scope: { paths: ["w1"] }, reason: "test" });
  assert.equal(result.tombstones, 521);
  assert.equal(result.held, 0);
});

test("errors are paged with ISO times", async (t) => {
  const s = setup(t);
  await s.configure();
  s.worker.core.db.writeTx(() => {
    s.worker.core.db.setError("project:p1", "b.txt", "error", "Cannot read (EACCES)", Date.UTC(2026, 0, 2));
    s.worker.core.db.setError("project:p1", "a.txt", "notice", "Not synced", Date.UTC(2026, 0, 1));
  });
  const page = await s.worker.call("errors", { share: "project:p1", offset: 0, limit: 1 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items, [{ path: "a.txt", kind: "notice", reason: "Not synced", at: "2026-01-01T00:00:00.000Z" }]);
});

test("flush walks the share when its last full scan is over an hour old, or only the turn's subtree", async (t) => {
  const s = setup(t, "worktrees");
  for (const tree of ["w1", "w2"]) {
    mkdirSync(path.join(s.root, tree, "src"), { recursive: true });
    writeFileSync(path.join(s.root, tree, "src", "a.ts"), tree);
  }
  await s.configure();
  const first = await s.worker.call("flush", { share: "worktrees:p1" });
  assert.equal(first.files, 6, "never scanned: a full scan");
  const quiet = await s.worker.call("flush", { share: "worktrees:p1", subtree: "w1" });
  assert.equal(quiet.files, 0, "recent and nothing pending: nothing to do");
  s.clock.advance(61 * 60_000);
  const subtree = await s.worker.call("flush", { share: "worktrees:p1", subtree: path.join(s.root, "w1") });
  assert.equal(subtree.files, 3, `only w1 is walked: ${subtree.files}`);
  const again = await s.worker.call("flush", { share: "worktrees:p1", subtree: "w1" });
  assert.equal(again.files, 0, "the subtree walk counts for the next hour");
  const whole = await s.worker.call("flush", { share: "worktrees:p1" });
  assert.equal(whole.files, 6, "without a subtree the stale share is walked whole");
});

test("at start every watched share gets its walk, a few at a time, and all of them finish", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-core-"));
  const worker = createInThreadWorker({ nodeId: NODE, dataDir: path.join(dir, "data"), clock: systemClock, random: Math.random, watch: true });
  t.after(async () => { await worker.stop(); rmSync(dir, { recursive: true, force: true }); });
  const shares = Array.from({ length: 6 }, (_, index) => {
    const root = path.join(dir, `p${index}`);
    mkdirSync(root);
    for (let file = 0; file < 40; file++) writeFileSync(path.join(root, `f${file}.txt`), `${index}/${file}`);
    return { key: `project:p${index}`, projectId: `p${index}`, kind: "project" as const, root, phase: "syncthing" as const, rules: {}, peers: [] };
  });
  await worker.call("configure", { enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] }, shares });
  const deadline = Date.now() + 30_000;
  let statuses: ShareStatus[] = [];
  while (Date.now() < deadline) {
    statuses = await worker.call("status", {});
    if (statuses.every((status) => status.state === "idle" && status.liveFiles === 40)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(statuses.map((status) => [status.share, status.state, status.liveFiles]), shares.map((share) => [share.key, "idle", 40]));
});

test("after stop, calls are refused and the database is closed", async (t) => {
  const s = setup(t);
  await s.configure();
  await s.worker.stop();
  await assert.rejects(s.worker.call("status", {}), /not running/);
});

// ---- file-sync.db ----

function dbFile(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "file-sync.db");
}

test("writeTx refuses an async callback and rolls it back", (t) => {
  const db = new FileSyncDb(dbFile(t), NODE);
  t.after(() => db.close());
  assert.throws(() => db.writeTx(async () => { db.setMeta("x", "1"); }), /must be synchronous/);
  assert.equal(db.meta("x"), undefined);
});

test("writeTx cannot be nested", (t) => {
  const db = new FileSyncDb(dbFile(t), NODE);
  t.after(() => db.close());
  assert.throws(() => db.writeTx(() => db.writeTx(() => undefined)), /cannot be nested/);
  assert.equal(db.inTransaction, false);
});

test("writes outside writeTx are refused", (t) => {
  const db = new FileSyncDb(dbFile(t), NODE);
  t.after(() => db.close());
  assert.throws(() => db.setMeta("x", "1"), /inside writeTx/);
});

test("the node clock is persisted and never goes back, even across a rebuilt index", (t) => {
  const file = dbFile(t);
  const first = new FileSyncDb(file, NODE);
  const version = first.writeTx(() => first.nextVersion({}, NODE, 1));
  first.writeTx(() => first.raiseClock({ [NODE]: 5_000_000 }, NODE));
  first.close();
  assert.equal(version[NODE], 1000, "counters are microseconds of wall time");
  // A newer release's schema: the index is rebuilt, the clock is kept.
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
  raw.exec("INSERT INTO shares(share, project_id, kind, root, index_id, digest) VALUES ('project:x', 'x', 'project', '/x', 'i', 'd')");
  raw.close();
  const second = new FileSyncDb(file, NODE);
  t.after(() => second.close());
  assert.equal(second.shares().length, 0, "the newer schema's rows are gone");
  assert.equal(second.meta("schema_version"), String(SCHEMA_VERSION));
  const next = second.writeTx(() => second.nextVersion({}, NODE, 10));
  assert.equal(next[NODE], 5_000_001, "above every counter this node issued before");
});

test("a data directory moved to another node starts a fresh index", (t) => {
  const file = dbFile(t);
  const first = new FileSyncDb(file, "node-a");
  first.writeTx(() => first.insertShare({ share: "project:x", projectId: "x", kind: "project", root: "/x", indexId: "i" }));
  first.close();
  const second = new FileSyncDb(file, "node-b");
  t.after(() => second.close());
  assert.equal(second.shares().length, 0);
  assert.equal(second.meta("node_id"), "node-b");
});

test("the per-directory and per-path queries seek instead of reading the whole share", (t) => {
  const file = dbFile(t);
  new FileSyncDb(file, NODE).close();
  const raw = new DatabaseSync(file);
  t.after(() => raw.close());
  const plan = (sql: string) => (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  const expected: Record<keyof typeof HOT_QUERIES, RegExp> = {
    entry: /^SEARCH entries USING PRIMARY KEY \(share=\? AND path=\?\)$/,
    children: /^SEARCH entries USING INDEX entries_parent \(share=\? AND parent=\?\)$/,
    descendants: /^SEARCH entries USING PRIMARY KEY \(share=\? AND path>\? AND path<\?\)$/,
    entriesSince: /^SEARCH entries USING INDEX entries_seq \(share=\? AND seq>\?\)$/,
    liveBelow: /^SEARCH entries USING PRIMARY KEY \(share=\? AND path>\? AND path<\?\)$/,
    liveInUnit: /PRIMARY KEY \(share=\? AND path=\?\).*PRIMARY KEY \(share=\? AND path>\? AND path<\?\)/,
    heldInUnit: /PRIMARY KEY \(share=\? AND path=\?\).*PRIMARY KEY \(share=\? AND path>\? AND path<\?\)/,
    anyHeldInUnit: /PRIMARY KEY \(share=\? AND path=\?\).*PRIMARY KEY \(share=\? AND path>\? AND path<\?\)/,
  };
  for (const [name, sql] of Object.entries(HOT_QUERIES) as Array<[keyof typeof HOT_QUERIES, string]>) {
    const detail = plan(sql);
    assert.match(detail, expected[name], `${name}: ${detail}`);
    assert.doesNotMatch(detail, /PRIMARY KEY \(share=\?\)(?! AND)|SCAN entries|SCAN held/, `${name} reads the whole share: ${detail}`);
  }
});

test("file-sync.db is readable by its owner only", (t) => {
  const file = dbFile(t);
  const db = new FileSyncDb(file, NODE);
  t.after(() => db.close());
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
