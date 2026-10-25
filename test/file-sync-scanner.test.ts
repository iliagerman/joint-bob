import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { FileSyncDb, type LocalEntry } from "../src/file-sync/db.js";
import { digestOf } from "../src/file-sync/digest.js";
import { compileRules, effectiveRules } from "../src/file-sync/ignore.js";
import type { CoreEvent } from "../src/file-sync/protocol.js";
import { REPLACED_MESSAGE, ShareScanner, SliceScheduler, Slicer, type ScannerOptions, type ShareContext } from "../src/file-sync/scanner.js";
import type { Clock, Phase, RuleSettings, ShareKind } from "../src/file-sync/types.js";
import { compareVectors } from "../src/file-sync/vectors.js";

const NODE = "node-a";
const NFD = "é.txt";
const NFC = "é.txt";

/** A clock the test moves; timers fire only when it advances past them. */
function manualClock(start: number) {
  let now = start;
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  const clock: Clock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    setTimeout(run, ms) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    advance(ms) {
      now += ms;
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) { timer.cancelled = true; timer.run(); }
    },
    pending: () => timers.filter((entry) => !entry.cancelled).length,
  };
  return clock;
}

interface Setup {
  dir: string;
  root: string;
  key: string;
  db: FileSyncDb;
  scanner: ShareScanner;
  events: CoreEvent[];
  rechecks: Array<{ paths: string[]; delayMs: number }>;
  clock: ReturnType<typeof manualClock>;
  context(overrides?: Partial<ShareContext> & { rules?: Partial<RuleSettings> }): ShareContext;
  write(relative: string, content?: string): void;
  rows(): LocalEntry[];
  live(): Map<string, LocalEntry>;
  row(relative: string): LocalEntry | undefined;
}

type InTransaction = NonNullable<ConstructorParameters<typeof ShareScanner>[0]["inTransaction"]>;

function setup(t: TestContext, options: { kind?: ShareKind; phase?: Phase; rules?: Partial<RuleSettings>; scanner?: Partial<ScannerOptions>; clockStart?: number; beforeCommit?(): void; inTransaction?: InTransaction; slicer?: Slicer } = {}): Setup {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-scan-"));
  t.after(() => {
    try { chmodSync(path.join(dir, "root", "locked"), 0o755); } catch { /* not every test locks a folder */ }
    rmSync(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, "root");
  mkdirSync(root);
  const kind = options.kind ?? "project";
  const key = `${kind}:p1`;
  const db = new FileSyncDb(path.join(dir, "file-sync.db"), NODE);
  t.after(() => db.close());
  db.writeTx(() => db.insertShare({ share: key, projectId: "p1", kind, root, indexId: "gen1" }));
  // An hour ahead of the files' mtimes: nothing looks "just modified" unless a test wants it to.
  const clock = manualClock(options.clockStart ?? Date.now() + 3_600_000);
  const events: CoreEvent[] = [];
  const rechecks: Array<{ paths: string[]; delayMs: number }> = [];
  let generations = 1;
  const context = (overrides: Partial<ShareContext> & { rules?: Partial<RuleSettings> } = {}): ShareContext => {
    const { rules, ...rest } = overrides;
    return { key, projectId: "p1", kind, root, phase: options.phase ?? "syncthing", matcher: compileRules(effectiveRules(kind, rules ?? options.rules)), peers: [], ...rest };
  };
  const scanner = new ShareScanner({
    db, nodeId: NODE, clock, emit: (event) => events.push(event), slicer: options.slicer ?? new Slicer(),
    recheck: (paths, delayMs) => rechecks.push({ paths, delayMs }), newIndexId: () => `gen${++generations}`,
    options: options.scanner, hooks: options.beforeCommit ? { beforeCommit: options.beforeCommit } : undefined, inTransaction: options.inTransaction,
  }, context());
  return {
    dir, root, key, db, scanner, events, rechecks, clock, context,
    write(relative, content = relative) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), content);
    },
    rows: () => db.entries(key),
    live: () => new Map(db.entries(key).filter((row) => !row.deleted).map((row) => [row.path, row])),
    row: (relative) => db.entry(key, relative),
  };
}

/** Runs `hook` once, at its nth look: the scanner looks once per directory it lists, per entry and per hashed chunk. */
class HookSlicer extends Slicer {
  private calls = 0;
  private hook: { at: number; run: () => void } | undefined;

  arm(at: number, run: () => void): void {
    this.calls = 0;
    this.hook = { at, run };
  }

  override async maybeYield(): Promise<void> {
    if (this.hook && ++this.calls === this.hook.at) {
      const { run } = this.hook;
      this.hook = undefined;
      run();
    }
    return super.maybeYield();
  }
}

function manyFiles(s: Setup, directory: string, count: number): void {
  mkdirSync(path.join(s.root, directory), { recursive: true });
  for (let index = 0; index < count; index++) writeFileSync(path.join(s.root, directory, `f${index}.txt`), `${directory}/${index}`);
}

test("a missing root leaves the share unavailable and writes nothing", async (t) => {
  const s = setup(t);
  rmSync(s.root, { recursive: true });
  const result = await s.scanner.scan("full");
  assert.equal(result.error, "The folder is missing");
  assert.equal(s.scanner.root?.state, "unavailable");
  assert.equal(s.rows().length, 0);
  assert.equal(s.db.share(s.key)?.maxSeq, 0);
});

