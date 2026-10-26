import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsModule, {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { tempNameFor } from "../src/file-sync/apply.js";
import { conflictCopyName, decideGlobal } from "../src/file-sync/conflicts.js";
import { gitExcludeFile } from "../src/file-sync/scanner.js";
import { createWorkerCore, type FileSyncCore } from "../src/file-sync/core.js";
import type { ApplyItemInput, CoreEvent, NeedItem } from "../src/file-sync/protocol.js";
import { Trash } from "../src/file-sync/trash.js";
import { DIRECTORY, FILE, SYMLINK, type Clock, type IndexEntry, type ShareKind } from "../src/file-sync/types.js";
import { canonicalVector, compareVectors, mergeVectors } from "../src/file-sync/vectors.js";

/* §5.5 rule by rule, on real files: one core in builtin phase, peer rows stored as a pull would store them. */

const SELF = "node-a";
const PEER = "node-b";
const darwin = process.platform === "darwin";

function sha(content: string | Buffer): string { return createHash("sha256").update(content).digest("hex"); }

interface Node {
  dir: string;
  root: string;
  dataDir: string;
  key: string;
  core: FileSyncCore;
  clock: Clock & { advance(ms: number): void };
  events: CoreEvent[];
  write(relative: string, content: string, mode?: number): void;
  scan(): Promise<void>;
  /** The next page of the peer's index. */
  pull(entries: Array<Partial<IndexEntry> & { path: string }>): Promise<void>;
  /** A peer version of `relative` that dominates what this node holds. */
  over(relative: string, fields: Partial<IndexEntry>): Partial<IndexEntry> & { path: string };
  download(relative: string, content: string | Buffer): string;
  apply(items: ApplyItemInput[]): Promise<Awaited<ReturnType<FileSyncCore["applier"]["applyBatch"]>>>;
  next(): NeedItem[];
  trashFiles(): Array<{ file: string; content: string }>;
  reopen(faults?: Parameters<typeof createWorkerCore>[0]["faults"]): Promise<void>;
}

function clockAt(start = Date.now()): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, setTimeout: () => ({ cancel() {} }), advance(ms) { now += ms; } };
}

async function node(t: TestContext, options: { kind?: ShareKind; phase?: "builtin" | "syncthing"; faults?: Parameters<typeof createWorkerCore>[0]["faults"]; diskFree?: (dir: string) => number; setup?: (root: string) => void; multiUserLinux?: boolean } = {}): Promise<Node> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-apply-"));
  const root = path.join(dir, "root");
  mkdirSync(root);
  const dataDir = path.join(dir, "data");
  const kind = options.kind ?? "project";
  const key = `${kind}:p1`;
  const clock = clockAt();
  const events: CoreEvent[] = [];
  let seed = 11;
  let seq = 0;
  const make = (faults = options.faults) => createWorkerCore({
    nodeId: SELF, dataDir, clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false,
    emit: (event) => events.push(event), faults, diskFree: options.diskFree,
    ...(options.multiUserLinux ? { multiUser: true, platform: "linux" as const } : {}),
  });
  const configure = (core: FileSyncCore) => core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key, projectId: "p1", kind, root, phase: options.phase ?? "builtin", rules: {}, peers: [PEER] }],
  });
  options.setup?.(root);
  const result: Node = {
    dir, root, dataDir, key, clock, events, core: make(),
    write(relative, content, mode = 0o644) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      chmodSync(file, mode);
      // Old enough that the scanner never waits for it to settle.
      utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    },
    async scan() {
      await result.core.call("scan", { share: key, scope: "full", reason: "test" });
      await result.core.need.idle();
    },
    async pull(entries) {
      const since = result.core.db.cursor(key, PEER)?.seq ?? 0;
      const rows = entries.map((fields): IndexEntry => ({
        type: FILE, size: 0, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: null, target: null, deleted: false, version: { [PEER]: ++seq }, modifiedBy: PEER, ...fields, seq: ++seq,
      }));
      await result.core.need.storeRemote(key, PEER, since, { indexId: "peer-gen", maxSeq: seq, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null, entries: rows, more: false });
      await result.core.need.idle();
    },
    over(relative, fields) {
      const local = result.core.db.entry(key, relative);
      return { path: relative, version: mergeVectors(local?.version ?? {}, { [PEER]: Date.now() * 1000 + ++seq }), ...fields };
    },
    download(relative, content) {
      const parent = result.core.applier.ensureParents(key, relative);
      assert.ok(parent.ok, JSON.stringify(parent));
      const temp = path.join(parent.directory, tempNameFor(key, relative, sha(content)));
      writeFileSync(temp, content);
      return temp;
    },
    apply: (items) => result.core.call("applyBatch", { share: key, items }),
    next: () => result.core.need.nextNeeds({ limit: 100 }).items,
    trashFiles() {
      const found: Array<{ file: string; content: string }> = [];
      const walk = (directory: string) => {
        let names: string[];
        try { names = readdirSync(directory); } catch { return; }
        for (const name of names) {
          const file = path.join(directory, name);
          const st = lstatSync(file);
          if (st.isDirectory()) walk(file);
          else found.push({ file, content: st.isSymbolicLink() ? `link:${readlinkSync(file)}` : readFileSync(file, "utf8") });
        }
      };
      walk(path.join(dataDir, "file-sync", "trash"));
      return found;
    },
    async reopen(faults) {
      await result.core.close();
      result.core = make(faults);
      await configure(result.core);
      await result.scan();
    },
  };
  t.after(async () => { await result.core.close(); rmSync(dir, { recursive: true, force: true }); });
  await configure(result.core);
  await result.scan();
  return result;
}

function onDisk(root: string, relative: string): string { return readFileSync(path.join(root, relative), "utf8"); }

test("a downloaded file is checked, put in place with its mode and mtime, and its row takes the target version", async (t) => {
  const n = await node(t);
  const content = "hello from b";
  await n.pull([
    { path: "sub", type: DIRECTORY, mode: 0o750 },
    { path: "sub/a.txt", size: content.length, sha256: sha(content), mode: 0o640, mtimeMs: 1_700_000_000_123 },
  ]);
  assert.deepEqual(n.next().map((item) => [item.path, item.action, item.sources]), [["sub", "mkdir", []], ["sub/a.txt", "fetch", [PEER]]]);
  const temp = n.download("sub/a.txt", content);
  const result = await n.apply([{ path: "sub/a.txt", tempPath: temp, source: PEER }]);
  assert.deepEqual(result.items, [{ path: "sub/a.txt", outcome: "applied" }]);
  assert.equal(onDisk(n.root, "sub/a.txt"), content);
  const st = statSync(path.join(n.root, "sub/a.txt"));
  assert.equal(st.mode & 0o777, 0o640);
  assert.ok(Math.abs(st.mtimeMs - 1_700_000_000_123) < 2, `mtime ${st.mtimeMs}`);
  assert.equal(existsSync(temp), false);
  const row = n.core.db.entry(n.key, "sub/a.txt")!;
  const remote = n.core.db.remote(n.key, PEER, "sub/a.txt")!;
  assert.deepEqual([canonicalVector(row.version), row.modifiedBy, row.mtimeMs, row.sha256, row.ino], [canonicalVector(remote.version), PEER, 1_700_000_000_123, sha(content), st.ino]);
  // The folder created for it took its own pending mkdir with it.
  assert.equal(statSync(path.join(n.root, "sub")).mode & 0o777, 0o750);
  assert.equal(canonicalVector(n.core.db.entry(n.key, "sub")!.version), canonicalVector(n.core.db.remote(n.key, PEER, "sub")!.version));
  assert.equal(n.core.db.needCount(n.key), 0);
  assert.ok(n.core.suppression.matches(n.key, "sub/a.txt", () => lstatSync(path.join(n.root, "sub/a.txt"))), "the watcher drops its own event");
  // A scan afterwards finds nothing to change.
  const before = n.core.db.share(n.key)!.maxSeq;
  await n.scan();
  assert.equal(n.core.db.share(n.key)!.maxSeq, before);
});

