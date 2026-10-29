import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileSyncDb, type LocalEntry } from "../src/file-sync/db.js";
import { mergeIdentical, NeedEngine, needPriority, isWorktreeBulk, supersedes, type NeedShare } from "../src/file-sync/need.js";
import { DIRECTORY, FILE, type Clock, type IndexEntry, type ShareKind } from "../src/file-sync/types.js";
import { canonicalVector } from "../src/file-sync/vectors.js";
import type { IndexPage } from "../src/file-sync/wire.js";

const SHARE = "project:p1";
const SHA_X = "a".repeat(64);
const SHA_Y = "b".repeat(64);

function entry(fields: Partial<IndexEntry>): IndexEntry {
  return { path: "f.txt", type: FILE, size: 1, mtimeMs: 1_000, mode: 0o644, sha256: SHA_X, target: null, deleted: false, version: {}, modifiedBy: "node-a", seq: 1, ...fields };
}

test("identical content merges into one version and one producer, whichever node decides", () => {
  const onA = entry({ version: { "node-a": 10 }, modifiedBy: "node-a", mtimeMs: 5_000, seq: 3 });
  const onB = entry({ version: { "node-b": 20 }, modifiedBy: "node-b", mtimeMs: 5_000, seq: 7 });
  const fromA = mergeIdentical(onA, [onB])!;
  const fromB = mergeIdentical(onB, [onA])!;
  assert.equal(canonicalVector(fromA.version), canonicalVector(fromB.version));
  assert.deepEqual([fromA.mtimeMs, fromA.modifiedBy], [fromB.mtimeMs, fromB.modifiedBy], "conflict copies of this version get one name everywhere");
  // The node whose tuple won keeps it; once both hold the merged row nothing moves again.
  const settledA = { ...onA, ...fromA };
  const settledB = { ...onB, ...fromB };
  assert.equal(mergeIdentical(settledA, [settledB]), undefined);
  assert.equal(mergeIdentical(settledB, [settledA]), undefined);
  // A version that dominates gives its producer to every copy of the same content.
  const later = entry({ version: { "node-a": 10, "node-b": 20, "node-c": 30 }, modifiedBy: "node-c", mtimeMs: 1_000 });
  assert.deepEqual(mergeIdentical(settledA, [later]), { version: later.version, mtimeMs: 1_000, modifiedBy: "node-c" });
  // Other content and other modes never count.
  assert.equal(mergeIdentical(onA, [entry({ sha256: SHA_Y, version: { "node-b": 20 } }), entry({ mode: 0o755, version: { "node-b": 20 } })]), undefined);
});

test("identical deletions merge although a third, live version wins over both", () => {
  const base = { "node-a": 1, "node-b": 1, "node-c": 1 };
  const live = entry({ sha256: SHA_Y, version: { ...base, "node-c": 50 }, modifiedBy: "node-c", mtimeMs: 9_000 });
  const deletedOnA = entry({ deleted: true, version: { ...base, "node-a": 40 }, modifiedBy: "node-a", mtimeMs: 7_000 });
  const deletedOnB = entry({ deleted: true, version: { ...base, "node-b": 30 }, modifiedBy: "node-b", mtimeMs: 8_000 });
  const onA = mergeIdentical(deletedOnA, [deletedOnB, live])!;
  const onB = mergeIdentical(deletedOnB, [deletedOnA, live])!;
  assert.equal(canonicalVector(onA.version), canonicalVector({ ...base, "node-a": 40, "node-b": 30 }));
  assert.equal(canonicalVector(onA.version), canonicalVector(onB.version), "merged now, so the live version leaving later changes nothing");
  assert.deepEqual([onA.mtimeMs, onA.modifiedBy], [onB.mtimeMs, onB.modifiedBy]);
  // Directories are content too.
  const dirA = entry({ type: DIRECTORY, sha256: null, size: 0, mode: 0o755, version: { "node-a": 2 } });
  const dirB = entry({ type: DIRECTORY, sha256: null, size: 0, mode: 0o755, version: { "node-b": 3 }, modifiedBy: "node-b" });
  assert.equal(canonicalVector(mergeIdentical(dirA, [dirB])!.version), canonicalVector({ "node-a": 2, "node-b": 3 }));
});