test("a root that disappears after a complete scan produces no tombstones", async (t) => {
  const s = setup(t);
  s.write("a.txt");
  s.write("dir/b.txt");
  await s.scanner.scan("full");
  rmSync(s.root, { recursive: true });
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 0, `tombstones: ${result.tombstones}`);
  assert.deepEqual([...s.live().keys()].sort(), ["a.txt", "dir", "dir/b.txt"]);
});

test("a symlinked root is an error and is not followed", async (t) => {
  const s = setup(t);
  const real = path.join(s.dir, "real");
  mkdirSync(real);
  writeFileSync(path.join(real, "x.txt"), "x");
  rmSync(s.root, { recursive: true });
  symlinkSync(real, s.root);
  const result = await s.scanner.scan("full");
  assert.equal(result.error, "The folder is a symbolic link");
  assert.equal(s.scanner.root?.state, "error");
  assert.equal(s.rows().length, 0);
});

test("a root that is a file is an error", async (t) => {
  const s = setup(t);
  rmSync(s.root, { recursive: true });
  writeFileSync(s.root, "not a folder");
  const result = await s.scanner.scan("full");
  assert.equal(result.error, "The folder is not a directory");
  assert.equal(s.db.share(s.key)?.scanError, "The folder is not a directory");
});

test("the first scan indexes files, folders and links without tombstones", async (t) => {
  const s = setup(t);
  s.write("a.txt", "hello");
  s.write("dir/b.txt", "world!");
  symlinkSync("../elsewhere", path.join(s.root, "link"));
  const result = await s.scanner.scan("full");
  assert.equal(result.newGeneration, true);
  assert.equal(result.tombstones, 0);
  const live = s.live();
  assert.deepEqual([...live.keys()].sort(), ["a.txt", "dir", "dir/b.txt", "link"]);
  assert.equal(live.get("a.txt")!.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(live.get("link")!.type, 2);
  assert.equal(live.get("link")!.target, "../elsewhere");
  assert.equal(live.get("dir")!.type, 1);
  for (const row of live.values()) assert.ok(row.version[NODE] > 0, `${row.path} has no counter for this node: ${JSON.stringify(row.version)}`);
  const share = s.db.share(s.key)!;
  assert.equal(share.maxSeq, 4);
  assert.equal(share.digest, digestOf(live.values()));
  assert.equal(share.liveFiles, 2);
  assert.equal(share.liveBytes, 11);
  assert.ok(share.fullScanAt !== null, "a complete scan is recorded");
});

test("an event-scoped scan before any complete scan walks the whole share", async (t) => {
  const s = setup(t);
  s.write("a.txt");
  s.write("deep/b.txt");
  await s.scanner.scan({ paths: ["a.txt"] });
  assert.deepEqual([...s.live().keys()].sort(), ["a.txt", "deep", "deep/b.txt"]);
});

test("another directory at the root path starts a new generation without tombstones", async (t) => {
  const s = setup(t);
  for (const name of ["a.txt", "b.txt", "c.txt"]) s.write(name);
  await s.scanner.scan("full");
  // Moved aside, not deleted: a freed inode can be handed straight back to the new folder.
  renameSync(s.root, `${s.root}-replaced`);
  mkdirSync(s.root);
  s.write("only.txt");
  const result = await s.scanner.scan({ paths: ["a.txt"] });
  assert.equal(result.newGeneration, true);
  assert.equal(result.tombstones, 0);
  assert.equal(s.db.share(s.key)!.indexId, "gen2");
  assert.deepEqual(s.rows().map((row) => row.path), ["only.txt"], "old rows are discarded, not tombstoned");
});

test("a replaced-looking root publishes nothing until it is confirmed", async (t) => {
  const s = setup(t);
  manyFiles(s, "src", 520);
  await s.scanner.scan("full");
  const before = s.db.share(s.key)!;
  // Moved aside, not deleted: a freed inode can be handed straight back to the new folder.
  renameSync(s.root, `${s.root}-replaced`);
  mkdirSync(s.root);
  manyFiles(s, "src", 100);
  const result = await s.scanner.scan("full");
  assert.equal(result.error, REPLACED_MESSAGE);
  const paused = s.db.share(s.key)!;
  assert.equal(paused.indexId, before.indexId);
  assert.equal(paused.maxSeq, before.maxSeq);
  assert.equal(paused.scanError, REPLACED_MESSAGE);
  assert.equal(s.live().size, 521, "the old index stays as it was");
  assert.equal((await s.scanner.scan({ paths: ["src/f1.txt"] })).error, REPLACED_MESSAGE, "later events change nothing either");
  const confirmed = await s.scanner.confirmReplacedRoot();
  assert.equal(confirmed.newGeneration, true);
  assert.equal(confirmed.tombstones, 0);
  assert.notEqual(s.db.share(s.key)!.indexId, before.indexId);
  assert.equal(s.db.share(s.key)!.scanError, null);
  assert.equal(s.live().size, 101);
});

test("a touch is not a change", async (t) => {
  const s = setup(t);
  s.write("a.txt", "same");
  await s.scanner.scan("full");
  const before = s.row("a.txt")!;
  utimesSync(path.join(s.root, "a.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  const result = await s.scanner.scan({ paths: ["a.txt"] });
  const after = s.row("a.txt")!;
  assert.equal(result.changed, 0);
  assert.equal(after.seq, before.seq);
  assert.deepEqual(after.version, before.version);
  assert.equal(after.mtimeMs, before.mtimeMs, "the version keeps its mtime");
  assert.equal(after.fsMtimeMs, new Date(2020, 0, 1).getTime(), "the fingerprint follows the disk");
});

test("an edit that keeps size and mtime is found through ctime", async (t) => {
  const s = setup(t);
  const file = path.join(s.root, "a.txt");
  s.write("a.txt", "aaaa");
  const { mtime } = lstatSync(file);
  await s.scanner.scan("full");
  const before = s.row("a.txt")!;
  writeFileSync(file, "bbbb");
  utimesSync(file, mtime, mtime);
  await s.scanner.scan({ paths: ["a.txt"] });
  const after = s.row("a.txt")!;
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(compareVectors(after.version, before.version), "greater");
});

test("chmod of a file is a new version with the same content", async (t) => {
  const s = setup(t);
  s.write("run.sh", "echo hi");
  chmodSync(path.join(s.root, "run.sh"), 0o644);
  await s.scanner.scan("full");
  const before = s.row("run.sh")!;
  chmodSync(path.join(s.root, "run.sh"), 0o755);
  const result = await s.scanner.scan({ paths: ["run.sh"] });
  const after = s.row("run.sh")!;
  assert.equal(result.changed, 1);
  assert.equal(after.mode, 0o755);
  assert.equal(after.sha256, before.sha256);
  assert.equal(compareVectors(after.version, before.version), "greater");
});

test("chmod of a directory is a new version", async (t) => {
  const s = setup(t);
  mkdirSync(path.join(s.root, "d"), { mode: 0o755 });
  chmodSync(path.join(s.root, "d"), 0o755);
  await s.scanner.scan("full");
  const before = s.row("d")!;
  chmodSync(path.join(s.root, "d"), 0o700);
  await s.scanner.scan({ paths: ["d"] });
  const after = s.row("d")!;
  assert.equal(after.mode, 0o700);
  assert.equal(compareVectors(after.version, before.version), "greater");
});

test("a deleted file becomes a tombstone that keeps what it deleted", async (t) => {
  const s = setup(t);
  s.write("a.txt", "keep me");
  s.write("b.txt");
  await s.scanner.scan("full");
  const before = s.row("a.txt")!;
  unlinkSync(path.join(s.root, "a.txt"));
  const result = await s.scanner.scan({ paths: ["a.txt"] });
  const tombstone = s.row("a.txt")!;
  assert.equal(result.tombstones, 1);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.sha256, before.sha256, "lastSha");
  assert.equal(tombstone.size, before.size);
  assert.equal(tombstone.type, 0);
  assert.equal(tombstone.modifiedBy, NODE);
  assert.equal(tombstone.deletedAt, s.clock.now());
  assert.equal(compareVectors(tombstone.version, before.version), "greater");
  const share = s.db.share(s.key)!;
  assert.equal(share.liveFiles, 1);
  assert.equal(share.digest, digestOf(s.live().values()), "tombstones are not in the digest");
});

test("a deleted folder tombstones its subtree", async (t) => {
  const s = setup(t);
  s.write("d/one.txt");
  s.write("d/sub/two.txt");
  s.write("keep.txt");
  await s.scanner.scan("full");
  rmSync(path.join(s.root, "d"), { recursive: true });
  const result = await s.scanner.scan({ paths: ["d"] });
  assert.equal(result.tombstones, 4);
  assert.deepEqual([...s.live().keys()], ["keep.txt"]);
});

test("an event for a new file in a known folder lists that folder", async (t) => {
  const s = setup(t);
  s.write("sub/old.txt");
  await s.scanner.scan("full");
  s.write("sub/new.txt", "new");
  s.write("sub/also.txt", "unreported");
  const result = await s.scanner.scan({ paths: ["sub/new.txt"] });
  assert.equal(result.changed, 2, "the listing finds the unreported sibling too");
  assert.ok(s.live().has("sub/new.txt"));
  assert.ok(s.live().has("sub/also.txt"));
});

test("an event deep inside new folders indexes every new parent", async (t) => {
  const s = setup(t);
  s.write("top.txt");
  await s.scanner.scan("full");
  s.write("x/y/z/f.txt");
  await s.scanner.scan({ paths: ["x/y/z/f.txt"] });
  assert.deepEqual([...s.live().keys()].sort(), ["top.txt", "x", "x/y", "x/y/z", "x/y/z/f.txt"]);
});

test("a symbolic link is indexed by its text and a new target is a new version", async (t) => {
  const s = setup(t);
  const outside = path.join(s.dir, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "never indexed");
  symlinkSync(outside, path.join(s.root, "link"));
  await s.scanner.scan("full");
  assert.deepEqual([...s.live().keys()], ["link"], "the scanner never follows a link");
  const before = s.row("link")!;
  unlinkSync(path.join(s.root, "link"));
  symlinkSync("somewhere-else", path.join(s.root, "link"));
  await s.scanner.scan({ paths: ["link"] });
  const after = s.row("link")!;
  assert.equal(after.target, "somewhere-else");
  assert.equal(compareVectors(after.version, before.version), "greater");
});

test("a file that becomes a folder is a new version and its content is indexed", async (t) => {
  const s = setup(t);
  s.write("a", "file");
  await s.scanner.scan("full");
  const before = s.row("a")!;
  unlinkSync(path.join(s.root, "a"));
  s.write("a/inside.txt");
  await s.scanner.scan({ paths: ["a"] });
  const after = s.row("a")!;
  assert.equal(after.type, 1);
  assert.equal(after.deleted, false);
  assert.equal(compareVectors(after.version, before.version), "greater");
  assert.ok(s.live().has("a/inside.txt"));
});

test("a folder that becomes a file tombstones what was below it", async (t) => {
  const s = setup(t);
  s.write("a/one.txt");
  s.write("a/two.txt");
  await s.scanner.scan("full");
  rmSync(path.join(s.root, "a"), { recursive: true });
  s.write("a", "now a file");
  const result = await s.scanner.scan({ paths: ["a"] });
  assert.equal(s.row("a")!.type, 0);
  assert.equal(result.tombstones, 2);
  assert.equal(s.row("a/one.txt")!.deleted, true);
});

test("a large delete is tombstoned at once, with nothing held for confirmation", async (t) => {
  const s = setup(t);
  manyFiles(s, "src", 600);
  s.write("keep.txt");
  await s.scanner.scan("full");
  for (let index = 0; index < 550; index++) unlinkSync(path.join(s.root, "src", `f${index}.txt`));
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 550);
  assert.equal(s.row("src/f0.txt")!.deleted, true);
  assert.equal(s.row("keep.txt")!.deleted, false);
});

test("a removed worktree is tombstoned whole, beside another worktree's few deletes", async (t) => {
  const s = setup(t, { kind: "worktrees" });
  manyFiles(s, "w1", 600);
  manyFiles(s, "w2", 600);
  await s.scanner.scan("full");
  rmSync(path.join(s.root, "w1"), { recursive: true });
  for (let index = 0; index < 10; index++) unlinkSync(path.join(s.root, "w2", `f${index}.txt`));
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 611);
  assert.equal(s.row("w1")!.deleted, true);
  assert.equal(s.row("w2/f10.txt")!.deleted, false);
});