test("a target that moved, a source that left the share, and bytes that do not hash right never reach the tree", async (t) => {
  const n = await node(t);
  await n.pull([{ path: "a.txt", size: 2, sha256: sha("v1"), version: { [PEER]: 10 } }]);
  const temp = n.download("a.txt", "v1");
  // A newer version arrives while the download waited.
  await n.pull([{ path: "a.txt", size: 2, sha256: sha("v2"), version: { [PEER]: 11 } }]);
  const stale = await n.apply([{ path: "a.txt", tempPath: temp, source: PEER }]);
  assert.deepEqual([stale.items[0].outcome, stale.items[0].reason], ["stale", "The download is of another version"]);
  assert.equal(existsSync(temp), false, "a stale temp is discarded");
  assert.equal(existsSync(path.join(n.root, "a.txt")), false);
  assert.equal(n.core.db.needRow(n.key, "a.txt")!.target.sha256, sha("v2"));
  // Revocation wins: bytes from a peer that is not in the share's peer set now.
  const revoked = n.download("a.txt", "v2");
  assert.equal((await n.apply([{ path: "a.txt", tempPath: revoked, source: "node-c" }])).items[0].outcome, "stale");
  assert.equal(existsSync(revoked), false);
  // Bytes that do not match the hash.
  const wrong = path.join(n.root, tempNameFor(n.key, "a.txt", sha("v2")));
  writeFileSync(wrong, "v33");
  const mismatch = await n.apply([{ path: "a.txt", tempPath: wrong, source: PEER }]);
  assert.deepEqual([mismatch.items[0].outcome, mismatch.items[0].reason], ["retry", "The content is not the size the index says"]);
  writeFileSync(wrong, "vX");
  const mismatch2 = await n.apply([{ path: "a.txt", tempPath: wrong, source: PEER }]);
  assert.deepEqual([mismatch2.items[0].outcome, mismatch2.items[0].reason], ["retry", "The content did not match its hash"]);
  assert.equal(existsSync(wrong), false);
  assert.equal(existsSync(path.join(n.root, "a.txt")), false);
  // A temp outside the target's folder is refused, and left alone.
  const elsewhere = path.join(n.dir, tempNameFor(n.key, "a.txt", sha("v2")));
  writeFileSync(elsewhere, "v2");
  assert.equal((await n.apply([{ path: "a.txt", tempPath: elsewhere, source: PEER }])).items[0].outcome, "retry");
  assert.equal(existsSync(elsewhere), true);
});

test("folders made for a download that is no longer wanted go again; a scan then finds nothing new", async (t) => {
  const n = await node(t);
  await n.pull([{ path: "x/y/a.txt", size: 2, sha256: sha("v1") }]);
  const temp = n.download("x/y/a.txt", "v1");
  assert.ok(existsSync(path.join(n.root, "x", "y")), "the download's parents are made before its bytes arrive");
  // The peer deletes the file while it downloads: the need goes; the folders hold the temp until the download ends.
  await n.pull([{ path: "x/y/a.txt", size: 2, sha256: sha("v1"), deleted: true, version: { [PEER]: 1_000 } }]);
  assert.equal(n.core.db.needRow(n.key, "x/y/a.txt"), undefined);
  assert.ok(existsSync(temp));
  assert.equal((await n.apply([{ path: "x/y/a.txt", tempPath: temp, source: PEER }])).items[0].outcome, "stale");
  assert.deepEqual([existsSync(temp), existsSync(path.join(n.root, "x"))], [false, false], "the temp and both folders made for it are gone");
  const before = n.core.db.share(n.key)!.maxSeq;
  await n.scan();
  assert.equal(n.core.db.share(n.key)!.maxSeq, before, "no folder is left for a scan to bring back");
  // A folder that existed before, or holds something, is never removed.
  mkdirSync(path.join(n.root, "kept"));
  await n.pull([{ path: "kept/b.txt", size: 2, sha256: sha("v2") }, { path: "made/c.txt", size: 2, sha256: sha("v3") }]);
  n.download("kept/b.txt", "v2");
  n.download("made/c.txt", "v3");
  writeFileSync(path.join(n.root, "made", "mine.txt"), "someone's");
  await n.pull([{ path: "kept/b.txt", size: 2, sha256: sha("v2"), deleted: true, version: { [PEER]: 2_000 } }, { path: "made/c.txt", size: 2, sha256: sha("v3"), deleted: true, version: { [PEER]: 2_001 } }]);
  for (const relative of ["kept/b.txt", "made/c.txt"]) await n.apply([{ path: relative, tempPath: path.join(n.root, path.dirname(relative), tempNameFor(n.key, relative, sha(relative === "kept/b.txt" ? "v2" : "v3"))), source: PEER }]);
  assert.deepEqual([existsSync(path.join(n.root, "kept")), readdirSync(path.join(n.root, "made"))], [true, ["mine.txt"]]);
});

test("nothing is written through a symlinked parent", async (t) => {
  const outside = mkdtempSync(path.join(os.tmpdir(), "jb-fs-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const n = await node(t, { setup: (root) => symlinkSync(outside, path.join(root, "link")) });
  await n.pull([{ path: "link/x.txt", size: 1, sha256: sha("x") }, { path: "y.txt", size: 1, sha256: sha("y") }]);
  const parent = n.core.applier.ensureParents(n.key, "link/x.txt");
  assert.deepEqual(parent, { ok: false, reason: "A folder above it is a symbolic link here", permanent: true });
  const result = await n.apply([{ path: "link/x.txt", localSource: { share: n.key, path: "nothing" } }]);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason], ["blocked", "A folder above it is a symbolic link here"]);
  assert.deepEqual(readdirSync(outside), []);
});

test("darwin: a case-variant parent and a case collision are blocked; a case-only rename moves the file", { skip: !darwin && "APFS is case-insensitive; ext4 is not" }, async (t) => {
  const n = await node(t, { setup: (root) => { mkdirSync(path.join(root, "Docs")); writeFileSync(path.join(root, "Docs/a.txt"), "a"); writeFileSync(path.join(root, "README.md"), "readme"); writeFileSync(path.join(root, "Notes.md"), "notes"); } });
  await n.pull([
    { path: "docs", type: DIRECTORY, mode: 0o755 },
    { path: "docs/new.txt", size: 3, sha256: sha("new") },
    { path: "readme.md", size: 5, sha256: sha("other") },
  ]);
  const parent = n.core.applier.ensureParents(n.key, "docs/new.txt");
  assert.deepEqual(parent, { ok: false, reason: "A folder above it differs only in case here", permanent: true });
  const collision = await n.apply([{ path: "readme.md", localSource: { share: n.key, path: "README.md" } }, { path: "docs/new.txt", localSource: { share: n.key, path: "Docs/a.txt" } }]);
  assert.deepEqual(collision.items.map((item) => [item.outcome, item.reason]), [
    ["blocked", "Another name in this folder differs only in case (README.md)"],
    ["blocked", "A folder above it differs only in case here"],
  ]);
  assert.equal(onDisk(n.root, "README.md"), "readme");
  // Notes.md → NOTES.md on the peer: one move, the same inode under the new spelling.
  const inode = lstatSync(path.join(n.root, "Notes.md")).ino;
  await n.pull([n.over("Notes.md", { deleted: true, size: 5, sha256: sha("notes") }), { path: "NOTES.md", size: 5, sha256: sha("notes"), mtimeMs: lstatSync(path.join(n.root, "Notes.md")).mtimeMs }]);
  const move = n.next().find((item) => item.path === "NOTES.md")!;
  assert.deepEqual([move.action, move.fromPath], ["move", "Notes.md"]);
  assert.deepEqual((await n.apply([{ path: "NOTES.md", move: true }])).items, [{ path: "NOTES.md", outcome: "applied" }]);
  assert.ok(readdirSync(n.root).includes("NOTES.md") && !readdirSync(n.root).includes("Notes.md"));
  assert.equal(lstatSync(path.join(n.root, "NOTES.md")).ino, inode);
  assert.equal(n.core.db.entry(n.key, "Notes.md")!.deleted, true);
});

