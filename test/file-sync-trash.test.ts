import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { applyFloorBytes, defaultTrashBudget, GiB, Trash, type DiskInfo, type TrashOptions } from "../src/file-sync/trash.js";
import type { Clock } from "../src/file-sync/types.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 25, 12, 0, 0);

function movableClock(start = START): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, setTimeout: () => ({ cancel() {} }), advance(ms) { now += ms; } };
}

function setup(t: TestContext, options: Partial<TrashOptions> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-trash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const share = path.join(dir, "share");
  mkdirSync(share);
  const clock = movableClock();
  const disk: (target: string) => DiskInfo = () => ({ freeBytes: 500 * GiB, totalBytes: 1000 * GiB });
  const trash = new Trash({ dataDir: path.join(dir, "data"), clock, disk, ...options });
  // A new inode each time, as apply's rename gives: writing in place would also change a hard-linked trash copy.
  const put = (relative: string, content: string) => {
    mkdirSync(path.dirname(path.join(share, relative)), { recursive: true });
    rmSync(path.join(share, relative), { force: true });
    writeFileSync(path.join(share, relative), content);
    return path.join(share, relative);
  };
  return { dir, share, clock, trash, put };
}

test("the apply floor is 2 GiB or 1 % of the filesystem, whichever is larger", () => {
  assert.equal(applyFloorBytes(100 * GiB), 2 * GiB);
  assert.equal(applyFloorBytes(500 * GiB), 5 * GiB);
  assert.equal(applyFloorBytes(0), 2 * GiB);
});

test("the default trash budget is 5 GiB on APFS and 1 GiB elsewhere", () => {
  assert.equal(defaultTrashBudget("darwin"), 5 * GiB);
  assert.equal(defaultTrashBudget("linux"), GiB);
});

test("preserve links the file under <fsId>/<day>/<share hash>/<path>", (t) => {
  const s = setup(t);
  const file = s.put("src/app.ts", "old content");
  const kept = s.trash.preserve("project:p1", "src/app.ts", file);
  const fsId = String(lstatSync(file).dev);
  const shareHash = createHash("sha256").update("project:p1").digest("hex").slice(0, 16);
  assert.equal(kept, path.join(s.trash.root, fsId, "20261025", shareHash, "src", "app.ts"));
  assert.equal(lstatSync(kept).ino, lstatSync(file).ino, "a hard link on the same filesystem");
  assert.ok(!kept.startsWith(s.share), "never inside the share");
});

test("the preserved content survives the original being replaced", (t) => {
  const s = setup(t);
  const file = s.put("notes.md", "version one");
  const kept = s.trash.preserve("project:p1", "notes.md", file);
  writeFileSync(path.join(s.share, ".tmp-new"), "version two");
  renameSync(path.join(s.share, ".tmp-new"), file);
  assert.equal(readFileSync(kept, "utf8"), "version one");
  assert.equal(readFileSync(file, "utf8"), "version two");
});

test("preserve copies when a hard link cannot cross filesystems", (t) => {
  const s = setup(t, { link: () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } });
  const file = s.put("a.txt", "copied");
  const kept = s.trash.preserve("project:p1", "a.txt", file);
  assert.equal(readFileSync(kept, "utf8"), "copied");
  assert.notEqual(lstatSync(kept).ino, lstatSync(file).ino);
});

