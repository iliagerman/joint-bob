import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSyncDb, type LocalEntry } from "../src/file-sync/db.js";
import { compileRules, effectiveRules, GitignoreTree, type GitIgnoredPaths, type IgnoreMatcher } from "../src/file-sync/ignore.js";
import { ShareScanner, Slicer, type ShareContext } from "../src/file-sync/scanner.js";
import type { Clock, Phase } from "../src/file-sync/types.js";

/* Random filesystem operations against two scanners on one tree: A walks the whole share after every
   round, B only scans the paths a watcher would have reported. After each round both indexes must
   equal an independent walk classified with the same rules (.gitignore files read afresh), tombstones
   must be exactly the synced paths that disappeared, and a touch must leave the version alone.
   FILE_SYNC_SEEDS sets the count. */

const SEEDS = Number(process.env.FILE_SYNC_SEEDS ?? 200);
const FIRST_SEED = Number(process.env.FILE_SYNC_FIRST_SEED ?? 1);
const ROUNDS = 4;
const RULES = { userRules: ["*.skip", "ign-dir/"], gitignore: true };
const NAMES = ["a", "b", "c", "d.txt", "e.md", "f.json", "Notes", "node_modules", "ign-dir", "x.skip", "éclair", "été", "dist", "src", ".hidden", "run.sh"];
const LINK_TARGETS = ["../outside", "a", "missing/target", "/etc/hosts", "d.txt"];
const GITIGNORE_LINES = ["*.md", "d.txt", "/a", "b/", "!e.md", "*.json", "src/", "c*", "**/f.json", "Notes", "!d.txt", "!a", "dist"];

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Files written during the test look an hour old: no settle re-checks, and timers never fire.
const clock: Clock = { now: () => Date.now() + 3_600_000, setTimeout: () => ({ cancel() {} }) };

interface Expected { type: number; mode: number; sha256: string | null; target: string | null }

/** The tree's .gitignore files as they are on disk now, without the scanners' caches; only through real folders (a folder replaced by a link has none). */
function freshGitignores(root: string): GitIgnoredPaths {
  return new GitignoreTree((dir) => {
    let folder = root;
    try {
      for (const name of dir ? dir.split("/") : []) {
        const spelled = readdirSync(folder).find((entry) => entry.normalize("NFC") === name);
        if (spelled === undefined || !lstatSync(path.join(folder, spelled)).isDirectory()) return null;
        folder = path.join(folder, spelled);
      }
      const file = path.join(folder, ".gitignore");
      return lstatSync(file).isFile() ? { text: readFileSync(file, "utf8"), fingerprint: "" } : null;
    } catch {
      return null;
    }
  });
}

/** The independent oracle: what a correct index holds for this tree (in shadow mode unless `phase` says builtin). */
function expectedIndex(root: string, matcher: IgnoreMatcher, previous: Map<string, LocalEntry>, phase: Phase = "syncthing"): Map<string, Expected> {
  const expected = new Map<string, Expected>();
  const tree = freshGitignores(root);
  const resurrects = (dir: string, key: string): boolean => {
    const names = readdirSync(dir);
    if (!names.length) return true;
    return names.some((name) => {
      const childKey = `${key}/${name.normalize("NFC")}`;
      const st = lstatSync(path.join(dir, name));
      if (matcher.classify(childKey, st.isDirectory(), tree) !== null) return false;
      if (!st.isDirectory()) return true;
      const row = previous.get(childKey);
      return !(row && row.deleted && row.type === 1) || resurrects(path.join(dir, name), childKey);
    });
  };
  const walk = (dir: string, key: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const childKey = key ? `${key}/${name.normalize("NFC")}` : name.normalize("NFC");
      const st = lstatSync(full);
      if (matcher.classify(childKey, st.isDirectory(), tree) !== null) continue;
      if (st.isDirectory()) {
        const row = previous.get(childKey);
        // In builtin mode a deleted folder that came back holding only ignored content stays deleted; in shadow mode a folder on disk is live.
        if (phase === "builtin" && row && row.deleted && row.type === 1 && !resurrects(full, childKey)) continue;
        expected.set(childKey, { type: 1, mode: st.mode & 0o777, sha256: null, target: null });
        walk(full, childKey);
      } else if (st.isSymbolicLink()) {
        expected.set(childKey, { type: 2, mode: 0, sha256: null, target: readlinkSync(full) });
      } else {
        expected.set(childKey, { type: 0, mode: st.mode & 0o777, sha256: createHash("sha256").update(readFileSync(full)).digest("hex"), target: null });
      }
    }
  };
  walk(root, "");
  return expected;
}

