import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  CONFLICT_COPY_LIMIT, conflictCopiesOverLimit, conflictCopyName, conflictCopyOriginal, conflictWinner, decide,
  placeConflictCopy, sameContent, sameMeta, shortNodeId,
} from "../src/file-sync/conflicts.js";
import type { IndexEntry } from "../src/file-sync/types.js";
import { canonicalTranscriptName, isSyncConflictPath } from "../src/harnesses/shared-paths.js";
import { conflictOriginalPath } from "../src/server/sync-check.js";

const X = "a".repeat(64);
const Y = "b".repeat(64);
const NODE = "0f8c2a54-7d1e-4c3b-9a6f-2b5e8d9c1a47";

function entry(fields: Partial<IndexEntry> = {}): IndexEntry {
  return { path: "f.txt", type: 0, size: 1, mtimeMs: 1000, mode: 0o644, sha256: X, target: null, deleted: false, version: { a: 1 }, modifiedBy: "a", seq: 1, ...fields };
}

function referenceBase32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  let output = "";
  for (let index = 0; index + 5 <= bits.length; index += 5) output += alphabet[parseInt(bits.slice(index, index + 5), 2)];
  return output;
}

test("sameContent compares type and bytes, link text or directory, never mode", () => {
  assert.equal(sameContent(entry({ deleted: true, sha256: X }), entry({ deleted: true, sha256: Y })), true, "two deletes are the same state whatever they deleted");
  assert.equal(sameContent(entry(), entry({ deleted: true })), false);
  assert.equal(sameContent(entry({ sha256: X }), entry({ sha256: Y })), false);
  assert.equal(sameContent(entry({ sha256: null }), entry({ sha256: null })), false, "an unknown hash must never count as equal");
  assert.equal(sameContent(entry({ type: 2, sha256: null, target: "t" }), entry({ type: 2, sha256: null, target: "t" })), true);
  assert.equal(sameContent(entry({ type: 2, sha256: null, target: "t" }), entry({ type: 2, sha256: null, target: "u" })), false);
  assert.equal(sameContent(entry({ type: 1, sha256: null, mode: 0o700 }), entry({ type: 1, sha256: null, mode: 0o755 })), true);
  assert.equal(sameContent(entry({ type: 0 }), entry({ type: 1, sha256: X })), false);
  assert.equal(sameContent(undefined, entry()), false);
});

test("sameMeta adds mode except for symlinks and tombstones", () => {
  assert.equal(sameMeta(entry({ mode: 0o644 }), entry({ mode: 0o600 })), false);
  assert.equal(sameMeta(entry({ type: 1, sha256: null, mode: 0o700 }), entry({ type: 1, sha256: null, mode: 0o755 })), false);
  assert.equal(sameMeta(entry({ type: 2, sha256: null, target: "t", mode: 0 }), entry({ type: 2, sha256: null, target: "t", mode: 0o777 })), true);
  assert.equal(sameMeta(entry({ deleted: true, mode: 0o644 }), entry({ deleted: true, mode: 0o600 })), true);
});

test("conflictWinner: a live version beats a delete", () => {
  const live = entry({ sha256: Y, mtimeMs: 1 });
  const tombstone = entry({ deleted: true, sha256: X, mtimeMs: 9 });
  assert.equal(conflictWinner(live, tombstone), "a");
  assert.equal(conflictWinner(tombstone, live), "b");
});

test("conflictWinner: a delete of exactly the live content wins", () => {
  assert.equal(conflictWinner(entry({ deleted: true, sha256: X, mtimeMs: 1 }), entry({ sha256: X, mtimeMs: 9 })), "a", "file tombstone with the same lastSha");
  assert.equal(conflictWinner(entry({ type: 2, sha256: null, target: "t", mtimeMs: 9 }), entry({ type: 2, sha256: null, target: "t", deleted: true, mtimeMs: 1 })), "b", "symlink tombstone with the same target");
  assert.equal(conflictWinner(entry({ type: 1, sha256: null, mtimeMs: 9 }), entry({ type: 1, sha256: null, deleted: true, mtimeMs: 1 })), "b", "directory tombstone");
  assert.equal(conflictWinner(entry({ type: 0, sha256: X }), entry({ type: 2, sha256: null, target: X, deleted: true })), "a", "a tombstone of another type deleted something else");
});

