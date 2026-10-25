import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Applier } from "../src/file-sync/apply.js";
import type { LocalEntry } from "../src/file-sync/db.js";
import { ShareScanner } from "../src/file-sync/scanner.js";
import { Trash } from "../src/file-sync/trash.js";
import { Harness, NO_FAULTS, prng, runSeed, sha256, SHARE, type HarnessOptions } from "./file-sync-harness.js";

/* The convergence harness proves the engine only if its oracles can fail. Each one is shown catching a
   deliberately broken engine (an apply that keeps nothing, a scanner that tombstones what is there, a
   divergence nobody synced, an engine writing a shadow tree), scripted and within a few random seeds;
   and a correct engine passes them on a scripted history whose outcome is checked path by path. */

async function harness(t: TestContext, options: Partial<HarnessOptions> = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-harness-test-"));
  const created = await Harness.create({ seed: 1, faults: NO_FAULTS, ...options, dir });
  t.after(async () => {
    await created.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return created;
}

function trashed(dataDir: string): string[] {
  const hashes: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const file = path.join(dir, name);
      if (lstatSync(file).isDirectory()) visit(file); else hashes.push(sha256(readFileSync(file)));
    }
  };
  visit(path.join(dataDir, "file-sync", "trash"));
  return hashes;
}

test("a scripted history reaches every node exactly, conflicts and deletes kept, and passes every oracle", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "docs/readme.txt", "first\n");
  h.write(a, "keep.txt", "old content\n");
  h.write(a, "shared.txt", "base\n");
  h.chmod(a, "keep.txt", 0o600);
  h.symlink(a, "link", "docs/readme.txt");
  await h.scan(a);
  await h.quiesce();
  assert.equal(readFileSync(path.join(b.root, "docs", "readme.txt"), "utf8"), "first\n");
  assert.equal(lstatSync(path.join(b.root, "keep.txt")).mode & 0o777, 0o600);
  assert.equal(readlinkSync(path.join(b.root, "link")), "docs/readme.txt");

  // Concurrent edits: one side wins everywhere, the loser's content survives as one conflict copy on both nodes.
  h.write(a, "shared.txt", "from a\n");
  h.write(b, "shared.txt", "from b\n");
  // A move across folders, a delete arriving at a peer, a file that becomes a folder.
  h.mkdir(a, "archive");
  h.rename(a, "docs/readme.txt", "archive/readme.txt");
  h.remove(b, "keep.txt");
  await h.scan(a);
  await h.scan(b);
  await h.quiesce();
  h.fileToDir(a, "shared.txt");
  await h.scan(a);
  await h.quiesce();

  const result = await h.check();
  assert.deepEqual(result.problems, []);
  for (const node of h.nodes) {
    const names = readdirSync(node.root).sort();
    const copies = names.filter((name) => name.startsWith("shared.sync-conflict-"));
    assert.equal(copies.length, 1, `${node.id} holds one conflict copy: ${names.join(", ")}`);
    assert.ok(["from a\n", "from b\n"].includes(readFileSync(path.join(node.root, copies[0]), "utf8")));
    assert.equal(readFileSync(path.join(node.root, "archive", "readme.txt"), "utf8"), "first\n");
    assert.ok(lstatSync(path.join(node.root, "shared.txt")).isDirectory());
    assert.ok(!names.includes("keep.txt"));
  }
  // The delete that arrived at a was preserved in a's trash (invariant 5).
  assert.ok(trashed(a.dataDir).includes(sha256("old content\n")));
  assert.equal(result.stats.engine, h.engine);
});

test("oracle (b) catches an apply that overwrites without keeping the previous content", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "notes.txt", "version one\n");
  await h.scan(a);
  await h.quiesce();
  assert.equal(readFileSync(path.join(b.root, "notes.txt"), "utf8"), "version one\n");
  assert.deepEqual((await h.check()).problems, []);
  // From here on nothing reaches the trash: b's apply replaces version one, the last copy anywhere.
  t.mock.method(Trash.prototype, "preserve", function (this: Trash, _share: string, relative: string) { return path.join(this.root, "dropped", relative); });
  h.write(a, "notes.txt", "version two\n");
  await h.scan(a);
  await h.quiesce();
  assert.equal(readFileSync(path.join(b.root, "notes.txt"), "utf8"), "version two\n");
  const { problems } = await h.check();
  assert.deepEqual(problems.filter((problem) => problem.startsWith("(b)")).map((problem) => problem.slice(0, 24)), [`(b) content ${sha256("version one\n").slice(0, 12)}`]);
});

