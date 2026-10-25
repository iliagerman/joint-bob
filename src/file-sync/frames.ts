import { z } from "zod";
import { normalizeRelativePath } from "./paths.js";

/* The `fetch` answer: many small files in one response. Each item is
   [u32 BE header length][header JSON][bytes], the header being {path, sha256, size} followed by
   `size` bytes, or {path, error} with no bytes. Limits bound what a peer can make us buffer. */

export const FRAME_LIMITS = { headerBytes: 16 * 1024, items: 256, bytes: 8 * 1024 * 1024 } as const;
export type FrameLimits = { headerBytes: number; items: number; bytes: number };

export type FrameErrorKind = "changed" | "missing" | "denied";
export type FileFrame = { path: string; sha256: string; size: number; bytes: Uint8Array };
export type ErrorFrame = { path: string; error: FrameErrorKind };
export type Frame = FileFrame | ErrorFrame;

export class FrameFormatError extends Error {}

const framePath = z.string().refine((value) => {
  try { return normalizeRelativePath(value) === value; } catch { return false; }
});
const fileHeader = z.object({ path: framePath, sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
const errorHeader = z.object({ path: framePath, error: z.enum(["changed", "missing", "denied"]) });

/** Tracks one answer's budget; `encode` throws FrameFormatError instead of exceeding it. */
export class FrameWriter {
  private items = 0;
  private bytes = 0;

  constructor(private readonly limits: FrameLimits = FRAME_LIMITS) {}

  /** Bytes still allowed in this answer. */
  get remainingBytes(): number { return this.limits.bytes - this.bytes; }
  get remainingItems(): number { return this.limits.items - this.items; }

  encode(frame: Frame): Uint8Array[] {
    const header = "error" in frame
      ? { path: frame.path, error: frame.error }
      : { path: frame.path, sha256: frame.sha256, size: frame.bytes.byteLength };
    const parsed = ("error" in header ? errorHeader : fileHeader).safeParse(header);
    if (!parsed.success) throw new FrameFormatError(`Invalid frame header for ${frame.path}`);
    if (this.items + 1 > this.limits.items) throw new FrameFormatError("Too many frames in one answer");
    const size = "error" in frame ? 0 : frame.bytes.byteLength;
    if (this.bytes + size > this.limits.bytes) throw new FrameFormatError("Frame bytes exceed the answer limit");
    const json = Buffer.from(JSON.stringify(header), "utf8");
    if (json.length > this.limits.headerBytes) throw new FrameFormatError("Frame header is too large");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length, 0);
    this.items += 1;
    this.bytes += size;
    return "error" in frame || size === 0 ? [prefix, json] : [prefix, json, frame.bytes];
  }
}

export async function* encodeFrames(frames: Iterable<Frame> | AsyncIterable<Frame>, limits: FrameLimits = FRAME_LIMITS): AsyncGenerator<Uint8Array> {
  const writer = new FrameWriter(limits);
  for await (const frame of frames) yield* writer.encode(frame);
}

// Pulls exact byte counts out of a chunked stream without re-concatenating everything buffered.
class ByteReader {
  private chunks: Buffer[] = [];
  private offset = 0;
  private buffered = 0;
  private done = false;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  /** `count` bytes, or null at a clean end of stream when `endOk` and nothing is buffered. */
  async read(count: number, endOk = false): Promise<Buffer | null> {
    while (this.buffered < count && !this.done) {
      const next = await this.source.next();
      if (next.done) { this.done = true; break; }
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      if (chunk.length) { this.chunks.push(chunk); this.buffered += chunk.length; }
    }
    if (this.buffered < count) {
      if (endOk && this.buffered === 0) return null;
      throw new FrameFormatError("Truncated fetch answer");
    }
    const parts: Buffer[] = [];
    let needed = count;
    while (needed > 0) {
      const chunk = this.chunks[0];
      const take = Math.min(needed, chunk.length - this.offset);
      parts.push(chunk.subarray(this.offset, this.offset + take));
      this.offset += take;
      needed -= take;
      if (this.offset === chunk.length) { this.chunks.shift(); this.offset = 0; }
    }
    this.buffered -= count;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
  }
}

function parseHeader(json: Buffer): z.infer<typeof fileHeader> | ErrorFrame {
  let value: unknown;
  try { value = JSON.parse(json.toString("utf8")); } catch { throw new FrameFormatError("Frame header is not JSON"); }
  const isError = value !== null && typeof value === "object" && "error" in value;
  const parsed = (isError ? errorHeader : fileHeader).safeParse(value);
  if (!parsed.success) throw new FrameFormatError("Invalid frame header");
  return parsed.data;
}

/** Frames from a fetch answer, in order. Throws FrameFormatError on a malformed or truncated stream
    or one over the limits. Bytes are not hash-checked here: apply verifies the temp file. */
export async function* decodeFrames(source: AsyncIterable<Uint8Array>, limits: FrameLimits = FRAME_LIMITS): AsyncGenerator<Frame> {
  const iterator = source[Symbol.asyncIterator]();
  const reader = new ByteReader(iterator);
  let items = 0;
  let bytes = 0;
  try {
    for (;;) {
      const prefix = await reader.read(4, true);
      if (!prefix) return;
      const length = prefix.readUInt32BE(0);
      if (length === 0 || length > limits.headerBytes) throw new FrameFormatError("Frame header length is out of range");
      const header = parseHeader((await reader.read(length))!);
      if (++items > limits.items) throw new FrameFormatError("Too many frames in one answer");
      if ("error" in header) { yield header; continue; }
      bytes += header.size;
      if (bytes > limits.bytes) throw new FrameFormatError("Frame bytes exceed the answer limit");
      const data = header.size ? (await reader.read(header.size))! : Buffer.alloc(0);
      yield { path: header.path, sha256: header.sha256, size: header.size, bytes: data };
    }
  } finally {
    await iterator.return?.();
  }
}