test("a losing local version becomes the deterministic conflict copy; at most ten copies, the oldest go to the trash", async (t) => {
  const n = await node(t, { setup: (root) => { writeFileSync(path.join(root, "c.txt"), "mine"); writeFileSync(path.join(root, "d.txt"), "mine too"); } });
  const loser = n.core.db.entry(n.key, "c.txt")!;
  // Concurrent, newer mtime: the peer's version wins, this node is the loser.
  await n.pull([{ path: "c.txt", size: 6, sha256: sha("theirs"), version: { [PEER]: 5 }, mtimeMs: loser.mtimeMs + 10_000 }]);
  const item = n.next()[0];
  assert.deepEqual([item.action, item.conflict], ["fetch", true]);
  assert.equal((await n.apply([{ path: "c.txt", tempPath: n.download("c.txt", "theirs"), source: PEER }])).items[0].outcome, "applied");
  const copy = conflictCopyName("c.txt", loser);
  assert.equal(onDisk(n.root, "c.txt"), "theirs");
  // A lost conflict ends in a version of its own, above both and never just their union: with three nodes another one
  // can reach that union deciding the other way over other rows, and one vector would then mean two contents.
  const resolved = n.core.db.entry(n.key, "c.txt")!;
  assert.equal(compareVectors(resolved.version, mergeVectors(loser.version, { [PEER]: 5 })), "greater");
  assert.deepEqual([resolved.sha256, resolved.modifiedBy], [sha("theirs"), PEER]);
  assert.equal(onDisk(n.root, copy), "mine");
  const copyRow = n.core.db.entry(n.key, copy)!;
  assert.deepEqual([copyRow.deleted, copyRow.sha256, copyRow.modifiedBy], [false, sha("mine"), SELF]);
  assert.deepEqual(n.trashFiles(), [], "the loser is kept as a copy, not in the trash");

  // Ten older copies of d.txt already: the eleventh pushes the oldest to the trash.
  const dLoser = n.core.db.entry(n.key, "d.txt")!;
  for (let index = 0; index < 10; index++) n.write(conflictCopyName("d.txt", { mtimeMs: dLoser.mtimeMs - (index + 1) * 86_400_000, modifiedBy: `old-${index}` }), `old ${index}`);
  await n.scan();
  await n.pull([{ path: "d.txt", size: 6, sha256: sha("theirs"), version: { [PEER]: 6 }, mtimeMs: dLoser.mtimeMs + 10_000 }]);
  assert.equal((await n.apply([{ path: "d.txt", tempPath: n.download("d.txt", "theirs"), source: PEER }])).items[0].outcome, "applied");
  const copies = readdirSync(n.root).filter((name) => name.startsWith("d.sync-conflict-"));
  assert.equal(copies.length, 10);
  assert.ok(copies.includes(conflictCopyName("d.txt", dLoser)));
  assert.deepEqual(n.trashFiles().map((file) => file.content), ["old 9"], "the oldest copy went to the trash");
  assert.equal(n.core.db.entry(n.key, conflictCopyName("d.txt", { mtimeMs: dLoser.mtimeMs - 10 * 86_400_000, modifiedBy: "old-9" }))!.deleted, true);
});

test("an overwrite and a delete keep the previous content in the trash; worktree bulk does not, its metadata does", async (t) => {
  const n = await node(t, { setup: (root) => { writeFileSync(path.join(root, "o.txt"), "old"); writeFileSync(path.join(root, "gone.txt"), "bye"); } });
  await n.pull([n.over("o.txt", { size: 3, sha256: sha("new") }), n.over("gone.txt", { deleted: true, size: 3, sha256: sha("bye") })]);
  assert.deepEqual(n.next().map((item) => [item.path, item.action, item.conflict]), [["o.txt", "fetch", false], ["gone.txt", "delete", false]]);
  const result = await n.apply([{ path: "o.txt", tempPath: n.download("o.txt", "new"), source: PEER }, { path: "gone.txt" }]);
  assert.deepEqual(result.items.map((item) => item.outcome), ["applied", "applied"]);
  assert.equal(onDisk(n.root, "o.txt"), "new");
  assert.equal(existsSync(path.join(n.root, "gone.txt")), false);
  assert.deepEqual(n.trashFiles().map((file) => file.content).sort(), ["bye", "old"]);
  assert.equal(n.core.db.entry(n.key, "gone.txt")!.deleted, true);
  // The trash is a local source for that content now.
  await n.pull([{ path: "back.txt", size: 3, sha256: sha("bye") }]);
  const back = n.next().find((item) => item.path === "back.txt")!;
  const fromTrash = back.localSources.find((source) => "trash" in source)!;
  assert.ok(fromTrash, JSON.stringify(back.localSources));
  assert.equal((await n.apply([{ path: "back.txt", localSource: fromTrash }])).items[0].outcome, "applied");
  assert.equal(onDisk(n.root, "back.txt"), "bye");

  const w = await node(t, { kind: "worktrees", setup: (root) => { mkdirSync(path.join(root, "wt/.joint-bob-worktree"), { recursive: true }); writeFileSync(path.join(root, "wt/a.ts"), "bulk"); writeFileSync(path.join(root, "wt/.joint-bob-worktree/meta.json"), "{}"); } });
  await w.pull([w.over("wt/a.ts", { size: 5, sha256: sha("bulk2") }), w.over("wt/.joint-bob-worktree/meta.json", { size: 4, sha256: sha('{"a"') })]);
  const wt = await w.apply([{ path: "wt/a.ts", tempPath: w.download("wt/a.ts", "bulk2"), source: PEER }, { path: "wt/.joint-bob-worktree/meta.json", tempPath: w.download("wt/.joint-bob-worktree/meta.json", '{"a"'), source: PEER }]);
  assert.deepEqual(wt.items.map((item) => item.outcome), ["applied", "applied"]);
  assert.deepEqual(w.trashFiles().map((file) => file.content), ["{}"], "worktree bulk is disposable; its metadata is kept");
});