test("oracle (b) finds that broken apply within a few random seeds, with a replayable report", async (t) => {
  t.mock.method(Trash.prototype, "preserve", function (this: Trash, _share: string, relative: string) { return path.join(this.root, "dropped", relative); });
  let caught;
  for (let seed = 1; seed <= 40 && !caught; seed++) {
    const result = await runSeed({ seed, nodes: 2 });
    if (result.problems.some((problem) => problem.startsWith("(b)"))) caught = result;
  }
  assert.ok(caught, "no seed of 40 noticed lost versions");
  assert.match(caught.report!, new RegExp(`FILE_SYNC_SEED=${caught.seed} FILE_SYNC_NODES=2 `));
  assert.match(caught.report!, /operation log \(\d+ lines, all of it in .+\.log; last 60\):\n/);
  assert.ok(caught.log.length > 10);
});

test("oracle (c) catches a scanner that tombstones a path that is still there", async (t) => {
  const h = await harness(t, { nodes: 1 });
  const [a] = h.nodes;
  h.write(a, "keep.txt", "still here\n");
  h.write(a, "other.txt", "x");
  await h.scan(a);
  assert.deepEqual(h.violations, []);
  const scanner = ShareScanner.prototype as unknown as { commit(run: { pending: unknown[] }): void };
  const commit = scanner.commit;
  let armed = true;
  t.mock.method(scanner, "commit", function (this: ShareScanner, run: { pending: unknown[] }) {
    const row = a.core.db.entry(SHARE, "keep.txt");
    if (armed && this.context.root === a.root && row && !row.deleted) {
      armed = false;
      run.pending.push({ kind: "tombstone", path: "keep.txt", expect: row.seq });
    }
    return commit.call(this, run);
  });
  h.write(a, "other.txt", "changed");
  await h.scan(a);
  assert.equal(a.core.db.entry(SHARE, "keep.txt")?.deleted, true, "the broken scanner wrote its tombstone");
  assert.equal(h.violations.length, 1);
  assert.match(h.violations[0], /^\(c\) node-a wrote a tombstone for keep\.txt, which exists on disk as a file/);
  assert.ok((await h.check()).problems.includes(h.violations[0]));
});

test("oracle (c) finds a scanner that tombstones live paths at random within a few seeds", async (t) => {
  const scanner = ShareScanner.prototype as unknown as { commit(run: { pending: unknown[] }): void };
  const commit = scanner.commit;
  const random = prng(7);
  t.mock.method(scanner, "commit", function (this: ShareScanner, run: { pending: unknown[] }) {
    if (random() < 0.15) {
      const db = (this as unknown as { deps: { db: { entries(share: string): LocalEntry[] } } }).deps.db;
      const live = db.entries(this.key).filter((entry) => !entry.deleted && entry.type === 0);
      if (live.length) {
        const victim = live[Math.floor(random() * live.length)];
        run.pending.push({ kind: "tombstone", path: victim.path, expect: victim.seq });
      }
    }
    return commit.call(this, run);
  });
  let caught;
  for (let seed = 1; seed <= 20 && !caught; seed++) {
    const result = await runSeed({ seed, nodes: 2 });
    if (result.problems.some((problem) => problem.startsWith("(c)"))) caught = result;
  }
  assert.ok(caught, "no seed of 20 noticed tombstones for existing paths");
});

test("oracle (g) catches an apply that puts a concurrent version in the trash instead of keeping it as a conflict copy", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "shared.txt", "base\n");
  await h.scan(a);
  await h.quiesce();
  // From here on the loser of a conflict goes to the trash: (b) is satisfied (it is kept somewhere), invariant 4 is not.
  const prototype = Applier.prototype as unknown as { conflictCopy(...args: unknown[]): unknown; preserveOld(...args: unknown[]): unknown };
  t.mock.method(prototype, "conflictCopy", function (this: typeof prototype, share: unknown, key: unknown, abs: unknown, loser: unknown, section: unknown) {
    return this.preserveOld(share, key, abs, loser, section);
  });
  h.write(a, "shared.txt", "from a\n");
  h.write(b, "shared.txt", "from b\n");
  await h.scan(a);
  await h.scan(b);
  await h.quiesce();
  assert.match(h.violations.join("\n"), /^\(g\) node-[ab] trashed shared\.txt \(\{.*\}\) for a target that does not supersede it/m);
  assert.ok(!(await h.check()).problems.some((problem) => problem.startsWith("(b)")), "every version is still somewhere");
});