test("conflictWinner: newer mtime, then larger modifiedBy, then larger sha256", () => {
  assert.equal(conflictWinner(entry({ mtimeMs: 2, modifiedBy: "a" }), entry({ mtimeMs: 1, modifiedBy: "z" })), "a");
  assert.equal(conflictWinner(entry({ modifiedBy: "a" }), entry({ modifiedBy: "b" })), "b");
  assert.equal(conflictWinner(entry({ sha256: Y }), entry({ sha256: X })), "a");
  assert.equal(conflictWinner(entry({ type: 1, sha256: null }), entry({ sha256: X })), "b", "a null hash ranks below any hash");
  assert.equal(conflictWinner(entry({ deleted: true, sha256: X, mtimeMs: 1 }), entry({ deleted: true, sha256: Y, mtimeMs: 2 })), "b", "two deletes follow the same order");
});

test("conflictWinner is antisymmetric", () => {
  const entries = [entry(), entry({ sha256: Y }), entry({ mtimeMs: 5 }), entry({ modifiedBy: "q" }), entry({ deleted: true }), entry({ deleted: true, sha256: Y }), entry({ type: 1, sha256: null }), entry({ mode: 0o755 }), entry({ version: { b: 1 } })];
  for (const left of entries) for (const right of entries) {
    if (left === right) continue;
    assert.notEqual(conflictWinner(left, right), conflictWinner(right, left), `both orders picked the same side for ${JSON.stringify([left, right])}`);
  }
});

test("decide: no target, identical content and covered vectors", () => {
  assert.deepEqual(decide(entry(), undefined), { kind: "none" });
  assert.deepEqual(decide(entry({ version: { a: 1 } }), entry({ version: { b: 1 }, modifiedBy: "b" })), { kind: "merge", version: { a: 1, b: 1 } }, "concurrent identical content merges vectors");
  assert.deepEqual(decide(entry({ version: { a: 2 } }), entry({ version: { a: 1 } })), { kind: "none" }, "an older identical version changes nothing");
  assert.deepEqual(decide(entry(), entry()), { kind: "none" });
  assert.deepEqual(decide(entry({ deleted: true, version: { a: 2 } }), entry({ deleted: true, sha256: Y, version: { b: 2 } })), { kind: "merge", version: { a: 2, b: 2 } }, "two deletes merge");
});

test("decide: a mode-only difference is a meta apply for the newer or winning side", () => {
  const local = entry({ mode: 0o644, version: { a: 1 }, mtimeMs: 1 });
  assert.deepEqual(decide(local, entry({ mode: 0o755, version: { a: 1, b: 1 } })), { kind: "apply", action: "meta", conflict: false });
  assert.deepEqual(decide(local, entry({ mode: 0o755, version: { b: 1 }, mtimeMs: 2 })), { kind: "apply", action: "meta", conflict: false }, "concurrent chmod with the newer mtime wins");
  assert.deepEqual(decide(entry({ mode: 0o644, version: { a: 1 }, mtimeMs: 3 }), entry({ mode: 0o755, version: { b: 1 }, mtimeMs: 2 })), { kind: "none" }, "the winning local mode stays");
  assert.deepEqual(decide(entry({ mode: 0o644, version: { a: 2 } }), entry({ mode: 0o755, version: { a: 1 } })), { kind: "none" });
});

test("decide: nothing local", () => {
  assert.deepEqual(decide(undefined, entry({ deleted: true })), { kind: "none" });
  assert.deepEqual(decide(undefined, entry()), { kind: "apply", action: "fetch", conflict: false });
  assert.deepEqual(decide(undefined, entry({ type: 1, sha256: null })), { kind: "apply", action: "mkdir", conflict: false });
  assert.deepEqual(decide(undefined, entry({ type: 2, sha256: null, target: "t" })), { kind: "apply", action: "symlink", conflict: false });
});