test("a path the rules now ignore leaves the index without a tombstone", async (t) => {
  const s = setup(t);
  s.write("notes.txt");
  s.write("private.txt");
  s.write("cache/a.bin");
  await s.scanner.scan("full");
  const seqBefore = s.db.share(s.key)!.maxSeq;
  const notesSeq = s.row("notes.txt")!.seq;
  s.scanner.update(s.context({ rules: { userRules: ["private.txt", "cache/"] } }));
  const result = await s.scanner.scan({ paths: [] });
  assert.equal(result.tombstones, 0);
  assert.deepEqual(s.rows().map((row) => row.path), ["notes.txt"]);
  const share = s.db.share(s.key)!;
  assert.equal(share.maxSeq, seqBefore + 1, "one seq without a row tells peers that something left");
  assert.equal(share.prunedBelow, share.maxSeq, "above every peer's cursor: they list the index again and lose the dropped rows");
  assert.equal(s.row("notes.txt")!.seq, notesSeq, "no row is written for what was dropped");
  assert.equal(share.digest, digestOf(s.live().values()));
  assert.equal(share.liveFiles, 1);
  const again = await s.scanner.scan("full");
  assert.equal(again.changed, 0);
  assert.equal(s.db.share(s.key)!.maxSeq, share.maxSeq, "nothing left to drop: no new seq");
});

