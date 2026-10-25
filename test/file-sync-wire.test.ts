import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { Digest, digestOf, EMPTY_DIGEST, entryDigest, updateDigest } from "../src/file-sync/digest.js";
import type { IndexEntry } from "../src/file-sync/types.js";
import {
  changedBodySchema, decodeIndexPage, encodeIndexPage, errorAnswerSchema, fetchBodySchema, fileBodySchema, filesTarget, fromWire,
  helloAnswerSchema, helloBodySchema, indexQuerySchema, INDEX_PAGE_LIMIT, parseIndexPage, sharesAnswerSchema, statusAnswerSchema,
  statusBodySchema, toWire, WireError, type IndexPage,
} from "../src/file-sync/wire.js";

const NODE = "0f8c2a54-7d1e-4c3b-9a6f-2b5e8d9c1a47";
const X = "a".repeat(64);
const DIGEST = "d".repeat(64);

function entry(fields: Partial<IndexEntry> = {}): IndexEntry {
  return { path: "src/a.ts", type: 0, size: 12, mtimeMs: 1_729_851_234_567.125, mode: 0o644, sha256: X, target: null, deleted: false, version: { [NODE]: 1_729_851_234_567 }, modifiedBy: NODE, seq: 7, ...fields };
}

function page(entries: IndexEntry[], fields: Partial<IndexPage> = {}): IndexPage {
  return { indexId: "idx_1", maxSeq: 9, digest: DIGEST, prunedBelow: 0, builtinSince: null, entries, more: false, ...fields };
}

test("toWire uses short keys and leaves out null hash, null link and live state", () => {
  assert.deepEqual(toWire(entry()), { p: "src/a.ts", t: 0, s: 12, m: 1_729_851_234_567.125, o: 0o644, h: X, v: { [NODE]: 1_729_851_234_567 }, b: NODE, q: 7 });
  assert.deepEqual(toWire(entry({ type: 2, sha256: null, target: "../x", mode: 0, deleted: true })), { p: "src/a.ts", t: 2, s: 12, m: 1_729_851_234_567.125, o: 0, l: "../x", d: true, v: { [NODE]: 1_729_851_234_567 }, b: NODE, q: 7 });
});

test("fromWire inverts toWire for every entry type", () => {
  const entries = [entry(), entry({ path: "d", type: 1, sha256: null, mode: 0o755, size: 0 }), entry({ path: "l", type: 2, sha256: null, target: "t", mode: 0 }), entry({ path: "gone", deleted: true })];
  assert.deepEqual(fromWire(JSON.parse(JSON.stringify(entries.map(toWire)))), entries);
});

test("fromWire normalizes paths to NFC", () => {
  const [decoded] = fromWire([toWire(entry({ path: "café.txt" }))]);
  assert.equal(decoded.path, "café.txt");
});

test("fromWire strips unknown keys", () => {
  const [decoded] = fromWire([{ ...toWire(entry()), future: { nested: true } }]);
  assert.deepEqual(Object.keys(decoded).sort(), Object.keys(entry()).sort());
});

test("fromWire rejects the whole page on one bad entry and names it", () => {
  const good = toWire(entry({ path: "ok" }));
  const next = toWire(entry({ path: "next" }));
  assert.equal(fromWire([good, next]).length, 2, "the unmodified pair must be accepted");
  // Schema failures must be reported as such, not as some later check.
  const schema = /Invalid index entry 1: (?!duplicate|only|a live)/;
  const bad: Array<[unknown, RegExp]> = [
    [{ ...next, p: "../escape" }, /entry 1: .*segment/],
    [{ ...next, p: "/abs" }, /entry 1: Path must be relative/],
    [{ ...next, t: 3 }, schema],
    [{ ...next, s: -1 }, schema],
    [{ ...next, s: 1.5 }, schema],
    [{ ...next, m: Infinity }, schema],
    [{ ...next, o: 0o1000 }, schema],
    [{ ...next, h: "ABC" }, schema],
    [{ ...next, d: 1 }, schema],
    [{ ...next, v: {} }, /entry 1: Version must name/],
    [{ ...next, v: { [NODE]: 0 } }, schema],
    [{ ...next, v: JSON.parse('{"__proto__":1}') }, schema],
    [{ ...next, v: { _private: 1 } }, schema],
    [{ ...next, b: "" }, schema],
    [{ ...next, q: "7" }, schema],
    [{ ...next, h: undefined }, /entry 1: a live file needs its hash/],
    [{ ...next, t: 1 }, /entry 1: only files carry a hash/],
    [{ ...next, t: 2, h: undefined }, /entry 1: a live symbolic link needs its target/],
    [{ ...next, l: "t" }, /entry 1: only symbolic links carry a target/],
    [{ ...next, t: 2, h: undefined, l: "a\0b" }, schema],
    [null, schema],
  ];
  for (const [value, error] of bad) assert.throws(() => fromWire([good, value]), error, JSON.stringify(value));
  assert.throws(() => fromWire({}), WireError);
});

