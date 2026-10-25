import { constants as fsConstants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { ZodError } from "zod";
import type { FileSyncDb, LocalEntry } from "./db.js";
import { FRAME_LIMITS, FrameWriter, type FrameErrorKind, type FrameLimits } from "./frames.js";
import { joinInside } from "./paths.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type ConfigureArgs, type FilesEndpoint, type ServeAnswer, type ShareSpec } from "./protocol.js";
import { FILE, shareKey, type Clock, type ShareKind, type ShareState } from "./types.js";
import {
  changedBodySchema, fetchBodySchema, fileBodySchema, indexIdSchema, indexQuerySchema, INDEX_CONTENT_TYPE, NOT_SHARED_ERROR, statusBodySchema, toWire,
  type SharesAnswer, type StatusAnswer,
} from "./wire.js";

/* Server logic of /api/cluster/v2/files/* (FILE-SYNC design §6.3), transport-agnostic: the direct
   listener and main's relay-fallback routes both call serve() once the request's signature is
   verified. Authorization per share is here: the caller must be in the share's peer set of the last
   configure, whatever else it may be allowed. Index pages are built and compressed here, in the
   worker, so neither the bytes nor the rows pass through the main thread. */

export interface FilesService {
  serve(peer: string, endpoint: FilesEndpoint, query: Record<string, string>, body: unknown, range?: string): Promise<ServeAnswer>;
}

export interface ServedShare {
  spec: ShareSpec;
  rulesHash: string;
  state(): ShareState;
  /** Whether the local rules leave a file out now: its row may outlive a rules change until the rescan, its bytes are not served. */
  ignored?(relative: string): boolean;
}

/** A share a peer named, as `changed` and `status` hand it to the sync layer. */
export interface Announced { key: string; indexId: string; maxSeq: number; rulesHash?: string }

export interface ServiceDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  config(): ConfigureArgs | undefined;
  origins(): string[];
  shares(): ReadonlyMap<string, ServedShare>;
  /** An authorized `changed` notice: compare and pull. `records` asks for the sender's shares answer. */
  changed(peer: string, shares: Announced[], records: boolean): void;
  /** An authorized `status` request: a caller ahead of our cursor is pulled from at once. */
  status(peer: string, shares: Announced[]): void;
  /** Between the files of a fetch answer and the chunks of a file answer: the worker's shared slice budget, so scans and RPCs get turns. */
  yieldSlice?(): Promise<void>;
  /** Tests: runs between reading an index page and reading the maxSeq it is paired with; after a file was opened for serving. */
  hooks?: { indexSnapshot?(): void; opened?(relative: string): void | Promise<void> };
  /** Tests: smaller fetch answers. */
  frameLimits?: FrameLimits;
}

export const FRAMES_CONTENT_TYPE = "application/x-joint-bob-frames";
/** One read per chunk of a file answer. */
const READ_CHUNK = 256 * 1024;
/** A file answer checks the descriptor's fingerprint this often (and before its last chunk): a file written under it ends the answer. */
const RECHECK_BYTES = 64 * 1024 * 1024;
// O_NOFOLLOW: a symbolic link swapped in at the name fails the open (ELOOP) instead of serving what it points at.
// O_NONBLOCK: a FIFO swapped in must not hang the open; regular files ignore it.
const OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0);

type Found = { entry: LocalEntry; absolute: string };
type ByteRange = { start: number; end: number };

/** The open file is the one the scanner indexed: a regular file with the same inode, size and on-disk mtime. */
function matches(stat: Stats, entry: LocalEntry): boolean {
  return stat.isFile() && stat.ino === entry.ino && stat.size === entry.size && stat.mtimeMs === entry.fsMtimeMs;
}

class ChangedWhileServing extends Error {}

/** Opens the indexed file without following a link at its name and checks its fingerprint; why not, otherwise. */
async function openIndexed(found: Found): Promise<{ handle: FileHandle } | { error: FrameErrorKind }> {
  let handle: FileHandle;
  try { handle = await open(found.absolute, OPEN_FLAGS); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { error: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "EACCES" || code === "EPERM" ? "denied" : "changed" };
  }
  try {
    if (matches(await handle.stat(), found.entry)) return { handle };
  } catch { /* unreadable now: as good as changed */ }
  await handle.close().catch(() => {});
  return { error: "changed" };
}

/** Reads `length` bytes at `position`; fewer only when the file ended early. */
async function readFully(handle: FileHandle, buffer: Buffer, length: number, position: number): Promise<number> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, Math.min(READ_CHUNK, length - done), position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return done;
}

