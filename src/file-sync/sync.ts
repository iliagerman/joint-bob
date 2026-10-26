import { createHash, type Hash } from "node:crypto";
import { constants as fsConstants, lstatSync, mkdirSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { FileSyncDb } from "./db.js";
import { decodeFrames, FRAME_LIMITS, type FrameLimits } from "./frames.js";
import type { NeedEngine } from "./need.js";
import { joinInside, parentKey } from "./paths.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type ConfigureArgs, type CoreEvent, type ShareSpec, type TempFingerprint } from "./protocol.js";
import type { Announced } from "./service.js";
import type { SpaceCheck } from "./trash.js";
import { FILE, shareKey, type Clock, type IndexEntry } from "./types.js";
import { decodeIndexPage, FETCH_ITEM_LIMIT, filesTarget, INDEX_PAGE_LIMIT, sharesAnswerSchema, type IndexPage, type SharesAnswer } from "./wire.js";

/* The client half of the protocol (FILE-SYNC design §6.2): pulls, notices, the capability probe and,
   in the builtin phase, transfers, per peer behind one small limiter. Nothing here polls: a pull starts
   on a notice, a status request, start, wake, a peer's return or a newly shared folder; a transfer pass
   runs when the need queue, a pull, a peer or a job changes, or at the one retry time the queue names;
   a failed delivery to a peer that is present is retried with backoff, and nothing while it is away. */

export interface PeerRequest {
  method: "GET" | "POST";
  /** Path and query under /api/cluster/v2/files, exactly as signed and sent. */
  target: string;
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  purpose: "notice" | "index" | "transfer" | "status" | "shares";
  /** "relay": only through main, whose channel authenticates the answer too; never a direct origin. */
  via?: "relay";
}
export interface PeerResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** The route that carried it, when the transport knows: a direct answer is plain HTTP that nothing signs. */
  route?: "direct" | "relay";
}
export interface PeerTransport {
  request(peer: string, request: PeerRequest): Promise<PeerResponse>;
  /** The route the last request to a peer took, for status. */
  route?(peer: string): "direct" | "relay" | "none";
  /** The peer reached us after it looked away: its addresses deserve a new try. */
  reachable?(peer: string): void;
}

export interface SyncShare { spec: ShareSpec; rulesHash: string }

// ---- what the transfer loop needs from need.ts, apply.ts and trash.ts (§5.4–§5.6, §6.2) ----

/** Content apply can take without the network: a live local file of any share, or a trash file. */
export type TransferLocalSource = { share: string; path: string } | { trash: string };

/** One need row as nextNeeds hands it out (need.ts NeedItem). */
export interface TransferItem {
  share: string;
  path: string;
  action: "fetch" | "delete" | "mkdir" | "symlink" | "meta" | "move";
  /** move: the local path of the same share that is renamed into place. */
  fromPath?: string;
  /** The full target version; for a fetch its sha256 names the bytes asked for. */
  target: IndexEntry;
  /** Eligible peers whose row has the target's content. */
  sources: readonly string[];
  localSources: readonly TransferLocalSource[];
  size: number;
  priority?: number;
  attempts?: number;
  conflict?: boolean;
}

export interface TransferQueue {
  /** Due, unblocked rows in transfer order; `inFlight` holds `share\npath` keys the loop is working on. */
  nextNeeds(options: { limit: number; availablePeers?: readonly string[]; inFlight?: Iterable<string> }): { items: TransferItem[]; nextRetryAt?: number };
  /** Tried again later with backoff (or after `delayMs`), when the stored target is still `target`. */
  retryLater(share: string, path: string, reason: string, options?: { delayMs?: number; target?: IndexEntry }): void;
  /** A failure the person has to see (an error row); `retryAfterMs` re-offers it later (not enough disk space). */
  block(share: string, path: string, reason: string, options?: { retryAfterMs?: number; target?: IndexEntry }): void;
  /** Rows at `prefix` (the whole share without one) go first until `until`. */
  prioritize?(share: string, prefix: string | undefined, until: number): void;
  /** The share's need rows changed: the loop takes another look. Returns the unsubscribe. */
  onNeedChanged?(listener: (share: string) => void): () => void;
}

/** What a transfer hands to apply for one path: downloaded bytes, a local copy to reuse, or the row's move. */
export interface TransferApplyInput {
  path: string;
  /** The deterministic temp beside the target holding the downloaded (hash-checked) bytes. */
  tempPath?: string;
  move?: boolean;
  localSource?: TransferLocalSource;
  /** The peer the bytes came from: it must still be in the share's peer set at the final rename (invariant 8). */
  source?: string;
  /** The temp as written whole here, every byte hash-checked on the way in: apply does not hash it again while it is still that file. */
  verified?: TempFingerprint;
}

/** applied; stale (the target moved or the source left the share: the temp is gone); retry later; changed on disk
    under it (scanned, retried); blocked (a permanent failure). `recorded`: apply noted retries and blocks in the need
    rows itself (apply.ts does), and the loop must not note them again: its batch may already have lifted that block. */
export type TransferOutcome = "applied" | "stale" | "retry" | "changed" | "blocked";
export interface TransferApplyResult { items: Array<{ path: string; outcome: TransferOutcome; reason?: string; /** blocked by disk space: offered again after this */ retryAfterMs?: number }>; recorded?: boolean }

/** Where a temp may be written: the parent directory (on-disk spelling), created symlink-safely, or why not. */
export type ParentCheck = { ok: true; directory: string } | { ok: false; reason: string; permanent?: boolean };

export interface TransferApplier {
  applyBatch(args: { share: string; items: TransferApplyInput[] }): Promise<TransferApplyResult>;
  /** apply.ts's symlink-safe parent preparation (§5.5.3); ensureParentsLocal below when absent. */
  ensureParents?(share: string, relative: string): ParentCheck;
  /** After a download ended: folders ensureParents made for items no longer wanted go again (apply.ts). */
  sweep?(share: string): void;
}

/** trash.ts: the floor check (pruning the trash first) and in-flight reservations (§5.5.10). */
export interface DiskSpace {
  ensureSpace(directory: string, bytes: number): SpaceCheck;
  reserve(directory: string, bytes: number): { release(): void };
}

export interface TransferDeps {
  queue: TransferQueue;
  apply: TransferApplier;
  disk: DiskSpace;
  /** Tests: runs after each chunk of a file download is written; a throw cuts the download there. */
  faults?: { midStream?(path: string, bytes: number): void };
  /** Tests: the 30 s stall guard, the 1 MiB fetch/file boundary, and fetch answer limits. */
  stallMs?: number;
  smallFileBytes?: number;
  frameLimits?: FrameLimits;
}

/** Received from one peer for one share since the worker started. */
export interface TransferCounters { directBytes: number; relayBytes: number; files: number }

export interface SyncDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  transport: PeerTransport;
  need: NeedEngine;
  emit(event: CoreEvent): void;
  shares(): ReadonlyMap<string, SyncShare>;
  hostId(): string;
  /** A pull ended or a peer's announcement or comparison moved: the share's status goes out. */
  stateChanged(key: string): void;
  /** Tests: shorter coalescing, and smaller pages to exercise paging. */
  noticeDelayMs?: number;
  pageLimit?: number;
  /** Transfers (builtin phase). Absent: this layer only pulls and notices (shadow-only nodes). */
  transfers?: TransferDeps;
}

const NOTICE_DELAY_MS = 250;
const MAX_BACKOFF_MS = 300_000;
const MAX_IN_FLIGHT = 4;
const MAX_INDEX_PULLS = 2;
/** A compressed page of 5,000 entries is a few hundred KB; this only stops a peer from filling memory. */
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const DIGEST_MISMATCH = "Index does not match its digest after a repair";

/** Files up to this size go in `fetch` batches; larger ones through `file`, resumable with Range. */
export const SMALL_FILE_BYTES = 1024 * 1024;
/** No byte for this long: the transfer is abandoned (a file's temp kept for the resume) and tried again. No total cap. */
export const TRANSFER_STALL_MS = 30_000;
/** A temp not written for this long is started over rather than resumed (the scanner removes such temps too). */
export const TEMP_STALE_MS = 60 * 60_000;
/** How long a handoff's status request keeps the caller's shares first in the queue (§6.5). */
export const HANDOFF_PRIORITY_MS = 10 * 60_000;
/** Transfers per peer at once: one limiter slot stays free, so index pulls and probes never wait behind long downloads. */
const TRANSFER_JOBS_PER_PEER = MAX_IN_FLIGHT - 1;
/** Need rows looked at per pass: enough for every slot of a peer to fill with a whole batch, plus local work. */
const TRANSFER_SCAN_LIMIT = (TRANSFER_JOBS_PER_PEER + 1) * FETCH_ITEM_LIMIT + 64;
/** Moves, deletes, folders, links, modes and local copies handed to apply at once (no network). */
const LOCAL_BATCH = 256;
/** Not enough disk space: offered again after this. */
const DISK_RETRY_MS = 60_000;
/** A source has another version or none: its newer index is probably on its way. */
const SOURCE_CHANGED_RETRY_MS = 5_000;
/** The path changed on disk under an apply: tried again once the scan looked at it. */
const CHANGED_RETRY_MS = 2_000;
/** setTimeout's longest delay. */
const MAX_TIMER_MS = 2_147_483_647;
const HASH_CHUNK = 1024 * 1024;
const ERROR_BODY_BYTES = 64 * 1024;

type Route = "direct" | "relay" | "none";
/** One request's worth of work: a fetch batch for one (peer, share), or one large file. */
interface TransferJob { peer: string; key: string; items: TransferItem[]; large: boolean; bytes?: number }
interface Prepared { item: TransferItem; temp: string }

function localInput(item: TransferItem): TransferApplyInput {
  if (item.action === "move") return { path: item.path, move: true };
  if (item.action === "fetch" && item.localSources.length) return { path: item.path, localSource: item.localSources[0] };
  return { path: item.path };
}

function fingerprint(st: Stats): TempFingerprint { return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }; }

/** A small download into its temp: created 0600 (apply sets the target's mode), never through a link at that name. Returns the file as written. */
async function writeTemp(file: string, bytes: Uint8Array): Promise<TempFingerprint> {
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    return fingerprint(await handle.stat());
  } finally { await handle.close(); }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** `.joint-bob-sync.<name40>.<hex16>.tmp`: deterministic per (share, path, content), so a download resumes where it stopped. */