test("a folder delete refuses local-only content, removes regenerable content without the trash, and keeps a folder holding files nobody deleted", async (t) => {
  const n = await node(t, { setup: (root) => {
    mkdirSync(path.join(root, "d"));
    writeFileSync(path.join(root, "d/a.txt"), "a");
    writeFileSync(path.join(root, "d/.env"), "SECRET=1");
    mkdirSync(path.join(root, "e/node_modules/x"), { recursive: true });
    writeFileSync(path.join(root, "e/b.txt"), "b");
    writeFileSync(path.join(root, "e/node_modules/x/y.js"), "y");
    mkdirSync(path.join(root, "f"));
    writeFileSync(path.join(root, "f/new-here.txt"), "newer");
    mkdirSync(path.join(root, "g"));
    writeFileSync(path.join(root, "g/.env"), "SECRET=2");
    writeFileSync(path.join(root, "g/kept.txt"), "kept");
  } });
  const dir = (relative: string) => n.over(relative, { type: DIRECTORY, deleted: true, mode: 0o755 });
  await n.pull([dir("d"), n.over("d/a.txt", { deleted: true, size: 1, sha256: sha("a") }), dir("e"), n.over("e/b.txt", { deleted: true, size: 1, sha256: sha("b") }), dir("f"), dir("g")]);
  // f/new-here.txt is newer here than the peer's delete of f: it stays, and so does f. g also holds local-only content, which
  // alone would block it; its synced file nobody deleted keeps it all the same (blocked here, the peer would wait under a file forever).
  assert.deepEqual(n.next().map((item) => item.path), ["d/a.txt", "e/b.txt", "d", "e", "f", "g"]);
  const result = await n.apply(n.next().map((item) => ({ path: item.path })));
  assert.deepEqual(result.items.map((item) => [item.path, item.outcome, item.reason]), [
    ["d/a.txt", "applied", undefined], ["e/b.txt", "applied", undefined],
    ["d", "blocked", "A folder with local-only files is in the way"],
    ["e", "applied", undefined],
    ["f", "stale", "The folder holds files changed here: it stays"],
    ["g", "stale", "The folder holds files changed here: it stays"],
  ]);
  assert.equal(compareVectors(n.core.db.entry(n.key, "g")!.version, n.core.db.remote(n.key, PEER, "g")!.version), "greater");
  // A modification beats a delete: f now has a version above the peer's delete, so the peer gets it back.
  assert.equal(compareVectors(n.core.db.entry(n.key, "f")!.version, n.core.db.remote(n.key, PEER, "f")!.version), "greater");
  assert.equal(n.core.db.needRow(n.key, "f"), undefined);
  assert.equal(readFileSync(path.join(n.root, "d/.env"), "utf8"), "SECRET=1");
  assert.equal(existsSync(path.join(n.root, "e")), false);
  assert.equal(onDisk(n.root, "f/new-here.txt"), "newer");
  assert.deepEqual(n.trashFiles().map((file) => file.content).sort(), ["a", "b"], "synced files through the trash, node_modules not");
  assert.equal(n.core.db.entry(n.key, "e")!.deleted, true);
  assert.equal(n.core.db.entry(n.key, "d")!.deleted, false);
});

test("a file in the way of a folder is waited for while a need row replaces it, and blocked while nothing will", async (t) => {
  const n = await node(t, { setup: (root) => { writeFileSync(path.join(root, "h"), "mine, newer"); writeFileSync(path.join(root, "k"), "replaced"); } });
  const old = 1_600_000_000_000;
  await n.pull([
    // The peer's folder h loses to the local file h (concurrent, older): nothing here will make h a folder.
    { path: "h", type: DIRECTORY, mode: 0o755, mtimeMs: old }, { path: "h/inner.txt", size: 5, sha256: sha("inner") },
    // The peer's folder k replaces the local file k: its contents wait for that.
    n.over("k", { type: DIRECTORY, mode: 0o755 }), { path: "k/inner.txt", size: 5, sha256: sha("inner") },
  ]);
  assert.equal(n.core.db.needRow(n.key, "h"), undefined);
  assert.deepEqual(n.core.applier.ensureParents(n.key, "h/inner.txt"), { ok: false, reason: "A folder above it is a file here", permanent: true });
  assert.deepEqual(n.core.applier.ensureParents(n.key, "k/inner.txt"), { ok: false, reason: "A folder above it is a file here", permanent: false });
  // Applied together, the folder goes first and its contents follow at once.
  const items = n.next().filter((item) => item.path.startsWith("k"));
  assert.deepEqual(items.map((item) => [item.path, item.action]), [["k", "mkdir"], ["k/inner.txt", "fetch"]]);
  assert.deepEqual((await n.apply([{ path: "k" }])).items.map((item) => item.outcome), ["applied"]);
  assert.equal((await n.apply([{ path: "k/inner.txt", tempPath: n.download("k/inner.txt", "inner"), source: PEER }])).items[0].outcome, "applied");
  assert.equal(onDisk(n.root, "k/inner.txt"), "inner");
  assert.deepEqual(n.trashFiles().map((file) => file.content), ["replaced"]);
});

test("type changes: file to folder, folder to file, file to link, link to file", async (t) => {
  const n = await node(t, { setup: (root) => {
    writeFileSync(path.join(root, "t1"), "file one");
    mkdirSync(path.join(root, "t2"));
    writeFileSync(path.join(root, "t2/a.txt"), "inside");
    writeFileSync(path.join(root, "t3"), "file three");
    symlinkSync("somewhere", path.join(root, "t4"));
  } });
  await n.pull([
    n.over("t1", { type: DIRECTORY, mode: 0o755 }), { path: "t1/inner.txt", size: 5, sha256: sha("inner") },
    n.over("t2/a.txt", { deleted: true, size: 6, sha256: sha("inside") }), n.over("t2", { size: 3, sha256: sha("now") }),
    n.over("t3", { type: SYMLINK, target: "../elsewhere", mode: 0 }),
    n.over("t4", { size: 4, sha256: sha("real"), type: FILE }),
  ]);
  // t1/inner.txt cannot be placed while t1 is a file: it waits for t1's mkdir.
  assert.deepEqual(n.core.applier.ensureParents(n.key, "t1/inner.txt"), { ok: false, reason: "A folder above it is a file here", permanent: false });
  const first = await n.apply([
    { path: "t1" }, { path: "t2", tempPath: n.download("t2", "now"), source: PEER }, { path: "t2/a.txt" }, { path: "t3" },
    { path: "t4", tempPath: n.download("t4", "real"), source: PEER },
  ]);
  assert.deepEqual(first.items.map((item) => [item.path, item.outcome]), [["t1", "applied"], ["t2", "applied"], ["t2/a.txt", "applied"], ["t3", "applied"], ["t4", "applied"]]);
  assert.ok(statSync(path.join(n.root, "t1")).isDirectory());
  assert.equal(onDisk(n.root, "t2"), "now");
  assert.equal(readlinkSync(path.join(n.root, "t3")), "../elsewhere");
  assert.ok(lstatSync(path.join(n.root, "t4")).isFile());
  assert.deepEqual(n.trashFiles().map((file) => file.content).sort(), ["file one", "file three", "inside", "link:somewhere"]);
  assert.equal((await n.apply([{ path: "t1/inner.txt", tempPath: n.download("t1/inner.txt", "inner"), source: PEER }])).items[0].outcome, "applied");
  assert.equal(n.core.db.needCount(n.key), 0);
  const before = n.core.db.share(n.key)!.maxSeq;
  await n.scan();
  assert.equal(n.core.db.share(n.key)!.maxSeq, before, "the tree is what the index says");
});

test("a mode-only change is a chmod in place: no temp, no trash, same inode", async (t) => {
  const n = await node(t, { setup: (root) => { writeFileSync(path.join(root, "m.sh"), "echo"); chmodSync(path.join(root, "m.sh"), 0o644); } });
  const inode = lstatSync(path.join(n.root, "m.sh")).ino;
  await n.pull([n.over("m.sh", { size: 4, sha256: sha("echo"), mode: 0o755 })]);
  assert.deepEqual(n.next().map((item) => [item.path, item.action]), [["m.sh", "meta"]]);
  assert.equal((await n.apply([{ path: "m.sh" }])).items[0].outcome, "applied");
  const st = lstatSync(path.join(n.root, "m.sh"));
  assert.deepEqual([st.mode & 0o777, st.ino], [0o755, inode]);
  assert.deepEqual(n.trashFiles(), []);
  assert.equal(n.core.db.entry(n.key, "m.sh")!.mode, 0o755);
});