function snapshot(db: FileSyncDb, share: string): Map<string, LocalEntry> {
  return new Map(db.entries(share).map((row) => [row.path, row]));
}

function liveContent(rows: Map<string, LocalEntry>): Map<string, Expected> {
  const live = new Map<string, Expected>();
  for (const row of rows.values()) if (!row.deleted) live.set(row.path, { type: row.type, mode: row.mode, sha256: row.sha256, target: row.target });
  return live;
}

function describe(map: Map<string, Expected>): string[] {
  return [...map].map(([key, value]) => `${key} t${value.type} m${value.mode.toString(8)} ${value.sha256?.slice(0, 8) ?? value.target ?? ""}`).sort();
}

class Tree {
  readonly touched = new Set<string>();
  readonly touchedOnly = new Set<string>();
  readonly modified = new Set<string>();
  private counter = 0;
  /** `outside`: where folders replaced by a link go (the link points there, outside the share). */
  constructor(readonly root: string, private readonly random: () => number, private readonly outside: string) {}

  private pick<T>(items: readonly T[]): T { return items[Math.floor(this.random() * items.length)]; }

  /** Every entry on disk (spelled as on disk), the root excluded. */
  entries(): Array<{ rel: string; dir: boolean; link: boolean }> {
    const out: Array<{ rel: string; dir: boolean; link: boolean }> = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(rel ? path.join(this.root, rel) : this.root)) {
        const child = rel ? `${rel}/${name}` : name;
        const st = lstatSync(path.join(this.root, child));
        out.push({ rel: child, dir: st.isDirectory(), link: st.isSymbolicLink() });
        if (st.isDirectory()) walk(child);
      }
    };
    walk("");
    return out;
  }

  private directories(): string[] { return ["", ...this.entries().filter((entry) => entry.dir).map((entry) => entry.rel)]; }

  /** A fresh child name of `dir` with no NFC twin already there (one name per key; twins are a unit test). */
  private freshName(dir: string): string | null {
    const existing = new Set(readdirSync(dir ? path.join(this.root, dir) : this.root).map((name) => name.normalize("NFC")));
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = this.random() < 0.7 ? this.pick(NAMES) : `n${this.counter++}`;
      if (!existing.has(name.normalize("NFC"))) return name;
    }
    return null;
  }

  private note(...paths: string[]): void { for (const rel of paths) { this.touched.add(rel); this.touchedOnly.delete(rel); this.modified.add(rel); } }

  private content(): string { return `${this.counter++}:${"z".repeat(Math.floor(this.random() * 40))}`; }

  step(): void {
    const roll = this.random();
    const entries = this.entries();
    const files = entries.filter((entry) => !entry.dir && !entry.link);
    const dirs = entries.filter((entry) => entry.dir);
    if (roll < 0.22) {
      // Create a file, sometimes under new folders.
      let dir = this.pick(this.directories());
      if (this.random() < 0.3) {
        for (let depth = 0; depth < 1 + Math.floor(this.random() * 2); depth++) {
          const name = this.freshName(dir);
          if (!name) break;
          dir = dir ? `${dir}/${name}` : name;
          mkdirSync(path.join(this.root, dir));
        }
      }
      const name = this.freshName(dir);
      if (!name) return;
      const rel = dir ? `${dir}/${name}` : name;
      writeFileSync(path.join(this.root, rel), this.content());
      this.note(rel);
    } else if (roll < 0.36 && files.length) {
      const file = this.pick(files);
      writeFileSync(path.join(this.root, file.rel), this.content());
      // A distinct mtime: same-size edits within one clock tick are a unit-test matter.
      const at = new Date(Date.now() - 86_400_000 + this.counter++ * 1000);
      utimesSync(path.join(this.root, file.rel), at, at);
      this.note(file.rel);
    } else if (roll < 0.46 && files.length) {
      const file = this.pick(files);
      unlinkSync(path.join(this.root, file.rel));
      this.note(file.rel);
    } else if (roll < 0.56 && entries.length) {
      const from = this.pick(entries);
      const dir = this.pick(this.directories().filter((candidate) => candidate !== from.rel && !candidate.startsWith(`${from.rel}/`)));
      const name = this.freshName(dir);
      if (!name) return;
      const to = dir ? `${dir}/${name}` : name;
      renameSync(path.join(this.root, from.rel), path.join(this.root, to));
      this.note(from.rel, to);
    } else if (roll < 0.64 && (files.length || dirs.length)) {
      const target = this.pick([...files, ...dirs]);
      chmodSync(path.join(this.root, target.rel), target.dir ? this.pick([0o755, 0o700, 0o750]) : this.pick([0o644, 0o755, 0o600]));
      this.note(target.rel);
    } else if (roll < 0.72) {
      const parent = this.pick(this.directories());
      const name = this.freshName(parent);
      if (!name) return;
      const rel = parent ? `${parent}/${name}` : name;
      mkdirSync(path.join(this.root, rel));
      this.note(rel);
    } else if (roll < 0.78 && dirs.length) {
      const dir = this.pick(dirs);
      rmSync(path.join(this.root, dir.rel), { recursive: true });
      this.note(dir.rel);
    } else if (roll < 0.84) {
      const parent = this.pick(this.directories());
      const name = this.freshName(parent);
      if (!name) return;
      const rel = parent ? `${parent}/${name}` : name;
      symlinkSync(this.pick(LINK_TARGETS), path.join(this.root, rel));
      this.note(rel);
    } else if (roll < 0.90) {
      // Ignored content nested anywhere: dependency trees, user-ignored folders and files.
      const parent = this.pick(this.directories());
      const holder = this.pick(["node_modules", "ign-dir", ".git"]);
      const rel = parent ? `${parent}/${holder}/pkg/${this.counter++}.js` : `${holder}/pkg/${this.counter++}.js`;
      try {
        mkdirSync(path.dirname(path.join(this.root, rel)), { recursive: true });
        writeFileSync(path.join(this.root, rel), this.content());
      } catch {
        return; // a file or link already holds that name
      }
      this.note(rel);
    } else if (roll < 0.94 && files.length) {
      // A touch: only the mtime moves.
      const file = this.pick(files);
      const at = new Date(Date.now() - 2 * 86_400_000 + this.counter++ * 1000);
      utimesSync(path.join(this.root, file.rel), at, at);
      this.touched.add(file.rel);
      if (!this.modified.has(file.rel)) this.touchedOnly.add(file.rel);
    } else if (roll < 0.97) {
      // A .gitignore written or rewritten anywhere (the option is on).
      const dir = this.pick(this.directories());
      const rel = dir ? `${dir}/.gitignore` : ".gitignore";
      const lines = Array.from({ length: 1 + Math.floor(this.random() * 3) }, () => this.pick(GITIGNORE_LINES));
      try { writeFileSync(path.join(this.root, rel), `${lines.join("\n")}\n`); } catch { return; }
      this.note(rel);
    } else if (roll < 0.985 && dirs.length) {
      // rm -rf of a folder, then a link in its place to a folder outside holding the same names.
      const dir = this.pick(dirs);
      const below = entries.filter((entry) => entry.rel.startsWith(`${dir.rel}/`)).map((entry) => entry.rel);
      const moved = path.join(this.outside, `moved-${this.counter++}`);
      renameSync(path.join(this.root, dir.rel), moved);
      symlinkSync(moved, path.join(this.root, dir.rel));
      this.note(dir.rel, ...below);
    } else {
      // A decomposed name (NFD) next to whatever is there.
      const parent = this.pick(this.directories());
      const name = `café-${this.counter++}`;
      const rel = parent ? `${parent}/${name}` : name;
      writeFileSync(path.join(this.root, rel), this.content());
      this.note(rel);
    }
  }

  newRound(): void {
    this.touched.clear();
    this.touchedOnly.clear();
    this.modified.clear();
  }
}

