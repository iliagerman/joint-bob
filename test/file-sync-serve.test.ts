import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkerCore, type CoreDeps, type FileSyncCore } from "../src/file-sync/core.js";
import { decodeFrames, type Frame, type FrameLimits } from "../src/file-sync/frames.js";
import type { OpArgs, ServeAnswer } from "../src/file-sync/protocol.js";
import { FRAMES_CONTENT_TYPE, parseRange } from "../src/file-sync/service.js";
import type { Clock } from "../src/file-sync/types.js";
import { NOT_SHARED_ERROR } from "../src/file-sync/wire.js";

/* FilesService fetch and file (FILE-SYNC design §6.3): only live indexed files whose descriptor still
   matches the scanned fingerprint are served; anything else is a per-item refusal. */

const SHARE = "project:p1";
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

class FakeClock implements Clock {
  current = Date.now();
  now(): number { return this.current; }
  setTimeout(): { cancel(): void } { return { cancel: () => {} }; }
}

interface Fixture {
  root: string;
  outside: string;
  core: FileSyncCore;
  configure(overrides?: Partial<OpArgs["configure"]["shares"][number]>): Promise<unknown>;
  scan(): Promise<unknown>;
}

async function setup(t: TestContext, options: Partial<CoreDeps> = {}): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-serve-"));
  const root = path.join(dir, "root");
  const outside = path.join(dir, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  let seed = 7;
  const core = createWorkerCore({
    nodeId: "a", dataDir: path.join(dir, "data"), clock: new FakeClock(), random: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
    watch: false, emit: () => {}, ...options,
  });
  t.after(async () => {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const configure = (overrides: Partial<OpArgs["configure"]["shares"][number]> = {}) => core.call("configure", {
    enabled: true, hostId: "host-a", records: { engines: [], settings: [] },
    peers: [{ nodeId: "b", publicKey: "unused", origins: [], present: false }],
    shares: [{ key: SHARE, projectId: "p1", kind: "project", root, phase: "syncthing", rules: {}, peers: ["b"], ...overrides }],
  });
  await configure();
  return { root, outside, core, configure, scan: () => core.call("scan", { share: SHARE, scope: "full", reason: "test" }) };
}

async function bytesOf(answer: ServeAnswer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body ?? []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function framesOf(answer: ServeAnswer, limits?: FrameLimits): Promise<Frame[]> {
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["content-type"], FRAMES_CONTENT_TYPE);
  const frames: Frame[] = [];
  for await (const frame of decodeFrames(answer.body!, limits)) frames.push(frame);
  return frames;
}

const fetch = (fixture: Fixture, items: Array<{ path: string; sha256: string }>, peer = "b") =>
  fixture.core.service.serve(peer, "fetch", {}, { projectId: "p1", kind: "project", items });
const file = (fixture: Fixture, relative: string, sha256: string, range?: string, peer = "b") =>
  fixture.core.service.serve(peer, "file", {}, { projectId: "p1", kind: "project", path: relative, sha256 }, range);

test("fetch answers each item with its bytes, or why not: changed, missing, denied", async (t) => {
  const fixture = await setup(t);
  writeFileSync(path.join(fixture.root, "one.txt"), "one");
  mkdirSync(path.join(fixture.root, "sub"));
  writeFileSync(path.join(fixture.root, "sub", "two.txt"), "two two");
  writeFileSync(path.join(fixture.root, "edited.txt"), "before");
  writeFileSync(path.join(fixture.root, "gone.txt"), "gone");
  writeFileSync(path.join(fixture.root, "secret.txt"), "secret");
  writeFileSync(path.join(fixture.root, "empty.txt"), "");
  await fixture.scan();
  // After indexing: edited in place (new mtime and size), removed, and newly left out by a rule (its row stays until a rescan).
  writeFileSync(path.join(fixture.root, "edited.txt"), "after, longer");
  unlinkSync(path.join(fixture.root, "gone.txt"));
  await fixture.configure({ rules: { userRules: ["secret.txt"] } });

  const frames = await framesOf(await fetch(fixture, [
    { path: "one.txt", sha256: sha("one") },
    { path: "sub/two.txt", sha256: sha("two two") },
    { path: "one.txt", sha256: sha("not this") },
    { path: "edited.txt", sha256: sha("before") },
    { path: "gone.txt", sha256: sha("gone") },
    { path: "never.txt", sha256: sha("never") },
    { path: "secret.txt", sha256: sha("secret") },
    { path: "empty.txt", sha256: sha("") },
  ]));
  assert.deepEqual(frames.map((frame) => "error" in frame ? [frame.path, frame.error] : [frame.path, Buffer.from(frame.bytes).toString()]), [
    ["one.txt", "one"],
    ["sub/two.txt", "two two"],
    ["one.txt", "changed"],
    ["edited.txt", "changed"],
    ["gone.txt", "missing"],
    ["never.txt", "missing"],
    ["secret.txt", "denied"],
    ["empty.txt", ""],
  ]);
  const one = frames[0] as Extract<Frame, { sha256: string }>;
  assert.equal(one.sha256, sha("one"));
  assert.equal(one.size, 3);
});

test("fetch and file refuse a caller outside the share, and bad bodies", async (t) => {
  const fixture = await setup(t);
  writeFileSync(path.join(fixture.root, "one.txt"), "one");
  await fixture.scan();
  for (const answer of [await fetch(fixture, [{ path: "one.txt", sha256: sha("one") }], "c"), await file(fixture, "one.txt", sha("one"), undefined, "c")]) {
    assert.equal(answer.status, 403);
    assert.deepEqual(answer.json, { error: NOT_SHARED_ERROR });
  }
  assert.equal((await fixture.core.service.serve("b", "fetch", {}, { projectId: "p1", kind: "project", items: [] })).status, 400);
  assert.equal((await fixture.core.service.serve("b", "fetch", {}, { projectId: "p1", kind: "project", items: [{ path: "../x", sha256: sha("x") }] })).status, 400);
  assert.equal((await fixture.core.service.serve("b", "file", {}, { projectId: "p1", kind: "project", path: "/etc/passwd", sha256: sha("x") })).status, 400);
});

test("a fetch answer stops at its item and byte budget; the caller asks again for the rest", async (t) => {
  const limits: FrameLimits = { headerBytes: 16 * 1024, items: 3, bytes: 100 };
  const fixture = await setup(t, { frameLimits: limits });
  for (let index = 0; index < 5; index++) writeFileSync(path.join(fixture.root, `f${index}.txt`), `${index}`.repeat(10));
  writeFileSync(path.join(fixture.root, "big.txt"), "x".repeat(101));
  writeFileSync(path.join(fixture.root, "a60.txt"), "a".repeat(60));
  writeFileSync(path.join(fixture.root, "b60.txt"), "b".repeat(60));
  await fixture.scan();
  const items = Array.from({ length: 5 }, (_, index) => ({ path: `f${index}.txt`, sha256: sha(`${index}`.repeat(10)) }));
  const byItems = await framesOf(await fetch(fixture, items), limits);
  assert.deepEqual(byItems.map((frame) => frame.path), ["f0.txt", "f1.txt", "f2.txt"]);
  // Bigger than any answer may be: refused, so the caller takes it through `file`.
  const big = await framesOf(await fetch(fixture, [{ path: "big.txt", sha256: sha("x".repeat(101)) }]), limits);
  assert.deepEqual(big, [{ path: "big.txt", error: "denied" }]);
  // 60 + 60 > 100: the answer ends after the first, without an error for the second.
  const byBytes = await framesOf(await fetch(fixture, [{ path: "a60.txt", sha256: sha("a".repeat(60)) }, { path: "b60.txt", sha256: sha("b".repeat(60)) }]), limits);
  assert.deepEqual(byBytes.map((frame) => frame.path), ["a60.txt"]);
});

test("a file changed after it was opened is refused, not sent half old and half new", async (t) => {
  let fixture: Fixture;
  const grow = new Set<string>();
  fixture = await setup(t, { serviceHooks: { opened: (relative) => { if (grow.delete(relative)) appendFileSync(path.join(fixture.root, relative), "more"); } } });
  writeFileSync(path.join(fixture.root, "small.txt"), "small");
  writeFileSync(path.join(fixture.root, "large.bin"), Buffer.alloc(600 * 1024, 7));
  await fixture.scan();
  grow.add("small.txt");
  assert.deepEqual(await framesOf(await fetch(fixture, [{ path: "small.txt", sha256: sha("small") }])), [{ path: "small.txt", error: "changed" }]);
  grow.add("large.bin");
  const answer = await file(fixture, "large.bin", sha(Buffer.alloc(600 * 1024, 7)));
  assert.equal(answer.status, 200);
  await assert.rejects(bytesOf(answer), /changed while it was sent/);
});

test("file serves the whole file or one range, 416 for a bad range, 409 when the file is not the indexed one", async (t) => {
  const fixture = await setup(t);
  const content = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));
  writeFileSync(path.join(fixture.root, "data.bin"), content);
  writeFileSync(path.join(fixture.root, "edited.bin"), "before");
  writeFileSync(path.join(fixture.root, "empty.bin"), "");
  await fixture.scan();
  const hash = sha(content);

  const whole = await file(fixture, "data.bin", hash);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers["content-length"], "1000");
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.equal(whole.headers["content-range"], undefined);
  assert.deepEqual(await bytesOf(whole), content);

  for (const [range, start, end] of [["bytes=10-19", 10, 19], ["bytes=990-", 990, 999], ["bytes=-5", 995, 999], ["bytes=900-5000", 900, 999], ["bytes=0-0", 0, 0]] as const) {
    const answer = await file(fixture, "data.bin", hash, range);
    assert.equal(answer.status, 206, range);
    assert.equal(answer.headers["content-range"], `bytes ${start}-${end}/1000`, range);
    assert.equal(answer.headers["content-length"], String(end - start + 1), range);
    assert.deepEqual(await bytesOf(answer), content.subarray(start, end + 1), range);
  }
  for (const range of ["bytes=1000-", "bytes=5-2", "bytes=abc", "bytes=-0", "bytes=0-1,5-6", "items=0-1", "bytes=-"]) {
    const answer = await file(fixture, "data.bin", hash, range);
    assert.equal(answer.status, 416, range);
    assert.equal(answer.headers["content-range"], "bytes */1000", range);
    assert.equal(answer.body, undefined, range);
  }
  const empty = await file(fixture, "empty.bin", sha(""));
  assert.equal(empty.status, 200);
  assert.equal((await bytesOf(empty)).length, 0);
  assert.equal((await file(fixture, "empty.bin", sha(""), "bytes=0-")).status, 416);

  writeFileSync(path.join(fixture.root, "edited.bin"), "after!");
  assert.deepEqual([await file(fixture, "edited.bin", sha("before"))].map((answer) => [answer.status, answer.json]), [[409, { error: "changed" }]]);
  assert.deepEqual([await file(fixture, "data.bin", sha("other"))].map((answer) => [answer.status, answer.json]), [[409, { error: "changed" }]]);
  assert.deepEqual([await file(fixture, "nowhere.bin", sha("x"))].map((answer) => [answer.status, answer.json]), [[409, { error: "missing" }]]);
});