test("a rename moves the file (0 bytes copied); a local copy is cloned from another path", async (t) => {
  const n = await node(t, { setup: (root) => { mkdirSync(path.join(root, "m")); writeFileSync(path.join(root, "m/old.txt"), "moved bytes"); writeFileSync(path.join(root, "same.txt"), "same bytes"); } });
  const inode = lstatSync(path.join(n.root, "m/old.txt")).ino;
  const mtime = lstatSync(path.join(n.root, "m/old.txt")).mtimeMs;
  await n.pull([n.over("m/old.txt", { deleted: true, size: 11, sha256: sha("moved bytes") }), { path: "n", type: DIRECTORY, mode: 0o755 }, { path: "n/new.txt", size: 11, sha256: sha("moved bytes"), mtimeMs: mtime }, { path: "copy.txt", size: 10, sha256: sha("same bytes") }]);
  const items = n.next();
  assert.deepEqual(items.map((item) => [item.path, item.action, item.fromPath ?? null]), [["n", "mkdir", null], ["copy.txt", "fetch", null], ["n/new.txt", "move", "m/old.txt"]]);
  const copy = items.find((item) => item.path === "copy.txt")!;
  assert.deepEqual(copy.localSources, [{ share: n.key, path: "same.txt" }]);
  const result = await n.apply([{ path: "n/new.txt", move: true }, { path: "copy.txt", localSource: copy.localSources[0] }]);
  assert.deepEqual(result.items.map((item) => item.outcome), ["applied", "applied"]);
  assert.equal(lstatSync(path.join(n.root, "n/new.txt")).ino, inode);
  assert.equal(existsSync(path.join(n.root, "m/old.txt")), false);
  assert.equal(onDisk(n.root, "copy.txt"), "same bytes");
  assert.equal(n.core.db.entry(n.key, "m/old.txt")!.deleted, true);
  assert.deepEqual(n.trashFiles(), [], "a moved file needs no trash: its bytes are the new path");
  assert.equal(n.core.db.needCount(n.key), 0);
});

test("a crash between temp and rename leaves a temp the next start uses; a crash after the rename converges without a conflict", async (t) => {
  let crash: "before" | "after" | undefined = "before";
  const faults = { beforeRename: () => { if (crash === "before") throw new Error("crash before rename"); }, afterRename: () => { if (crash === "after") throw new Error("crash after rename"); } };
  const n = await node(t, { faults, setup: (root) => { writeFileSync(path.join(root, "x.txt"), "x0"); writeFileSync(path.join(root, "y.txt"), "y0"); } });
  await n.pull([n.over("x.txt", { size: 2, sha256: sha("x1") }), n.over("y.txt", { size: 2, sha256: sha("y1") })]);
  const temp = n.download("x.txt", "x1");
  await assert.rejects(n.apply([{ path: "x.txt", tempPath: temp, source: PEER }]), /crash before rename/);
  assert.equal(onDisk(n.root, "x.txt"), "x0");
  assert.ok(existsSync(temp), "the deterministic temp stays for the next try");
  crash = undefined;
  await n.reopen(faults);
  assert.equal(onDisk(n.root, "x.txt"), "x0", "the rescan saw no change: the temp is ignored");
  const again = n.next().find((item) => item.path === "x.txt")!;
  assert.equal(again.action, "fetch");
  assert.equal((await n.apply([{ path: "x.txt", tempPath: temp, source: PEER }])).items[0].outcome, "applied");
  assert.equal(onDisk(n.root, "x.txt"), "x1");

  crash = "after";
  await assert.rejects(n.apply([{ path: "y.txt", tempPath: n.download("y.txt", "y1"), source: PEER }]), /crash after rename/);
  assert.equal(onDisk(n.root, "y.txt"), "y1", "renamed, not recorded");
  crash = undefined;
  await n.reopen(faults);
  const row = n.core.db.entry(n.key, "y.txt")!;
  assert.equal(row.sha256, sha("y1"));
  assert.equal(n.core.db.needRow(n.key, "y.txt"), undefined, "the same content merged: nothing left to do");
  assert.ok(!readdirSync(n.root).some((name) => name.includes("sync-conflict")), "no conflict copy");
  assert.equal(n.core.db.needCount(n.key), 0);
});

test("below the disk floor a local copy is refused, to be tried again later", async (t) => {
  const n = await node(t, { diskFree: () => 1024, setup: (root) => writeFileSync(path.join(root, "src.txt"), "content") });
  await n.pull([{ path: "dst.txt", size: 7, sha256: sha("content") }]);
  const item = n.next()[0];
  const result = await n.apply([{ path: "dst.txt", localSource: item.localSources[0] }]);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason, result.items[0].retryAfterMs], ["blocked", "Not enough free disk space", 60_000]);
  assert.equal(existsSync(path.join(n.root, "dst.txt")), false);
  assert.ok(!readdirSync(n.root).some((name) => name.endsWith(".tmp")));
});

test("shadow mode writes nothing into the tree; builtin housekeeping only in builtin", async (t) => {
  const stale = ".joint-bob-sync.old.0123456789abcdef.tmp";
  const setup = (root: string) => {
    writeFileSync(path.join(root, stale), "partial");
    utimesSync(path.join(root, stale), new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000));
    execFileSync("git", ["init", "-q", root]);
  };
  const shadow = await node(t, { phase: "syncthing", setup });
  await shadow.pull([{ path: "a.txt", size: 1, sha256: sha("a") }]);
  assert.equal(shadow.core.db.needCount(shadow.key), 0);
  const temp = path.join(shadow.root, tempNameFor(shadow.key, "a.txt", sha("a")));
  writeFileSync(temp, "a");
  assert.equal((await shadow.apply([{ path: "a.txt", tempPath: temp, source: PEER }])).items[0].outcome, "stale");
  assert.ok(existsSync(temp) && existsSync(path.join(shadow.root, stale)), "not even a temp is removed in shadow mode");
  assert.equal(existsSync(path.join(shadow.root, "a.txt")), false);
  assert.ok(!readFileSync(path.join(shadow.root, ".git/info/exclude"), "utf8").includes(".joint-bob-sync.*.tmp"));

  const builtin = await node(t, { setup });
  assert.equal(existsSync(path.join(builtin.root, stale)), false, "an engine temp idle for over an hour goes");
  for (let attempt = 0; attempt < 50 && !readFileSync(path.join(builtin.root, ".git/info/exclude"), "utf8").includes(".joint-bob-sync.*.tmp"); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(readFileSync(path.join(builtin.root, ".git/info/exclude"), "utf8").split("\n").includes(".joint-bob-sync.*.tmp"));
});