test("in shadow mode a deleted folder that comes back is live whatever it holds", async (t) => {
  const s = setup(t);
  s.write("d/a.txt");
  await s.scanner.scan("full");
  rmSync(path.join(s.root, "d"), { recursive: true });
  await s.scanner.scan({ paths: ["d"] });
  assert.equal(s.row("d")!.deleted, true);
  // Syncthing creates a folder that holds only ignored files on the other node empty: both trees have it.
  s.write("d/.DS_Store", "finder");
  await s.scanner.scan("full");
  assert.equal(s.row("d")!.deleted, false);
  assert.equal(s.row("d/.DS_Store"), undefined);
});

test("in builtin mode a deleted folder that comes back holding only ignored files stays deleted", async (t) => {
  const s = setup(t, { phase: "builtin" });
  s.write("d/a.txt");
  await s.scanner.scan("full");
  rmSync(path.join(s.root, "d"), { recursive: true });
  await s.scanner.scan({ paths: ["d"] });
  const tombstone = s.row("d")!;
  s.write("d/.DS_Store", "finder");
  s.write("d/node_modules/x/index.js");
  await s.scanner.scan("full");
  assert.equal(s.row("d")!.deleted, true);
  assert.equal(s.row("d")!.seq, tombstone.seq, "not resurrected");
  s.write("d/real.txt");
  await s.scanner.scan({ paths: ["d/real.txt"] });
  assert.equal(s.row("d")!.deleted, false, "synced content brings it back");
  assert.ok(s.live().has("d/real.txt"));
});

test("a non-NFC name is indexed under its NFC key", async (t) => {
  const s = setup(t);
  writeFileSync(path.join(s.root, NFD), "accent");
  await s.scanner.scan("full");
  const row = s.row(NFC);
  assert.ok(row, `rows: ${JSON.stringify(s.rows().map((entry) => entry.path))}`);
  const spelled = readdirSync(s.root)[0];
  // APFS finds a file by either normalization; Linux keeps the on-disk spelling to reach it.
  assert.equal(row.fsName, process.platform === "darwin" || spelled === NFC ? null : NFD);
  const again = await s.scanner.scan({ paths: [spelled] });
  assert.equal(again.changed, 0);
  unlinkSync(path.join(s.root, spelled));
  await s.scanner.scan({ paths: [spelled] });
  assert.equal(s.row(NFC)!.deleted, true);
});