test("decide: a dominating target applies without a conflict", () => {
  const local = entry({ version: { a: 1 } });
  assert.deepEqual(decide(local, entry({ sha256: Y, version: { a: 1, b: 1 } })), { kind: "apply", action: "fetch", conflict: false });
  assert.deepEqual(decide(local, entry({ deleted: true, sha256: X, version: { a: 2 } })), { kind: "apply", action: "delete", conflict: false });
  assert.deepEqual(decide(local, entry({ sha256: Y, version: { a: 0 } })), { kind: "none" }, "an older target does nothing");
});

test("decide: a concurrent winning target keeps a live local file or symlink as a conflict copy", () => {
  const target = entry({ sha256: Y, version: { b: 1 }, modifiedBy: "b", mtimeMs: 5 });
  assert.deepEqual(decide(entry({ version: { a: 1 }, mtimeMs: 1 }), target), { kind: "apply", action: "fetch", conflict: true });
  assert.deepEqual(decide(entry({ type: 2, sha256: null, target: "t", version: { a: 1 }, mtimeMs: 1 }), target), { kind: "apply", action: "fetch", conflict: true });
  assert.deepEqual(decide(entry({ type: 1, sha256: null, version: { a: 1 }, mtimeMs: 1 }), target), { kind: "apply", action: "fetch", conflict: false }, "a directory is cleared, not copied");
});

test("decide: a concurrent live target over a local delete fetches without a conflict", () => {
  const local = entry({ deleted: true, sha256: X, version: { a: 2 } });
  assert.deepEqual(decide(local, entry({ sha256: Y, version: { a: 1, b: 1 }, modifiedBy: "b" })), { kind: "apply", action: "fetch", conflict: false }, "the edit beats the delete");
  assert.deepEqual(decide(local, entry({ sha256: X, version: { a: 1, b: 1 }, modifiedBy: "b" })), { kind: "none" }, "the delete removed exactly this content: the peer deletes");
});

test("decide: a winning concurrent delete of the same content removes it without a copy", () => {
  const local = entry({ sha256: X, version: { a: 1, b: 1 }, mtimeMs: 9 });
  assert.deepEqual(decide(local, entry({ deleted: true, sha256: X, version: { b: 2 } })), { kind: "apply", action: "delete", conflict: false });
});

test("decide: a concurrent local winner does nothing", () => {
  const local = entry({ sha256: Y, version: { a: 1 }, mtimeMs: 9 });
  assert.deepEqual(decide(local, entry({ sha256: X, version: { b: 1 }, mtimeMs: 1 })), { kind: "none" });
  assert.deepEqual(decide(local, entry({ deleted: true, sha256: X, version: { b: 1 }, mtimeMs: 99 })), { kind: "none" }, "a delete of other content loses to the edit");
});

const LOSER = { mtimeMs: Date.UTC(2026, 9, 6, 17, 32, 52, 345), modifiedBy: NODE };
const ID = referenceBase32(createHash("sha256").update(NODE).digest()).slice(0, 7);

test("conflictCopyName stamps the loser's UTC mtime and a 7-character base32 node id", () => {
  assert.match(ID, /^[A-Z2-7]{7}$/);
  assert.equal(shortNodeId(NODE), ID);
  assert.equal(conflictCopyName("docs/CHANGELOG.md", LOSER), `docs/CHANGELOG.sync-conflict-20261006-173252-${ID}.md`);
  assert.equal(conflictCopyName("Makefile", LOSER), `Makefile.sync-conflict-20261006-173252-${ID}`);
  assert.equal(conflictCopyName("a/archive.tar.gz", LOSER), `a/archive.sync-conflict-20261006-173252-${ID}.tar.gz`, "inserted before the first extension");
  assert.equal(conflictCopyName(".env", LOSER), `.env.sync-conflict-20261006-173252-${ID}`, "a leading dot is not an extension");
  assert.equal(conflictCopyName("x.md", LOSER, 3), `x.sync-conflict-20261006-173255-${ID}.md`, "bumped seconds");
  assert.notEqual(shortNodeId("another-node"), ID);
});