test("oracle (r): a node that shares the folder with nobody gains nothing but its own writes", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "x.txt", "x\n");
  await h.scan(a);
  await h.quiesce();
  await h.toggleRevocation();
  h.write(b, "y.txt", "only b\n");
  h.write(a, "mine.txt", "a's own\n");
  await h.scan(b);
  await h.scan(a);
  for (let round = 0; round < 5; round++) {
    await h.deliver(h.net.parked.length + 4);
    for (const node of h.nodes) await h.transfer(node);
    await h.advance(1000);
  }
  h.checkRevoked();
  assert.deepEqual(h.violations, []);
  assert.equal(existsSync(path.join(a.root, "y.txt")), false, "nothing comes from a peer that no longer shares the folder");
  // Shared again (quiesce restores it): everything meets.
  await h.quiesce();
  assert.equal(readFileSync(path.join(a.root, "y.txt"), "utf8"), "only b\n");
  assert.equal(readFileSync(path.join(b.root, "mine.txt"), "utf8"), "a's own\n");
  assert.deepEqual((await h.check()).problems, []);
  await h.toggleRevocation();
  writeFileSync(path.join(a.root, "sneaked.txt"), "from nowhere\n");
  h.checkRevoked();
  assert.match(h.violations.join("\n"), /^\(r\) node-[ab] gained sneaked\.txt|^\(r\) node-a gained sneaked\.txt/m);
});

test("a peer that refused the folder while it was not shared is asked again once it is, and the download waiting on it resumes", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "f.txt", "content\n");
  await h.scan(a);
  // b learns of f.txt (notice, pull), but nothing is downloaded yet.
  for (let round = 0; round < 20; round++) await h.deliver(1, (parked) => parked.purpose !== "transfer");
  await h.toggleRevocation();
  // b's download, asked for before, is refused (403): a does not share the folder with b now.
  await h.deliver(h.net.parked.length + 4);
  assert.ok(h.log.some((line) => line.includes("node-b>node-a fetch: 403")), h.log.slice(-10).join("\n"));
  // Shared again: nothing new on either side would bring b back to f.txt but the answer that lifts a's refusal.
  await h.toggleRevocation();
  await h.quiesce();
  assert.equal(readFileSync(path.join(b.root, "f.txt"), "utf8"), "content\n");
  assert.deepEqual((await h.check()).problems, []);
});

test("a refusal that arrives late is lifted by the peer's next notice, and the download waiting on it resumes", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(b, "f.txt", "from b\n");
  await h.scan(b);
  // a learns of f.txt (notice, pull); its download waits in the network.
  for (let round = 0; round < 20; round++) await h.deliver(1, (parked) => parked.purpose !== "transfer");
  await h.dropShare(b);
  // b answers the download 403 (it does not share the folder now), and that answer is held back.
  await h.deliver(1, (parked) => parked.from === "node-a" && parked.purpose === "transfer", { ...NO_FAULTS, hold: 1 });
  await h.addShare(b);
  // b's notice names the folder again (a lifts the refusal) before the held 403 lands and sets it once more.
  await h.deliver(h.net.parked.length, (parked) => parked.state === "request");
  await h.deliver(1, (parked) => parked.state === "response");
  assert.ok(h.log.some((line) => line.includes("node-a>node-b fetch: 403")), h.log.slice(-12).join("\n"));
  // b's next notice (a rules change: a seq, no row a needs) names it again: nothing else would bring a back to f.txt.
  b.rules = { userRules: ["*.skip", "*.md"] };
  await (h as unknown as { configure(node: unknown): Promise<void> }).configure(b);
  await h.quiesce();
  assert.equal(readFileSync(path.join(a.root, "f.txt"), "utf8"), "from b\n");
  assert.deepEqual((await h.check()).problems, []);
});

test("oracle (c) sees a rules change that turns newly ignored files into deletes", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "notes.md", "ignored on a soon\n");
  h.write(a, "keep.txt", "stays synced\n");
  await h.scan(a);
  await h.quiesce();
  assert.ok(existsSync(path.join(b.root, "notes.md")));
  const scanner = ShareScanner.prototype as unknown as { dropIgnored(run: { pending: unknown[] }, key: string): void };
  // A broken scanner: what the rules now ignore leaves the index as a tombstone (a delete on every peer).
  t.mock.method(scanner, "dropIgnored", function (this: ShareScanner, run: { pending: unknown[] }, key: string) {
    const row = a.core.db.entry(SHARE, key);
    if (row && !row.deleted) run.pending.push({ kind: "tombstone", path: key, expect: row.seq });
  });
  h.nodes[0].rules = { userRules: ["*.skip", "*.md"] };
  await (h as unknown as { configure(node: unknown): Promise<void> }).configure(a);
  await h.scan(a, "full");
  assert.match(h.violations.join("\n"), /^\(c\) node-a wrote a tombstone for notes\.md, which exists on disk as a file/m);
});