test("O_NOFOLLOW: a symbolic link swapped in after indexing is never served, nor what a swapped parent points at", async (t) => {
  const fixture = await setup(t);
  writeFileSync(path.join(fixture.root, "target.txt"), "same bytes");
  mkdirSync(path.join(fixture.root, "dir"));
  writeFileSync(path.join(fixture.root, "dir", "inner.txt"), "inner");
  await fixture.scan();
  // Same name, same content, same size: only the open without following tells the difference.
  writeFileSync(path.join(fixture.outside, "target.txt"), "same bytes");
  unlinkSync(path.join(fixture.root, "target.txt"));
  symlinkSync(path.join(fixture.outside, "target.txt"), path.join(fixture.root, "target.txt"));
  assert.deepEqual(await framesOf(await fetch(fixture, [{ path: "target.txt", sha256: sha("same bytes") }])), [{ path: "target.txt", error: "changed" }]);
  assert.deepEqual([await file(fixture, "target.txt", sha("same bytes"))].map((answer) => [answer.status, answer.json]), [[409, { error: "changed" }]]);
  // A parent replaced by a link to elsewhere leads to another inode: refused too.
  writeFileSync(path.join(fixture.outside, "inner.txt"), "inner");
  renameSync(path.join(fixture.root, "dir"), path.join(fixture.root, "dir-moved"));
  symlinkSync(fixture.outside, path.join(fixture.root, "dir"));
  assert.deepEqual(await framesOf(await fetch(fixture, [{ path: "dir/inner.txt", sha256: sha("inner") }])), [{ path: "dir/inner.txt", error: "changed" }]);
  assert.equal((await file(fixture, "dir/inner.txt", sha("inner"))).status, 409);
});