test("conflictCopyName clamps out-of-range mtimes to a valid stamp", () => {
  assert.equal(conflictCopyName("f", { mtimeMs: -5_000, modifiedBy: NODE }), `f.sync-conflict-19700101-000000-${ID}`);
  assert.equal(conflictCopyName("f", { mtimeMs: 9e15, modifiedBy: NODE }), `f.sync-conflict-99991231-235959-${ID}`);
});

const NAMES = ["CHANGELOG.md", "Makefile", "archive.tar.gz", ".env", ".bashrc.local", "..foo", "café notes.txt", "a/b/c.d.e", "x/y.sync-conflict-20250101-000000-ABCDEFG.txt"];

test("conflict copies round-trip through sync-check's conflictOriginalPath", () => {
  for (const name of NAMES) {
    const copy = conflictCopyName(name, LOSER);
    assert.equal(conflictOriginalPath(path.join("/project", copy)), path.join("/project", name), `sync-check must map ${copy} back to ${name}`);
    assert.equal(conflictCopyOriginal(copy), name, `conflictCopyOriginal must map ${copy} back to ${name}`);
  }
  assert.equal(conflictCopyOriginal("docs/CHANGELOG.md"), undefined);
  assert.equal(conflictCopyOriginal("a.sync-conflict-2026-ABC.md"), undefined);
});

test("conflict copies of transcripts match the transcript matcher", () => {
  const transcript = "projects/-Users-x/7c6a1f0e-2b9d-4e8a-a1c3-5d7f9e2b4c6a.jsonl";
  const copy = conflictCopyName(transcript, LOSER);
  assert.equal(isSyncConflictPath(copy), true, `${copy} must be recognised as a conflict copy`);
  assert.equal(canonicalTranscriptName(path.basename(copy)), path.basename(transcript));
});

test("placeConflictCopy reuses a copy with the same content and skips one with other content", () => {
  const loser = { ...LOSER, type: 0 as const, sha256: X, target: null, deleted: false };
  const first = conflictCopyName("f.md", loser);
  const second = conflictCopyName("f.md", loser, 1);
  assert.deepEqual(placeConflictCopy("f.md", loser, () => undefined), { path: first, preserved: false });
  assert.deepEqual(placeConflictCopy("f.md", loser, (candidate) => candidate === first ? entry({ sha256: X, mode: 0o600 }) : undefined), { path: first, preserved: true }, "already preserved by another node");
  assert.deepEqual(placeConflictCopy("f.md", loser, (candidate) => candidate === first ? entry({ sha256: Y }) : undefined), { path: second, preserved: false }, "different content moves one second on");
  assert.deepEqual(placeConflictCopy("f.md", loser, (candidate) => candidate === first ? entry({ deleted: true }) : undefined), { path: first, preserved: false }, "a deleted copy frees its name");
  const link = { ...LOSER, type: 2 as const, sha256: null, target: "t", deleted: false };
  assert.deepEqual(placeConflictCopy("l", link, () => entry({ type: 2, sha256: null, target: "t" })), { path: conflictCopyName("l", link), preserved: true });
});

test("conflictCopiesOverLimit returns the oldest copies beyond ten", () => {
  assert.equal(CONFLICT_COPY_LIMIT, 10);
  const copies = Array.from({ length: 12 }, (_, index) => conflictCopyName("d/f.md", { mtimeMs: Date.UTC(2026, 0, 1, 0, 0, 12 - index), modifiedBy: NODE }));
  const unrelated = ["d/f.md", "d/g.md", conflictCopyName("d/g.md", LOSER), conflictCopyName("e/f.md", LOSER)];
  const over = conflictCopiesOverLimit("d/f.md", [...copies, ...unrelated]);
  assert.deepEqual(over, [copies[11], copies[10]], `got ${JSON.stringify(over)}`);
  assert.deepEqual(conflictCopiesOverLimit("d/f.md", copies.slice(0, 10)), []);
  assert.deepEqual(conflictCopiesOverLimit("d/f.md", copies.slice(0, 4), 3), [copies[3]]);
});