test("oracles (a), (d) and the index check see a divergence the engines never made", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "same.txt", "same everywhere\n");
  h.write(a, "other.txt", "other\n");
  await h.scan(a);
  await h.quiesce();
  assert.deepEqual((await h.check()).problems, []);
  // Behind every engine's back: a file only b has (never scanned), and a version only a's index holds.
  writeFileSync(path.join(b.root, "sneaked.txt"), "nobody synced this\n");
  const row = a.core.db.entry(SHARE, "same.txt")!;
  a.core.db.writeTx(() => a.core.db.putEntry(SHARE, { ...row, version: { ...row.version, "node-z": 1 } }));
  const { problems } = await h.check();
  assert.ok(problems.some((problem) => problem.startsWith("(index) node-b: a final full scan changed 1 rows (sneaked.txt)")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.startsWith("(a) sneaked.txt differs: node-a absent | node-b file 644")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.startsWith("(d) same.txt has 2 versions")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.startsWith("(d) digests differ")), problems.join("\n"));
});

test("a crash between temp and rename abandons the core; the node restarts on its data and converges", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "data.bin", "before the crash\n");
  await h.scan(a);
  await h.quiesce();
  h.armCrash(b, "beforeRename");
  h.write(a, "data.bin", "after the crash\n");
  await h.scan(a);
  await h.quiesce();
  assert.ok(h.log.some((line) => line.includes("node-b CRASH at beforeRename data.bin")), h.log.join("\n"));
  assert.equal(b.generation, 2);
  assert.equal(readFileSync(path.join(b.root, "data.bin"), "utf8"), "after the crash\n");
  assert.deepEqual((await h.check()).problems, []);
});

test("a crash stops the core at once: its small temp stays for the restarted node, which finishes the item", async (t) => {
  const h = await harness(t);
  const [a, b] = h.nodes;
  h.write(a, "data.bin", "before the crash\n");
  await h.scan(a);
  await h.quiesce();
  h.armCrash(b, "beforeRename");
  h.write(a, "data.bin", "after the crash\n");
  await h.scan(a);
  for (let round = 0; round < 200 && !b.crashed; round++) {
    await h.deliver(h.net.parked.length + 2);
    if (!b.crashed && !h.net.parked.length) { h.clock.fireNext(); await h.settle(); }
  }
  assert.ok(b.crashed, "the armed crash fired");
  await h.settle();
  // A dead process removes nothing: no catch of the dead core deleted the temp it had verified.
  assert.ok(readdirSync(b.root).some((name) => /^\.joint-bob-sync\.data\.bin\.[0-9a-f]{16}\.tmp$/.test(name)), readdirSync(b.root).join(", "));
  await h.quiesce();
  assert.equal(readFileSync(path.join(b.root, "data.bin"), "utf8"), "after the crash\n");
  assert.deepEqual((await h.check()).problems, []);
});

test("the engine never writes a tree whose phase is not builtin, and oracle (f) would see it", async (t) => {
  for (let seed = 1; seed <= 5; seed++) {
    // Crashes are the convergence test's business; here they would only add its findings.
    const result = await runSeed({ seed, nodes: 2, phases: ["builtin", "syncthing"], weights: { crash: 0 } });
    assert.deepEqual(result.problems, [], result.report);
  }
  const h = await harness(t, { phases: ["builtin", "syncthing"] });
  const [a, b] = h.nodes;
  h.write(a, "from-a.txt", "a builtin node's file\n");
  await h.scan(a);
  await h.quiesce();
  assert.deepEqual(readdirSync(b.root), [], "the shadow node got nothing");
  writeFileSync(path.join(b.root, "written-by-someone.txt"), "not through the harness\n");
  h.checkShadows();
  assert.match(h.violations.join("\n"), /^\(f\) the engine wrote into node-b's tree in phase syncthing/);
});

test("the network faults happen, and the engines still converge", async () => {
  const faults = { drop: 0.2, refuse: 0.05, hold: 0.3, truncate: 0.2, lose: 0.1 };
  const totals = { dropped: 0, truncated: 0, held: 0, lost: 0 };
  for (let seed = 1; seed <= 6; seed++) {
    const result = await runSeed({ seed, nodes: 3, faults, weights: { crash: 0 } });
    assert.deepEqual(result.problems, [], result.report);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += Number(result.stats[`net.${key}`]);
  }
  for (const [key, value] of Object.entries(totals)) assert.ok(value > 0, `some requests were ${key}`);
});

test("a seed replays the same operations", async () => {
  // A seed with a long run (its length moves with the engine: fewer rounds once things settle sooner).
  const first = await runSeed({ seed: 13, nodes: 3 });
  const second = await runSeed({ seed: 13, nodes: 3 });
  assert.ok(first.log.length > 50, `seed 13 logged only ${first.log.length} lines`);
  assert.deepEqual(second.log, first.log);
});