test("two names on disk for one key are both skipped and reported", async (t) => {
  const s = setup(t);
  writeFileSync(path.join(s.root, NFC), "composed");
  writeFileSync(path.join(s.root, NFD), "decomposed");
  if (readdirSync(s.root).length < 2) { t.skip("this filesystem keeps one name per normalization"); return; }
  await s.scanner.scan("full");
  assert.equal(s.row(NFC), undefined);
  const errors = s.db.errorsPage(s.key, 0, 10);
  assert.equal(errors.total, 1);
  assert.equal(errors.items[0].path, NFC);
});

test("a small file modified just now is checked again after the settle time", async (t) => {
  const s = setup(t, { clockStart: Date.now() });
  s.write("fresh.txt");
  await s.scanner.scan("full");
  assert.ok(s.row("fresh.txt"), "small files are hashed at once");
  assert.deepEqual(s.rechecks, [{ paths: ["fresh.txt"], delayMs: 2000 }]);
});

test("a large file is hashed only after two agreeing looks at least 2 s apart", async (t) => {
  const s = setup(t, { scanner: { smallFileBytes: 10 } });
  s.write("big.bin", "x".repeat(100));
  await s.scanner.scan("full");
  assert.equal(s.row("big.bin"), undefined, "not hashed on the first look");
  assert.deepEqual(s.rechecks.at(-1), { paths: ["big.bin"], delayMs: 2000 });
  s.clock.advance(1000);
  await s.scanner.scan({ paths: ["big.bin"] });
  assert.equal(s.row("big.bin"), undefined, "agreeing but too soon");
  s.write("big.bin", "y".repeat(200));
  s.clock.advance(1500);
  await s.scanner.scan({ paths: ["big.bin"] });
  assert.equal(s.row("big.bin"), undefined, "still changing");
  assert.deepEqual(s.rechecks.at(-1), { paths: ["big.bin"], delayMs: 4000 }, "the wait doubles");
  s.clock.advance(4000);
  await s.scanner.scan({ paths: ["big.bin"] });
  assert.equal(s.row("big.bin")?.size, 200);
});

test("a row changed by another writer during the scan is not overwritten blindly", async (t) => {
  let s: Setup | undefined;
  let interfere = false;
  s = setup(t, {
    beforeCommit: () => {
      if (!interfere || !s) return;
      interfere = false;
      // Another writer (apply) wrote the row between the scanner's read and its commit.
      const db = s.db;
      const row = db.entry(s.key, "a.txt")!;
      db.writeTx(() => db.putEntry(s!.key, { ...row, seq: row.seq + 1000, version: { other: 99 } }));
    },
  });
  s.write("a.txt", "one");
  await s.scanner.scan("full");
  s.write("a.txt", "two, longer");
  interfere = true;
  await s.scanner.scan({ paths: ["a.txt"] });
  const row = s.row("a.txt")!;
  assert.equal(row.size, 11, "the re-scan indexed what is on disk");
  assert.equal(row.version.other, 99, "the other writer's version is built on, not lost");
  assert.ok(row.version[NODE] > 0);
});

test("a delete whose row another writer changed during the scan still becomes a tombstone", async (t) => {
  let s: Setup | undefined;
  let interfere = false;
  s = setup(t, {
    beforeCommit: () => {
      if (!interfere || !s) return;
      interfere = false;
      // A peer's identical version merged into the row (shadow mode) between the scanner's read and its commit.
      const db = s.db;
      for (const relative of ["a.txt", "dir/b.txt"]) {
        const row = db.entry(s.key, relative)!;
        db.writeTx(() => db.putEntry(s!.key, { ...row, seq: row.seq + 1000, version: { ...row.version, other: 99 } }));
      }
    },
  });
  s.write("a.txt", "one");
  s.write("dir/b.txt", "two");
  await s.scanner.scan("full");
  unlinkSync(path.join(s.root, "a.txt"));
  rmSync(path.join(s.root, "dir"), { recursive: true });
  interfere = true;
  await s.scanner.scan({ paths: ["a.txt", "dir"] });
  for (const relative of ["a.txt", "dir/b.txt", "dir"]) {
    const row = s.row(relative)!;
    assert.equal(row.deleted, true, `${relative} is a tombstone after the compare-and-set retry`);
  }
  assert.equal(s.row("a.txt")!.version.other, 99, "the merged version is built on");
  assert.deepEqual(s.rechecks, [], "settled within the scan");
});

test("tombstones are pruned only when every peer has them and they are old", async (t) => {
  const s = setup(t);
  s.write("gone.txt");
  s.write("stay.txt");
  await s.scanner.scan("full");
  unlinkSync(path.join(s.root, "gone.txt"));
  await s.scanner.scan({ paths: ["gone.txt"] });
  const tombstone = s.row("gone.txt")!;
  const indexId = s.db.share(s.key)!.indexId;
  s.db.writeTx(() => s.db.setAck(s.key, "peer-a", indexId, tombstone.seq, s.clock.now()));
  assert.equal(s.scanner.pruneTombstones(["peer-a"]), 0, "too young");
  s.clock.advance(31 * 86_400_000);
  assert.equal(s.scanner.pruneTombstones(["peer-a", "peer-b"]), 0, "peer-b never acknowledged");
  assert.equal(s.scanner.pruneTombstones([]), 0, "no peers, no pruning");
  assert.equal(s.scanner.pruneTombstones(["peer-a"]), 1);
  assert.equal(s.row("gone.txt"), undefined);
  assert.equal(s.db.share(s.key)!.prunedBelow, tombstone.seq);
});

