import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeFrames, encodeFrames, FRAME_LIMITS, FrameFormatError, FrameWriter, type Frame } from "../src/file-sync/frames.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function file(path: string, text: string): Frame {
  const bytes = Buffer.from(text);
  return { path, sha256: sha(bytes), size: bytes.length, bytes };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function encoded(frames: Frame[]): Promise<Buffer> {
  return Buffer.concat(await collect(encodeFrames(frames)));
}

function rawFrame(header: unknown, bytes = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, bytes]);
}

function plain(frames: Frame[]): unknown[] {
  return frames.map((frame) => "error" in frame ? frame : { ...frame, bytes: Buffer.from(frame.bytes).toString() });
}

test("frames round-trip through the streaming decoder at any chunk size", async () => {
  const frames: Frame[] = [file("a.txt", "alpha"), { path: "gone.txt", error: "missing" }, file("dir/empty", ""), file("b.bin", "x".repeat(10_000)), { path: "c", error: "changed" }];
  const bytes = await encoded(frames);
  for (const size of [1, 3, 7, 4096, bytes.length]) {
    const decoded = await collect(decodeFrames(chunked(bytes, size)));
    assert.deepEqual(plain(decoded), plain(frames), `chunk size ${size} decoded differently`);
  }
});

test("the header is a big-endian length followed by {path, sha256, size}", async () => {
  const frame = file("a.txt", "hi");
  const bytes = await encoded([frame]);
  const length = bytes.readUInt32BE(0);
  assert.deepEqual(JSON.parse(bytes.subarray(4, 4 + length).toString()), { path: "a.txt", sha256: sha(Buffer.from("hi")), size: 2 });
  assert.equal(bytes.subarray(4 + length).toString(), "hi");
});

test("an empty answer decodes to no frames", async () => {
  assert.deepEqual(await collect(decodeFrames(chunked(Buffer.alloc(0), 1))), []);
});

test("a stream cut anywhere inside a frame is reported as truncated", async () => {
  const bytes = await encoded([file("a.txt", "alpha"), file("b.txt", "beta")]);
  const firstEnd = 4 + bytes.readUInt32BE(0) + 5;
  for (const cut of [1, 3, 4, 10, firstEnd - 1, firstEnd + 2, bytes.length - 1]) {
    await assert.rejects(collect(decodeFrames(chunked(bytes.subarray(0, cut), 2))), /Truncated/, `cut at ${cut} of ${bytes.length} must fail`);
  }
});

test("the decoder rejects oversized and zero-length headers", async () => {
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(FRAME_LIMITS.headerBytes + 1, 0);
  await assert.rejects(collect(decodeFrames(chunked(huge, 4))), /out of range/);
  await assert.rejects(collect(decodeFrames(chunked(Buffer.alloc(4), 4))), /out of range/);
});

test("the decoder rejects malformed headers", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ path: "a", sha256: "nothex", size: 1 }, /Invalid frame header/],
    [{ path: "../a", sha256: "a".repeat(64), size: 0 }, /Invalid frame header/],
    [{ path: "a", error: "exploded" }, /Invalid frame header/],
    [{ path: "a", sha256: "a".repeat(64), size: -1 }, /Invalid frame header/],
    [{ path: "café", sha256: "a".repeat(64), size: 0 }, /Invalid frame header/],
  ];
  for (const [header, error] of cases) await assert.rejects(collect(decodeFrames(chunked(rawFrame(header), 64))), error, JSON.stringify(header));
  const notJson = Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{x")]);
  await assert.rejects(collect(decodeFrames(chunked(notJson, 64))), /not JSON/);
});

test("the decoder strips unknown header keys", async () => {
  const [frame] = await collect(decodeFrames(chunked(rawFrame({ path: "a", sha256: "a".repeat(64), size: 1, extra: true }, Buffer.from("z")), 64)));
  assert.deepEqual(Object.keys(frame).sort(), ["bytes", "path", "sha256", "size"]);
});

test("the decoder enforces the item and byte limits", async () => {
  const limits = { headerBytes: 1024, items: 2, bytes: 10 };
  const three = await encoded([file("a", "1"), file("b", "2"), file("c", "3")]);
  await assert.rejects(collect(decodeFrames(chunked(three, 5), limits)), /Too many frames/);
  const big = rawFrame({ path: "a", sha256: "a".repeat(64), size: 11 }, Buffer.alloc(11));
  await assert.rejects(collect(decodeFrames(chunked(big, 5), limits)), /exceed/);
});

test("a consumer that stops early closes the source", async () => {
  let closed = false;
  const bytes = await encoded([file("a", "1"), file("b", "2")]);
  async function* source(): AsyncGenerator<Uint8Array> {
    try { yield bytes; } finally { closed = true; }
  }
  for await (const frame of decodeFrames(source())) { assert.equal(frame.path, "a"); break; }
  assert.equal(closed, true, "breaking out of the decoder must return the source iterator");
});

test("FrameWriter refuses to exceed an answer's limits", () => {
  const writer = new FrameWriter({ headerBytes: 1024, items: 2, bytes: 4 });
  writer.encode(file("a", "abc"));
  assert.equal(writer.remainingBytes, 1);
  assert.throws(() => writer.encode(file("b", "de")), FrameFormatError);
  writer.encode({ path: "b", error: "denied" });
  assert.equal(writer.remainingItems, 0);
  assert.throws(() => writer.encode({ path: "c", error: "denied" }), /Too many frames/);
  assert.throws(() => new FrameWriter().encode({ path: "/abs", error: "denied" }), /Invalid frame header/);
  assert.throws(() => new FrameWriter({ headerBytes: 40, items: 9, bytes: 9 }).encode(file("a".repeat(50), "")), /too large/);
});