test("fromWire rejects two entries for one path, also after NFC", () => {
  assert.throws(() => fromWire([toWire(entry({ path: "café" })), toWire(entry({ path: "café" }))]), /entry 1: duplicate path/);
});

test("a deleted file may keep its hash and a deleted link its target", () => {
  const entries = fromWire([toWire(entry({ deleted: true })), toWire(entry({ path: "l", type: 2, sha256: null, target: "t", deleted: true, mode: 0 }))]);
  assert.equal(entries[0].sha256, X);
  assert.equal(entries[1].target, "t");
});

test("index pages round-trip through gzip", async () => {
  const original = page([entry(), entry({ path: "b", seq: 9 })], { more: true, builtinSince: 4, prunedBelow: 2 });
  const body = await encodeIndexPage(original);
  assert.equal(body[0], 0x1f, "gzip magic");
  assert.deepEqual(await decodeIndexPage(body), original);
});

test("decodeIndexPage refuses bodies that inflate past the limit", async () => {
  const body = await encodeIndexPage(page([entry()]));
  await assert.rejects(decodeIndexPage(body, 64), /too large/);
  await assert.rejects(decodeIndexPage(Buffer.from("not gzip")), /not gzip/);
  await assert.rejects(decodeIndexPage(gzipSync("{nope")), /not JSON/);
});

test("parseIndexPage checks the header fields and the entry count", () => {
  const wire = { ...page([]), entries: [] };
  assert.deepEqual(parseIndexPage({ ...wire, unknown: 1 }), page([]));
  assert.throws(() => parseIndexPage({ ...wire, digest: "x" }), WireError);
  assert.throws(() => parseIndexPage({ ...wire, indexId: "has space" }), WireError);
  assert.throws(() => parseIndexPage({ ...wire, more: "no" }), WireError);
  assert.throws(() => parseIndexPage({ ...wire, entries: Array.from({ length: INDEX_PAGE_LIMIT + 1 }, (_, index) => toWire(entry({ path: `f${index}` }))) }), /Invalid index page/);
});

test("filesTarget builds the exact path and query that get signed", () => {
  assert.equal(filesTarget("shares"), "/api/cluster/v2/files/shares");
  assert.equal(filesTarget("index", { projectId: "p 1/x", kind: "project", since: 5, limit: 100 }), "/api/cluster/v2/files/index?projectId=p+1%2Fx&kind=project&since=5&limit=100");
});

test("indexQuerySchema parses query strings with defaults and bounds", () => {
  const query = Object.fromEntries(new URLSearchParams("projectId=p&kind=tickets&since=12"));
  assert.deepEqual(indexQuerySchema.parse(query), { projectId: "p", kind: "tickets", since: 12, limit: INDEX_PAGE_LIMIT });
  for (const bad of [{ since: "-1" }, { since: "01" }, { since: "1e3" }, { limit: "0" }, { limit: String(INDEX_PAGE_LIMIT + 1) }, { kind: "other" }]) {
    assert.equal(indexQuerySchema.safeParse({ projectId: "p", kind: "project", ...bad }).success, false, JSON.stringify(bad));
  }
});

test("fetch and file bodies normalize paths and reject bad ones", () => {
  const body = fetchBodySchema.parse({ projectId: "p", kind: "project", items: [{ path: "café", sha256: X }], extra: 1 });
  assert.deepEqual(body, { projectId: "p", kind: "project", items: [{ path: "café", sha256: X }] });
  assert.equal(fetchBodySchema.safeParse({ projectId: "p", kind: "project", items: [] }).success, false, "an empty fetch is invalid");
  assert.equal(fetchBodySchema.safeParse({ projectId: "p", kind: "project", items: Array.from({ length: 257 }, (_, index) => ({ path: `f${index}`, sha256: X })) }).success, false, "more than 256 items");
  assert.equal(fileBodySchema.safeParse({ projectId: "p", kind: "project", path: "../x", sha256: X }).success, false);
  assert.equal(fileBodySchema.parse({ projectId: "p", kind: "worktrees", path: "w/a", sha256: X }).path, "w/a");
});