test("written rows reach the in-transaction hook with their before and after", async (t) => {
  const seen: Array<{ path: string; before: boolean; after: string; inTransaction: boolean }> = [];
  let s: Setup | undefined;
  s = setup(t, {
    inTransaction: (changes) => {
      for (const change of changes) seen.push({ path: change.path, before: Boolean(change.before), after: change.after ? (change.after.deleted ? "tombstone" : "live") : "dropped", inTransaction: s!.db.inTransaction });
    },
  });
  s.write("a.txt");
  s.write("b.txt");
  await s.scanner.scan("full");
  unlinkSync(path.join(s.root, "a.txt"));
  s.scanner.update(s.context({ rules: { userRules: ["b.txt"] } }));
  await s.scanner.scan({ paths: ["a.txt"] });
  assert.deepEqual(seen.sort((x, y) => x.path.localeCompare(y.path) || Number(x.before) - Number(y.before)), [
    { path: "a.txt", before: false, after: "live", inTransaction: true },
    { path: "a.txt", before: true, after: "tombstone", inTransaction: true },
    { path: "b.txt", before: false, after: "live", inTransaction: true },
    { path: "b.txt", before: true, after: "dropped", inTransaction: true },
  ]);
});

test("each scan reports a metric with counts", async (t) => {
  const s = setup(t);
  s.write("a.txt", "12345");
  await s.scanner.scan("full", "manual");
  const metric = s.events.find((event) => event.event === "metric" && event.operation === "fileSync.scan");
  assert.ok(metric && metric.event === "metric");
  assert.equal(metric.fields?.files, 1);
  assert.equal(metric.fields?.hashedBytes, 5);
  assert.equal(metric.fields?.scope, "full");
});

test("stale engine temps are removed in builtin mode and left alone in shadow mode", async (t) => {
  const shadow = setup(t, { phase: "syncthing" });
  const temp = ".joint-bob-sync.file.0123456789abcdef.tmp";
  shadow.write(temp, "partial");
  const old = new Date(Date.now() - 2 * 3_600_000);
  utimesSync(path.join(shadow.root, temp), old, old);
  await shadow.scanner.scan("full");
  assert.ok(existsSync(path.join(shadow.root, temp)), "shadow mode writes nothing into the tree");
  assert.equal(shadow.row(temp), undefined, "engine temps are never indexed");
  shadow.scanner.update(shadow.context({ phase: "builtin" }));
  await shadow.scanner.scan("full");
  assert.equal(existsSync(path.join(shadow.root, temp)), false);
});

test("builtin mode keeps engine temps out of git status", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) { t.skip("git is not installed"); return; }
  const s = setup(t, { phase: "builtin" });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: s.root }).status, 0);
  s.write("a.txt");
  await s.scanner.scan("full");
  const exclude = path.join(s.root, ".git", "info", "exclude");
  for (let waited = 0; waited < 5000 && !(existsSync(exclude) && readFileSync(exclude, "utf8").includes(".joint-bob-sync.*.tmp")); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(readFileSync(exclude, "utf8").split("\n").includes(".joint-bob-sync.*.tmp"), readFileSync(exclude, "utf8"));
});

test("shadow mode never touches .git/info/exclude", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) { t.skip("git is not installed"); return; }
  const s = setup(t, { phase: "syncthing" });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: s.root }).status, 0);
  const exclude = path.join(s.root, ".git", "info", "exclude");
  const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : null;
  await s.scanner.scan("full");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(exclude) ? readFileSync(exclude, "utf8") : null, before);
});

test("an unreadable folder is reported, never treated as deleted", async (t) => {
  if (process.getuid?.() === 0) { t.skip("root reads every folder"); return; }
  const s = setup(t);
  s.write("locked/inside.txt");
  s.write("open.txt");
  await s.scanner.scan("full");
  chmodSync(path.join(s.root, "locked"), 0o000);
  const result = await s.scanner.scan("full");
  chmodSync(path.join(s.root, "locked"), 0o755);
  assert.equal(result.tombstones, 0);
  assert.equal(s.row("locked/inside.txt")!.deleted, false);
  assert.ok(s.db.hasError(s.key, "locked"), "the folder is listed as an error");
});

test("the .gitignore option ignores what the tree's own .gitignore files list, with or without a repository", async (t) => {
  const s = setup(t, { rules: { gitignore: true } });
  s.write(".gitignore", "generated/\n*.out\n");
  s.write("generated/a.js");
  s.write("run.out");
  s.write("src/main.ts");
  s.write("src/.gitignore", "local.json\n!keep.out\n");
  s.write("src/local.json");
  s.write("src/keep.out");
  await s.scanner.scan("full");
  assert.deepEqual([...s.live().keys()].sort(), [".gitignore", "src", "src/.gitignore", "src/keep.out", "src/main.ts"]);
});