test("a file edited under an apply is never overwritten unseen: changed, scanned, then kept as the conflict loser", async (t) => {
  const n = await node(t, { setup: (root) => writeFileSync(path.join(root, "e.txt"), "base") });
  await n.pull([n.over("e.txt", { size: 6, sha256: sha("theirs"), mtimeMs: Date.now() + 3_600_000 })]);
  const temp = n.download("e.txt", "theirs");
  // Someone writes the file after the scan, before the apply.
  writeFileSync(path.join(n.root, "e.txt"), "edited here");
  const result = await n.apply([{ path: "e.txt", tempPath: temp, source: PEER }]);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason], ["changed", "It changed on disk"]);
  assert.equal(onDisk(n.root, "e.txt"), "edited here");
  assert.ok(existsSync(temp), "the downloaded bytes stay for the retry");
  // The scan apply asked for records the edit: concurrent with the peer's version, which wins by mtime.
  for (let attempt = 0; attempt < 100 && n.core.db.entry(n.key, "e.txt")!.sha256 !== sha("edited here"); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  const edited = n.core.db.entry(n.key, "e.txt")!;
  assert.equal(edited.sha256, sha("edited here"));
  assert.deepEqual(n.next().find((candidate) => candidate.path === "e.txt"), undefined, "apply recorded a short backoff");
  n.clock.advance(2001);
  const item = n.next().find((candidate) => candidate.path === "e.txt")!;
  assert.deepEqual([item.action, item.conflict], ["fetch", true]);
  assert.equal((await n.apply([{ path: "e.txt", tempPath: temp, source: PEER }])).items[0].outcome, "applied");
  assert.equal(onDisk(n.root, "e.txt"), "theirs");
  assert.equal(onDisk(n.root, conflictCopyName("e.txt", edited)), "edited here");
});

test("a file someone writes while apply places a version is never lost: before the rename the item stops, after it the write is a newer version", async (t) => {
  // The fault hooks stand for the moments right before and right after the rename: someone writes the target there.
  const writes = new Map<string, { at: "beforeRename" | "afterRename"; content: string }>();
  const racing = (at: "beforeRename" | "afterRename") => (file: string) => {
    const write = writes.get(path.basename(file));
    if (write?.at !== at) return;
    writes.delete(path.basename(file));
    writeFileSync(file, write.content);
  };
  const n = await node(t, { faults: { beforeRename: racing("beforeRename"), afterRename: racing("afterRename") }, setup: (root) => writeFileSync(path.join(root, "u.txt"), "u0") });
  await n.pull([
    { path: "new.txt", size: 6, sha256: sha("theirs") },
    n.over("u.txt", { size: 2, sha256: sha("u1") }),
    { path: "after.txt", size: 6, sha256: sha("placed") },
  ]);

  // A new file written into the free name: a hard link never replaces it (a rename would have, unseen).
  writes.set("new.txt", { at: "beforeRename", content: "mine, just now" });
  const newTemp = n.download("new.txt", "theirs");
  assert.deepEqual((await n.apply([{ path: "new.txt", tempPath: newTemp, source: PEER }])).items.map((item) => item.outcome), ["changed"]);
  assert.equal(onDisk(n.root, "new.txt"), "mine, just now");
  // An indexed file written in place: looked at again after that moment, before it is kept or replaced.
  writes.set("u.txt", { at: "beforeRename", content: "edited in place" });
  assert.deepEqual((await n.apply([{ path: "u.txt", tempPath: n.download("u.txt", "u1"), source: PEER }])).items.map((item) => item.outcome), ["changed"]);
  assert.equal(onDisk(n.root, "u.txt"), "edited in place");
  assert.deepEqual(n.trashFiles(), [], "nothing was kept or replaced");

  // Written over once in place: applied, but indexed so that the next scan hashes it, and the write becomes its own version.
  writes.set("after.txt", { at: "afterRename", content: "written after" });
  assert.deepEqual((await n.apply([{ path: "after.txt", tempPath: n.download("after.txt", "placed"), source: PEER }])).items.map((item) => item.outcome), ["applied"]);
  assert.equal(onDisk(n.root, "after.txt"), "written after");
  assert.equal(n.core.suppression.matches(n.key, "after.txt", () => lstatSync(path.join(n.root, "after.txt"))), false, "the watcher's event for the write is not dropped");
  await n.scan();
  const row = n.core.db.entry(n.key, "after.txt")!;
  assert.equal(row.sha256, sha("written after"));
  assert.equal(compareVectors(row.version, n.core.db.remote(n.key, PEER, "after.txt")!.version), "greater", "the write is newer than the version it replaced");
  for (const relative of ["new.txt", "u.txt"]) assert.notEqual(n.core.db.entry(n.key, relative)?.sha256, undefined);
  assert.equal(n.core.db.entry(n.key, "new.txt")!.sha256, sha("mine, just now"));
  assert.equal(n.core.db.entry(n.key, "u.txt")!.sha256, sha("edited in place"));
});

test("the trash keeps a file under a name that was a trashed file the same day", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-trash-twin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trash = new Trash({ dataDir: path.join(dir, "data"), clock: clockAt() });
  writeFileSync(path.join(dir, "d0"), "was a file");
  const first = trash.preserve("project:p1", "d0", path.join(dir, "d0"));
  rmSync(path.join(dir, "d0"));
  mkdirSync(path.join(dir, "d0"));
  writeFileSync(path.join(dir, "d0/f5"), "below the folder that took its name");
  const second = trash.preserve("project:p1", "d0/f5", path.join(dir, "d0/f5"));
  assert.equal(readFileSync(first, "utf8"), "was a file");
  assert.equal(readFileSync(second, "utf8"), "below the folder that took its name");
  assert.equal(path.basename(path.dirname(second)), "d0~1");
});

/** Runs `run` with one node:fs function wrapped (apply imports it by name: the ESM exports are synced both ways). */
async function withFs<K extends "copyFileSync" | "renameSync" | "linkSync" | "symlinkSync" | "openSync", T>(name: K, wrap: (original: typeof fsModule[K]) => typeof fsModule[K], run: () => Promise<T>): Promise<T> {
  const original = fsModule[name];
  (fsModule as unknown as Record<string, unknown>)[name] = wrap(original);
  syncBuiltinESMExports();
  try { return await run(); } finally {
    (fsModule as unknown as Record<string, unknown>)[name] = original;
    syncBuiltinESMExports();
  }
}

test("what an apply keeps is never pruned by its own trash budget: a version bigger than the budget, and a folder whose files together are", async (t) => {
  // diskFree 1000: the budget is 25 % of (free + trash), far below what these keep.
  const big = "A".repeat(4000);
  const n = await node(t, { diskFree: () => 1000, setup: (root) => {
    writeFileSync(path.join(root, "big.bin"), big);
    writeFileSync(path.join(root, "gone.bin"), "B".repeat(4000));
    mkdirSync(path.join(root, "d"));
    for (let index = 0; index < 10; index++) writeFileSync(path.join(root, `d/f${index}`), String(index).repeat(300));
  } });
  await n.pull([
    n.over("big.bin", { size: 3, sha256: sha("new") }),
    n.over("gone.bin", { deleted: true, size: 4000, sha256: sha("B".repeat(4000)) }),
    ...Array.from({ length: 10 }, (_, index) => n.over(`d/f${index}`, { deleted: true, size: 300, sha256: sha(String(index).repeat(300)) })),
    n.over("d", { deleted: true, type: DIRECTORY }),
  ]);
  const result = await n.apply([{ path: "big.bin", tempPath: n.download("big.bin", "new"), source: PEER }, { path: "gone.bin" }, { path: "d" }]);
  assert.deepEqual(result.items.map((item) => item.outcome), ["applied", "applied", "applied"]);
  const kept = n.trashFiles().map((file) => file.content).sort();
  assert.deepEqual(kept, [...Array.from({ length: 10 }, (_, index) => String(index).repeat(300)), big, "B".repeat(4000)].sort(), "every previous version is in the trash");
  // The next batch that keeps something prunes the old ones (a soft cap), never its own.
  n.write("later.txt", "later");
  await n.scan();
  await n.pull([n.over("later.txt", { deleted: true, size: 5, sha256: sha("later") })]);
  assert.equal((await n.apply([{ path: "later.txt" }])).items[0].outcome, "applied");
  const left = n.trashFiles().map((file) => file.content);
  assert.ok(left.includes("later"));
  assert.ok(!left.includes(big) && !left.includes("B".repeat(4000)), "the oldest went first");
  // 25 % of (1000 free + 11005 kept) = 3001, pruned down to 90 % of it.
  assert.equal(left.reduce((sum, content) => sum + content.length, 0), 2405);
});