test("changed, status and error bodies", () => {
  assert.deepEqual(changedBodySchema.parse({ shares: [{ projectId: "p", kind: "project", indexId: "i", maxSeq: 3, rulesHash: DIGEST }], records: true }), { shares: [{ projectId: "p", kind: "project", indexId: "i", maxSeq: 3 }], records: true });
  assert.equal(changedBodySchema.safeParse({ shares: [{ projectId: "p", kind: "project", indexId: "i", maxSeq: -1 }] }).success, false);
  assert.deepEqual(statusBodySchema.parse({ projectId: "p" }), { projectId: "p" });
  const answer = { shares: [{ kind: "project", state: "idle", cursor: 4, callerIndexId: null, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, digest: DIGEST, maxSeq: 4 }] };
  assert.deepEqual(statusAnswerSchema.parse(answer), answer);
  assert.equal(statusAnswerSchema.safeParse({ shares: [{ ...answer.shares[0], state: "dreaming" }] }).success, false, "unknown states are rejected");
  assert.deepEqual(errorAnswerSchema.parse({ error: "changed", detail: 1 }), { error: "changed" });
});

test("shares answers and hello capability parts", () => {
  const answer = {
    fileSync: { protocol: 1, minProtocol: 1, enabled: true },
    nodeId: NODE, hostId: "host-1", origins: ["http://100.64.0.2:22700"],
    shares: [{ projectId: "p", kind: "project", indexId: "i", maxSeq: 1, digest: DIGEST, rulesHash: DIGEST, state: "idle", builtinSince: null, prunedBelow: 0, rootDev: 16777230, rootIno: 123456 }],
    engines: [{ projectId: "p", mode: "builtin", generation: 2, updatedAt: "2026-10-25T10:00:00.000Z", origin: NODE }],
    settings: [{ key: "project:p", value: { disabledBuiltins: [], userRules: ["*.log"], removedUserRules: [], gitignore: false, importedFrom: [NODE] }, updatedAt: "2026-10-25T10:00:00.000Z", origin: NODE }],
  };
  assert.deepEqual(sharesAnswerSchema.parse({ ...answer, later: true }), answer);
  for (const origin of ["http://100.64.0.2:22700/path", "ftp://x:1", "not a url"]) {
    assert.equal(sharesAnswerSchema.safeParse({ ...answer, origins: [origin] }).success, false, origin);
  }
  assert.equal(sharesAnswerSchema.safeParse({ ...answer, engines: [{ ...answer.engines[0], mode: "rsync" }] }).success, false);
  assert.equal(sharesAnswerSchema.safeParse({ ...answer, settings: [{ ...answer.settings[0], key: "user:x" }] }).success, false);
  assert.deepEqual(helloBodySchema.parse({ protocol: 1, origins: [] }), { protocol: 1, origins: [] });
  assert.equal(helloAnswerSchema.safeParse({ protocol: 1, origins: [] }).success, false, "the answer carries minProtocol");
});

test("entryDigest hashes path, type, content and octal mode", () => {
  const expected = createHash("sha256").update(`src/a.ts\u00000\u0000${X}\u0000644`).digest("hex");
  assert.equal(entryDigest(entry())!.toString("hex"), expected);
  assert.equal(entryDigest(entry({ deleted: true })), null, "tombstones are not in the digest");
  assert.equal(entryDigest(entry({ type: 2, sha256: null, target: "t", mode: 0o777 }))!.toString("hex"), entryDigest(entry({ type: 2, sha256: null, target: "t", mode: 0 }))!.toString("hex"), "symlinks have no mode");
  assert.notEqual(entryDigest(entry({ mode: 0o755 }))!.toString("hex"), expected, "a chmod changes the digest");
});

test("the digest is the order-independent XOR of live entries", () => {
  const entries = [entry(), entry({ path: "b", sha256: "b".repeat(64) }), entry({ path: "d", type: 1, sha256: null, mode: 0o755 }), entry({ path: "l", type: 2, sha256: null, target: "x", mode: 0 })];
  assert.equal(digestOf([]), EMPTY_DIGEST);
  assert.equal(digestOf(entries), digestOf([...entries].reverse()));
  assert.equal(digestOf([...entries, entry({ path: "gone", deleted: true })]), digestOf(entries), "a tombstone leaves the digest unchanged");
  assert.match(digestOf(entries), /^[0-9a-f]{64}$/);
});

test("incremental digest updates match a full recomputation", () => {
  const a = entry({ path: "a" });
  const b = entry({ path: "b" });
  const b2 = { ...b, sha256: "c".repeat(64) };
  const digest = new Digest().add(a).add(b).change(b, b2).change(undefined, entry({ path: "c" })).change(entry({ path: "c" }), { ...entry({ path: "c" }), deleted: true });
  assert.equal(digest.toString(), digestOf([a, b2]));
  assert.equal(updateDigest(digest.toString(), a, undefined), digestOf([b2]));
  assert.equal(new Digest(digest.toString()).remove(a).remove(b2).toString(), EMPTY_DIGEST, "removing everything returns to empty");
  assert.throws(() => new Digest("XYZ"), /64 lowercase hex/);
});