test("a file created after the first scan that a .gitignore matches is never indexed", async (t) => {
  const s = setup(t, { rules: { gitignore: true } });
  s.write(".gitignore", "dist/\n*.out\n");
  s.write("src/main.ts");
  await s.scanner.scan("full");
  s.write("late.out", "build output");
  s.write("dist/bundle.js");
  s.write("src/credentials.out");
  await s.scanner.scan({ paths: ["late.out", "dist/bundle.js", "src/credentials.out"] });
  s.scanner.requireFullScan();
  await s.scanner.scan("full");
  assert.deepEqual([...s.live().keys()].sort(), [".gitignore", "src", "src/main.ts"]);
});

test("a .gitignore the rules ignore still counts, and its change is picked up", async (t) => {
  const s = setup(t, { rules: { gitignore: true, userRules: [".gitignore"] } });
  s.write(".gitignore", "*.out\n");
  s.write("a.out");
  s.write("a.txt");
  await s.scanner.scan("full");
  assert.deepEqual([...s.live().keys()].sort(), ["a.txt"]);
  assert.equal(s.scanner.ignoresEvent(".gitignore"), false, "its events reach the scan");
  s.write(".gitignore", "*.txt\n");
  await s.scanner.scan({ paths: [".gitignore"] });
  assert.deepEqual([...s.live().keys()].sort(), ["a.out"]);
});

test("a .gitignore change drops what it now ignores", async (t) => {
  const s = setup(t, { rules: { gitignore: true } });
  s.write(".gitignore", "*.out\n");
  s.write("logs.txt");
  await s.scanner.scan("full");
  assert.ok(s.live().has("logs.txt"));
  s.write(".gitignore", "*.out\nlogs.txt\n");
  const result = await s.scanner.scan({ paths: [".gitignore"] });
  assert.equal(result.tombstones, 0);
  assert.equal(s.row("logs.txt"), undefined);
});

test("a rename inside the share is a tombstone plus a new entry with the same content", async (t) => {
  const s = setup(t);
  s.write("old.txt", "content");
  await s.scanner.scan("full");
  const before = s.row("old.txt")!;
  renameSync(path.join(s.root, "old.txt"), path.join(s.root, "new.txt"));
  await s.scanner.scan({ paths: ["old.txt", "new.txt"] });
  assert.equal(s.row("old.txt")!.deleted, true);
  assert.equal(s.row("new.txt")!.sha256, before.sha256);
});

// ---- the folder or the settings changing under a running scan ----

function fiveFolders(s: Setup): void {
  for (let index = 0; index < 5; index++) manyFiles(s, `d${index}`, 10);
}

test("a folder moved away during a full scan writes no tombstones, and a walk is armed for when it is back", async (t) => {
  const slicer = new HookSlicer();
  const s = setup(t, { slicer });
  fiveFolders(s);
  await s.scanner.scan("full");
  const moved = path.join(s.dir, "moved");
  slicer.arm(20, () => renameSync(s.root, moved));
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 0, `tombstones: ${result.tombstones}`);
  assert.match(result.error ?? "", /moved or replaced/);
  assert.equal(s.live().size, 55, "every row stays live");
  assert.equal(s.scanner.fullScanRequired, true);
  assert.deepEqual(s.rechecks.at(-1), { paths: [""], delayMs: 0 });
  renameSync(moved, s.root);
  const again = await s.scanner.scan({ paths: [""] });
  assert.deepEqual([again.tombstones, again.error, s.live().size], [0, undefined, 55]);
});

test("another folder put at the root path during a scan adds nothing to the old generation", async (t) => {
  const slicer = new HookSlicer();
  const s = setup(t, { slicer, scanner: { batchSize: 5 } });
  fiveFolders(s);
  await s.scanner.scan("full");
  // Every file edited, so the rescan commits as it goes.
  for (let folder = 0; folder < 5; folder++) for (let index = 0; index < 10; index++) writeFileSync(path.join(s.root, `d${folder}`, `f${index}.txt`), `edited ${folder}/${index}`);
  slicer.arm(30, () => {
    renameSync(s.root, path.join(s.dir, "old"));
    mkdirSync(path.join(s.root, "d3"), { recursive: true });
    s.write("x.txt");
    s.write("d3/new.txt");
  });
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 0, `tombstones: ${result.tombstones}`);
  assert.deepEqual([s.row("x.txt"), s.row("d3/new.txt")], [undefined, undefined], "nothing of the new folder joins the old generation");
  assert.equal(s.db.share(s.key)!.indexId, "gen1");
  const next = await s.scanner.scan("full");
  assert.equal(next.newGeneration, true);
  assert.deepEqual([...s.live().keys()].sort(), ["d3", "d3/new.txt", "x.txt"]);
});

test("a new root from configure during a scan ends that scan's writes", async (t) => {
  const slicer = new HookSlicer();
  const s = setup(t, { slicer });
  fiveFolders(s);
  await s.scanner.scan("full");
  const other = path.join(s.dir, "other");
  mkdirSync(other);
  writeFileSync(path.join(other, "x.txt"), "x");
  slicer.arm(10, () => s.scanner.update(s.context({ root: other })));
  const result = await s.scanner.scan("full");
  assert.deepEqual([result.tombstones, result.changed], [0, 0]);
  assert.match(result.error ?? "", /changed during the scan/);
  assert.equal(s.live().size, 55);
  const next = await s.scanner.scan("full");
  assert.equal(next.newGeneration, true, "the next scan sees another folder");
  assert.deepEqual([...s.live().keys()], ["x.txt"]);
});