test("other link failures are not hidden by a copy", (t) => {
  const s = setup(t, { link: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  const file = s.put("a.txt", "x");
  assert.throws(() => s.trash.preserve("project:p1", "a.txt", file), /denied/);
});

test("a second copy of the same path on the same day gets ~1, then ~2", (t) => {
  const s = setup(t);
  const file = s.put("a.txt", "one");
  const first = s.trash.preserve("project:p1", "a.txt", file);
  const second = s.trash.preserve("project:p1", "a.txt", s.put("a.txt", "two"));
  const third = s.trash.preserve("project:p1", "a.txt", s.put("a.txt", "three"));
  assert.equal(second, `${first}~1`);
  assert.equal(third, `${first}~2`);
  assert.deepEqual([first, second, third].map((kept) => readFileSync(kept, "utf8")), ["one", "two", "three"]);
});

test("a symbolic link is preserved as a link, not followed", (t) => {
  const s = setup(t);
  symlinkSync("../somewhere", path.join(s.share, "link"));
  const kept = s.trash.preserve("project:p1", "link", path.join(s.share, "link"));
  assert.equal(lstatSync(kept).isSymbolicLink(), true);
  assert.equal(readlinkSync(kept), "../somewhere");
});

test("folders are preserved through their files", (t) => {
  const s = setup(t);
  mkdirSync(path.join(s.share, "dir"));
  assert.throws(() => s.trash.preserve("project:p1", "dir", path.join(s.share, "dir")), /through its files/);
});

test("prune removes days older than the retention", (t) => {
  const s = setup(t);
  const old = s.trash.preserve("project:p1", "old.txt", s.put("old.txt", "old"));
  s.clock.advance(3 * DAY);
  const recent = s.trash.preserve("project:p1", "recent.txt", s.put("recent.txt", "recent"));
  s.clock.advance(5 * DAY);
  const result = s.trash.prune();
  assert.equal(result.removed, 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(path.dirname(path.dirname(old))), false, "emptied day folders go too");
});

test("a write that takes the trash over its budget prunes the oldest first", (t) => {
  const s = setup(t, { budgetBytes: 100 });
  const first = s.trash.preserve("project:p1", "1.bin", s.put("1.bin", "a".repeat(60)));
  s.clock.advance(DAY);
  const second = s.trash.preserve("project:p1", "2.bin", s.put("2.bin", "b".repeat(30)));
  assert.equal(s.trash.sizeBytes(), 90);
  s.clock.advance(DAY);
  const third = s.trash.preserve("project:p1", "3.bin", s.put("3.bin", "c".repeat(30)));
  assert.equal(existsSync(first), false, "the oldest item went");
  assert.equal(existsSync(second), true);
  assert.equal(existsSync(third), true);
  assert.equal(s.trash.sizeBytes(), 60);
});

test("the budget never exceeds a quarter of free space plus the trash", (t) => {
  const s = setup(t, { budgetBytes: 10 * GiB, disk: () => ({ freeBytes: 300, totalBytes: 1000 * GiB }) });
  const fsId = s.trash.fsId(s.share);
  s.trash.preserve("project:p1", "a.bin", s.put("a.bin", "a".repeat(100)));
  assert.equal(s.trash.budget(fsId), Math.floor(0.25 * (300 + 100)));
});

test("ensureSpace allows a download that keeps the floor free", (t) => {
  const s = setup(t, { disk: () => ({ freeBytes: 10 * GiB, totalBytes: 100 * GiB }) });
  const check = s.trash.ensureSpace(s.share, 7 * GiB);
  assert.deepEqual(check, { ok: true, freeBytes: 10 * GiB, floorBytes: 2 * GiB });
  assert.equal(s.trash.ensureSpace(s.share, 9 * GiB).ok, false);
});

test("reservations of downloads in flight count against the floor", (t) => {
  const s = setup(t, { disk: () => ({ freeBytes: 10 * GiB, totalBytes: 100 * GiB }) });
  const reservation = s.trash.reserve(s.share, 5 * GiB);
  const refused = s.trash.ensureSpace(s.share, 4 * GiB);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "Not enough free disk space");
  reservation.release();
  reservation.release();
  assert.equal(s.trash.reserved(reservation.fsId), 0, "a second release is a no-op");
  assert.equal(s.trash.ensureSpace(s.share, 4 * GiB).ok, true);
});

test("ensureSpace prunes this filesystem's trash, oldest first, before refusing", (t) => {
  let trash: Trash | undefined;
  let held = 0;
  // Free space grows by whatever leaves the trash.
  const s = setup(t, { disk: () => ({ freeBytes: 2 * GiB + 50 - (trash ? trash.sizeBytes() : 0) + held, totalBytes: 100 * GiB }) });
  trash = s.trash;
  const first = s.trash.preserve("project:p1", "1.bin", s.put("1.bin", "a".repeat(40)));
  s.clock.advance(DAY);
  const second = s.trash.preserve("project:p1", "2.bin", s.put("2.bin", "b".repeat(40)));
  held = 80;
  // 2 GiB + 50 free, floor 2 GiB: a 70-byte download needs 20 more bytes, the oldest item frees 40.
  const check = s.trash.ensureSpace(s.share, 70);
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), true, "only as much as needed is pruned");
});

test("ensureSpace refuses when even an empty trash leaves too little", (t) => {
  const s = setup(t, { disk: () => ({ freeBytes: 2 * GiB + 10, totalBytes: 100 * GiB }) });
  s.trash.preserve("project:p1", "small.bin", s.put("small.bin", "x".repeat(5)));
  const check = s.trash.ensureSpace(s.share, GiB);
  assert.equal(check.ok, false);
  assert.equal(check.floorBytes, 2 * GiB);
});

test("trash size is reported per filesystem and survives a restart", (t) => {
  const s = setup(t);
  s.trash.preserve("project:p1", "a.bin", s.put("a.bin", "x".repeat(12)));
  s.trash.preserve("tickets:p1", "b.bin", s.put("b.bin", "y".repeat(8)));
  const fsId = s.trash.fsId(s.share);
  assert.equal(s.trash.sizeBytes(fsId), 20);
  const reopened = new Trash({ dataDir: path.join(s.dir, "data"), clock: s.clock, disk: () => ({ freeBytes: 500 * GiB, totalBytes: 1000 * GiB }) });
  assert.equal(reopened.sizeBytes(), 20);
  assert.equal(reopened.sizeBytes("no-such-filesystem"), 0);
});