function makeScanner(db: FileSyncDb, share: string, root: string, matcher: IgnoreMatcher, nodeId: string): ShareScanner {
  db.writeTx(() => db.insertShare({ share, projectId: "p", kind: "project", root, indexId: "start" }));
  let generation = 0;
  const context: ShareContext = { key: share, projectId: "p", kind: "project", root, phase: "syncthing", matcher, peers: [] };
  return new ShareScanner({ db, nodeId, clock, emit: () => undefined, slicer: new Slicer(), newIndexId: () => `g${++generation}` }, context);
}

async function runSeed(seed: number): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-prop-"));
  const share = "project:p";
  const dbA = new FileSyncDb(path.join(dir, "a.db"), "node-a");
  const dbB = new FileSyncDb(path.join(dir, "b.db"), "node-b");
  try {
    const root = path.join(dir, "root");
    mkdirSync(root);
    const random = prng(seed);
    const matcher = compileRules(effectiveRules("project", RULES));
    const full = makeScanner(dbA, share, root, matcher, "node-a");
    const scoped = makeScanner(dbB, share, root, matcher, "node-b");
    const tree = new Tree(root, random, dir);
    for (let step = 0; step < 6; step++) tree.step();
    const first = await full.scan("full");
    await scoped.scan("full");
    assert.equal(first.tombstones, 0, `seed ${seed}: the first scan wrote tombstones`);
    for (let round = 0; round < ROUNDS; round++) {
      const before = snapshot(dbA, share);
      tree.newRound();
      const replaced = random() < 0.04;
      if (replaced) {
        // The root itself replaced: a new generation on both sides, nothing deleted.
        // Moved aside, not deleted: a freed inode can be handed straight back to the new folder.
        renameSync(root, `${root}-replaced-${round}`);
        mkdirSync(root);
      }
      const steps = 1 + Math.floor(random() * 10);
      for (let step = 0; step < steps; step++) tree.step();
      // A new generation starts without rows, so no earlier tombstone can keep a folder deleted.
      const expected = expectedIndex(root, matcher, replaced ? new Map() : before);
      const resultA = await full.scan("full");
      const resultB = await scoped.scan({ paths: [...tree.touched] });
      const context = `seed ${seed} round ${round}${replaced ? " (root replaced)" : ""}; touched ${JSON.stringify([...tree.touched])}`;
      assert.equal(resultA.error, undefined, `${context}: full scan failed: ${resultA.error}`);
      assert.equal(resultB.error, undefined, `${context}: scoped scan failed: ${resultB.error}`);
      const after = snapshot(dbA, share);
      const afterB = snapshot(dbB, share);
      assert.deepEqual(describe(liveContent(after)), describe(expected), `${context}: the full scan's index differs from the tree`);
      assert.deepEqual(describe(liveContent(afterB)), describe(expected), `${context}: event-scoped scans did not converge to the full scan's index`);
      const deleted = (rows: Map<string, LocalEntry>) => [...rows.values()].filter((row) => row.deleted).map((row) => row.path).sort();
      assert.deepEqual(deleted(afterB), deleted(after), `${context}: event-scoped scans wrote different tombstones`);
      if (replaced) {
        assert.equal(resultA.newGeneration, true, `${context}: a replaced root must start a new generation`);
        assert.equal(resultA.tombstones, 0, `${context}: a new generation wrote tombstones`);
        assert.equal([...after.values()].some((row) => row.deleted), false, `${context}: tombstones survived a new generation`);
        continue;
      }
      // Tombstones written this round are exactly the synced paths that disappeared. A path that is
      // there again as something the rules ignore (a folder under a folder-only rule) leaves silently.
      const gitignores = freshGitignores(root);
      const ignoredNow = (row: LocalEntry): boolean => {
        let st;
        try { st = lstatSync(path.join(root, row.fsName ?? row.path)); } catch { st = undefined; }
        return matcher.classify(row.path, st ? st.isDirectory() : row.type === 1, gitignores) !== null;
      };
      const disappeared = [...before.values()].filter((row) => !row.deleted && !expected.has(row.path) && !ignoredNow(row)).map((row) => row.path).sort();
      const newTombstones = [...after.values()].filter((row) => row.deleted && !before.get(row.path)?.deleted).map((row) => row.path).sort();
      assert.deepEqual(newTombstones, disappeared, `${context}: tombstones are not the paths that went away`);
      for (const rel of tree.touchedOnly) {
        const key = rel.normalize("NFC");
        const was = before.get(key);
        const now = after.get(key);
        if (!was || was.deleted || !now || !existsSync(path.join(root, rel))) continue;
        assert.deepEqual(now.version, was.version, `${context}: a touch of ${key} changed its version`);
        assert.equal(now.seq, was.seq, `${context}: a touch of ${key} took a new seq`);
      }
    }
  } finally {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test(`scanner property: ${SEEDS} seeds of random file operations`, { timeout: 600_000 }, async () => {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) await runSeed(seed);
});