test("below the disk floor a refused local copy leaves the trash as it was (pruning could not have made room)", async (t) => {
  const n = await node(t, { diskFree: () => 1024 ** 3, setup: (root) => { writeFileSync(path.join(root, "gone.txt"), "only copy of this"); writeFileSync(path.join(root, "src.txt"), "content"); } });
  await n.pull([n.over("gone.txt", { deleted: true, size: 17, sha256: sha("only copy of this") })]);
  assert.equal((await n.apply([{ path: "gone.txt" }])).items[0].outcome, "applied");
  await n.pull([{ path: "dup.txt", size: 7, sha256: sha("content") }]);
  const item = n.next().find((candidate) => candidate.path === "dup.txt")!;
  const local = item.localSources.find((source) => "share" in source)!;
  const result = await n.apply([{ path: "dup.txt", localSource: local }]);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason], ["blocked", "Not enough free disk space"]);
  assert.deepEqual(n.trashFiles().map((file) => file.content), ["only copy of this"]);
});

test("a file saved while its conflict copy is made: the copy goes and the item stops, so no row claims the loser's hash for other bytes", async (t) => {
  const n = await node(t, { setup: (root) => writeFileSync(path.join(root, "c.txt"), "mine") });
  const loser = n.core.db.entry(n.key, "c.txt")!;
  await n.pull([{ path: "c.txt", size: 6, sha256: sha("theirs"), version: { [PEER]: 5 }, mtimeMs: loser.mtimeMs + 10_000 }]);
  const temp = n.download("c.txt", "theirs");
  let fired = false;
  const result = await withFs("copyFileSync", (original) => ((from: string, to: string, mode?: number) => {
    // The agent's save (truncate and write, same inode) lands as the clone starts.
    if (!fired && String(to).includes(".sync-conflict-")) { fired = true; writeFileSync(String(from), "agent's newer text"); }
    return original(from, to, mode);
  }) as typeof fsModule.copyFileSync, () => n.apply([{ path: "c.txt", tempPath: temp, source: PEER }]));
  assert.equal(fired, true);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason], ["changed", "It changed on disk while its conflict copy was made"]);
  assert.equal(onDisk(n.root, "c.txt"), "agent's newer text");
  assert.equal(existsSync(path.join(n.root, conflictCopyName("c.txt", loser))), false);
  assert.equal(n.core.db.entry(n.key, conflictCopyName("c.txt", loser)), undefined);
  assert.deepEqual(n.trashFiles(), []);
});

