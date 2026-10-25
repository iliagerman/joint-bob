import { createHash } from "node:crypto";
import { FILE, SYMLINK, type IndexEntry } from "./types.js";

/* A share's digest: the XOR of one hash per live entry, so a change updates it in O(1) and two nodes
   with the same synced tree compare equal without listing it. Tombstones are left out; mode is in, so
   a chmod that never arrived shows up as a mismatch. */

export const EMPTY_DIGEST = "0".repeat(64);
const HEX = /^[0-9a-f]{64}$/;

export type DigestFields = Pick<IndexEntry, "path" | "type" | "mode" | "sha256" | "target" | "deleted">;

/** sha256(path \0 type \0 content \0 mode) of a live entry; null for a tombstone. */
export function entryDigest(entry: DigestFields): Buffer | null {
  if (entry.deleted) return null;
  const content = entry.type === FILE ? entry.sha256 ?? "" : entry.type === SYMLINK ? entry.target ?? "" : "";
  const mode = entry.type === SYMLINK ? 0 : entry.mode & 0o777;
  return createHash("sha256").update(`${entry.path}\0${entry.type}\0${content}\0${mode.toString(8)}`, "utf8").digest();
}

export class Digest {
  private readonly bytes: Buffer;

  constructor(hex: string = EMPTY_DIGEST) {
    if (!HEX.test(hex)) throw new Error("Digest must be 64 lowercase hex characters");
    this.bytes = Buffer.from(hex, "hex");
  }

  private xor(entry: DigestFields | undefined): void {
    const hash = entry && entryDigest(entry);
    if (hash) for (let index = 0; index < 32; index += 1) this.bytes[index] ^= hash[index];
  }

  add(entry: DigestFields): this { this.xor(entry); return this; }
  remove(entry: DigestFields): this { this.xor(entry); return this; }
  /** One row changed from `before` to `after` (either may be absent or a tombstone). */
  change(before: DigestFields | undefined, after: DigestFields | undefined): this {
    this.xor(before);
    this.xor(after);
    return this;
  }

  toString(): string { return this.bytes.toString("hex"); }
}

export function digestOf(entries: Iterable<DigestFields>): string {
  const digest = new Digest();
  for (const entry of entries) digest.add(entry);
  return digest.toString();
}

export function updateDigest(digest: string, before: DigestFields | undefined, after: DigestFields | undefined): string {
  return new Digest(digest).change(before, after).toString();
}