export function transferTempName(share: string, relative: string, sha256: string): string {
  const base = relative.slice(relative.lastIndexOf("/") + 1);
  const name40 = Array.from(base).slice(0, 40).join("");
  const hex16 = createHash("sha256").update(`${share}\0${relative}\0${sha256}`).digest("hex").slice(0, 16);
  return `.joint-bob-sync.${name40}.${hex16}.tmp`;
}

/**
 * Symlink-safe parents for a temp when apply offers no helper (§5.5.3): every existing segment must be a real
 * directory with exactly that spelling, missing ones are created, a link is never followed. A link or a
 * case-variant is permanent until the person fixes it; a file in the way may be another need row's to replace.
 */
export function ensureParentsLocal(root: string, fsDirectory: string): ParentCheck {
  let current = path.resolve(root);
  let rootStat: Stats;
  try { rootStat = lstatSync(current); } catch { return { ok: false, reason: "The shared folder is missing" }; }
  if (!rootStat.isDirectory()) return { ok: false, reason: "The shared folder is not a folder", permanent: true };
  if (fsDirectory === "") return { ok: true, directory: current };
  for (const segment of fsDirectory.split("/")) {
    const next = path.join(current, segment);
    let stat: Stats | undefined;
    try { stat = lstatSync(next); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `A parent folder cannot be read: ${(error as Error).message}` };
    }
    if (!stat) {
      try { mkdirSync(next); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, reason: `A parent folder cannot be created: ${(error as Error).message}` };
      }
      stat = lstatSync(next);
    }
    if (stat.isSymbolicLink()) return { ok: false, reason: "A parent folder is a symbolic link here", permanent: true };
    if (!stat.isDirectory()) return { ok: false, reason: "A parent folder is a file here" };
    // A case-insensitive volume finds "Docs" under the name "docs": writing there would land in another folder. APFS
    // also finds either Unicode normalization of a name; that is the same folder, so only case counts.
    if (process.platform === "darwin") {
      const wanted = segment.normalize("NFC");
      if (!readdirSync(current).some((name) => name === segment || name.normalize("NFC") === wanted)) return { ok: false, reason: "A parent folder differs only in case here", permanent: true };
    }
    current = next;
  }
  return { ok: true, directory: current };
}

class StallError extends Error {
  constructor() { super("File sync transfer stalled"); this.name = "TimeoutError"; }
}

/**
 * Aborts `controller` once no byte moved for `ms` (no total cap). One timer per window, not one per chunk:
 * when it fires early it re-arms for the rest. Driven by the core's clock, so tests stall it on purpose.
 */
class StallWatch {
  private last: number;
  private timer: { cancel(): void } | undefined;
  private finished = false;

  constructor(private readonly clock: Clock, private readonly ms: number, private readonly controller: AbortController) {
    this.last = clock.now();
    this.arm(ms);
  }

  private arm(delay: number): void {
    this.timer = this.clock.setTimeout(() => {
      if (this.finished) return;
      const idle = this.clock.now() - this.last;
      if (idle >= this.ms) this.controller.abort(new StallError()); else this.arm(this.ms - idle);
    }, delay);
  }

  touch(): void { this.last = this.clock.now(); }

  done(): void { this.finished = true; this.timer?.cancel(); }
}

/**
 * `promise`, or the abort's reason once `signal` aborts first: a transport that ignores the signal cannot hold a
 * transfer. The listener goes when the promise settles, so a long stream does not pile them up.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** The body, each read raced against the abort, touching the stall watch as bytes arrive. */
async function* watched(body: AsyncIterable<Uint8Array>, signal: AbortSignal, stall: StallWatch): AsyncGenerator<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done) { finished = true; return; }
      stall.touch();
      yield next.value;
    }
  } finally {
    // A transport stuck in a read never settles its return(): not awaited, the abort signal ends it.
    if (!finished) void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function unlinkQuietly(file: string): void {
  try { unlinkSync(file); } catch { /* gone already */ }
}

type Capability = "unknown" | "capable" | "incapable";
type Timer = { cancel(): void };

/**
 * ≤ 4 requests in flight per peer, ≤ 2 of them index pulls; notices take no slot (they are tiny and
 * must not wait behind bulk work); a person's request goes ahead of queued background ones.
 */
export class PeerLimiter {
  private inFlight = 0;
  private pulls = 0;
  private readonly queue: Array<{ index: boolean; urgent: boolean; start: () => void }> = [];

  acquire(purpose: PeerRequest["purpose"], urgent = false): Promise<() => void> {
    if (purpose === "notice") return Promise.resolve(() => {});
    const index = purpose === "index";
    return new Promise((resolve) => {
      const start = () => {
        this.inFlight++;
        if (index) this.pulls++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.inFlight--;
          if (index) this.pulls--;
          this.pump();
        });
      };
      const waiter = { index, urgent, start };
      // Urgent ones queue behind earlier urgent ones only.
      if (urgent) {
        const at = this.queue.findIndex((queued) => !queued.urgent);
        if (at < 0) this.queue.push(waiter); else this.queue.splice(at, 0, waiter);
      } else this.queue.push(waiter);
      this.pump();
    });
  }

  private fits(index: boolean): boolean { return this.inFlight < MAX_IN_FLIGHT && (!index || this.pulls < MAX_INDEX_PULLS); }

  private pump(): void {
    // A pull held back by the pull cap does not hold back other requests behind it.
    for (let at = 0; at < this.queue.length && this.inFlight < MAX_IN_FLIGHT;) {
      if (this.fits(this.queue[at].index)) this.queue.splice(at, 1)[0].start(); else at++;
    }
  }

  get active(): { inFlight: number; pulls: number; queued: number } { return { inFlight: this.inFlight, pulls: this.pulls, queued: this.queue.length }; }
}

interface PeerState {
  id: string;
  present: boolean;
  capability: Capability;
  protocol: number;
  enabled: boolean;
  /** Its engine is off (its shares answer says so) or not ready (a notice got 503): nothing is noticed until a probe or its own notice says otherwise. */
  off: boolean;
  origins: string[];
  hostId?: string;
  limiter: PeerLimiter;
  lastCapability?: string;
  lastRecords?: string;
  contacting?: Promise<void>;
  /** A trigger that needs an answer newer than the one in flight (a notice from the peer itself). */
  contactAgain: boolean;
  /** The next successful contact notices every share (start, wake, return, a newly shared folder). */
  contactNotify: boolean;
  contactAttempts: number;
  contactRetry?: Timer;
  /** Shares the peer does not serve us (left out of its shares answer, or refused): not noticed until it names them again. */
  refused: Set<string>;
  /** Shares changed since the last notice (coalescing window). */
  pending: Set<string>;
  noticeTimer?: Timer;
  /** Shares whose notice could not be delivered; sent again with backoff while present. */
  outbox: Set<string>;
  outboxAttempts: number;
  outboxRetry?: Timer;
  sending?: Promise<void>;
}

interface Notice { projectId: string; kind: string; indexId: string; maxSeq: number; rulesHash: string }

interface PullState { peer: string; key: string; running?: Promise<void>; dirty: boolean; urgent: boolean; reset: boolean; attempts: number; retry?: Timer }

class Fetched { constructor(readonly status: number, readonly headers: Record<string, string>, readonly bytes: Buffer, readonly route?: "direct" | "relay") {} }

async function readBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error("Answer is too large");
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks, total);
}

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try { for await (const _chunk of body) { /* drained so the connection can be reused */ } } catch { /* nothing to keep */ }
}

function backoff(attempts: number): number { return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempts - 1)); }

/** A 503 from the peer's engine (main's routes with file sync off, or an engine still starting), not a relay's own (machine offline). */
function engineNotRunning(fetched: Fetched): boolean {
  try {
    const error = (JSON.parse(fetched.bytes.toString("utf8")) as { error?: unknown }).error;
    return typeof error === "string" && /^File sync is (off|starting)\b/.test(error);
  } catch {
    return false;
  }
}

function recordsText(answer: SharesAnswer): string | undefined {
  return answer.engines.length || answer.settings.length ? JSON.stringify([answer.engines, answer.settings]) : undefined;
}