function engine(t: TestContext, hooks: { yieldNow?(): Promise<void> } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-need-"));
  const db = new FileSyncDb(path.join(dir, "file-sync.db"), "node-b");
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.writeTx(() => db.insertShare({ share: SHARE, projectId: "p1", kind: "project", root: dir, indexId: "gen1" }));
  const state = { served: true };
  const share: NeedShare = { key: SHARE, phase: "syncthing", rulesHash: "h", peers: () => ["node-a"], ignored: () => false };
  const need = new NeedEngine({
    db, nodeId: "node-b", clock: { now: () => Date.now(), setTimeout: () => ({ cancel() {} }) }, settleMs: 1000,
    share: (key) => state.served && key === SHARE ? share : undefined,
    localChanged: () => {}, comparisonChanged: () => {},
    // Every few rows is a slice of its own, so the page spans many.
    sliceMs: () => 0, yieldNow: hooks.yieldNow,
  });
  t.after(() => need.close());
  return { db, need, state, dir };
}

function page(count: number): IndexPage {
  const entries = Array.from({ length: count }, (_, index) => entry({ path: `f${String(index).padStart(4, "0")}.txt`, seq: index + 1, version: { "node-a": index + 1 } }));
  return { indexId: "peer-gen", maxSeq: count, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null, entries, more: false };
}

test("a page is stored in time slices and abandoned when the share is dropped between two of them", async (t) => {
  let yields = 0;
  const holder: { drop?: () => void } = {};
  const { db, need, state, dir } = engine(t, { yieldNow: async () => { if (++yields === 1) holder.drop?.(); await new Promise((resolve) => setImmediate(resolve)); } });
  holder.drop = () => { db.writeTx(() => db.deleteShare(SHARE)); state.served = false; };
  const result = await need.storeRemote(SHARE, "node-a", 0, page(200));
  assert.equal(result.restart, true, "the rest of the page must not land in a dropped share");
  assert.ok(result.stored > 0 && result.stored < 200, `stored ${result.stored} before the drop`);
  assert.equal(db.cursor(SHARE, "node-a"), undefined, "no cursor claims a whole index");
  assert.equal(db.remoteCount(SHARE, "node-a"), 0);
  // A share added again starts with nothing of the old one, even rows something wrote after the drop.
  db.writeTx(() => { db.putRemote(SHARE, "node-a", entry({ path: "left-over.txt" })); db.updateCursor(SHARE, "node-a", { indexId: "peer-gen", seq: 200, listed: true }, Date.now()); });
  db.writeTx(() => db.insertShare({ share: SHARE, projectId: "p1", kind: "project", root: dir, indexId: "gen2" }));
  assert.equal(db.remoteCount(SHARE, "node-a"), 0);
  assert.equal(db.cursor(SHARE, "node-a"), undefined);
});

test("an undisturbed page spanning many slices is stored whole", async (t) => {
  let yields = 0;
  const { db, need } = engine(t, { yieldNow: async () => { yields++; await new Promise((resolve) => setImmediate(resolve)); } });
  const result = await need.storeRemote(SHARE, "node-a", 0, page(200));
  assert.deepEqual([result.restart, result.stored, result.cursor], [false, 200, 200]);
  assert.ok(yields > 1, `took ${yields + 1} slices`);
  assert.equal(db.remoteCount(SHARE, "node-a"), 200);
  const cursor = db.cursor(SHARE, "node-a")!;
  assert.deepEqual([cursor.indexId, cursor.seq, cursor.listed], ["peer-gen", 200, true]);
});

// ---- the need queue (builtin phase, §5.4) ----

const SHA_Z = "c".repeat(64);
const SHA_W = "d".repeat(64);

/** A fake clock whose one-shot timers fire when it is advanced. */
function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    setTimeout(run, ms) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    advance(ms) {
      now += ms;
      for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.cancelled) continue;
        if (timer.at <= now) timer.run(); else timers.push(timer);
      }
    },
  };
}