test("an unreadable file is denied", { skip: process.getuid?.() === 0 ? "root reads anything" : false }, async (t) => {
  const fixture = await setup(t);
  writeFileSync(path.join(fixture.root, "locked.txt"), "locked");
  await fixture.scan();
  chmodSync(path.join(fixture.root, "locked.txt"), 0o000);
  try {
    assert.deepEqual(await framesOf(await fetch(fixture, [{ path: "locked.txt", sha256: sha("locked") }])), [{ path: "locked.txt", error: "denied" }]);
    assert.deepEqual([await file(fixture, "locked.txt", sha("locked"))].map((answer) => [answer.status, answer.json]), [[409, { error: "denied" }]]);
  } finally {
    chmodSync(path.join(fixture.root, "locked.txt"), 0o600);
  }
});

test("revocation wins: an answer in progress stops once the caller leaves the share", async (t) => {
  let fixture: Fixture;
  let revoke = false;
  fixture = await setup(t, { serviceHooks: { opened: async () => { if (revoke) { revoke = false; await fixture.configure({ peers: [] }); } } } });
  writeFileSync(path.join(fixture.root, "a.txt"), "a");
  writeFileSync(path.join(fixture.root, "b.txt"), "b");
  writeFileSync(path.join(fixture.root, "big.bin"), Buffer.alloc(300 * 1024, 1));
  await fixture.scan();
  revoke = true;
  // Revoked while the first file was open: nothing more goes out, that file included.
  assert.deepEqual(await framesOf(await fetch(fixture, [{ path: "a.txt", sha256: sha("a") }, { path: "b.txt", sha256: sha("b") }])), []);
  assert.equal((await fetch(fixture, [{ path: "a.txt", sha256: sha("a") }])).status, 403);
  await fixture.configure();
  const answer = await file(fixture, "big.bin", sha(Buffer.alloc(300 * 1024, 1)));
  assert.equal(answer.status, 200);
  revoke = true;
  await assert.rejects(bytesOf(answer), /no longer shared/);
});

test("parseRange", () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange("", 10), null);
  assert.deepEqual(parseRange("bytes=0-9", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange(" bytes = 3 - ", 10), { start: 3, end: 9 });
  assert.deepEqual(parseRange("bytes=-20", 10), { start: 0, end: 9 });
  assert.equal(parseRange("bytes=10-", 10), "bad");
  assert.equal(parseRange("bytes=99999999999999999999-", 10), "bad");
  assert.equal(parseRange("bytes=-1", 0), "bad");
});