export class SyncLayer {
  private readonly peers = new Map<string, PeerState>();
  private readonly pulls = new Map<string, PullState>();
  private readonly inflight = new Set<Promise<unknown>>();
  /** `share\npeer` pairs of the last configure, so a newly shared folder is pulled at once. */
  private pairs = new Set<string>();
  /** Same-folder guard: `share\npeer` of a peer on this machine whose share root is literally ours. */
  private readonly excluded = new Set<string>();
  /** Live consistency check: pairs repaired once for a digest mismatch, and pairs whose mismatch persisted. */
  private readonly repaired = new Set<string>();
  private readonly mismatched = new Set<string>();
  private readonly abort = new AbortController();
  private closed = false;
  /** Transfers: `share\npath` of items a job holds (downloading, or waiting for apply), and jobs per peer. */
  private readonly transferring = new Set<string>();
  private readonly peerJobs = new Map<string, number>();
  private localJob: Promise<void> | undefined;
  private pumpQueued = false;
  private transferTimer: { at: number; timer: Timer } | undefined;
  /** Main's event loop is busy: transfers over the relay fallback (which run through main) wait; direct ones do not touch main. */
  private relayPaused = false;
  private readonly counters = new Map<string, TransferCounters>();
  /** `share\npath\nsha` whose local copy apply could not use: downloaded next time. */
  private readonly localFailed = new Set<string>();
  /** `share\npath\nsha` → sources that answered they have another version: another source goes first next time. */
  private readonly sourceFailed = new Map<string, Set<string>>();
  /** applyBatch calls run one at a time: two batches never interleave their checks and renames in one tree. */
  private applying: Promise<unknown> = Promise.resolve();
  /** `share\npath` → the temp of its last unfinished large download: a newer version's download removes it. */
  private readonly lastTemps = new Map<string, string>();
  /** Content ids apply found stale: a second time in a row backs off instead of asking again at once. */
  private readonly staleSeen = new Set<string>();
  private readonly unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: SyncDeps) {
    // A changed queue (pulls, scans, applies, priorities) wakes the transfer loop; so do pulls ending, peers returning and its one retry timer.
    this.unsubscribe = deps.transfers?.queue.onNeedChanged?.(() => this.kickTransfers());
  }

  // ---- state ----

  private peer(id: string): PeerState {
    let state = this.peers.get(id);
    if (!state) {
      state = {
        id, present: false, capability: "unknown", protocol: 0, enabled: false, off: false, origins: [], limiter: new PeerLimiter(),
        contactAgain: false, contactNotify: false, contactAttempts: 0, refused: new Set(), pending: new Set(), outbox: new Set(), outboxAttempts: 0,
      };
      this.peers.set(id, state);
    }
    return state;
  }

  /** Background work: tracked for idle(), and never a rejection nobody handles (in a worker that would end the thread). */
  private track(key: string, work: () => Promise<void>, done?: () => void): Promise<void> {
    const promise: Promise<void> = work().catch((error) => {
      if (!this.closed) this.warn(key, `File sync: ${(error as Error).message}`);
    }).finally(() => {
      this.inflight.delete(promise);
      done?.();
    });
    this.inflight.add(promise);
    return promise;
  }

  private warn(key: string, message: string): void { this.deps.emit({ event: "log", level: "warn", key, message }); }

  private sharesWith(peer: string): Array<[string, SyncShare]> {
    return [...this.deps.shares()].filter(([key, share]) => share.spec.peers.includes(peer) && !this.isExcluded(key, peer));
  }

  /** Whether a notice about this share (or any, without one) can mean something to the peer now. */
  private noticeable(state: PeerState, key?: string): boolean {
    return state.present && state.capability !== "incapable" && !state.off && (key === undefined || !state.refused.has(key));
  }

  isExcluded(key: string, peer: string): boolean { return this.excluded.has(`${key}\n${peer}`); }

  route(peer: string): "direct" | "relay" | "none" { return this.deps.transport.route?.(peer) ?? "none"; }

  /** Whether a pull of this pair is running or queued (tests and status). */
  pulling(key: string, peer: string): boolean { return Boolean(this.pulls.get(`${key}\n${peer}`)?.running); }

  mismatch(key: string): string[] { return [...this.mismatched].filter((pair) => pair.startsWith(`${key}\n`)).map((pair) => pair.slice(key.length + 1)); }

  /** Resolves once no request, pull or notice is running (tests; stop). Coalescing and retry timers are not waited for. */
  async idle(): Promise<void> {
    while (this.inflight.size || this.deps.need.busy) {
      await Promise.allSettled([...this.inflight]);
      await this.deps.need.idle();
    }
  }

  // ---- triggers ----

  /** The desired state: presence from main, and a contact for every peer that shares a folder with us for the first time. */
  configure(args: ConfigureArgs): void {
    if (this.closed) return;
    const pairs = new Set<string>();
    const contact = new Set<string>();
    const shares = args.enabled ? args.shares : [];
    for (const share of shares) {
      for (const peer of share.peers) {
        const pair = `${share.key}\n${peer}`;
        pairs.add(pair);
        if (!this.pairs.has(pair)) contact.add(peer);
      }
    }
    const removed = [...this.pairs].filter((pair) => !pairs.has(pair));
    this.pairs = pairs;
    const listed = new Set(args.peers.map((peer) => peer.nodeId));
    for (const spec of args.peers) {
      const state = this.peer(spec.nodeId);
      const returned = spec.present && !state.present;
      state.present = spec.present;
      if (spec.origins.length) state.origins = spec.origins;
      if (returned) contact.add(spec.nodeId);
      if (!spec.present) this.cancelRetries(state);
    }
    for (const [id, state] of this.peers) {
      if (listed.has(id) || [...pairs].some((pair) => pair.endsWith(`\n${id}`))) continue;
      this.forget(state);
    }
    for (const pair of removed) {
      const [key, peer] = pair.split("\n");
      this.excluded.delete(pair);
      const pull = this.pulls.get(pair);
      pull?.retry?.cancel();
      if (!pull?.running) this.pulls.delete(pair);
      this.deps.need.syncComparison(key, peer);
    }
    // Peers listed only so their signatures verify (no shared folder) are never contacted.
    for (const peer of contact) if (this.peer(peer).present && this.sharesWith(peer).length) this.contact(peer, { notify: true });
    // Rows that had no source a moment ago may have one now (a peer shares the folder again, or came back): nothing else
    // looks at them again when their need rows did not change.
    if (contact.size || removed.length) this.kickTransfers();
  }

  /** announce: start, wake or join. One shares request per peer that may run the engine, then pulls and one notice each. */
  announce(slept: boolean): void {
    if (this.closed) return;
    for (const state of this.peers.values()) {
      // Main forgot who was away when this node slept (its availability starts over): so does this.
      if (slept) state.present = true;
      if (!state.present || !this.sharesWith(state.id).length) continue;
      // After a sleep a peer may have been updated meanwhile: ask again even if it was too old before.
      if (state.capability === "incapable" && !slept) continue;
      this.contact(state.id, { notify: true });
    }
  }

  presence(peer: string, present: boolean, origins?: string[]): void {
    const state = this.peer(peer);
    if (origins?.length) state.origins = origins;
    state.present = present;
    if (!present) { this.cancelRetries(state); return; }
    this.kickTransfers();
    // Back again, maybe updated: the probe decides what it can do now.
    if (state.capability === "incapable") state.capability = "unknown";
    if (this.sharesWith(peer).length) this.contact(peer, { notify: true });
  }

  /** Local rows changed (a scan commit, merges): peers hear about it after a short coalescing window. */
  localCommitted(key: string): void {
    const share = this.deps.shares().get(key);
    if (!share || this.closed) return;
    // Local rows moved: what the queue holds for them may have changed too.
    if (share.spec.phase === "builtin") this.kickTransfers();
    for (const peer of share.spec.peers) {
      if (this.isExcluded(key, peer)) continue;
      const state = this.peer(peer);
      if (!this.noticeable(state, key)) continue;
      state.pending.add(key);
      state.noticeTimer ??= this.deps.clock.setTimeout(() => {
        state.noticeTimer = undefined;
        this.sendNotices(state);
      }, this.deps.noticeDelayMs ?? NOTICE_DELAY_MS);
    }
  }

  /** An authorized `changed` notice arrived (directly, or through main as the notice op). */
  noticeReceived(peer: string, shares: Announced[], records: boolean): void {
    if (this.closed) return;
    const state = this.peer(peer);
    // It reached us, so it is around and runs the engine; whatever we owe it goes now.
    const returned = this.reached(state);
    // A share it names again never heard what changed here while it was refused: a notice goes for it. Rows that waited on
    // it as their only source are looked at again (their need rows did not change, so nothing else would).
    let lifted = false;
    for (const share of shares) if (state.refused.delete(share.key)) { state.pending.add(share.key); lifted = true; }
    if (lifted) this.kickTransfers();
    // Its engine runs and serves these now: an older probe saying otherwise is stale, and records it asks us to fetch are
    // newer than any answer in flight. Notices dropped while its engine was off are made up for with one for every share.
    if (state.capability !== "capable" || state.off || records) this.contact(peer, { notify: returned || state.off, fresh: true });
    // Back from away: what changed here meanwhile was never noticed to it.
    else if (returned) this.flush(state, true);
    this.announced(peer, shares, false);
    if ((state.outbox.size || state.pending.size) && this.noticeable(state)) this.sendNotices(state);
  }

  /** An authorized `status` request: whatever the caller has that we do not is pulled at once. */
  statusReceived(peer: string, shares: Announced[]): void {
    if (this.closed) return;
    const state = this.peer(peer);
    if (this.reached(state) && this.noticeable(state)) this.flush(state, true);
    // A handoff asks (§6.5): what the caller is about to hand over goes first here for a while.
    const until = this.deps.clock.now() + HANDOFF_PRIORITY_MS;
    for (const share of shares) this.prioritize(share.key, undefined, until);
    this.announced(peer, shares, true);
    if (state.outbox.size && this.noticeable(state)) this.sendNotices(state);
  }

  /** The prioritize op and handoffs: matching need rows go first (priority 0) until `until`. */
  prioritize(key: string, prefix: string | undefined, until: number): void {
    if (this.closed || !this.deps.transfers?.queue.prioritize) return;
    try { this.deps.transfers.queue.prioritize(key, prefix, until); } catch (error) {
      this.warn(`fileSync:${key}:priority`, `File sync could not move ${key} up the queue: ${errorText(error)}`);
      return;
    }
    this.kickTransfers();
  }

  /** Whether it was away until now. */
  private reached(state: PeerState): boolean {
    if (state.present) return false;
    state.present = true;
    this.deps.transport.reachable?.(state.id);
    // Rows it is the only source of can go now: their need rows did not change, so nothing else looks at them again.
    this.kickTransfers();
    return true;
  }

  /** Drop the peer's rows and cursor for the share and pull its whole index again. */
  repair(key: string, peer: string, urgent = true): void {
    const pull = this.pullState(key, peer);
    pull.reset = true;
    this.schedulePull(peer, key, urgent);
  }

  private announced(peer: string, shares: Announced[], urgent: boolean): void {
    const { db } = this.deps;
    const behind: string[] = [];
    const rules: string[] = [];
    const changed = new Set<string>();
    const now = this.deps.clock.now();
    db.writeTx(() => {
      for (const share of shares) {
        if (this.isExcluded(share.key, peer)) continue;
        const cursor = db.cursor(share.key, peer);
        const current = cursor?.peerIndexId !== share.indexId || share.maxSeq >= (cursor?.peerMaxSeq ?? 0);
        // A notice carries no digest: the stored one stays paired with an older maxSeq until the next page or shares answer.
        if (cursor?.peerIndexId !== share.indexId || share.maxSeq > (cursor?.peerMaxSeq ?? 0)) {
          db.updateCursor(share.key, peer, { peerIndexId: share.indexId, peerMaxSeq: share.maxSeq }, now);
          changed.add(share.key);
        }
        // A share the peer started serving after our last shares request, or whose rules it changed: comparable or not from
        // now on. A notice overtaken by a newer one says less than what we hold: its rules may no longer hold.
        if (share.rulesHash && current && cursor?.peerRulesHash !== share.rulesHash) {
          db.updateCursor(share.key, peer, { peerRulesHash: share.rulesHash }, now);
          rules.push(share.key);
          changed.add(share.key);
        }
        if (cursor?.indexId !== share.indexId || share.maxSeq > cursor.seq) behind.push(share.key);
      }
    });
    for (const key of rules) this.deps.need.syncComparison(key, peer);
    // A pull reports when it ends; an unchanged announcement changes no status.
    for (const key of changed) this.deps.stateChanged(key);
    for (const key of behind) this.schedulePull(peer, key, urgent);
  }

  // ---- requests ----

  /** One request through the peer's limiter; the slot is held until the whole (bounded) answer is read. A 401 is retried once. */
  private async fetch(peer: string, request: Omit<PeerRequest, "signal">, maxBytes: number, urgent = false): Promise<Fetched> {
    const state = this.peer(peer);
    const release = await state.limiter.acquire(request.purpose, urgent);
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.closed) throw new Error("File sync is stopping");
        let response: PeerResponse;
        try {
          response = await this.deps.transport.request(peer, { ...request, signal: this.abort.signal });
        } catch (error) {
          // Main has the peer as away (the relay leg was refused or failed): it reports the return, which ends this.
          if ((error as { away?: unknown })?.away === true) this.away(state);
          throw error;
        }
        // Signed when the slot was granted; a long wait can still outlive the receiver's clock window once.
        if (response.status === 401 && attempt === 0) { await discard(response.body); continue; }
        return new Fetched(response.status, response.headers, await readBody(response.body, maxBytes), response.route);
      }
    } finally {
      release();
    }
  }

  /** Nothing more goes to the peer in the background until main reports it back, it reaches us, or this node wakes (§0.11). */
  private away(state: PeerState): void {
    if (!state.present) return;
    state.present = false;
    this.cancelRetries(state);
  }

  // ---- contact: capability, announcements, records ----

  /**
   * One shares request at a time per peer. A trigger while one is in flight folds into it (its answer
   * is as fresh as the trigger), except the peer's own notice: it may have changed after answering.
   */
  private contact(peer: string, options: { notify: boolean; fresh?: boolean }): void {
    if (this.closed) return;
    const state = this.peer(peer);
    state.contactNotify ||= options.notify;
    if (state.contacting) { state.contactAgain ||= Boolean(options.fresh); return; }
    state.contactRetry?.cancel();
    state.contactRetry = undefined;
    state.contacting = this.track(`fileSync:peer:${peer}`, () => this.runContact(state), () => { state.contacting = undefined; });
  }

  private async runContact(state: PeerState): Promise<void> {
    do {
      state.contactAgain = false;
      if (!state.present || this.closed) return;
      let fetched: Fetched;
      try {
        fetched = await this.fetch(state.id, { method: "GET", target: filesTarget("shares"), purpose: "shares" }, MAX_JSON_BYTES);
      } catch (error) {
        // The worker is stopping (turned off, the node shutting down): nothing to retry, nothing about the peer to report.
        if ((error as { code?: unknown })?.code === "stopping") return;
        this.contactFailed(state, (error as Error).message);
        return;
      }
      // An old node answers an unknown signed /files/* request with 404: it cannot sync files this way.
      if (fetched.status === 404) { this.setCapability(state, "incapable"); return; }
      if (fetched.status !== 200) { this.contactFailed(state, `HTTP ${fetched.status}`); return; }
      const answer = this.sharesAnswer(state, fetched);
      if (!answer) return;
      state.contactAttempts = 0;
      state.origins = answer.origins;
      state.hostId = answer.hostId;
      state.protocol = answer.fileSync.protocol;
      state.enabled = answer.fileSync.enabled;
      const wasRunning = state.capability === "capable" && !state.off;
      state.off = !answer.fileSync.enabled;
      const compatible = answer.fileSync.minProtocol <= FILE_SYNC_PROTOCOL && answer.fileSync.protocol >= FILE_SYNC_MIN_PROTOCOL;
      this.setCapability(state, compatible ? "capable" : "incapable");
      // Its engine runs now where it did not (off, still starting, never asked): a direct address that failed meanwhile
      // (main is up before the worker binds its listener) gets a new try, not five minutes of transfers over the relay.
      if (!wasRunning && compatible && !state.off) this.deps.transport.reachable?.(state.id);
      if (!compatible || state.off) { state.contactNotify = false; continue; }
      this.applyShares(state, answer);
      // What it serves now may lift a refusal its earlier answers caused: rows waiting on it as their only source are looked at again.
      this.kickTransfers();
      const notify = state.contactNotify;
      state.contactNotify = false;
      this.flush(state, notify);
      await this.forwardRecords(state, answer, fetched.route);
    } while (state.contactAgain && !this.closed);
  }

  private sharesAnswer(state: PeerState, fetched: Fetched): SharesAnswer | undefined {
    let answer: SharesAnswer;
    try {
      answer = sharesAnswerSchema.parse(JSON.parse(fetched.bytes.toString("utf8")));
    } catch {
      this.warn(`fileSync:peer:${state.id}`, `File sync could not read the shares answer of ${state.id}`);
      return undefined;
    }
    if (answer.nodeId !== state.id) {
      this.warn(`fileSync:peer:${state.id}`, `File sync got a shares answer from ${answer.nodeId} when asking ${state.id}`);
      return undefined;
    }
    return answer;
  }

  private contactFailed(state: PeerState, reason: string): void {
    if (this.closed || !state.present) return;
    state.contactAttempts++;
    const delay = backoff(state.contactAttempts);
    if (state.contactAttempts === 1) this.warn(`fileSync:peer:${state.id}`, `File sync could not reach ${state.id} (${reason}); trying again in ${Math.round(delay / 1000)} s`);
    state.contactRetry?.cancel();
    state.contactRetry = this.deps.clock.setTimeout(() => {
      state.contactRetry = undefined;
      if (state.present) this.contact(state.id, { notify: false });
    }, delay);
  }

  private setCapability(state: PeerState, capability: Capability): void {
    const was = state.capability;
    state.capability = capability;
    if (capability === "capable" && was !== "capable") this.kickTransfers();
    // Nothing it could act on: notices for it are dropped rather than retried forever.
    if (capability === "incapable" || state.off) this.dropNotices(state);
    const event = {
      event: "capability" as const, peer: state.id, protocol: state.protocol, enabled: capability === "capable" && state.enabled,
      origins: capability === "incapable" ? [] : state.origins, ...(state.hostId ? { hostId: state.hostId } : {}),
    };
    const text = JSON.stringify(event);
    if (text === state.lastCapability) return;
    state.lastCapability = text;
    this.deps.emit(event);
  }

  private dropNotices(state: PeerState): void {
    state.outbox.clear();
    state.pending.clear();
    state.noticeTimer?.cancel();
    state.noticeTimer = undefined;
    this.cancelRetries(state);
  }

  /**
   * Records go to main with the sender this node authenticated; main decides what it accepts (owner,
   * origin). A direct answer is plain HTTP from whatever holds that address, so new records are
   * fetched again through main, whose channel authenticates the peer.
   */
  private async forwardRecords(state: PeerState, answer: SharesAnswer, route: Fetched["route"]): Promise<void> {
    const text = recordsText(answer);
    if (text === undefined || text === state.lastRecords) return;
    let trusted = answer;
    if (route === "direct") {
      let fetched: Fetched;
      try {
        fetched = await this.fetch(state.id, { method: "GET", target: filesTarget("shares"), purpose: "shares", via: "relay" }, MAX_JSON_BYTES);
      } catch (error) {
        this.warn(`fileSync:peer:${state.id}:records`, `File sync could not fetch the settings of ${state.id} through the relay: ${(error as Error).message}`);
        return;
      }
      const relayed = fetched.status === 200 ? this.sharesAnswer(state, fetched) : undefined;
      if (!relayed) return;
      trusted = relayed;
    }
    const trustedText = recordsText(trusted);
    if (trustedText === undefined || trustedText === state.lastRecords) return;
    state.lastRecords = trustedText;
    this.deps.emit({ event: "records", fromPeer: state.id, engines: trusted.engines, settings: trusted.settings });
  }

  private applyShares(state: PeerState, answer: SharesAnswer): void {
    const { db } = this.deps;
    const hostId = this.deps.hostId();
    const local = this.deps.shares();
    const behind: string[] = [];
    const touched: string[] = [];
    const changed = new Set<string>();
    /** Shares whose same-folder exclusion of this peer changed. */
    const regrouped = new Set<string>();
    const now = this.deps.clock.now();
    const served = new Set<string>();
    db.writeTx(() => {
      for (const announced of answer.shares) {
        const key = shareKey(announced);
        const share = local.get(key);
        if (!share || !share.spec.peers.includes(state.id)) continue;
        served.add(key);
        touched.push(key);
        const row = db.share(key);
        const pair = `${key}\n${state.id}`;
        // Two nodes on one machine whose share is literally the same folder: syncing it with itself would only race.
        if (answer.hostId === hostId && announced.rootIno !== null && row?.rootIno === announced.rootIno && row.rootDev === announced.rootDev) {
          if (!this.excluded.has(pair)) {
            this.excluded.add(pair);
            changed.add(key);
            regrouped.add(key);
            this.warn(`fileSync:${key}:same-folder`, `File sync leaves ${key} out with ${state.id}: both nodes use the same folder on this machine`);
          }
          continue;
        }
        if (this.excluded.delete(pair)) { changed.add(key); regrouped.add(key); }
        const before = db.cursor(key, state.id);
        // An answer a notice overtook (same generation, lower maxSeq) is older than what we hold: its digest and rules too.
        const stale = before?.peerIndexId === announced.indexId && announced.maxSeq < before.peerMaxSeq;
        if (!stale && (before?.peerIndexId !== announced.indexId || before.peerMaxSeq !== announced.maxSeq || before.peerDigest !== announced.digest
          || before.peerRulesHash !== announced.rulesHash || before.peerBuiltinSince !== announced.builtinSince)) {
          changed.add(key);
          db.updateCursor(key, state.id, {
            peerIndexId: announced.indexId, peerMaxSeq: announced.maxSeq, peerDigest: announced.digest,
            peerRulesHash: announced.rulesHash, peerBuiltinSince: announced.builtinSince,
          }, now);
        }
        const cursor = db.cursor(key, state.id)!;
        // A prune above our cursor implies maxSeq above it too: the pull sees it and resets.
        if (stale ? this.behind(key, state.id) : cursor.indexId !== announced.indexId || cursor.seq !== announced.maxSeq) behind.push(key);
      }
    });
    // What it left out is not served to us there (not derived yet, or not shared): no notices until it names them.
    // One it names again never heard what changed here meanwhile (no notice went out for it): it gets one now.
    const wasRefused = new Set(state.refused);
    state.refused.clear();
    for (const [key] of this.sharesWith(state.id)) {
      if (!served.has(key)) state.refused.add(key);
      else if (wasRefused.has(key)) state.pending.add(key);
    }
    for (const key of touched) {
      // Its rules hash may match ours now (or no longer), or it was left out as the same folder.
      this.deps.need.syncComparison(key, state.id);
      if (changed.has(key)) this.deps.stateChanged(key);
    }
    // Its rows count (or stop counting) for this share's targets now: need is decided again from the stored rows.
    for (const key of regrouped) this.deps.need.recomputeNeed(key);
    for (const key of behind) this.schedulePull(state.id, key, false);
    // Caught up already (a restart, an idle project): the check runs on what is stored, and clears an error that no longer holds.
    for (const key of touched) if (!behind.includes(key)) this.liveCheck(key, state.id);
  }

  // ---- pulls ----

  private pullState(key: string, peer: string): PullState {
    const id = `${key}\n${peer}`;
    let pull = this.pulls.get(id);
    if (!pull) { pull = { peer, key, dirty: false, urgent: false, reset: false, attempts: 0 }; this.pulls.set(id, pull); }
    return pull;
  }

  /** Single flight per (peer, share): a trigger during a pull marks it dirty and the loop goes once more. */
  schedulePull(peer: string, key: string, urgent = false): void {
    if (this.closed) return;
    const pull = this.pullState(key, peer);
    pull.urgent ||= urgent;
    if (pull.running) { pull.dirty = true; return; }
    pull.retry?.cancel();
    pull.retry = undefined;
    pull.running = this.track(`fileSync:${key}:pull:${peer}`, () => this.runPull(pull), () => {
      pull.running = undefined;
      if (pull.dirty && !this.closed) this.schedulePull(peer, key);
      // The share's transfers waited for its index to be whole: renames pair up and targets settle only then.
      else this.kickTransfers();
    });
  }

  private async runPull(pull: PullState): Promise<void> {
    const { db, need } = this.deps;
    const { peer, key } = pull;
    for (;;) {
      pull.dirty = false;
      const state = this.peer(peer);
      const share = this.deps.shares().get(key);
      if (this.closed || !state.present || state.capability === "incapable" || !share || !share.spec.peers.includes(peer) || this.isExcluded(key, peer)) return;
      if (pull.reset) {
        pull.reset = false;
        need.resetPeer(key, peer);
        need.syncComparison(key, peer);
      }
      const cursor = db.cursor(key, peer);
      const since = cursor?.indexId ? cursor.seq : 0;
      const query: Record<string, string | number> = { projectId: share.spec.projectId, kind: share.spec.kind, since, limit: this.deps.pageLimit ?? INDEX_PAGE_LIMIT };
      if (cursor?.indexId) query.indexId = cursor.indexId;
      let fetched: Fetched;
      try {
        fetched = await this.fetch(peer, { method: "GET", target: filesTarget("index", query), purpose: "index" }, MAX_INDEX_BYTES, pull.urgent);
      } catch (error) {
        this.pullFailed(pull, (error as Error).message);
        return;
      }
      if (fetched.status === 404) { this.setCapability(state, "incapable"); return; }
      // Not shared on its side (yet): it contacts us once it derives the share.
      if (fetched.status === 403) { state.refused.add(key); return; }
      if (fetched.status !== 200) { this.pullFailed(pull, `HTTP ${fetched.status}`); return; }
      let page: IndexPage;
      try {
        page = await decodeIndexPage(fetched.bytes);
        if (this.closed) return;
        const stored = await need.storeRemote(key, peer, since, page);
        if (stored.restart) continue;
      } catch (error) {
        if (this.closed) return;
        this.pullFailed(pull, (error as Error).message);
        return;
      }
      // Any answer is contact: notices we owe it go now.
      if (state.outbox.size && !state.sending && this.noticeable(state)) this.sendNotices(state);
      if (page.more || pull.reset) continue;
      // A trigger during the pull goes once more only if it announced more than this pull reached.
      if (pull.dirty && this.behind(key, peer)) continue;
      pull.dirty = false;
      break;
    }
    pull.attempts = 0;
    pull.urgent = false;
    need.syncComparison(key, peer);
    this.liveCheck(key, peer, true);
    this.deps.stateChanged(key);
  }

  /** Our copy is not at what the peer announced last (another generation, or a lower seq). */
  private behind(key: string, peer: string): boolean {
    const cursor = this.deps.db.cursor(key, peer);
    return !cursor?.indexId || cursor.indexId !== (cursor.peerIndexId ?? cursor.indexId) || cursor.seq < cursor.peerMaxSeq;
  }

  private pullFailed(pull: PullState, reason: string): void {
    if (this.closed) return;
    const state = this.peer(pull.peer);
    if (!state.present) return;
    pull.attempts++;
    const delay = backoff(pull.attempts);
    if (pull.attempts === 1) this.warn(`fileSync:${pull.key}:pull:${pull.peer}`, `File sync could not pull ${pull.key} from ${pull.peer} (${reason}); trying again in ${Math.round(delay / 1000)} s`);
    pull.retry?.cancel();
    pull.retry = this.deps.clock.setTimeout(() => {
      pull.retry = undefined;
      if (this.peer(pull.peer).present) this.schedulePull(pull.peer, pull.key);
    }, delay);
  }

  /**
   * Live consistency check (§6.2): caught up with nothing differing, yet the digests disagree under the
   * same rules — our copy of its index is wrong. One repair; if that does not help, a share error. It
   * runs on what is stored (the digest the peer paired with the maxSeq we reached) when a pull ends, when
   * a comparison has been computed in full, and on a contact that finds the pair caught up; never while
   * a pull, a repair or the comparison is still to come, since their differences are not all there yet.
   */
  liveCheck(key: string, peer: string, fromPull = false): void {
    if (this.closed) return;
    const { db, need } = this.deps;
    const share = this.deps.shares().get(key);
    if (!share || !share.spec.peers.includes(peer) || this.isExcluded(key, peer)) return;
    const pull = this.pulls.get(`${key}\n${peer}`);
    if (pull?.reset || pull?.dirty || (!fromPull && pull?.running)) return;
    if (need.comparing(key, peer)) return;
    const cursor = db.cursor(key, peer);
    if (!cursor?.indexId || !cursor.peerDigest || cursor.indexId !== cursor.peerIndexId || cursor.seq !== cursor.peerMaxSeq) return;
    if (cursor.peerRulesHash !== share.rulesHash) return;
    if (!db.shadowClean(key, peer) || need.pendingDifferences(key, peer) > 0) return;
    const summary = db.needSummary(key);
    if (summary.files || summary.blocked) return;
    const local = db.share(key);
    if (!local) return;
    const pair = `${key}\n${peer}`;
    if (local.digest === cursor.peerDigest) {
      this.repaired.delete(pair);
      this.mismatched.delete(pair);
      // The error row outlives a restart (the in-memory mark does not): any matching check clears it once no peer mismatches.
      if (!this.mismatch(key).length && db.hasError(key, "")) {
        db.writeTx(() => db.clearError(key, ""));
        this.deps.stateChanged(key);
      }
      return;
    }
    // Reported once; looking again at the same state changes nothing.
    if (this.mismatched.has(pair)) return;
    const persisted = this.repaired.has(pair);
    this.deps.emit({ event: "metric", operation: "fileSync.digestMismatch", durationMs: 0, fields: { repaired: persisted } });
    if (!persisted) {
      this.repaired.add(pair);
      this.warn(`fileSync:${key}:digest:${peer}`, `File sync found that its copy of the index of ${peer} for ${key} does not match its digest; pulling it again`);
      this.repair(key, peer, false);
      return;
    }
    this.mismatched.add(pair);
    db.writeTx(() => db.setError(key, "", "error", `${DIGEST_MISMATCH} (${peer})`, this.deps.clock.now()));
    this.warn(`fileSync:${key}:digest:${peer}`, `File sync: the index of ${peer} for ${key} still does not match its digest after a repair`);
    this.deps.stateChanged(key);
  }

  // ---- notices ----

  /** The outbox and, after a contact with notify, every share we have with the peer go out now. */
  private flush(state: PeerState, notifyAll: boolean): void {
    if (notifyAll) for (const [key] of this.sharesWith(state.id)) state.pending.add(key);
    if (state.pending.size || state.outbox.size) this.sendNotices(state);
  }

  private sendNotices(state: PeerState): void {
    if (this.closed) return;
    if (state.sending) { state.noticeTimer ??= this.deps.clock.setTimeout(() => { state.noticeTimer = undefined; this.sendNotices(state); }, this.deps.noticeDelayMs ?? NOTICE_DELAY_MS); return; }
    state.noticeTimer?.cancel();
    state.noticeTimer = undefined;
    state.outboxRetry?.cancel();
    state.outboxRetry = undefined;
    const keys = new Set([...state.outbox, ...state.pending]);
    state.pending.clear();
    state.outbox.clear();
    if (!this.noticeable(state) || !keys.size) return;
    const shares: Notice[] = [];
    const sent = new Set<string>();
    const local = this.deps.shares();
    for (const key of keys) {
      const share = local.get(key);
      const row = this.deps.db.share(key);
      if (!share || !row || !share.spec.peers.includes(state.id) || this.isExcluded(key, state.id) || state.refused.has(key)) continue;
      shares.push({ projectId: share.spec.projectId, kind: share.spec.kind, indexId: row.indexId, maxSeq: row.maxSeq, rulesHash: share.rulesHash });
      sent.add(key);
    }
    if (!shares.length) return;
    state.sending = this.track(`fileSync:peer:${state.id}`, () => this.deliver(state, shares, sent), () => { state.sending = undefined; });
  }

  private async deliver(state: PeerState, shares: Notice[], keys: Set<string>): Promise<void> {
    let fetched: Fetched | undefined;
    try {
      fetched = await this.fetch(state.id, { method: "POST", target: filesTarget("changed"), json: { shares }, purpose: "notice" }, MAX_JSON_BYTES);
    } catch { /* no answer: retried below */ }
    if (this.closed) return;
    const status = fetched?.status ?? 0;
    if (status >= 200 && status < 300) { state.outboxAttempts = 0; return; }
    if (status === 404) { this.setCapability(state, "incapable"); return; }
    // It does not share these (any more): nothing to retry, and nothing more to tell it until it names them.
    if (status === 403) { for (const key of keys) state.refused.add(key); return; }
    if (status === 400) return;
    // Its engine is off or still starting: it contacts us (and pulls) once it runs, so nothing waits here for it.
    if (status === 503 && engineNotRunning(fetched!)) { state.off = true; this.dropNotices(state); return; }
    for (const key of keys) state.outbox.add(key);
    if (!state.present) return;
    state.outboxAttempts++;
    state.outboxRetry?.cancel();
    state.outboxRetry = this.deps.clock.setTimeout(() => {
      state.outboxRetry = undefined;
      if (state.present) this.sendNotices(state);
    }, backoff(state.outboxAttempts));
  }

  // ---- transfers (§6.2, builtin phase) ----

  /** Main's event loop is busy (ELU > 70 % for 10 s) or calm again: transfers over the relay fallback wait meanwhile. */
  pace(relayPaused: boolean): void {
    if (this.relayPaused === relayPaused) return;
    this.relayPaused = relayPaused;
    if (!relayPaused) this.kickTransfers();
  }

  /** Bytes and files this node received from the peer for the share since the worker started (status). */
  transferCounters(key: string, peer: string): TransferCounters | undefined { return this.counters.get(`${key}\n${peer}`); }

  /** Items a transfer job holds right now (tests, status). */
  get transfersInFlight(): number { return this.transferring.size; }

  /** One pass of the transfer loop after this turn; triggers in between fold into it. */
  kickTransfers(): void {
    if (this.closed || !this.deps.transfers || this.pumpQueued) return;
    this.pumpQueued = true;
    void this.track("fileSync:transfers", async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.pumpQueued = false;
      if (!this.closed) this.pumpTransfers();
    });
  }

  private transferPeers(): string[] {
    return [...this.peers.values()].filter((state) => state.present && state.capability === "capable" && !state.off).map((state) => state.id);
  }

  /** A pull of the share is storing pages: renames pair up and targets settle only once it ends, so its transfers wait for that. */
  private sharePulling(key: string): boolean {
    for (const pull of this.pulls.values()) if (pull.key === key && pull.running) return true;
    return false;
  }

  /** Invariant 12: the engine writes into a tree only while the project's phase here is builtin. */
  private writable(key: string): SyncShare | undefined {
    const share = this.deps.shares().get(key);
    return share?.spec.phase === "builtin" && !this.closed ? share : undefined;
  }

  private contentId(item: TransferItem): string { return `${item.share}\n${item.path}\n${item.target.sha256}`; }

  /** A reachable peer with the content, one that has not just said it has another version first, a direct route first. */
  private sourceFor(item: TransferItem, share: SyncShare, available: ReadonlySet<string>): string | undefined {
    const candidates = item.sources.filter((peer) => available.has(peer) && share.spec.peers.includes(peer) && !this.isExcluded(item.share, peer) && !this.peer(peer).refused.has(item.share));
    const failed = this.sourceFailed.get(this.contentId(item));
    const fresh = failed ? candidates.filter((peer) => !failed.has(peer)) : candidates;
    const pool = fresh.length ? fresh : candidates;
    return pool.find((peer) => this.route(peer) === "direct") ?? pool[0];
  }

  private pumpTransfers(): void {
    const transfers = this.deps.transfers!;
    const shares = this.deps.shares();
    const available = new Set(this.transferPeers());
    let next: ReturnType<TransferQueue["nextNeeds"]>;
    try {
      next = transfers.queue.nextNeeds({ limit: TRANSFER_SCAN_LIMIT, availablePeers: [...available], inFlight: this.transferring });
    } catch (error) {
      if (!this.closed) this.warn("fileSync:transfers", `File sync could not read what it needs: ${errorText(error)}`);
      return;
    }
    this.armTransferTimer(next.nextRetryAt);
    const small = transfers.smallFileBytes ?? SMALL_FILE_BYTES;
    const limits = transfers.frameLimits ?? FRAME_LIMITS;
    const local = new Map<string, TransferItem[]>();
    let localCount = 0;
    const jobs: TransferJob[] = [];
    const batches = new Map<string, TransferJob>();
    for (const item of next.items) {
      const share = shares.get(item.share);
      if (!share || share.spec.phase !== "builtin" || this.transferring.has(`${item.share}\n${item.path}`) || this.sharePulling(item.share)) continue;
      const networked = item.sources.some((peer) => available.has(peer));
      // A local copy that did not do is downloaded instead, when some peer can send it.
      const reuse = item.action === "fetch" && item.localSources.length > 0 && !(networked && this.localFailed.has(this.contentId(item)));
      if (item.action !== "fetch" || reuse) {
        // No network: one local job at a time, applied in the queue's order.
        if (this.localJob || localCount >= LOCAL_BATCH * 4) continue;
        let list = local.get(item.share);
        if (!list) local.set(item.share, list = []);
        list.push(item);
        localCount++;
        continue;
      }
      if (item.target.type !== FILE || item.target.deleted || item.target.sha256 === null) continue;
      const peer = this.sourceFor(item, share, available);
      if (!peer || (this.relayPaused && this.route(peer) === "relay")) continue;
      if (item.size > small) { jobs.push({ peer, key: item.share, items: [item], large: true }); continue; }
      const slot = `${peer}\n${item.share}`;
      let job = batches.get(slot);
      if (!job || job.items.length >= limits.items || (job.bytes ?? 0) + item.size > limits.bytes) {
        job = { peer, key: item.share, items: [], bytes: 0, large: false };
        batches.set(slot, job);
        jobs.push(job);
      }
      job.items.push(item);
      job.bytes! += item.size;
    }
    if (local.size) this.startLocal(local);
    const lowDisk = new Map<string, string>();
    let recorded = false;
    for (const job of jobs) {
      // Below the floor nothing more is scheduled into that share this pass: its items wait, blocked, for a later look.
      const low = lowDisk.get(job.key);
      if (low !== undefined) { for (const item of job.items) this.blockItem(job.key, item, low, DISK_RETRY_MS); recorded = true; continue; }
      if ((this.peerJobs.get(job.peer) ?? 0) >= TRANSFER_JOBS_PER_PEER) continue;
      const started = this.startJob(job);
      if (started.refused !== undefined) lowDisk.set(job.key, started.refused);
      recorded ||= started.recorded;
    }
    // Retries and blocks noted without a job: one more pass arms the timer for their retry time.
    if (recorded) this.kickTransfers();
  }

  private armTransferTimer(at: number | undefined): void {
    // Only a time still to come: rows due now are handed out, or held by a job whose end looks again.
    const now = this.deps.clock.now();
    const wanted = at !== undefined && Number.isFinite(at) && at > now ? at : undefined;
    if (this.transferTimer?.at === wanted) return;
    this.transferTimer?.timer.cancel();
    this.transferTimer = undefined;
    if (wanted === undefined || this.closed) return;
    // One one-shot timer at the earliest retry time (§0.11): nothing polls. Node fires a longer delay at once, so it is capped.
    this.transferTimer = { at: wanted, timer: this.deps.clock.setTimeout(() => { this.transferTimer = undefined; this.kickTransfers(); }, Math.min(wanted - now, MAX_TIMER_MS)) };
  }

  /**
   * Prepares the temps and reserves disk space synchronously, so the jobs of one pass count each other, then
   * runs the download. `refused`: the disk is below its floor (nothing was requested); `recorded`: some item got
   * a retry or a block here.
   */
  private startJob(job: TransferJob): { refused?: string; recorded: boolean } {
    const share = this.writable(job.key);
    if (!share) return { recorded: false };
    const root = path.resolve(share.spec.root);
    const prepared: Prepared[] = [];
    // Siblings share their parents' check: a batch of files in one big folder lists it once, not once per file.
    const parents = new Map<string, ParentCheck>();
    for (const item of job.items) {
      const temp = this.tempFor(job.key, root, item, parents);
      if ("reason" in temp) {
        if (temp.permanent) this.blockItem(job.key, item, temp.reason); else this.retry(job.key, item, temp.reason);
        continue;
      }
      prepared.push({ item, temp: temp.file });
    }
    const recorded = prepared.length < job.items.length;
    if (!prepared.length) return { recorded };
    if (job.large) {
      // A newer version of the path is wanted now: the bytes of the older one can never be resumed.
      const id = `${job.key}\n${prepared[0].item.path}`;
      const previous = this.lastTemps.get(id);
      if (previous !== undefined && previous !== prepared[0].temp) unlinkQuietly(previous);
      if (this.lastTemps.size >= 10_000) this.lastTemps.clear();
      this.lastTemps.set(id, prepared[0].temp);
    }
    // A large file needs only what its temp does not hold yet.
    const have = job.large ? this.resumable(prepared[0].temp, prepared[0].item.size) : 0;
    const bytes = job.large ? prepared[0].item.size - have : prepared.reduce((sum, entry) => sum + entry.item.size, 0);
    const reservation = this.reserve(job.key, root, prepared.map((entry) => entry.item), bytes);
    if (!reservation.ok) return { refused: reservation.reason, recorded: true };
    const ids = prepared.map(({ item }) => `${job.key}\n${item.path}`);
    for (const id of ids) this.transferring.add(id);
    this.peerJobs.set(job.peer, (this.peerJobs.get(job.peer) ?? 0) + 1);
    void this.track(`fileSync:${job.key}:transfer:${job.peer}`, () => job.large ? this.runFile(job.peer, job.key, prepared[0], have) : this.runFetch(job.peer, job.key, prepared), () => {
      reservation.release();
      for (const id of ids) this.transferring.delete(id);
      // Its temps are gone or in place now: a folder made for one that is not wanted any more is empty again.
      if (!this.closed) {
        try { this.deps.transfers?.apply.sweep?.(job.key); } catch (error) { this.warn(`fileSync:${job.key}:transfer`, `File sync could not tidy folders in ${job.key}: ${errorText(error)}`); }
      }
      const left = (this.peerJobs.get(job.peer) ?? 1) - 1;
      if (left > 0) this.peerJobs.set(job.peer, left); else this.peerJobs.delete(job.peer);
      if (!this.closed) this.deps.stateChanged(job.key);
      this.kickTransfers();
    });
    return { recorded };
  }

  /** Moves, deletes, folders, links, modes and local copies: straight to apply in the queue's order, no network. */
  private startLocal(local: Map<string, TransferItem[]>): void {
    const ids: string[] = [];
    for (const [key, items] of local) {
      for (const item of items) {
        ids.push(`${key}\n${item.path}`);
        // A move holds its source path too: nothing else is handed out for it until the rename is done.
        if (item.fromPath !== undefined) ids.push(`${key}\n${item.fromPath}`);
      }
    }
    for (const id of ids) this.transferring.add(id);
    this.localJob = this.track("fileSync:transfers:local", async () => {
      for (const [key, all] of local) {
        for (let at = 0; at < all.length; at += LOCAL_BATCH) {
          const share = this.writable(key);
          if (!share) break;
          let items = all.slice(at, at + LOCAL_BATCH);
          const copies = items.filter((item) => item.action === "fetch");
          let reservation: { release(): void } | undefined;
          if (copies.length) {
            // A clone may take no space, a copy across filesystems all of it: counted as a download.
            const reserved = this.reserve(key, path.resolve(share.spec.root), copies, copies.reduce((sum, item) => sum + item.size, 0));
            if (reserved.ok) reservation = reserved; else items = items.filter((item) => item.action !== "fetch");
          }
          try {
            if (items.length) await this.applyItems(key, items.map((item) => ({ item, input: localInput(item) })));
          } finally {
            reservation?.release();
          }
        }
      }
    }, () => {
      for (const id of ids) this.transferring.delete(id);
      this.localJob = undefined;
      this.kickTransfers();
    });
  }

  /** The on-disk relative spelling of a path: below its deepest indexed ancestor's own spelling (Linux fs_name). */
  private fsRelative(key: string, relative: string): string {
    const segments = relative.split("/");
    for (let depth = segments.length; depth > 0; depth--) {
      const ancestor = segments.slice(0, depth).join("/");
      const entry = this.deps.db.entry(key, ancestor);
      if (!entry || entry.deleted) continue;
      const rest = segments.slice(depth).join("/");
      const base = entry.fsName ?? ancestor;
      return rest ? `${base}/${rest}` : base;
    }
    return relative;
  }

  /** The deterministic temp beside the target, its parents prepared symlink-safely; or why it cannot be written. */
  private tempFor(key: string, root: string, item: TransferItem, parents?: Map<string, ParentCheck>): { file: string } | { reason: string; permanent?: boolean } {
    const parent = parentKey(item.path);
    let check = parents?.get(parent);
    if (!check) {
      try {
        const helper = this.deps.transfers!.apply.ensureParents;
        if (helper) check = helper(key, item.path);
        else {
          const fsParent = parent === "" ? "" : this.fsRelative(key, parent);
          // The temp's directory must be inside the share: a path that leaves it never gets one.
          joinInside(root, fsParent === "" ? item.path : `${fsParent}/x`);
          check = ensureParentsLocal(root, fsParent);
        }
      } catch (error) {
        check = { ok: false, reason: `The path is not valid here: ${errorText(error)}`, permanent: true };
      }
      // A refusal may be about the file's own name: only a usable directory is reused.
      if (check.ok) parents?.set(parent, check);
    }
    if (!check.ok) return { reason: check.reason, ...(check.permanent ? { permanent: true } : {}) };
    return { file: path.join(check.directory, transferTempName(key, item.path, item.target.sha256!)) };
  }

  /** The floor check before any request (§5.5.10); below it the items are blocked (offered again later) and nothing is requested. */
  private reserve(key: string, root: string, items: readonly TransferItem[], bytes: number): ({ ok: true } & { release(): void }) | { ok: false; reason: string } {
    const disk = this.deps.transfers!.disk;
    let check: SpaceCheck;
    try { check = disk.ensureSpace(root, bytes); } catch (error) {
      check = { ok: false, reason: `Free disk space is unknown: ${errorText(error)}`, freeBytes: 0, floorBytes: 0 };
    }
    if (!check.ok) {
      for (const item of items) this.blockItem(key, item, check.reason, DISK_RETRY_MS);
      this.warn(`fileSync:${key}:disk`, `File sync paused downloads into ${key}: ${check.reason}`);
      return { ok: false, reason: check.reason };
    }
    const reservation = disk.reserve(root, bytes);
    return { ok: true, release: () => reservation.release() };
  }

  /** Bytes of a temp that can be resumed: a regular file, not longer than the target, written within the hour. */
  private resumable(temp: string, size: number): number {
    let stat: Stats;
    try { stat = lstatSync(temp); } catch { return 0; }
    if (stat.isFile() && stat.size <= size && this.deps.clock.now() - stat.mtimeMs < TEMP_STALE_MS) return stat.size;
    // Stale, too long or not a plain file: started over (a link is removed, never written through).
    if (!stat.isDirectory()) unlinkQuietly(temp);
    return 0;
  }

  private retry(key: string, item: TransferItem, reason: string, delayMs?: number): void {
    try { this.deps.transfers!.queue.retryLater(key, item.path, reason, { target: item.target, ...(delayMs !== undefined ? { delayMs } : {}) }); } catch (error) {
      if (!this.closed) this.warn(`fileSync:${key}:transfer`, `File sync could not note a retry for ${key}: ${errorText(error)}`);
    }
  }

  private blockItem(key: string, item: TransferItem, reason: string, retryAfterMs?: number): void {
    try { this.deps.transfers!.queue.block(key, item.path, reason, { target: item.target, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }); } catch (error) {
      if (!this.closed) this.warn(`fileSync:${key}:transfer`, `File sync could not note a blocked item in ${key}: ${errorText(error)}`);
    }
  }

  /** The source has another version of the file, none, or refuses it: another source goes first next time. */
  private sourceRefused(key: string, peer: string, item: TransferItem, kind: string): void {
    const id = this.contentId(item);
    let failed = this.sourceFailed.get(id);
    if (!failed) {
      if (this.sourceFailed.size >= 10_000) this.sourceFailed.clear();
      this.sourceFailed.set(id, failed = new Set());
    }
    failed.add(peer);
    // Its newer index is probably on its way (changed, missing); a refusal waits for the usual backoff unless another source has it.
    const another = item.sources.some((source) => !failed!.has(source));
    this.retry(key, item, `${peer} answered "${kind}" for it`, kind !== "denied" || another ? SOURCE_CHANGED_RETRY_MS : undefined);
  }

  private count(key: string, peer: string, route: Route, bytes: number): void {
    const id = `${key}\n${peer}`;
    let counters = this.counters.get(id);
    if (!counters) this.counters.set(id, counters = { directBytes: 0, relayBytes: 0, files: 0 });
    if (route === "relay") counters.relayBytes += bytes; else counters.directBytes += bytes;
  }

  private metric(endpoint: "fetch" | "file", route: Route, started: number, bytes: number, files: number): void {
    this.deps.emit({ event: "metric", operation: "fileSync.transfer", durationMs: Math.round(performance.now() - started), fields: { bytes, files, endpoint, route } });
  }

  /** One transfer request through the peer's limiter; the slot and the stall watch are the caller's until it is done. A 401 is retried once. */
  private async openStream(peer: string, request: Omit<PeerRequest, "signal">, controller: AbortController, signal: AbortSignal): Promise<{ response: PeerResponse; release: () => void; stall: StallWatch }> {
    const state = this.peer(peer);
    const release = await state.limiter.acquire(request.purpose);
    // Waiting for a slot is not a stall: the watch starts with the request.
    const stall = new StallWatch(this.deps.clock, this.deps.transfers?.stallMs ?? TRANSFER_STALL_MS, controller);
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.closed) throw new Error("File sync is stopping");
        let response: PeerResponse;
        try {
          response = await raceAbort(this.deps.transport.request(peer, { ...request, signal }), signal);
        } catch (error) {
          if ((error as { away?: unknown })?.away === true) this.away(state);
          throw error;
        }
        stall.touch();
        if (response.status === 401 && attempt === 0) { await discard(response.body); continue; }
        return { response, release, stall };
      }
    } catch (error) {
      stall.done();
      release();
      throw error;
    }
  }

  /** A refusal of a whole request: an old peer, a share it does not serve us (now), its engine off, or the content moved there. */
  private async refused(peer: string, key: string, items: readonly TransferItem[], response: PeerResponse): Promise<string> {
    let error = "";
    try { error = String((JSON.parse((await readBody(response.body, ERROR_BODY_BYTES)).toString("utf8")) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
    const state = this.peer(peer);
    if (response.status === 404) this.setCapability(state, "incapable");
    else if (response.status === 403) state.refused.add(key);
    else if (response.status === 503 && /^File sync is (off|starting)\b/.test(error)) state.off = true;
    for (const item of items) {
      if (response.status === 409) this.sourceRefused(key, peer, item, error || "changed");
      else this.retry(key, item, `${peer} answered HTTP ${response.status}${error ? ` (${error})` : ""}`);
    }
    return error;
  }

  /** Hands items to apply (one batch at a time) and records what became of each (§5.5). Returns how many were applied. */
  private async applyItems(key: string, batch: Array<{ item: TransferItem; input: TransferApplyInput; temp?: string; small?: boolean }>, peer?: string): Promise<number> {
    const apply = this.deps.transfers!.apply;
    const run = this.applying.then(() => this.writable(key) ? apply.applyBatch({ share: key, items: batch.map((entry) => entry.input) }) : undefined);
    this.applying = run.catch(() => undefined);
    let result: TransferApplyResult | undefined;
    try {
      result = await run;
    } catch (error) {
      if (this.closed) return 0;
      const writable = Boolean(this.writable(key));
      for (const { item, temp, small } of batch) {
        this.retry(key, item, `Could not apply: ${errorText(error)}`);
        if (temp && small && writable) unlinkQuietly(temp);
      }
      return 0;
    }
    // The phase left builtin (or the worker is stopping) meanwhile: nothing was written, nothing is touched; the rows wait.
    if (!result) return 0;
    const outcomes = new Map(result.items.map((outcome) => [outcome.path, outcome]));
    const writable = Boolean(this.writable(key));
    const recorded = result.recorded === true;
    let applied = 0;
    for (const { item, input, temp, small } of batch) {
      const outcome = outcomes.get(item.path);
      const content = this.contentId(item);
      if (outcome?.outcome !== "stale") this.staleSeen.delete(content);
      switch (outcome?.outcome) {
        case "applied":
          applied++;
          this.sourceFailed.delete(content);
          this.lastTemps.delete(`${key}\n${item.path}`);
          break;
        case "stale":
          // The target moved and apply decided the path again (its temp is gone). Handed out unchanged again, the queue
          // and apply disagree: backing off keeps that from becoming a loop of requests.
          if (this.staleSeen.has(content)) { this.staleSeen.delete(content); this.retry(key, item, outcome.reason ?? "The target moved while it was on its way"); }
          else { if (this.staleSeen.size >= 10_000) this.staleSeen.clear(); this.staleSeen.add(content); }
          break;
        case "blocked": if (!recorded) this.blockItem(key, item, outcome.reason ?? "Blocked", outcome.retryAfterMs); break;
        case "changed": if (!recorded) this.retry(key, item, outcome.reason ?? "The file changed while it was applied", CHANGED_RETRY_MS); break;
        default:
          if (input.localSource) this.rememberLocalFailure(this.contentId(item));
          if (!recorded || !outcome) this.retry(key, item, outcome?.reason ?? "Apply did not report on it");
      }
      // A small file is fetched whole again next time; a large one's temp stays, to be resumed or applied again.
      if (temp && small && writable && outcome?.outcome !== "applied") unlinkQuietly(temp);
    }
    if (peer && applied) {
      const counters = this.counters.get(`${key}\n${peer}`);
      if (counters) counters.files += applied;
    }
    return applied;
  }

  private rememberLocalFailure(id: string): void {
    if (this.localFailed.size >= 10_000) this.localFailed.clear();
    this.localFailed.add(id);
  }

  /** Small files: one `fetch` answer of frames, each hash-checked and written to its temp as it arrives, then one applyBatch. */
  private async runFetch(peer: string, key: string, prepared: Prepared[]): Promise<void> {
    const share = this.writable(key);
    if (!share) return;
    const transfers = this.deps.transfers!;
    const started = performance.now();
    const pending = new Map(prepared.map((entry) => [entry.item.path, entry]));
    const ready: Array<{ item: TransferItem; input: TransferApplyInput; temp: string; small: boolean }> = [];
    let received = 0;
    let route: Route = "none";
    const controller = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, controller.signal]);
    let opened: Awaited<ReturnType<SyncLayer["openStream"]>>;
    try {
      opened = await this.openStream(peer, {
        method: "POST", target: filesTarget("fetch"), purpose: "transfer",
        json: { projectId: share.spec.projectId, kind: share.spec.kind, items: prepared.map(({ item }) => ({ path: item.path, sha256: item.target.sha256 })) },
      }, controller, signal);
    } catch (error) {
      if (!this.closed) for (const { item } of prepared) this.retry(key, item, `Could not reach ${peer}: ${errorText(error)}`);
      return;
    }
    const { response, release, stall } = opened;
    let answered = 0;
    try {
      route = response.route ?? this.route(peer);
      if (response.status !== 200) { await this.refused(peer, key, prepared.map((entry) => entry.item), response); pending.clear(); return; }
      for await (const frame of decodeFrames(watched(response.body, signal, stall), transfers.frameLimits ?? FRAME_LIMITS)) {
        const entry = pending.get(frame.path);
        // Not asked for, or twice: nothing to do with it.
        if (!entry) continue;
        pending.delete(frame.path);
        answered++;
        const { item, temp } = entry;
        if ("error" in frame) { this.sourceRefused(key, peer, item, frame.error); continue; }
        received += frame.size;
        this.count(key, peer, route, frame.size);
        if (frame.size !== item.target.size || createHash("sha256").update(frame.bytes).digest("hex") !== item.target.sha256) {
          this.retry(key, item, `The content from ${peer} did not match its hash`);
          continue;
        }
        // Revocation wins (invariant 8), and nothing is written once the phase left builtin.
        if (!this.writable(key)?.spec.peers.includes(peer)) { controller.abort(new Error("The share changed during the download")); break; }
        let verified: TempFingerprint;
        try {
          verified = await writeTemp(temp, frame.bytes);
        } catch (error) {
          this.retry(key, item, `Could not write the download: ${errorText(error)}`);
          continue;
        }
        ready.push({ item, temp, small: true, input: { path: item.path, tempPath: temp, source: peer, verified } });
      }
    } catch (error) {
      // What arrived whole before the failure is still applied below; the rest goes again later.
      if (!this.closed) for (const { item } of pending.values()) this.retry(key, item, `Download from ${peer} failed: ${errorText(error)}`);
      pending.clear();
    } finally {
      stall.done();
      release();
    }
    // An answer that stopped at its limits leaves the rest to the next pass; one with nothing at all would only repeat.
    if (!answered && !this.closed) for (const { item } of pending.values()) this.retry(key, item, `${peer} sent none of the files asked for`);
    const applied = ready.length && !this.closed ? await this.applyItems(key, ready, peer) : 0;
    this.metric("fetch", route, started, received, applied);
  }

  /**
   * What a temp holds already, hashed again (reads are async: the loop keeps turning). False when it cannot be read whole;
   * undefined when file sync stops meanwhile (a multi-GiB temp would hold shutdown far past its budget; the temp stays).
   */
  private async hashPrefix(file: string, length: number, hash: Hash): Promise<boolean | undefined> {
    let handle: FileHandle;
    try { handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return false; }
    try {
      const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK, length));
      for (let position = 0; position < length;) {
        if (this.closed || this.abort.signal.aborted) return undefined;
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position);
        if (!bytesRead) return false;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /** A large file through `file`, resumed with Range from its deterministic temp and hashed while it streams, then applied. */
  private async runFile(peer: string, key: string, prepared: Prepared, have: number): Promise<void> {
    if (!this.writable(key)) return;
    const { item, temp } = prepared;
    const size = item.target.size;
    const started = performance.now();
    const progress = { received: 0, route: "none" as Route };
    let applied = 0;
    try {
      let hash = createHash("sha256");
      let position = have;
      // Bytes already there are trusted only once hashed again; unreadable ones are fetched again.
      if (position > 0) {
        const readable = await this.hashPrefix(temp, position, hash);
        if (readable === undefined) return;
        if (!readable) { hash = createHash("sha256"); position = 0; }
      }
      // Written whole by this download (not resumed), so every byte in it went through the hash: apply need not read it again.
      let verified: TempFingerprint | undefined;
      if (position < size) {
        const done = await this.download(peer, key, item, temp, position, hash, progress);
        if (!done) return;
        hash = done.hash;
        position = done.position;
        if (done.whole) verified = done.written;
      }
      if (this.closed) return;
      if (position !== size) { this.retry(key, item, `The download from ${peer} ended early`); return; }
      if (hash.digest("hex") !== item.target.sha256) {
        // Wrong bytes cannot be resumed: the next try starts over.
        if (this.writable(key)) unlinkQuietly(temp);
        this.retry(key, item, `The content from ${peer} did not match its hash`);
        return;
      }
      applied = await this.applyItems(key, [{ item, temp, small: false, input: { path: item.path, tempPath: temp, source: peer, ...(verified ? { verified } : {}) } }], peer);
    } finally {
      if (progress.received || applied) this.metric("file", progress.route, started, progress.received, applied);
    }
  }

  /** Streams `file` from `position` into the temp; the hash and position it reached, or undefined when it failed (already recorded). */
  private async download(peer: string, key: string, item: TransferItem, temp: string, from: number, hashSoFar: Hash, progress: { received: number; route: Route }): Promise<{ hash: Hash; position: number; whole: boolean; written: TempFingerprint } | undefined> {
    const share = this.writable(key);
    if (!share) return undefined;
    const size = item.target.size;
    let hash = hashSoFar;
    let position = from;
    /** Every byte of the temp was written (and hashed) by this download. */
    let whole = from === 0;
    let handle: FileHandle;
    try {
      handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
      if (position === 0) await handle.truncate(0);
    } catch (error) {
      this.retry(key, item, `Could not write the download: ${errorText(error)}`);
      return undefined;
    }
    try {
      const controller = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, controller.signal]);
      let opened: Awaited<ReturnType<SyncLayer["openStream"]>>;
      try {
        opened = await this.openStream(peer, {
          method: "POST", target: filesTarget("file"), purpose: "transfer",
          json: { projectId: share.spec.projectId, kind: share.spec.kind, path: item.path, sha256: item.target.sha256 },
          ...(position > 0 ? { headers: { range: `bytes=${position}-` } } : {}),
        }, controller, signal);
      } catch (error) {
        if (!this.closed) this.retry(key, item, `Could not reach ${peer}: ${errorText(error)}`);
        return undefined;
      }
      const { response, release, stall } = opened;
      try {
        progress.route = response.route ?? this.route(peer);
        if (response.status === 416) {
          // What the temp holds does not fit the file there: started over.
          await discard(response.body);
          await handle.truncate(0);
          this.retry(key, item, `${peer} could not resume the download`);
          return undefined;
        }
        if (response.status !== 200 && response.status !== 206) {
          await this.refused(peer, key, [item], response);
          // Bytes of a version the source no longer has are no use to resume.
          if (response.status === 409 && this.writable(key)) unlinkQuietly(temp);
          return undefined;
        }
        let start = 0;
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header(response.headers, "content-range") ?? "");
          if (!range || Number(range[3]) !== size || Number(range[2]) !== size - 1) {
            await discard(response.body);
            this.retry(key, item, `${peer} answered another range`);
            return undefined;
          }
          start = Number(range[1]);
        }
        if (start !== position) {
          if (start !== 0) { await discard(response.body); this.retry(key, item, `${peer} answered another range`); return undefined; }
          // A whole answer to a resume: what the temp holds is replaced.
          position = 0;
          whole = true;
          hash = createHash("sha256");
          await handle.truncate(0);
        }
        for await (const chunk of watched(response.body, signal, stall)) {
          if (position + chunk.byteLength > size) throw new Error(`${peer} sent more than the file's size`);
          // Revocation wins (invariant 8), and nothing is written once the phase left builtin: before every write.
          if (!this.writable(key)?.spec.peers.includes(peer)) throw new Error("The share changed during the download");
          await handle.write(chunk, 0, chunk.byteLength, position);
          hash.update(chunk);
          position += chunk.byteLength;
          progress.received += chunk.byteLength;
          this.count(key, peer, progress.route, chunk.byteLength);
          this.deps.transfers!.faults?.midStream?.(item.path, position);
        }
      } catch (error) {
        // The temp keeps what arrived: the next try resumes from there.
        if (!this.closed) this.retry(key, item, `Download from ${peer} failed: ${errorText(error)}`);
        return undefined;
      } finally {
        stall.done();
        release();
      }
      return { hash, position, whole, written: fingerprint(await handle.stat()) };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // ---- lifecycle ----

  private cancelRetries(state: PeerState): void {
    state.contactRetry?.cancel();
    state.contactRetry = undefined;
    state.outboxRetry?.cancel();
    state.outboxRetry = undefined;
    for (const pull of this.pulls.values()) {
      if (pull.peer !== state.id) continue;
      pull.retry?.cancel();
      pull.retry = undefined;
    }
  }

  private forget(state: PeerState): void {
    this.cancelRetries(state);
    state.noticeTimer?.cancel();
    this.peers.delete(state.id);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.peers.values()) { this.cancelRetries(state); state.noticeTimer?.cancel(); }
    for (const pull of this.pulls.values()) pull.retry?.cancel();
    this.transferTimer?.timer.cancel();
    this.transferTimer = undefined;
    this.unsubscribe?.();
    this.abort.abort();
    await this.idle();
  }
}