interface Queue {
  db: FileSyncDb;
  need: NeedEngine;
  clock: ReturnType<typeof fakeClock>;
  state: { phase: NeedShare["phase"]; peers: string[]; ignored: Set<string>; available: boolean };
  /** Stores rows as the next page of `peer`'s index. */
  pull(peer: string, entries: Array<Partial<IndexEntry>>): Promise<void>;
  /** A local row, as a scan writes it (need moves in the same transaction). */
  local(fields: Partial<IndexEntry>): LocalEntry;
  changed: string[];
}

function queue(t: TestContext, options: { kind?: ShareKind; phase?: NeedShare["phase"]; peers?: string[] } = {}): Queue {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-queue-"));
  const db = new FileSyncDb(path.join(dir, "file-sync.db"), "node-b");
  const clock = fakeClock();
  t.after(() => { need.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const kind = options.kind ?? "project";
  const key = `${kind}:p1`;
  db.writeTx(() => {
    db.insertShare({ share: key, projectId: "p1", kind, root: dir, indexId: "gen1" });
    // A complete local index under the current rules: need rows are kept from the start.
    db.updateShare(key, { fullScanAt: 1, rulesHash: "h" });
  });
  const state = { phase: options.phase ?? "builtin" as NeedShare["phase"], peers: options.peers ?? ["p1", "p2", "p3"], ignored: new Set<string>(), available: true };
  const share = (): NeedShare => ({
    key, phase: state.phase, rulesHash: "h", kind, peers: () => state.peers, available: () => state.available,
    ignored: (relative) => [...state.ignored].some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`)),
  });
  const changed: string[] = [];
  const need: NeedEngine = new NeedEngine({
    db, nodeId: "node-b", clock, settleMs: 1000, share: (wanted) => wanted === key ? share() : undefined,
    localChanged: () => {}, comparisonChanged: () => {}, needChanged: (changedKey) => changed.push(changedKey),
  });
  need.syncNeed(key);
  const seqs = new Map<string, number>();
  return {
    db, need, clock, state, changed,
    async pull(peer, entries) {
      const since = db.cursor(key, peer)?.seq ?? 0;
      let seq = seqs.get(peer) ?? 0;
      const rows = entries.map((fields) => entry({ ...fields, seq: ++seq }));
      seqs.set(peer, seq);
      await need.storeRemote(key, peer, since, { indexId: `${peer}-gen`, maxSeq: seq, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null, entries: rows, more: false });
    },
    local(fields) {
      return db.writeTx(() => {
        const row = db.share(key)!;
        const base = entry(fields);
        const next: LocalEntry = { ...base, fsName: null, ino: 7, ctimeMs: 1, fsMtimeMs: base.mtimeMs, deletedAt: base.deleted ? 1 : null, seq: row.maxSeq + 1 };
        const before = db.entry(key, next.path);
        db.putEntry(key, next);
        db.updateShare(key, { maxSeq: next.seq });
        need.localChangesInTx(key, [{ path: next.path, after: next }]);
        void before;
        return next;
      });
    },
  };
}

const KEY = "project:p1";

test("the need row holds the one global target: three peers and the decideGlobal counterexample", async (t) => {
  const q = queue(t);
  // L was edited into A by b; c made B independently: mtimes rank L > B > A, dominance says A > L (conflicts tests).
  q.local({ version: { a: 10 }, modifiedBy: "a", mtimeMs: 300, sha256: SHA_X });
  await q.pull("p1", [{ version: { a: 10, b: 20 }, modifiedBy: "b", mtimeMs: 100, sha256: SHA_Y }]);
  await q.pull("p2", [{ version: { c: 15 }, modifiedBy: "c", mtimeMs: 200, sha256: SHA_Z }]);
  await q.pull("p3", [{ version: { a: 10, b: 20 }, modifiedBy: "b", mtimeMs: 100, sha256: SHA_Y }]);
  const row = q.db.needRow(KEY, "f.txt")!;
  assert.equal(canonicalVector(row.target.version), canonicalVector({ c: 15 }));
  assert.deepEqual([row.action, row.conflict, row.target.sha256, row.target.modifiedBy, row.target.mtimeMs, row.target.seq], ["fetch", false, SHA_Z, "c", 200, 0],
    "L was already replaced by A: history, not a conflict; the full target (version, producer, mtime) is stored");
  const { items } = q.need.nextNeeds({ limit: 10 });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].path, items[0].action, items[0].sources, items[0].localSources, items[0].priority, items[0].size], ["f.txt", "fetch", ["p2"], [], 2, 1]);
  // Where the local version is A (nobody's history), the same rows make it a conflict copy.
  q.local({ path: "g.txt", version: { a: 10, b: 20 }, modifiedBy: "b", mtimeMs: 100, sha256: SHA_Y });
  await q.pull("p1", [{ path: "g.txt", version: { a: 10 }, modifiedBy: "a", mtimeMs: 300, sha256: SHA_X }]);
  await q.pull("p2", [{ path: "g.txt", version: { c: 15 }, modifiedBy: "c", mtimeMs: 200, sha256: SHA_Z }]);
  assert.deepEqual([q.db.needRow(KEY, "g.txt")?.action, q.db.needRow(KEY, "g.txt")?.conflict], ["fetch", true]);
});

test("a stored target moves only forward; the set's winner replaces a pairwise winner; a forced recompute takes the rows as they are", async (t) => {
  const q = queue(t);
  await q.pull("p2", [{ version: { p1: 5 }, modifiedBy: "p1", sha256: SHA_X }]);
  await q.pull("p1", [{ version: { p1: 9 }, modifiedBy: "p1", sha256: SHA_Y }]);
  assert.equal(canonicalVector(q.db.needRow(KEY, "f.txt")!.target.version), canonicalVector({ p1: 9 }));
  // p1's rows go (an index reset): what is left is older, and the stored target stays.
  q.need.resetPeer(KEY, "p1");
  q.need.reconcilePaths(KEY, ["f.txt"]);
  assert.equal(canonicalVector(q.need.derive(KEY, "f.txt")!.target!.version), canonicalVector({ p1: 5 }));
  assert.equal(canonicalVector(q.db.needRow(KEY, "f.txt")!.target.version), canonicalVector({ p1: 9 }), "a partial view never moves the target back");
  assert.equal(supersedes(entry({ version: { p1: 5 } }), entry({ version: { p1: 9 } })), false);
  // Rules, peers or a whole listing changed: the rows as stored decide.
  q.need.recomputeNeed(KEY);
  await q.need.idle();
  assert.equal(canonicalVector(q.db.needRow(KEY, "f.txt")!.target.version), canonicalVector({ p1: 5 }));

  // T1 is dominated by X, and Y wins among the undominated: Y replaces T1 although T1 beats Y pairwise (newer mtime).
  await q.pull("p1", [{ path: "h.txt", version: { a: 5 }, modifiedBy: "a", mtimeMs: 500, sha256: SHA_Y }]);
  assert.equal(canonicalVector(q.db.needRow(KEY, "h.txt")!.target.version), canonicalVector({ a: 5 }));
  await q.pull("p3", [{ path: "h.txt", version: { a: 5, c: 1 }, modifiedBy: "c", mtimeMs: 100, sha256: SHA_Z }]);
  await q.pull("p2", [{ path: "h.txt", version: { b: 7 }, modifiedBy: "b", mtimeMs: 300, sha256: SHA_W }]);
  const derived = q.need.derive(KEY, "h.txt")!;
  assert.equal(canonicalVector(derived.target!.version), canonicalVector({ b: 7 }));
  assert.equal(canonicalVector(q.db.needRow(KEY, "h.txt")!.target.version), canonicalVector({ b: 7 }), "apply must be able to re-derive the stored target");
});

test("a delete and a create of the same content pair into one move, whichever arrives first; the delete is never handed out alone", async (t) => {
  const q = queue(t);
  q.local({ path: "old.txt", version: { "node-b": 1 }, modifiedBy: "node-b", sha256: SHA_X });
  q.local({ path: "keep.txt", version: { "node-b": 1 }, modifiedBy: "node-b", sha256: SHA_Y });
  await q.pull("p1", [{ path: "new.txt", version: { p1: 3 }, modifiedBy: "p1", sha256: SHA_X }]);
  await q.pull("p1", [{ path: "old.txt", deleted: true, version: { "node-b": 1, p1: 4 }, modifiedBy: "p1", sha256: SHA_X }]);
  assert.deepEqual([q.db.needRow(KEY, "new.txt")?.action, q.db.needRow(KEY, "new.txt")?.fromPath], ["move", "old.txt"]);
  assert.equal(q.db.needRow(KEY, "old.txt")?.action, "delete");
  let { items } = q.need.nextNeeds({ limit: 10 });
  assert.deepEqual(items.map((item) => [item.path, item.action, item.fromPath]), [["new.txt", "move", "old.txt"]], "the delete waits for the create that wants its bytes");
  ({ items } = q.need.nextNeeds({ limit: 10, inFlight: [`${KEY}\nnew.txt`] }));
  assert.deepEqual(items, [], "in flight: nothing, and still not the delete");
  // The other order: delete first, then the create.
  await q.pull("p2", [{ path: "keep.txt", deleted: true, version: { "node-b": 1, p2: 5 }, modifiedBy: "p2", sha256: SHA_Y }]);
  await q.pull("p2", [{ path: "dir/kept.txt", version: { p2: 6 }, modifiedBy: "p2", sha256: SHA_Y }]);
  assert.deepEqual([q.db.needRow(KEY, "dir/kept.txt")?.action, q.db.needRow(KEY, "dir/kept.txt")?.fromPath], ["move", "keep.txt"]);
  // The source is edited here: its delete loses (a modification beats a delete), the move becomes a plain fetch.
  q.local({ path: "keep.txt", version: { "node-b": 9 }, modifiedBy: "node-b", sha256: SHA_W, mtimeMs: 9_000 });
  assert.equal(q.db.needRow(KEY, "keep.txt"), undefined);
  assert.deepEqual([q.db.needRow(KEY, "dir/kept.txt")?.action, q.db.needRow(KEY, "dir/kept.txt")?.fromPath], ["fetch", null]);
});

test("creates and updates go smallest first, then deletes deepest first", async (t) => {
  const q = queue(t, { peers: ["p1"] });
  for (const [where, type] of [["a", DIRECTORY], ["a/b", DIRECTORY], ["a/b/c.txt", FILE], ["a/z.txt", FILE]] as const) {
    q.local({ path: where, type, sha256: type === FILE ? SHA_X : null, size: type === FILE ? 1 : 0, version: { "node-b": 1 }, modifiedBy: "node-b" });
  }
  await q.pull("p1", [
    { path: "a/b/c.txt", deleted: true, version: { "node-b": 1, p1: 2 }, modifiedBy: "p1" },
    { path: "a", type: DIRECTORY, sha256: null, size: 0, deleted: true, version: { "node-b": 1, p1: 2 }, modifiedBy: "p1" },
    { path: "a/b", type: DIRECTORY, sha256: null, size: 0, deleted: true, version: { "node-b": 1, p1: 2 }, modifiedBy: "p1" },
    { path: "a/z.txt", deleted: true, version: { "node-b": 1, p1: 2 }, modifiedBy: "p1" },
    { path: "big.txt", size: 10, sha256: SHA_Y, version: { p1: 3 }, modifiedBy: "p1" },
    { path: "small.txt", size: 5, sha256: SHA_Z, version: { p1: 3 }, modifiedBy: "p1" },
  ]);
  const { items } = q.need.nextNeeds({ limit: 10 });
  assert.deepEqual(items.map((item) => item.path), ["small.txt", "big.txt", "a/b/c.txt", "a/b", "a/z.txt", "a"]);
  assert.deepEqual(items.map((item) => item.action), ["fetch", "fetch", "delete", "delete", "delete", "delete"]);
  // A peer that cannot be reached right now: its content waits, deletes need no peer.
  assert.deepEqual(q.need.nextNeeds({ limit: 10, availablePeers: [] }).items.map((item) => item.path), ["a/b/c.txt", "a/b", "a/z.txt", "a"]);
  assert.deepEqual(q.need.nextNeeds({ limit: 3 }).items.map((item) => item.path), ["small.txt", "big.txt", "a/b/c.txt"]);
});

test("priorities: worktree metadata and small files, project, tickets, worktree bulk, baselines; prioritize until it expires", async (t) => {
  assert.equal(needPriority("worktrees", "wt/.joint-bob-worktree/meta.json", 900_000), 1);
  assert.equal(needPriority("worktrees", "wt/src/a.ts", 100), 1);
  assert.equal(needPriority("worktrees", "wt/assets/big.bin", 64 * 1024), 4);
  assert.equal(needPriority("worktrees", "wt/.joint-bob-baseline/a.ts", 10), 5);
  assert.equal(needPriority("worktrees", ".joint-bob-baseline-2/a", 10), 5);
  assert.equal(needPriority("project", "src/a.ts", 10_000_000), 2);
  assert.equal(needPriority("tickets", "t1/notes.md", 10), 3);
  assert.equal(isWorktreeBulk("worktrees", "wt/src/a.ts"), true);
  assert.equal(isWorktreeBulk("worktrees", "wt/.joint-bob-worktree/meta.json"), false);
  assert.equal(isWorktreeBulk("worktrees", "wt/.joint-bob-baseline/x"), false);
  assert.equal(isWorktreeBulk("project", "src/a.ts"), false);
  const q = queue(t, { kind: "worktrees", peers: ["p1"] });
  const key = "worktrees:p1";
  await q.pull("p1", [
    { path: "wt/.joint-bob-baseline/a.ts", size: 10, sha256: SHA_X, version: { p1: 1 } },
    { path: "wt/assets/big.bin", size: 100_000, sha256: SHA_Y, version: { p1: 1 } },
    { path: "wt/src/a.ts", size: 2000, sha256: SHA_Z, version: { p1: 1 } },
    { path: "wt/.joint-bob-worktree/meta.json", size: 500, sha256: SHA_W, version: { p1: 1 } },
    { path: "other/assets/huge.bin", size: 200_000, sha256: "e".repeat(64), version: { p1: 1 } },
  ]);
  const order = () => q.need.nextNeeds({ limit: 10 }).items.map((item) => `${item.priority} ${item.path}`);
  assert.deepEqual(order(), ["1 wt/.joint-bob-worktree/meta.json", "1 wt/src/a.ts", "4 wt/assets/big.bin", "4 other/assets/huge.bin", "5 wt/.joint-bob-baseline/a.ts"]);
  q.need.prioritize(key, "other/", q.clock.now() + 10_000);
  assert.deepEqual(order()[0], "0 other/assets/huge.bin");
  // A row arriving while the priority lasts gets it too; then the one-shot timer puts both back.
  await q.pull("p1", [{ path: "other/late.bin", size: 300_000, sha256: "f".repeat(64), version: { p1: 2 } }]);
  assert.equal(q.db.needRow(key, "other/late.bin")?.priority, 0);
  q.clock.advance(10_001);
  assert.deepEqual([q.db.needRow(key, "other/assets/huge.bin")?.priority, q.db.needRow(key, "other/late.bin")?.priority], [4, 4]);
});

// fix (P4+P5): a worktree merge asks what of that worktree is still on its way, and from whom.
test("what is pending under a worktree counts only its own rows, and what only an unavailable machine has waits for it", async (t) => {
  const q = queue(t, { kind: "worktrees", peers: ["p1", "p2"] });
  const key = "worktrees:p1";
  await q.pull("p1", [
    { path: "w1/a.ts", size: 10, sha256: SHA_X, version: { p1: 1 } },
    { path: "w2/b.ts", size: 20, sha256: SHA_Y, version: { p1: 1 } },
    { path: "w2/c.ts", size: 30, sha256: SHA_Z, version: { p1: 1 } },
  ]);
  const none = { files: 0, bytes: 0, peers: [] };
  assert.deepEqual(q.need.pendingUnder(key, "w1", ["p1", "p2"]), { files: 1, bytes: 10, blocked: 0, errors: 0, waiting: none });
  assert.deepEqual(q.need.pendingUnder(key, "w2/", ["p1"]), { files: 2, bytes: 50, blocked: 0, errors: 0, waiting: none });
  assert.deepEqual(q.need.pendingUnder(key, "w3", ["p1"]), { files: 0, bytes: 0, blocked: 0, errors: 0, waiting: none }, "a worktree with nothing on its way");
  // p1, the only machine with the content, is away: nothing can come now.
  assert.deepEqual(q.need.pendingUnder(key, "w2", ["p2"]), { files: 0, bytes: 0, blocked: 0, errors: 0, waiting: { files: 2, bytes: 50, peers: ["p1"] } });
  // A copy already here (the same bytes in w1) needs no machine; a blocked row waits for a person, not for a machine.
  q.local({ path: "w1/copy.ts", size: 30, sha256: SHA_Z, version: { "node-b": 1 }, modifiedBy: "node-b" });
  q.need.block(key, "w2/b.ts", "Another name in this folder differs only in case (B.ts)");
  q.db.writeTx(() => {
    q.db.setError(key, "w1/a.ts", "error", "Unreadable", q.clock.now());
    q.db.setError(key, "w2", "error", "Unreadable folder", q.clock.now());
    q.db.setError(key, "w2/secret.txt", "error", "Unreadable", q.clock.now());
    q.db.setError(key, "w2-other/file.txt", "error", "Different worktree", q.clock.now());
  });
  assert.deepEqual(q.need.pendingUnder(key, "w2", []), { files: 1, bytes: 30, blocked: 1, errors: 2, waiting: none });
  assert.deepEqual(q.need.pendingUnder(key, "w1", []), { files: 0, bytes: 0, blocked: 0, errors: 1, waiting: { files: 1, bytes: 10, peers: ["p1"] } });
  assert.equal(q.need.pendingUnder(key, "", []).errors, 4, "the whole-share prefix still includes every error");
});

test("blocked rows are left out of the queue and the pending count, listed as problems, and tried again when something related changes", async (t) => {
  const q = queue(t, { peers: ["p1"] });
  await q.pull("p1", [{ path: "docs/readme.md", sha256: SHA_X, size: 3, version: { p1: 1 } }, { path: "x.txt", sha256: SHA_Y, size: 4, version: { p1: 1 } }]);
  q.need.block(KEY, "docs/readme.md", "Another name in this folder differs only in case (README.md)");
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items.map((item) => item.path), ["x.txt"]);
  assert.deepEqual(q.db.needSummary(KEY), { files: 1, bytes: 4, blocked: 1 });
  const problems = q.db.problemsPage(KEY, 0, 10);
  assert.equal(problems.total, 1);
  assert.deepEqual([problems.items[0].path, problems.items[0].kind, problems.items[0].reason, problems.items[0].blocked], ["docs/readme.md", "blocked", "Another name in this folder differs only in case (README.md)", true]);
  // The case twin beside it changes (renamed away, say): blocked no more.
  q.local({ path: "docs/README.md", deleted: true, version: { "node-b": 2 }, modifiedBy: "node-b" });
  assert.equal(q.db.needRow(KEY, "docs/readme.md")?.blocked, false);
  // Not enough disk space waits for its time instead.
  q.need.block(KEY, "x.txt", "Not enough free disk space", { retryAfterMs: 60_000 });
  q.local({ path: "x.txt.other", version: { "node-b": 3 }, modifiedBy: "node-b" });
  assert.equal(q.db.needRow(KEY, "x.txt")?.blocked, true);
  assert.equal(q.need.nextNeeds({ limit: 10 }).nextRetryAt, q.clock.now() + 60_000);
  q.clock.advance(60_000);
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items.map((item) => item.path), ["docs/readme.md", "x.txt"]);
  // A row blocked for another target stays as it is.
  q.need.block(KEY, "x.txt", "elsewhere", { target: entry({ path: "x.txt", version: { p1: 99 } }) });
  assert.equal(q.db.needRow(KEY, "x.txt")?.blocked, false);
});

test("rule and peer changes recompute need from the stored rows, without a pull", async (t) => {
  const q = queue(t, { peers: ["p1", "p2"] });
  await q.pull("p1", [{ path: "build/out.js", sha256: SHA_X, version: { p1: 1 } }, { path: "src/a.ts", sha256: SHA_Y, version: { p1: 1 } }]);
  await q.pull("p2", [{ path: "src/b.ts", sha256: SHA_Z, version: { p2: 1 } }]);
  assert.equal(q.db.needCount(KEY), 3);
  q.state.ignored.add("build");
  q.need.recomputeNeed(KEY);
  await q.need.idle();
  assert.equal(q.db.needRow(KEY, "build/out.js"), undefined, "an ignored path never has a need row");
  assert.equal(q.db.remote(KEY, "p1", "build/out.js")?.sha256, SHA_X, "its row is kept for the next rules change");
  q.state.ignored.clear();
  q.need.recomputeNeed(KEY);
  await q.need.idle();
  assert.equal(q.db.needRow(KEY, "build/out.js")?.action, "fetch");
  // p2 leaves the share: its rows no longer count.
  q.state.peers = ["p1"];
  q.need.recomputeNeed(KEY);
  await q.need.idle();
  assert.deepEqual([q.db.needRow(KEY, "src/b.ts"), q.db.needCount(KEY)], [undefined, 2]);
});

test("a share in shadow mode never gets need rows; leaving builtin drops them", async (t) => {
  const q = queue(t, { phase: "syncthing", peers: ["p1"] });
  await q.pull("p1", [{ path: "a.txt", sha256: SHA_X, version: { p1: 1 } }, { path: "b.txt", sha256: SHA_Y, version: { p1: 1 } }]);
  q.local({ path: "c.txt", sha256: SHA_Z, version: { "node-b": 1 } });
  assert.equal(q.db.needCount(KEY), 0);
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items, []);
  assert.equal(q.need.derive(KEY, "a.txt")?.wanted, false, "apply would refuse it too");
  q.state.phase = "builtin";
  q.need.syncNeed(KEY);
  await q.need.idle();
  assert.equal(q.db.needCount(KEY), 2);
  q.state.phase = "restoring";
  q.need.syncNeed(KEY);
  assert.equal(q.db.needCount(KEY), 0);
  await q.pull("p1", [{ path: "d.txt", sha256: SHA_W, version: { p1: 2 } }]);
  assert.equal(q.db.needCount(KEY), 0);
});

test("an incomplete local index keeps no need: files not indexed yet must not be fetched over", async (t) => {
  const q = queue(t, { peers: ["p1"] });
  q.db.writeTx(() => q.db.updateShare(KEY, { rulesHash: "old" }));
  q.need.syncNeed(KEY);
  await q.pull("p1", [{ path: "a.txt", sha256: SHA_X, version: { p1: 1 } }]);
  assert.equal(q.db.needCount(KEY), 0);
  q.db.writeTx(() => q.db.updateShare(KEY, { rulesHash: "h" }));
  q.need.syncNeed(KEY);
  await q.need.idle();
  assert.equal(q.db.needRow(KEY, "a.txt")?.action, "fetch");
});

test("rows kept while the index was incomplete are announced again once it is complete, even when the recompute changes none", async (t) => {
  const q = queue(t, { peers: ["p1"] });
  await q.pull("p1", [{ path: "a.txt", sha256: SHA_X, version: { p1: 1 } }]);
  assert.equal(q.db.needRow(KEY, "a.txt")?.action, "fetch");
  // A rules change: the index is incomplete until its rescan, and nothing is handed out meanwhile (the row stays).
  q.db.writeTx(() => q.db.updateShare(KEY, { rulesHash: "old" }));
  q.need.syncNeed(KEY);
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items, []);
  await q.need.idle();
  await new Promise((resolve) => setImmediate(resolve));
  q.changed.length = 0;
  // The rescan completes it: the row is unchanged, and the transfer loop must still hear that it is wanted again.
  q.db.writeTx(() => q.db.updateShare(KEY, { rulesHash: "h" }));
  q.need.syncNeed(KEY);
  await q.need.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items.map((item) => item.path), ["a.txt"]);
  assert.ok(q.changed.includes(KEY), "need-changed was announced");
});

test("a share whose folder is missing hands nothing out; its rows wait for it", async (t) => {
  const q = queue(t, { peers: ["p1"] });
  await q.pull("p1", [{ path: "a.txt", sha256: SHA_X, version: { p1: 1 } }]);
  q.state.available = false;
  assert.deepEqual([q.need.nextNeeds({ limit: 10 }).items, q.db.needCount(KEY)], [[], 1]);
  q.changed.length = 0;
  q.state.available = true;
  q.need.wake(KEY);
  await Promise.resolve();
  assert.deepEqual(q.changed, [KEY], "listeners hear the folder is back");
  assert.deepEqual(q.need.nextNeeds({ limit: 10 }).items.map((item) => item.path), ["a.txt"]);
});