/**
 * One `bytes=` range of a file of `size` bytes: null without a header, "bad" (416) when it is malformed, a
 * multi-range, or unsatisfiable. Only this engine asks, and it asks for one range or a suffix.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "bad" {
  if (header === undefined || header.trim() === "") return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return "bad";
  if (match[1] === "") {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length === 0 || size === 0) return "bad";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || start >= size || last < start) return "bad";
  return { start, end: Math.min(last, size - 1) };
}

class ServiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const notShared = (): ServiceError => new ServiceError(403, NOT_SHARED_ERROR);
const gzipAsync = promisify(gzip);
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/** Entries encoded per turn of the event loop. */
const SERIALIZE_CHUNK = 500;

function json(status: number, value: unknown): ServeAnswer {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, json: value };
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

export function createFilesService(deps: ServiceDeps): FilesService {
  const { db } = deps;

  function servedFor(peer: string): ServedShare[] {
    return [...deps.shares().values()].filter((share) => share.spec.peers.includes(peer));
  }

  /** A share missing from the last configure is refused like one the caller is not in: main derives again on its own triggers. */
  function authorized(peer: string, projectId: string, kind: ShareKind): ServedShare {
    const served = deps.shares().get(shareKey({ projectId, kind }));
    if (!served || !served.spec.peers.includes(peer)) throw notShared();
    return served;
  }

  function shares(peer: string): ServeAnswer {
    const config = deps.config();
    const served = config?.enabled ? servedFor(peer) : [];
    const projects = new Set(served.map((share) => share.spec.projectId));
    const answer: SharesAnswer = {
      fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: Boolean(config?.enabled) },
      nodeId: deps.nodeId,
      hostId: config?.hostId ?? "",
      origins: deps.origins(),
      shares: served.flatMap((share) => {
        const row = db.share(share.spec.key);
        if (!row) return [];
        return [{
          projectId: share.spec.projectId, kind: share.spec.kind, indexId: row.indexId, maxSeq: row.maxSeq, digest: row.digest, rulesHash: share.rulesHash,
          state: share.state(), builtinSince: row.builtinSince, prunedBelow: row.prunedBelow, rootDev: row.rootDev, rootIno: row.rootIno,
        }];
      }),
      // Records about projects the caller shares, and this node's own all-projects rules once it shares anything.
      engines: (config?.records.engines ?? []).filter((record) => projects.has(record.projectId)),
      settings: (config?.records.settings ?? []).filter((record) => record.key.startsWith("project:")
        ? projects.has(record.key.slice("project:".length))
        : record.key === `global:${deps.nodeId}` && projects.size > 0),
    };
    return json(200, answer);
  }

  async function index(peer: string, query: Record<string, string>): Promise<ServeAnswer> {
    const parsed = indexQuerySchema.parse(query);
    // Not in indexQuerySchema (old wire module): the generation the caller's `since` belongs to.
    const known = query.indexId !== undefined ? indexIdSchema.safeParse(query.indexId) : undefined;
    const served = authorized(peer, parsed.projectId, parsed.kind);
    const key = served.spec.key;
    // One snapshot: rows and the maxSeq they are paired with, so `more ? last.seq : maxSeq` can never skip a row committed in between.
    const { rows, share } = db.readTx(() => {
      const rows = db.entriesSince(key, parsed.since, parsed.limit + 1);
      deps.hooks?.indexSnapshot?.();
      return { rows, share: db.share(key) };
    });
    if (!share) throw notShared();
    const more = rows.length > parsed.limit;
    const entries = more ? rows.slice(0, parsed.limit) : rows;
    const head = JSON.stringify({
      indexId: share.indexId, maxSeq: share.maxSeq, digest: share.digest, prunedBelow: share.prunedBelow, builtinSince: share.builtinSince,
      rulesHash: served.rulesHash, more,
    });
    // The rows are one snapshot already; encoding them goes in slices and compression on zlib's pool, so a
    // 5,000-entry page does not hold up the worker's other requests and scans (§5.1).
    const parts: string[] = [];
    for (let at = 0; at < entries.length; at += SERIALIZE_CHUNK) {
      if (at) await yieldTurn();
      parts.push(entries.slice(at, at + SERIALIZE_CHUNK).map((entry) => JSON.stringify(toWire(entry))).join(","));
    }
    const bytes = await gzipAsync(Buffer.from(`${head.slice(0, -1)},"entries":[${parts.join(",")}]}`, "utf8"));
    // The caller holds everything up to `since` of this generation: tombstones it acknowledged may be pruned (§5.2.8).
    // A `since` from another generation (or from a caller that does not say which) acknowledges nothing.
    if (parsed.since <= share.maxSeq && (parsed.since === 0 || (known?.success && known.data === share.indexId))) {
      db.writeTx(() => db.setAck(key, peer, share.indexId, parsed.since, deps.clock.now()));
    }
    // Compressed JSON as the body's own type: no Content-Encoding (main's cluster routes refuse encoded bodies, proxies may undo them).
    return { status: 200, headers: { "content-type": INDEX_CONTENT_TYPE, "content-length": String(bytes.length) }, body: once(bytes) };
  }

  function changed(peer: string, body: unknown): ServeAnswer {
    const parsed = changedBodySchema.parse(body ?? {});
    const served = deps.shares();
    const named: Announced[] = [];
    for (const share of parsed.shares) {
      const key = shareKey(share);
      if (served.get(key)?.spec.peers.includes(peer)) named.push({ key, indexId: share.indexId, maxSeq: share.maxSeq, ...(share.rulesHash ? { rulesHash: share.rulesHash } : {}) });
    }
    if (!named.length && (parsed.shares.length || !servedFor(peer).length)) throw notShared();
    // Scheduling only: the pulls run after the answer.
    deps.changed(peer, named, Boolean(parsed.records));
    return json(202, {});
  }

  function status(peer: string, body: unknown): ServeAnswer {
    const parsed = statusBodySchema.parse(body ?? {});
    const served = servedFor(peer).filter((share) => share.spec.projectId === parsed.projectId);
    if (!served.length) throw notShared();
    const answer: StatusAnswer = {
      shares: served.flatMap((share) => {
        const row = db.share(share.spec.key);
        if (!row) return [];
        const cursor = db.cursor(share.spec.key, peer);
        const need = db.needSummary(share.spec.key);
        return [{
          kind: share.spec.kind, state: share.state(), cursor: cursor?.indexId ? cursor.seq : 0, callerIndexId: cursor?.indexId ?? null,
          need: { files: need.files, bytes: need.bytes }, blocked: need.blocked, errors: db.errorCount(share.spec.key), digest: row.digest, maxSeq: row.maxSeq,
        }];
      }),
    };
    const asked: Announced[] = [];
    for (const share of parsed.shares ?? []) {
      const key = shareKey({ projectId: parsed.projectId, kind: share.kind });
      if (served.some((candidate) => candidate.spec.key === key)) asked.push({ key, indexId: share.indexId, maxSeq: share.maxSeq });
    }
    if (asked.length) deps.status(peer, asked);
    return json(200, answer);
  }

  // ---- file bytes (§6.3): only what the index holds live, from the very file the scanner hashed ----

  /** Revocation wins (invariant 8): checked again before every file and chunk an answer sends. */
  function stillShared(peer: string, key: string): boolean {
    return deps.shares().get(key)?.spec.peers.includes(peer) === true;
  }

  /** The live local row and on-disk path of a file a peer asks for by content, or why it cannot have it. */
  function lookup(served: ServedShare, relative: string, sha256: string): Found | { error: FrameErrorKind } {
    const key = served.spec.key;
    const entry = db.entry(key, relative);
    if (!entry || entry.deleted) return { error: "missing" };
    if (served.ignored?.(relative)) return { error: "denied" };
    if (entry.type !== FILE || entry.sha256 !== sha256) return { error: "changed" };
    const share = db.share(key);
    if (!share) return { error: "missing" };
    try { return { entry, absolute: joinInside(share.root, entry.fsName ?? entry.path) }; } catch { return { error: "denied" }; }
  }

  /** One small file whole, checked against the index when opened and again after reading (written meanwhile → changed). */
  async function readItem(found: Found): Promise<{ bytes: Buffer } | { error: FrameErrorKind }> {
    const opened = await openIndexed(found);
    if ("error" in opened) return opened;
    const { handle } = opened;
    try {
      await deps.hooks?.opened?.(found.entry.path);
      const bytes = Buffer.allocUnsafe(found.entry.size);
      const read = await readFully(handle, bytes, bytes.length, 0);
      if (read !== bytes.length || !matches(await handle.stat(), found.entry)) return { error: "changed" };
      return { bytes };
    } catch {
      return { error: "changed" };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * Frames in the order asked. The answer ends early, without the rest, at the item or byte budget or once the
   * share is no longer shared with the caller; the caller asks again for whatever it did not get. One file is in
   * memory at a time, and the consumer's pace (the socket, the relay window) holds the next read back.
   */
  async function* frames(peer: string, served: ServedShare, items: ReadonlyArray<{ path: string; sha256: string }>, limits: FrameLimits): AsyncGenerator<Uint8Array> {
    const writer = new FrameWriter(limits);
    const key = served.spec.key;
    for (const [index, item] of items.entries()) {
      if (writer.remainingItems <= 0) return;
      if (index) await deps.yieldSlice?.();
      if (!stillShared(peer, key)) return;
      const found = lookup(served, item.path, item.sha256);
      if ("error" in found) { yield* writer.encode({ path: item.path, error: found.error }); continue; }
      // Larger than any answer may carry: only `file` can.
      if (found.entry.size > limits.bytes) { yield* writer.encode({ path: item.path, error: "denied" }); continue; }
      if (found.entry.size > writer.remainingBytes) return;
      const read = await readItem(found);
      if (!stillShared(peer, key)) return;
      if ("error" in read) { yield* writer.encode({ path: item.path, error: read.error }); continue; }
      yield* writer.encode({ path: item.path, sha256: item.sha256, size: read.bytes.length, bytes: read.bytes });
    }
  }

  function fetchFiles(peer: string, body: unknown): ServeAnswer {
    const parsed = fetchBodySchema.parse(body ?? {});
    const served = authorized(peer, parsed.projectId, parsed.kind);
    return { status: 200, headers: { "content-type": FRAMES_CONTENT_TYPE }, body: frames(peer, served, parsed.items, deps.frameLimits ?? FRAME_LIMITS) };
  }

  /**
   * Bytes start..end streamed from one descriptor. Opened when the reader starts, so an answer nobody reads
   * holds no descriptor; the fingerprint is checked at the open, every 64 MiB and before the last chunk, so an
   * answer that ends normally carries the indexed content (the receiver also verifies the hash).
   */
  async function* fileBytes(peer: string, key: string, found: Found, start: number, end: number): AsyncGenerator<Uint8Array> {
    const opened = await openIndexed(found);
    if ("error" in opened) throw new ChangedWhileServing("The file changed before it was sent");
    const { handle } = opened;
    try {
      await deps.hooks?.opened?.(found.entry.path);
      let position = start;
      let unchecked = 0;
      while (position <= end) {
        const length = Math.min(READ_CHUNK, end - position + 1);
        const chunk = Buffer.allocUnsafe(length);
        if (await readFully(handle, chunk, length, position) !== length) throw new ChangedWhileServing("The file changed while it was sent");
        position += length;
        unchecked += length;
        if (unchecked >= RECHECK_BYTES || position > end) {
          unchecked = 0;
          if (!matches(await handle.stat(), found.entry)) throw new ChangedWhileServing("The file changed while it was sent");
        }
        if (!stillShared(peer, key)) throw new ChangedWhileServing("The project is no longer shared with this node");
        yield chunk;
        await deps.yieldSlice?.();
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function file(peer: string, body: unknown, range: string | undefined): Promise<ServeAnswer> {
    const parsed = fileBodySchema.parse(body ?? {});
    const served = authorized(peer, parsed.projectId, parsed.kind);
    const found = lookup(served, parsed.path, parsed.sha256);
    // 409 for every per-file refusal: 404 reads as "an old node" and 403 as "not shared" to the caller.
    if ("error" in found) return json(409, { error: found.error });
    // Checked before the head goes out, so a file that changed since its scan gets a 409 rather than a broken stream.
    const probe = await openIndexed(found);
    if ("error" in probe) return json(409, { error: probe.error });
    await probe.handle.close().catch(() => {});
    const size = found.entry.size;
    const wanted = parseRange(range, size);
    if (wanted === "bad") return { status: 416, headers: { "content-type": "application/json; charset=utf-8", "content-range": `bytes */${size}` }, json: { error: "Range not satisfiable" } };
    const start = wanted?.start ?? 0;
    const end = wanted?.end ?? size - 1;
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream", "content-length": String(end - start + 1), "accept-ranges": "bytes",
      ...(wanted ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    };
    return { status: wanted ? 206 : 200, headers, body: size === 0 ? once(new Uint8Array(0)) : fileBytes(peer, served.spec.key, found, start, end) };
  }

  return {
    async serve(peer, endpoint, query, body, range) {
      // Before the first configure nothing is authorized yet; a caller retries with backoff.
      if (!deps.config()) return json(503, { error: "File sync is starting" });
      try {
        switch (endpoint) {
          case "shares": return shares(peer);
          case "index": return await index(peer, query ?? {});
          case "changed": return changed(peer, body);
          case "status": return status(peer, body);
          case "fetch": return fetchFiles(peer, body);
          case "file": return await file(peer, body, range);
          default: return json(404, { error: "Not found" });
        }
      } catch (error) {
        if (error instanceof ServiceError) return json(error.status, { error: error.message });
        if (error instanceof ZodError) return json(400, { error: "Invalid request" });
        throw error;
      }
    },
  };
}