test("the first complete scan drops rows an interrupted first scan wrote, instead of deleting them", async (t) => {
  const slicer = new Slicer();
  let commits = 0;
  const s = setup(t, { slicer, scanner: { batchSize: 10 }, beforeCommit: () => { if (++commits === 1) slicer.aborted = true; } });
  manyFiles(s, "d", 30);
  const aborted = await s.scanner.scan("full");
  assert.equal(aborted.error, "Scan stopped");
  slicer.aborted = false;
  const partial = s.rows();
  assert.equal(partial.length, 10, `rows: ${partial.length}`);
  assert.equal(s.db.share(s.key)!.fullScanAt, null);
  const gone = partial.find((row) => row.type === 0)!;
  unlinkSync(path.join(s.root, gone.path));
  const complete = await s.scanner.scan("full");
  assert.equal(complete.tombstones, 0);
  assert.equal(s.row(gone.path), undefined, "dropped, not tombstoned");
  assert.equal(s.live().size, 30);
  const next = [...s.live().keys()].find((relative) => relative !== "d")!;
  unlinkSync(path.join(s.root, next));
  const later = await s.scanner.scan({ paths: [next] });
  assert.equal(later.tombstones, 1, "after a complete scan a delete is a tombstone again");
});

// ---- links in place of folders ----

function linkedFolder(s: Setup): string {
  s.write("a/b.txt", "inside");
  s.write("keep.txt");
  const outside = path.join(s.dir, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "b.txt"), "OUTSIDE CONTENT");
  writeFileSync(path.join(outside, "secret.txt"), "never indexed");
  return outside;
}

function assertNothingFromOutside(s: Setup): void {
  const outside = createHash("sha256").update("OUTSIDE CONTENT").digest("hex");
  assert.equal(s.row("a")!.type, 2, "a is a link now");
  assert.equal(s.row("a/b.txt")!.deleted, true, "what was below the folder is deleted");
  assert.equal(s.row("a/secret.txt"), undefined);
  assert.deepEqual(s.rows().filter((row) => !row.deleted && row.sha256 === outside).map((row) => row.path), [], "content from outside the share was indexed");
}

for (const paths of [["a/b.txt", "a"], ["a/b.txt"]]) {
  test(`a folder replaced by a link is never read through it (events: ${paths.join(", ")})`, async (t) => {
    const s = setup(t);
    const outside = linkedFolder(s);
    await s.scanner.scan("full");
    rmSync(path.join(s.root, "a"), { recursive: true });
    symlinkSync(outside, path.join(s.root, "a"));
    await s.scanner.scan({ paths });
    assertNothingFromOutside(s);
    // Later events and full scans keep it that way, even when the file behind the link changes.
    writeFileSync(path.join(outside, "b.txt"), "OUTSIDE CONTENT, edited");
    await s.scanner.scan({ paths: ["a/b.txt"] });
    s.scanner.requireFullScan();
    await s.scanner.scan("full");
    assert.equal(s.row("a/b.txt")!.deleted, true);
    assert.equal(s.live().size, 2, `live: ${[...s.live().keys()].join(", ")}`);
  });
}

test("a folder replaced by a link between being listed and being walked is not walked through the link", async (t) => {
  const slicer = new HookSlicer();
  const s = setup(t, { slicer });
  const outside = linkedFolder(s);
  s.write("z1.txt");
  s.write("z2.txt");
  await s.scanner.scan("full");
  // Look 1 lists the root, looks 2–5 its four entries; look 6 comes just before "a" is listed.
  slicer.arm(6, () => {
    rmSync(path.join(s.root, "a"), { recursive: true });
    symlinkSync(outside, path.join(s.root, "a"));
  });
  const result = await s.scanner.scan("full");
  assert.equal(result.tombstones, 1);
  assertNothingFromOutside(s);
});

// ---- cost ----

test("a deleted folder's per-file events read its subtree once, not once per file", async (t) => {
  const s = setup(t, { kind: "worktrees" });
  for (let index = 0; index < 20; index++) manyFiles(s, `w1/sub${index}`, 50);
  await s.scanner.scan("full");
  const events = s.rows().map((row) => row.path).reverse();
  rmSync(path.join(s.root, "w1"), { recursive: true });
  let reads = 0;
  const descendants = s.db.descendants.bind(s.db);
  s.db.descendants = (share, prefix) => { reads++; return descendants(share, prefix); };
  const result = await s.scanner.scan({ paths: events });
  assert.equal(result.tombstones, 1021);
  assert.ok(reads <= 2, `the subtree was read ${reads} times for ${events.length} events`);
});

test("scans of many shares share one slice budget, so a timer waits about one slice, not one per share", async () => {
  const scheduler = new SliceScheduler(() => 15);
  let stop = false;
  const spin = async (slicer: Slicer) => {
    while (!stop) {
      for (const until = performance.now() + 1; performance.now() < until;) { /* a slice of scanning */ }
      await slicer.maybeYield();
    }
  };
  const running = Array.from({ length: 8 }, () => spin(new Slicer(scheduler)));
  const timer = () => new Promise<number>((resolve) => { const armed = performance.now(); setTimeout(() => resolve(performance.now() - armed), 0); });
  try {
    await timer();
    const delays = [await timer(), await timer(), await timer()];
    // Each share with its own budget took about 8 × 15 ms between turns of the event loop.
    assert.ok(Math.max(...delays) < 60, `timers fired after ${delays.map((delay) => delay.toFixed(0)).join(", ")} ms`);
  } finally {
    stop = true;
    await Promise.all(running);
  }
});