test("a file saved inside a folder being cleared keeps its edit; one saved as its own delete moves it goes back in place", async (t) => {
  const n = await node(t, { setup: (root) => {
    mkdirSync(path.join(root, "d"));
    writeFileSync(path.join(root, "d/a.txt"), "a");
    writeFileSync(path.join(root, "d/b.txt"), "b");
    writeFileSync(path.join(root, "gone.txt"), "bye");
  } });
  await n.pull([
    n.over("d/a.txt", { deleted: true, size: 1, sha256: sha("a") }), n.over("d/b.txt", { deleted: true, size: 1, sha256: sha("b") }), n.over("d", { deleted: true, type: DIRECTORY }),
    n.over("gone.txt", { deleted: true, size: 3, sha256: sha("bye") }),
  ]);
  const gone = path.join(n.root, "gone.txt");
  const fired: string[] = [];
  const result = await withFs("renameSync", (original) => ((from: fsModule.PathLike, to: fsModule.PathLike) => {
    // The folder goes deepest first, in reverse key order: d/b.txt moves into the trash first, and d/a.txt is saved right then.
    if (!fired.includes("folder") && String(from).endsWith(`${path.sep}d${path.sep}b.txt`)) { fired.push("folder"); writeFileSync(path.join(n.root, "d/a.txt"), "agent's edit"); }
    // Saved in place between the last look and the move itself.
    if (!fired.includes("file") && String(from) === gone) { fired.push("file"); writeFileSync(gone, "saved just now"); }
    return original(from, to);
  }) as typeof fsModule.renameSync, () => n.apply([{ path: "d" }, { path: "gone.txt" }]));
  assert.deepEqual(fired.sort(), ["file", "folder"]);
  assert.deepEqual(result.items.map((item) => item.outcome), ["changed", "changed"]);
  assert.equal(onDisk(n.root, "d/a.txt"), "agent's edit");
  assert.equal(onDisk(n.root, "gone.txt"), "saved just now");
  assert.equal(n.core.db.entry(n.key, "d/b.txt")!.deleted, true, "what went before the save is committed");
  assert.equal(n.core.db.entry(n.key, "d/a.txt")!.deleted, false);
  assert.deepEqual(n.trashFiles().map((file) => file.content), ["b"], "the edits are not in the trash");
  // The scans apply asked for index both edits as newer versions.
  for (let attempt = 0; attempt < 100 && n.core.db.entry(n.key, "gone.txt")!.sha256 !== sha("saved just now"); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(n.core.db.entry(n.key, "d/a.txt")!.sha256, sha("agent's edit"));
  assert.equal(n.core.db.entry(n.key, "gone.txt")!.sha256, sha("saved just now"));
});

test("into an empty name a link, or a file where a folder was cleared, never replaces what someone wrote there meanwhile", async (t) => {
  const n = await node(t, { setup: (root) => { mkdirSync(path.join(root, "d0")); writeFileSync(path.join(root, "d0/x.txt"), "x"); } });
  await n.pull([
    { path: "l2", type: SYMLINK, target: "f1.txt" },
    n.over("d0/x.txt", { deleted: true, size: 1, sha256: sha("x") }),
    n.over("d0", { type: FILE, size: 4, sha256: sha("file") }),
  ]);
  const temp = n.download("d0", "file");
  const result = await withFs("symlinkSync", (original) => ((target: fsModule.PathLike, file: fsModule.PathLike, type?: fsModule.symlink.Type | null) => {
    if (String(file) === path.join(n.root, "l2")) writeFileSync(String(file), "written at l2");
    return original(target, file, type);
  }) as typeof fsModule.symlinkSync, () => withFs("linkSync", (original) => ((from: fsModule.PathLike, to: fsModule.PathLike) => {
    if (String(to) === path.join(n.root, "d0")) writeFileSync(String(to), "written at d0");
    return original(from, to);
  }) as typeof fsModule.linkSync, () => withFs("openSync", (original) => ((file: fsModule.PathLike, flags?: fsModule.OpenMode, mode?: fsModule.Mode | null) => {
    // darwin takes the empty name with an exclusive placeholder instead of a link.
    if (String(file) === path.join(n.root, "d0") && flags === "wx") writeFileSync(String(file), "written at d0");
    return original(file, flags, mode);
  }) as typeof fsModule.openSync, () => n.apply([{ path: "l2" }, { path: "d0", tempPath: temp, source: PEER }]))));
  assert.deepEqual(result.items.map((item) => [item.outcome, item.reason]), [["changed", "Something was written in its place meanwhile"], ["changed", "Something was written in its place meanwhile"]]);
  assert.equal(onDisk(n.root, "l2"), "written at l2");
  assert.equal(onDisk(n.root, "d0"), "written at d0");
  assert.deepEqual(n.trashFiles().map((file) => file.content), ["x"]);
});

test("darwin: a file sync placed reports its later delete, as FSEvents never does for a file that had a second link", { skip: !darwin && "FSEvents is darwin's" }, async (t) => {
  const n = await node(t);
  // The stream must see the placement: one that starts afterwards reports the delete either way.
  const seen: string[] = [];
  const watcher = fsModule.watch(n.root, { recursive: true }, (_type, name) => { if (name !== null) seen.push(String(name)); });
  t.after(() => watcher.close());
  await new Promise((resolve) => setTimeout(resolve, 300));
  await n.pull([{ path: "placed.txt", size: 6, sha256: sha("placed") }]);
  const temp = n.download("placed.txt", "placed");
  assert.deepEqual((await n.apply([{ path: "placed.txt", tempPath: temp, source: PEER }])).items, [{ path: "placed.txt", outcome: "applied" }]);
  assert.equal(lstatSync(path.join(n.root, "placed.txt")).nlink, 1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  seen.length = 0;
  fsModule.unlinkSync(path.join(n.root, "placed.txt"));
  for (let waited = 0; waited < 5000 && !seen.includes("placed.txt"); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(seen.includes("placed.txt"), `events: ${JSON.stringify(seen)}`);
});

test("engine temps stay out of git status: the exclude is written as a share moves into builtin, and in a repository around the project", async (t) => {
  const RULE = ".joint-bob-sync.*.tmp";
  const n = await node(t, { phase: "syncthing", setup: (root) => execFileSync("git", ["init", "-q", root]) });
  const exclude = path.join(n.root, ".git/info/exclude");
  assert.ok(!readFileSync(exclude, "utf8").split("\n").includes(RULE));
  // The switch writes it at once: transfers start right after configure, before any scan.
  await n.core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: n.key, projectId: "p1", kind: "project", root: n.root, phase: "builtin", rules: {}, peers: [PEER] }],
  });
  assert.ok(readFileSync(exclude, "utf8").split("\n").includes(RULE));

  // A project folder inside a repository: that repository's status would show the temps.
  const nested = await node(t, { setup: (root) => execFileSync("git", ["init", "-q", path.dirname(root)]) });
  assert.ok(readFileSync(path.join(path.dirname(nested.root), ".git/info/exclude"), "utf8").split("\n").includes(RULE));
  // A linked worktree reads its common directory's exclude; a repository at the home folder (dotfiles) is never touched.
  const outer = path.dirname(nested.root);
  mkdirSync(path.join(outer, ".git/worktrees/wt"), { recursive: true });
  writeFileSync(path.join(outer, ".git/worktrees/wt/commondir"), "../..\n");
  const linked = path.join(outer, "linked");
  mkdirSync(path.join(linked, "sub"), { recursive: true });
  writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(outer, ".git/worktrees/wt")}\n`);
  assert.equal(gitExcludeFile(path.join(linked, "sub")), path.join(outer, ".git/info/exclude"));
  assert.equal(gitExcludeFile(nested.root, outer), undefined);
  assert.equal(gitExcludeFile(os.tmpdir(), path.join(os.tmpdir(), "elsewhere")), undefined);
});

test("a big batch commits in sections of 32 items, with turns of the worker loop between them", async (t) => {
  const n = await node(t, { setup: (root) => { for (let index = 0; index < 70; index++) writeFileSync(path.join(root, `f${index}.txt`), String(index)); } });
  await n.pull(Array.from({ length: 70 }, (_, index) => n.over(`f${index}.txt`, { deleted: true, size: String(index).length, sha256: sha(String(index)) })));
  let turns = 0;
  let spinning = true;
  const spin = () => { if (!spinning) return; turns++; setImmediate(spin); };
  setImmediate(spin);
  const result = await n.apply(Array.from({ length: 70 }, (_, index) => ({ path: `f${index}.txt` })));
  spinning = false;
  assert.equal(result.applied, 70);
  assert.ok(turns >= 2, `the loop turned ${turns} times while three sections committed`);
  assert.equal(readdirSync(n.root).filter((name) => name.endsWith(".txt")).length, 0);
  assert.equal(n.trashFiles().length, 70);
});

test("multi-user mode on Linux: a new file takes the peer's group bits (the ACL mask), an existing one keeps its own", async (t) => {
  const n = await node(t, { multiUserLinux: true, setup: (root) => { writeFileSync(path.join(root, "mine.sh"), "old"); chmodSync(path.join(root, "mine.sh"), 0o775); } });
  await n.pull([
    { path: "notes.md", size: 5, mode: 0o664, sha256: sha("notes") },
    { path: "run.sh", size: 3, mode: 0o775, sha256: sha("run") },
    n.over("mine.sh", { size: 3, mode: 0o745, sha256: sha("new") }),
  ]);
  const result = await n.apply([
    { path: "notes.md", tempPath: n.download("notes.md", "notes"), source: PEER },
    { path: "run.sh", tempPath: n.download("run.sh", "run"), source: PEER },
    { path: "mine.sh", tempPath: n.download("mine.sh", "new"), source: PEER },
  ]);
  assert.deepEqual(result.items.map((item) => item.outcome), ["applied", "applied", "applied"]);
  // The temps are 0600: taking their group bits made the mask --- and the stripped mode this node's own version, sent everywhere.
  assert.equal(statSync(path.join(n.root, "notes.md")).mode & 0o777, 0o664);
  assert.equal(statSync(path.join(n.root, "run.sh")).mode & 0o777, 0o775);
  for (const relative of ["notes.md", "run.sh"]) {
    const row = n.core.db.entry(n.key, relative)!;
    assert.deepEqual([row.mode, row.modifiedBy], [statSync(path.join(n.root, relative)).mode & 0o777, PEER], `${relative} keeps the peer's version`);
  }
  // Group bits are never lowered on a file that was here (rwx stays): this node's mode, its own version as a scan would make it.
  assert.equal(statSync(path.join(n.root, "mine.sh")).mode & 0o777, 0o775);
  assert.equal(n.core.db.entry(n.key, "mine.sh")!.modifiedBy, SELF);
});

test("a folder kept for a file changed in it stays concurrent with a file that took its place elsewhere: that file becomes a conflict copy there, not trash", async (t) => {
  const n = await node(t, { setup: (root) => { mkdirSync(path.join(root, "d")); writeFileSync(path.join(root, "d/old.txt"), "old"); } });
  // A file written in the folder here, which the peer never saw.
  n.write("d/new.txt", "made here");
  await n.scan();
  const folder = n.core.db.entry(n.key, "d")!;
  // The peer replaced the folder with a file: its rows dominate what this node had of both.
  await n.pull([n.over("d/old.txt", { deleted: true, size: 3, sha256: sha("old") }), n.over("d", { type: FILE, size: 4, sha256: sha("file"), mtimeMs: folder.mtimeMs + 60_000 })]);
  const result = await n.apply([{ path: "d", tempPath: n.download("d", "file"), source: PEER }]);
  assert.deepEqual([result.items[0].outcome, result.items[0].reason], ["stale", "The folder holds files changed here: it stays"]);
  assert.equal(onDisk(n.root, "d/new.txt"), "made here");
  const kept = n.core.db.entry(n.key, "d")!;
  const theirs = n.core.db.remote(n.key, PEER, "d")!;
  assert.equal(compareVectors(kept.version, theirs.version), "concurrent", "never a version over the peer's file");
  assert.ok(kept.mtimeMs > theirs.mtimeMs, "and newer, so the folder wins on every node");
  // On the peer: its file loses to the folder and is kept beside it as a conflict copy.
  const there = decideGlobal(theirs, [kept]);
  assert.equal(there.target, kept);
  assert.deepEqual(there.decision, { kind: "apply", action: "mkdir", conflict: true });
});
