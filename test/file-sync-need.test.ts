import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileSyncDb } from "../src/file-sync/db.js";
import { mergeIdentical, NeedEngine, type NeedShare } from "../src/file-sync/need.js";
import { DIRECTORY, FILE, type IndexEntry } from "../src/file-sync/types.js";
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
