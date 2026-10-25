import { createHash } from "node:crypto";
import fsModule, {
  chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync, type Stats,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Applier } from "../src/file-sync/apply.js";
import { CONFLICT_COPY_LIMIT, conflictCopyOriginal, decideGlobal, placeConflictCopy, sameContent } from "../src/file-sync/conflicts.js";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerRequest, type PeerResponse, type PeerTransport } from "../src/file-sync/core.js";
import { FileSyncDb, fileSyncDbPath, type LocalEntry } from "../src/file-sync/db.js";
import { Digest } from "../src/file-sync/digest.js";
import { compileRules, effectiveRules, isDeletableClass, type IgnoreMatcher } from "../src/file-sync/ignore.js";
import { NeedEngine } from "../src/file-sync/need.js";
import { caseFoldKey, parentKey } from "../src/file-sync/paths.js";
import { opSchemas, type ConfigureArgs, type CoreEvent, type FilesEndpoint, type ShareStatus } from "../src/file-sync/protocol.js";
import { ShareScanner } from "../src/file-sync/scanner.js";
import { SyncLayer } from "../src/file-sync/sync.js";
import { Trash } from "../src/file-sync/trash.js";
import { DIRECTORY, FILE, SYMLINK, type Clock, type EntryType, type IndexEntry, type Phase, type RuleSettings } from "../src/file-sync/types.js";
import { canonicalVector, compareVectors, mergeVectors } from "../src/file-sync/vectors.js";
import { FILES_API } from "../src/file-sync/wire.js";

/* A deterministic chaos rig for the built-in file sync engine (FILE-SYNC design §9 P3a). Two or three
   cores run in this thread on their own temp trees, with one fake clock and one seeded PRNG behind every
   choice. Their transport parks each request until the scheduler delivers, drops, reorders or truncates
   it, so the network is just another thing the PRNG decides. Random filesystem operations, scans,
   crashes between temp and rename, lost indexes, dropped shares and replaced roots are interleaved;
   quiesce() then runs the engines until nothing is left to do, and check() holds the result against
   the invariants of §0:
   (a) the trees agree on every synced path (type, bytes, link text, mode bits); whatever differs must be
       a blocked item the model explains (a case collision on darwin, a link or file where a peer has a
       folder, a folder kept for local-only files);
   (b) every content any node ever held in a tree is still somewhere: a live file, a conflict copy or a
       trash; only people's own edits may destroy the last copy of something;
   (c) no scanner tombstone was written while the path existed on that node;
   (d) one version vector per path across nodes, and equal digests;
   (g) apply puts a version in the trash only when what replaces or deletes it supersedes it (a newer
       version, or a tombstone of exactly that content), never a concurrent one (that becomes a conflict
       copy), never an edit the index has not seen, never on a stale decision;
   (h) identical content never becomes a conflict copy;
   (r) revocation wins: nothing is applied with bytes from a peer that no longer shares the folder, and a
       node that shares it with nobody gains no content it did not hold or write;
   plus: a final full scan changes nothing (the index is what is on disk), nothing appears outside the
   trees (no writes through links), a node whose phase is not builtin is never written by the engine, and
   content someone wrote while apply placed a version ends live in a tree (in place or as a conflict copy),
   not only in a trash. Writers race the apply's whole synchronous section (before and after the rename,
   right after the old content is kept, right before a temp goes into an empty name), people edit a path
   while its apply is prepared, rules change on some nodes, and nodes leave builtin for a while.
   Engines: "stub" plays need and apply (§5.4–§5.5) from the cores' own index rows, for as long as the
   real ones are not in the core; "ops" drives the core's nextNeeds/applyBatch ops with bytes read from
   the source tree; "core" leaves transfers to the core's sync layer and only carries its requests. */

export const SHARE = "project:p1";
export const PROJECT_ID = "p1";
const DARWIN = process.platform === "darwin";
const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;
const MiB = 1024 * 1024;
/** Turns of the event loop one settle may take before it gives up waiting for quiet. */
const SETTLE_TICKS = 20_000;
const CLOSE_TIMEOUT_MS = 10_000;

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export function sha256(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** The PRNG of the other file-sync property tests (mulberry32 over a scrambled seed). */
export function prng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed derived from several parts (FNV-1a), so each core's own randomness is independent of the scheduler's. */
export function mixSeed(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u0001")) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash;
}

/** Seeds to run: FILE_SYNC_SEED (one), else FILE_SYNC_SEEDS from FILE_SYNC_SEED_START (default 1). */
export function seedList(defaultCount: number): number[] {
  if (process.env.FILE_SYNC_SEED !== undefined) return [Number(process.env.FILE_SYNC_SEED)];
  const count = Number(process.env.FILE_SYNC_SEEDS ?? defaultCount);
  const start = Number(process.env.FILE_SYNC_SEED_START ?? 1);
  return Array.from({ length: count }, (_, index) => start + index);
}

/** Timers fire only when the harness advances time, in due order; nothing is real time. */
export class FakeClock implements Clock {
  private timers: Array<{ at: number; seq: number; run(): void; cancelled: boolean }> = [];
  private seq = 0;
  /* A fixed start: harness writes stamp mtimes from this clock, so a seed replays with the same mtimes, and real
     mtimes (folders, engine temps) are always later than it (a temp never looks idle for an hour). */
  current = Date.UTC(2026, 9, 1, 12, 0, 0);
  now(): number { return this.current; }
  setTimeout(run: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.current + Math.max(0, ms), seq: this.seq++, run, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }
  private live(): Array<{ at: number; seq: number; run(): void; cancelled: boolean }> {
    this.timers = this.timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at || a.seq - b.seq);
    return this.timers;
  }
  get pending(): number { return this.live().length; }
  fireNext(limit = Number.POSITIVE_INFINITY): boolean {
    const next = this.live()[0];
    if (!next || next.at > limit) return false;
    this.timers.shift();
    this.current = Math.max(this.current, next.at);
    next.run();
    return true;
  }
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (this.fireNext(target)) await tick();
    this.current = Math.max(this.current, target);
  }
}

export class HarnessCrash extends Error {
  constructor(point: string) { super(`Harness crash at ${point}`); }
}

// ---------------------------------------------------------------- instrumentation

/* Installed once per process and shared by every harness: oracle (c) needs to see each tombstone the
   scanner commits while the scanner's run is known, and settle() needs to know when a delivered index
   page has been decoded (gunzip runs on the thread pool, out of sight of the event loop). */
const harnesses = new Set<Harness>();
/** FILE_SYNC_TRACE=<regexp>: every row written for a matching path goes into the operation log (who, version, content). */
const TRACE = process.env.FILE_SYNC_TRACE ? new RegExp(process.env.FILE_SYNC_TRACE) : /(?!)/;
/** FILE_SYNC_TRACE_HASH=<sha256 prefix>: where that content is each time people destroy a copy of it. */
const TRACE_HASH = process.env.FILE_SYNC_TRACE_HASH;
let installed = false;
/** People's own symlink calls (the harness's operations) are no apply to race. */
let peopleLinking = 0;
let writeCount = 0;
let activeScanner: ShareScanner | undefined;
type Callable = (...args: unknown[]) => unknown;

function install(): void {
  if (installed) return;
  installed = true;
  const scanner = ShareScanner.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ["scanNow"]) {
    const original = scanner[name];
    if (typeof original !== "function") continue;
    scanner[name] = function (this: ShareScanner, ...args: unknown[]) {
      for (const harness of harnesses) harness.scanStarted(this);
      return original.apply(this, args);
    };
  }
  const commit = scanner.commit;
  if (typeof commit === "function") {
    scanner.commit = function (this: ShareScanner, ...args: unknown[]) {
      const previous = activeScanner;
      activeScanner = this;
      try { return commit.apply(this, args); } finally { activeScanner = previous; }
    };
  }
  const putEntry = FileSyncDb.prototype.putEntry;
  FileSyncDb.prototype.putEntry = function (this: FileSyncDb, share: string, entry: LocalEntry) {
    if (activeScanner && entry.deleted) {
      const before = this.entry(share, entry.path);
      if (before && !before.deleted) for (const harness of harnesses) harness.tombstoneWritten(this, activeScanner, entry);
    }
    if (TRACE.test(entry.path)) for (const harness of harnesses) harness.trace(this, `local${activeScanner ? " (scan)" : ""}`, entry);
    return putEntry.call(this, share, entry);
  };
  const putRemote = FileSyncDb.prototype.putRemote;
  FileSyncDb.prototype.putRemote = function (this: FileSyncDb, share: string, peer: string, entry: IndexEntry) {
    if (TRACE.test(entry.path)) for (const harness of harnesses) harness.trace(this, `remote ${peer}`, entry);
    return putRemote.call(this, share, peer, entry);
  };
  const writeTx = FileSyncDb.prototype.writeTx;
  FileSyncDb.prototype.writeTx = function <T>(this: FileSyncDb, run: () => T): T {
    writeCount++;
    return writeTx.call(this, run) as T;
  };
  const storeRemote = NeedEngine.prototype.storeRemote;
  NeedEngine.prototype.storeRemote = function (this: NeedEngine, ...args: Parameters<NeedEngine["storeRemote"]>) {
    const db = (this as unknown as { deps: { db: FileSyncDb } }).deps.db;
    for (const harness of harnesses) harness.pageDecoded(db);
    return storeRemote.apply(this, args);
  };
  // Oracle (g) and the writers racing what apply keeps: every preservation is looked at as it happens.
  const trash = Trash.prototype as unknown as Record<string, Callable>;
  for (const name of ["preserve", "take"]) {
    const original = trash[name];
    trash[name] = function (this: Trash, ...args: unknown[]) {
      const [, relative, absolute] = args as [string, string, string];
      for (const harness of harnesses) harness.trashing(this, relative, absolute);
      const kept = original.apply(this, args);
      for (const harness of harnesses) {
        harness.innerRace(absolute, `after ${name}`);
        // A delete may be one entry of a folder being cleared: someone saves another file in it right then.
        if (name === "take") harness.innerRaceSibling(absolute);
      }
      return kept;
    };
  }
  const applier = Applier.prototype as unknown as Record<string, Callable>;
  // Oracle (h): the loser of a conflict copy is never the content that replaces it.
  const conflictCopy = applier.conflictCopy;
  applier.conflictCopy = function (this: Applier, ...args: unknown[]) {
    const [share, key, , loser] = args as [{ key: string }, string, string, LocalEntry];
    for (const harness of harnesses) harness.copying(this, share.key, key, loser);
    return conflictCopy.apply(this, args);
  };
  // Oracle (r): what commitPlan applied with a peer's bytes, checked against the peer set of that moment.
  const commitPlan = applier.commitPlan;
  applier.commitPlan = function (this: Applier, ...args: unknown[]) {
    const result = commitPlan.apply(this, args);
    const [share, plan] = args as [{ key: string; peers(): readonly string[] }, { input?: { source?: string }; path?: string }];
    for (const harness of harnesses) harness.appliedFrom(this, share, plan);
    return result;
  };
  // Between an apply's preparation (copies, hashing: awaits) and its synchronous section: people edit the path there.
  const finishTemp = applier.finishTemp;
  applier.finishTemp = async function (this: Applier, ...args: unknown[]) {
    for (const harness of harnesses) await harness.perturb(this, args[0] as { path?: string });
    return finishTemp.apply(this, args);
  };
  // A writer right before a temp (or a link) goes into a name apply found empty: a hard link or symlink must fail
  // there (EEXIST) where a rename would replace the write unseen. A rename over an existing file cannot be made safe in
  // Node (no compare-and-swap), so only a rename into a name that is empty now is raced.
  const placing = (from: string, to: string, link: boolean) => {
    if (!link && lstatQuiet(to)) return;
    if (!ENGINE_TEMP.test(path.basename(from))) return;
    for (const harness of harnesses) harness.innerRace(to, "before the temp is placed");
  };
  const { renameSync: rename, linkSync: hardLink, symlinkSync: symlink, copyFileSync: copyFile } = fsModule;
  // The loser of a conflict saved again as its copy is cloned: the copy must be of the loser, or no copy at all.
  fsModule.copyFileSync = function (from: fsModule.PathLike, to: fsModule.PathLike, mode?: number) {
    if (String(to).includes(".sync-conflict-")) for (const harness of harnesses) harness.innerRace(String(from), "while its conflict copy is made");
    return copyFile(from, to, mode);
  };
  fsModule.renameSync = function (from: fsModule.PathLike, to: fsModule.PathLike) {
    // A delete moving the file into the trash: someone saves it right before (the move must notice it took an edit).
    if (String(to).includes(`${path.sep}file-sync${path.sep}trash${path.sep}`)) for (const harness of harnesses) harness.innerRace(String(from), "before it moves into the trash");
    else placing(String(from), String(to), false);
    return rename(from, to);
  };
  fsModule.linkSync = function (from: fsModule.PathLike, to: fsModule.PathLike) { placing(String(from), String(to), true); return hardLink(from, to); };
  fsModule.symlinkSync = function (target: fsModule.PathLike, file: fsModule.PathLike, type?: fsModule.symlink.Type | null) {
    if (!peopleLinking) for (const harness of harnesses) harness.innerRace(String(file), "before a link is made");
    return symlink(target, file, type);
  } as typeof fsModule.symlinkSync;
  syncBuiltinESMExports();
  const sync = SyncLayer.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const pullFailed = sync.pullFailed;
  if (typeof pullFailed === "function") {
    sync.pullFailed = function (this: SyncLayer, ...args: unknown[]) {
      const db = (this as unknown as { deps: { db: FileSyncDb } }).deps.db;
      for (const harness of harnesses) harness.pageDecoded(db);
      return pullFailed.apply(this, args);
    };
  }
}

// ---------------------------------------------------------------- files on disk

export interface TreeItem { type: EntryType; mode: number; hash: string | null; target: string | null }

function joinKey(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
function depthOf(key: string): number { return key ? key.split("/").length : 0; }
function abs(root: string, key: string): string { return key ? path.join(root, ...key.split("/")) : root; }
function typeOf(st: Stats): EntryType { return st.isDirectory() ? DIRECTORY : st.isSymbolicLink() ? SYMLINK : FILE; }
function lstatQuiet(file: string): Stats | null { try { return lstatSync(file); } catch { return null; } }
function isAncestor(ancestor: string, key: string): boolean { return ancestor === "" || key.startsWith(`${ancestor}/`); }
function related(a: string, b: string): boolean { return a === b || isAncestor(a, b) || isAncestor(b, a); }

/**
 * What is at `key` inside the tree: every ancestor must be a real folder (lstat alone follows a link in the
 * middle of a path) spelled exactly (APFS finds "D0/f" under "d0/F"); otherwise nothing is there.
 */
function lstatInTree(root: string, key: string): Stats | null {
  if (!key) return lstatQuiet(root);
  let dir = root;
  const segments = key.split("/");
  for (let index = 0; index < segments.length; index++) {
    if (DARWIN) {
      let names: string[];
      try { names = readdirSync(dir); } catch { return null; }
      if (!names.some((name) => name.normalize("NFC") === segments[index])) return null;
    }
    const st = lstatQuiet(path.join(dir, segments[index]));
    if (!st) return null;
    if (index === segments.length - 1) return st;
    if (!st.isDirectory()) return null;
    dir = path.join(dir, segments[index]);
  }
  return null;
}

/** Whether `dirKey` is a real folder of the tree ("" is the root). */
function realDirectory(root: string, dirKey: string): boolean { return lstatInTree(root, dirKey)?.isDirectory() ?? false; }

/** The spelling `key` has on disk: on APFS a write to "F0" lands in an existing "f0", which is what people edit then. */
function spelling(root: string, key: string): string {
  if (!DARWIN || !key) return key;
  let dir = root;
  const out: string[] = [];
  const segments = key.split("/");
  for (let index = 0; index < segments.length; index++) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return [...out, ...segments.slice(index)].join("/"); }
    const segment = segments[index];
    const name = names.find((candidate) => candidate === segment) ?? names.find((candidate) => caseFoldKey(candidate) === caseFoldKey(segment));
    if (name === undefined) return [...out, ...segments.slice(index)].join("/");
    out.push(name);
    dir = path.join(dir, name);
  }
  return out.join("/");
}

class HashCache {
  private readonly cache = new Map<string, { fingerprint: string; hash: string }>();
  hash(file: string, st: Stats): string {
    const fingerprint = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const cached = this.cache.get(file);
    if (cached?.fingerprint === fingerprint) return cached.hash;
    const hash = sha256(readFileSync(file));
    this.cache.set(file, { fingerprint, hash });
    return hash;
  }
}

/** Every regular file below `dir` (links are never followed), with its key relative to `dir`. */
function eachFile(dir: string, visit: (file: string, key: string, st: Stats) => void, key = ""): void {
  let names: string[];
  try { names = readdirSync(abs(dir, key)).sort(); } catch { return; }
  for (const name of names) {
    const child = joinKey(key, name);
    const st = lstatQuiet(abs(dir, child));
    if (!st) continue;
    if (st.isDirectory()) eachFile(dir, visit, child);
    else if (st.isFile()) visit(abs(dir, child), child, st);
  }
}

// ---------------------------------------------------------------- the network

export interface FaultRates {
  /** A request lost before it reaches the peer. */
  drop: number;
  /** The peer cannot be reached at all. */
  refuse: number;
  /** The answer is held back for a later delivery step (responses reorder too). */
  hold: number;
  /** The answer's bytes are cut short (the connection breaks mid-body). */
  truncate: number;
  /** The peer did the work but its answer never arrives. */
  lose: number;
}

export const DEFAULT_FAULTS: FaultRates = { drop: 0.05, refuse: 0.02, hold: 0.15, truncate: 0.05, lose: 0.03 };
export const NO_FAULTS: FaultRates = { drop: 0, refuse: 0, hold: 0, truncate: 0, lose: 0 };

interface Answer { status: number; headers: Record<string, string>; chunks: Buffer[]; error?: Error }

export interface Parked {
  id: number;
  from: string;
  to: string;
  endpoint: string;
  purpose: PeerRequest["purpose"];
  request: PeerRequest;
  sender: FileSyncCore;
  /** Stable order key: what is parked is sorted by it, so the choice does not depend on arrival order. */
  order: string;
  state: "request" | "response";
  answer?: Answer;
  resolve(response: PeerResponse): void;
  reject(error: Error): void;
}

function connectionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function* chunked(answer: Answer, cutAt?: number): AsyncIterable<Uint8Array> {
  let sent = 0;
  for (const chunk of answer.chunks) {
    for (let at = 0; at < chunk.length; at += 64 * 1024) {
      const piece = chunk.subarray(at, Math.min(chunk.length, at + 64 * 1024));
      if (cutAt !== undefined && sent + piece.length > cutAt) {
        if (cutAt > sent) yield piece.subarray(0, cutAt - sent);
        throw connectionError("ECONNRESET", "socket hang up (harness cut the answer short)");
      }
      sent += piece.length;
      yield piece;
    }
  }
  if (answer.error) throw answer.error;
}

export class Network {
  readonly parked: Parked[] = [];
  readonly stats = { requests: 0, served: 0, dropped: 0, refused: 0, held: 0, truncated: 0, lost: 0, aborted: 0 };
  private nextId = 0;

  constructor(private readonly harness: Harness) {}

  transport(node: HarnessNode, holder: { core?: FileSyncCore }): PeerTransport {
    return {
      request: (peer, request) => this.park(node, holder.core!, peer, request),
      route: () => "direct",
    };
  }

  private park(node: HarnessNode, sender: FileSyncCore, peer: string, request: PeerRequest): Promise<PeerResponse> {
    this.stats.requests++;
    if (this.harness.isDead(sender)) return Promise.reject(connectionError("ECONNRESET", "the sending core is gone"));
    const url = new URL(request.target, "http://peer");
    const endpoint = url.pathname.slice(FILES_API.length + 1);
    const body = request.json === undefined ? "" : JSON.stringify(request.json);
    const order = `${node.id}>${peer} ${request.method} ${request.target} ${request.headers?.range ?? ""} ${body.length > 200 ? sha256(body) : body}`;
    return new Promise<PeerResponse>((resolve, reject) => {
      const parked: Parked = { id: this.nextId++, from: node.id, to: peer, endpoint, purpose: request.purpose, request, sender, order, state: "request", resolve, reject };
      const signal = request.signal;
      if (signal?.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); return; }
      signal?.addEventListener("abort", () => {
        if (this.remove(parked)) { this.stats.aborted++; reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }
      }, { once: true });
      this.parked.push(parked);
    });
  }

  private remove(parked: Parked): boolean {
    const at = this.parked.indexOf(parked);
    if (at < 0) return false;
    this.parked.splice(at, 1);
    return true;
  }

  /** What is parked, in a stable order; `filter` narrows it (one purpose, one node). */
  pending(filter?: (parked: Parked) => boolean): Parked[] {
    return this.parked.filter((parked) => !filter || filter(parked)).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id - b.id));
  }

  /** Delivers one parked request or answer; what happens to it comes from `random` and `faults`. Returns a log line. */
  async deliver(parked: Parked, random: () => number, faults: FaultRates): Promise<string> {
    if (!this.remove(parked)) return "";
    const what = `${parked.from}>${parked.to} ${parked.endpoint}${parked.endpoint === "index" ? `?since=${new URL(parked.request.target, "http://peer").searchParams.get("since")}` : ""}`;
    if (this.harness.isDead(parked.sender)) { parked.reject(connectionError("ECONNRESET", "the sending core is gone")); return `${what}: sender gone`; }
    if (parked.state === "response") return this.answer(parked, random, faults, what);
    const roll = random();
    if (roll < faults.drop) { this.stats.dropped++; parked.reject(connectionError("ECONNRESET", "socket hang up (harness dropped the request)")); return `${what}: dropped`; }
    const target = this.harness.nodeById(parked.to);
    if (roll < faults.drop + faults.refuse || !target || this.harness.isDead(target.core)) {
      this.stats.refused++;
      parked.reject(connectionError("ECONNREFUSED", `connect ECONNREFUSED ${parked.to}`));
      return `${what}: refused`;
    }
    const url = new URL(parked.request.target, "http://peer");
    const body = parked.request.json === undefined ? undefined : structuredClone(parked.request.json);
    const range = parked.request.headers?.range ?? parked.request.headers?.Range;
    let answer: Answer;
    try {
      const serve = target.core.service.serve as (peer: string, endpoint: FilesEndpoint, query: Record<string, string>, body: unknown, range?: string) => ReturnType<FileSyncCore["service"]["serve"]>;
      const served = await serve.call(target.core.service, parked.from, parked.endpoint as FilesEndpoint, Object.fromEntries(url.searchParams), body, range);
      answer = { status: served.status, headers: served.headers, chunks: [] };
      // Read here, whole: what the peer serves is decided now (its files as they are), and the client gets it later.
      if (served.json !== undefined) answer.chunks.push(Buffer.from(JSON.stringify(served.json)));
      else if (served.body) {
        try { for await (const chunk of served.body) answer.chunks.push(Buffer.from(chunk)); } catch (error) { answer.error = error as Error; }
      }
    } catch (error) {
      answer = { status: 500, headers: { "content-type": "application/json" }, chunks: [Buffer.from(JSON.stringify({ error: (error as Error).message }))] };
    }
    this.stats.served++;
    parked.answer = answer;
    if (random() < faults.hold) {
      this.stats.held++;
      parked.state = "response";
      parked.order = `~${parked.order}`;
      this.parked.push(parked);
      return `${what}: ${answer.status}, answer held`;
    }
    return this.answer(parked, random, faults, what);
  }

  private answer(parked: Parked, random: () => number, faults: FaultRates, what: string): string {
    const answer = parked.answer!;
    if (this.harness.isDead(parked.sender)) { parked.reject(connectionError("ECONNRESET", "the sending core is gone")); return `${what}: sender gone`; }
    const roll = random();
    if (roll < faults.lose) { this.stats.lost++; parked.reject(connectionError("ECONNRESET", "socket hang up (harness lost the answer)")); return `${what}: ${answer.status}, answer lost`; }
    const total = answer.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    let cutAt: number | undefined;
    if (total > 0 && roll < faults.lose + faults.truncate) { cutAt = Math.floor(random() * total); this.stats.truncated++; }
    if (parked.endpoint === "index" && answer.status === 200 && cutAt === undefined) this.harness.pageDelivered(parked.from);
    parked.resolve({ status: answer.status, headers: answer.headers, body: chunked(answer, cutAt), route: "direct" });
    // No byte counts: folder mtimes are real time, so an index page's compressed size varies between runs of one seed.
    return `${what}: ${answer.status}${cutAt !== undefined ? " cut short" : ""}`;
  }

  /** Everything a gone core sent or was owed fails (its process is dead). */
  failFrom(sender: FileSyncCore): void {
    for (const parked of [...this.parked]) {
      if (parked.sender !== sender) continue;
      this.remove(parked);
      parked.reject(connectionError("ECONNRESET", "the sending core is gone"));
    }
  }

  failAll(): void {
    for (const parked of this.parked.splice(0)) parked.reject(connectionError("ECONNRESET", "harness closed"));
  }
}

// ---------------------------------------------------------------- the content ledger (oracle b)

/**
 * Contents that must still exist somewhere at the end. Everything the scheduler writes, and everything seen
 * in a tree since, is required; a content leaves only when people's own operation destroys its last copy
 * (nothing else held it: no tree, no trash). An engine overwrite or delete never releases anything.
 */
class Ledger {
  readonly required = new Map<string, string>();
  readonly released = new Map<string, string>();
  write(hash: string, note: string): void { if (!this.required.has(hash)) this.required.set(hash, note); this.released.delete(hash); }
  observe(hash: string, note: string): void { if (!this.required.has(hash)) { this.required.set(hash, note); this.released.delete(hash); } }
  release(hash: string, note: string): void { if (this.required.delete(hash)) this.released.set(hash, note); }
  /** Written while apply placed a version (a local edit concurrent with it): must stay live, in place or as a conflict copy, until people destroy a copy. */
  readonly live = new Map<string, string>();
  /** The racing content last written at each node:path: a later write there by people supersedes it (the path may be empty by then). */
  readonly livePlaces = new Map<string, string>();
}

// ---------------------------------------------------------------- nodes and drivers

export interface HarnessNode {
  id: string;
  index: number;
  root: string;
  dataDir: string;
  core: FileSyncCore;
  generation: number;
  phase: Phase;
  /** The share is configured on this node (dropShare/addShare). */
  shared: boolean;
  /** Paths people changed since this node last scanned them: what its watcher would report. */
  dirty: Set<string>;
  /** Harness operations by op number, for oracle (c): a scan that raced one of them saw a moving tree. */
  touches: Array<{ op: number; path: string }>;
  engineWrites: Array<{ op: number; path: string }>;
  crashAt?: "beforeRename" | "afterRename";
  crashed?: FileSyncCore;
  /** An index page was delivered and not decoded yet (settle waits for it). */
  pages: number;
  pagesSince: number;
  events: number;
  warnings: string[];
  /** A node not in builtin phase: its tree as the harness left it (the engine must not change it). */
  snapshot?: string;
  /** Where the root was moved while it is missing (an unmounted disk, a folder moved away and back). */
  away?: string;
  /** The index generation when the root went missing: only a share indexed afresh since may create it again. */
  awayIndexId?: string;
  /** The share was configured anew (added again) since the root went missing: a new generation, even if it is dropped again by the time the root returns. */
  awayFresh?: boolean;
  /** The index generation the root had when it was replaced: no tombstone may come from it (its rows describe the old folder). */
  replaced?: string;
  /** The rules this node runs now (a rules action changes them on some nodes for a while). */
  rules: Partial<RuleSettings>;
  /** Peers this node does not share the folder with now (a revocation, both ways). */
  unshared?: Set<string>;
  /** Sharing with nobody: what it held then, and what people wrote since (oracle r). */
  revoked?: Set<string>;
}

export interface BlockedItem { node: string; path: string; reason: string; model?: string }

interface Driver {
  readonly name: EngineMode;
  /** One transfer step on the node; true when it did something. */
  step(node: HarnessNode): Promise<boolean>;
  /** Paths the node still has to bring up to date (blocked ones aside). */
  pending(node: HarnessNode): number;
  blocked(node: HarnessNode): BlockedItem[];
  /** What is pending, for the report of a run that does not quiesce. */
  describe?(node: HarnessNode): string[];
}

export type EngineMode = "stub" | "ops" | "core";

export function detectEngine(): EngineMode {
  const forced = process.env.FILE_SYNC_ENGINE;
  if (forced === "stub" || forced === "ops" || forced === "core") return forced;
  if (!("nextNeeds" in opSchemas) || !("applyBatch" in opSchemas)) return "stub";
  return Object.getOwnPropertyNames(SyncLayer.prototype).some((name) => /transfer/i.test(name)) ? "core" : "ops";
}

/** Need rows as the core stores them (§4: need(..., last_error, blocked)); empty before P3. */
function needRows(core: FileSyncCore): Array<{ path: string; blocked: boolean; reason: string | null }> {
  const raw = (core.db as unknown as { db?: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } }).db;
  try {
    return (raw?.prepare("SELECT * FROM need WHERE share = ?").all(SHARE) ?? []).map((row) => {
      const record = row as Record<string, unknown>;
      return { path: String(record.path), blocked: record.blocked === 1, reason: (record.last_error as string | null) ?? null };
    });
  } catch { return []; }
}

function coreBlocked(node: HarnessNode): BlockedItem[] {
  const items = new Map<string, BlockedItem>();
  for (const row of needRows(node.core)) if (row.blocked) items.set(row.path, { node: node.id, path: row.path, reason: row.reason ?? "blocked" });
  try {
    const db = node.core.db;
    for (const row of db.errorsPage(SHARE, 0, 10_000).items) if (row.kind === "blocked" && !items.has(row.path)) items.set(row.path, { node: node.id, path: row.path, reason: row.reason });
  } catch { /* no share row */ }
  return [...items.values()];
}

class CoreDriver implements Driver {
  readonly name = "core" as const;
  constructor(private readonly harness: Harness) {}
  async step(node: HarnessNode): Promise<boolean> {
    // The core runs its own transfer loop; a step carries one of its requests.
    const parked = this.harness.net.pending((item) => item.purpose === "transfer" && (item.from === node.id || item.to === node.id));
    if (!parked.length) return false;
    await this.harness.deliverParked(parked[Math.floor(this.harness.random() * parked.length)]);
    return true;
  }
  pending(node: HarnessNode): number { return node.shared ? node.core.db.needSummary(SHARE).files : 0; }
  blocked(node: HarnessNode): BlockedItem[] { return coreBlocked(node); }
}

/** nextNeeds/applyBatch as protocol.ts documents them (P3), without the sync layer's transfer loop. */
class OpsDriver implements Driver {
  readonly name = "ops" as const;
  constructor(private readonly harness: Harness) {}
  async step(node: HarnessNode): Promise<boolean> {
    if (!node.shared || node.phase !== "builtin" || this.harness.isDead(node.core)) return false;
    const call = node.core.call as unknown as (op: string, args: unknown) => Promise<unknown>;
    const peers = this.harness.peersOf(node).filter((peer) => this.harness.nodeById(peer)?.shared);
    const next = await call.call(node.core, "nextNeeds", { limit: 64, availablePeers: peers }) as { items: Array<{ share: string; path: string; action: string; target: IndexEntry; sources: string[]; localSources: unknown[] }> };
    const items: Array<Record<string, unknown>> = [];
    for (const item of next.items.filter((candidate) => candidate.share === SHARE)) {
      if (item.action === "move") { items.push({ path: item.path, move: true }); continue; }
      if (item.action !== "fetch") { items.push({ path: item.path }); continue; }
      if (item.localSources.length) { items.push({ path: item.path, localSource: item.localSources[0] }); continue; }
      const fetched = this.harness.readSource(node, item.path, item.target, item.sources);
      if (!fetched) continue;
      const directory = this.harness.parentsFor(node, parentKey(item.path));
      if (!directory) { items.push({ path: item.path, source: fetched.peer }); continue; }
      const temp = path.join(directory, tempName(SHARE, item.path, item.target.sha256!));
      writeFileSync(temp, fetched.bytes);
      items.push({ path: item.path, tempPath: temp, source: fetched.peer });
    }
    if (!items.length) return false;
    // Only an applied item is progress: a retry that never succeeds must let the quiescence loop run timers and fail.
    const result = await call.call(node.core, "applyBatch", { share: SHARE, items }) as { applied?: number };
    return (result.applied ?? 0) > 0;
  }
  pending(node: HarnessNode): number { return node.shared ? node.core.db.needSummary(SHARE).files : 0; }
  blocked(node: HarnessNode): BlockedItem[] { return coreBlocked(node); }
}

/** `.joint-bob-sync.<name40>.<hex16>.tmp` (§1 Temp files). */
export function tempName(share: string, key: string, sha: string): string {
  const base = Array.from(key.slice(key.lastIndexOf("/") + 1)).slice(0, 40).join("");
  return `.joint-bob-sync.${base}.${sha256(`${share}\0${key}\0${sha}`).slice(0, 16)}.tmp`;
}

interface StubItem { path: string; local: LocalEntry | undefined; target: IndexEntry; conflict: boolean }

/**
 * §5.4–§5.5 played from the cores' own rows until need.ts/apply.ts do it: decideGlobal over the local row and
 * the eligible peers' rows, then the write with its checks (the disk is what the index says, exact parents, no
 * case collision), preservation (conflict copy or trash), and the local row written as apply does (version =
 * merge(local, target), no bump). Bytes come straight from a source peer's tree, hash-verified.
 */
class StubDriver implements Driver {
  readonly name = "stub" as const;
  private readonly blockedBy = new Map<string, Map<string, string>>();

  constructor(private readonly harness: Harness) {}

  private items(node: HarnessNode): StubItem[] {
    // A missing root is not created again: nothing is applied until it is back.
    if (!node.shared || node.phase !== "builtin" || this.harness.isDead(node.core) || !lstatQuiet(node.root)?.isDirectory()) return [];
    const db = node.core.db;
    const peers = this.harness.peersOf(node);
    const paths = new Set<string>();
    for (const entry of db.entries(SHARE)) paths.add(entry.path);
    for (const peer of peers) for (const row of db.remoteAfter(SHARE, peer, "", 1_000_000)) paths.add(row.path);
    const items: StubItem[] = [];
    for (const key of [...paths].sort()) {
      const item = this.decide(node, key);
      if (item) items.push(item);
    }
    return items;
  }

  private decide(node: HarnessNode, key: string): StubItem | undefined {
    const db = node.core.db;
    const remotes = this.harness.peersOf(node).map((peer) => db.remote(SHARE, peer, key)).filter((row): row is IndexEntry => row !== undefined);
    if (!remotes.length) return undefined;
    const local = db.entry(SHARE, key);
    // Paths the local rules ignore never get a need (§5.4).
    if (local && this.harness.ignored(key, local.type === DIRECTORY)) return undefined;
    const { target, decision } = decideGlobal(local, remotes);
    if (!target || decision.kind !== "apply" || this.harness.ignored(key, target.type === DIRECTORY)) return undefined;
    return { path: key, local, target, conflict: decision.conflict };
  }

  pending(node: HarnessNode): number {
    const blocked = this.blockedBy.get(node.id);
    return this.items(node).filter((item) => !blocked?.has(item.path)).length;
  }

  describe(node: HarnessNode): string[] {
    const blocked = this.blockedBy.get(node.id);
    const text = (entry: IndexEntry | undefined) => entry ? `${entry.deleted ? "deleted " : ""}${["file", "dir", "link"][entry.type]} ${entry.sha256?.slice(0, 8) ?? entry.target ?? ""} ${entry.mode.toString(8)} ${canonicalVector(entry.version)}` : "none";
    return this.items(node).filter((item) => !blocked?.has(item.path)).map((item) => `${item.path}: local ${text(item.local)} -> ${text(item.target)}${item.conflict ? " (conflict)" : ""}`);
  }

  blocked(node: HarnessNode): BlockedItem[] {
    return [...this.blockedBy.get(node.id) ?? []].map(([key, reason]) => ({ node: node.id, path: key, reason }));
  }

  async step(node: HarnessNode): Promise<boolean> {
    const items = this.items(node);
    const blocked = new Map<string, string>();
    this.blockedBy.set(node.id, blocked);
    if (!items.length) return false;
    // Deletes deepest first (a folder empties before it goes), then everything else shallowest first.
    const deletes = items.filter((item) => item.target.deleted).sort((a, b) => depthOf(b.path) - depthOf(a.path) || (a.path < b.path ? -1 : 1));
    const others = items.filter((item) => !item.target.deleted).sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : 1));
    const scan = new Set<string>();
    let applied = 0;
    try {
      for (const item of [...deletes, ...others]) {
        if (this.harness.isDead(node.core)) break;
        if (this.apply(node, item.path, blocked, scan)) applied++;
      }
    } catch (error) {
      if (!(error instanceof HarnessCrash)) throw error;
    }
    if (scan.size && !this.harness.isDead(node.core)) await this.harness.scan(node, [...scan]);
    return applied > 0;
  }

  private block(blocked: Map<string, string>, key: string, reason: string): false { blocked.set(key, reason); return false; }

  private apply(node: HarnessNode, key: string, blocked: Map<string, string>, scan: Set<string>): boolean {
    const harness = this.harness;
    const db = node.core.db;
    const item = this.decide(node, key);
    if (!item) return false;
    const { local, target, conflict } = item;
    const file = abs(node.root, key);
    // §5.5.5: what is on disk must be what the index says; anything else is scanned first, never overwritten.
    const st = lstatInTree(node.root, key);
    if (!matchesRow(st, local)) { node.dirty.add(key); return false; }
    const parents = harness.prepareParents(node, parentKey(key), !target.deleted);
    if (parents.reason) return target.deleted && parents.missing ? (this.writeRow(node, key, target, null), true) : this.block(blocked, key, parents.reason);
    // Parents created now, and folders the index holds as deleted (kept for local-only files, left by a crash): a
    // synced child makes them live again, which only a scan records as a new version.
    for (let above = parentKey(key); above; above = parentKey(above)) {
      const row = db.entry(SHARE, above);
      if (!row || row.deleted || row.type !== DIRECTORY) scan.add(above);
    }
    if (!st && !target.deleted && DARWIN) {
      const base = key.slice(key.lastIndexOf("/") + 1);
      const clash = readdirSync(path.dirname(file)).find((name) => name.normalize("NFC") !== base && caseFoldKey(name) === caseFoldKey(base));
      if (clash) return this.block(blocked, key, `Case collision with ${clash}`);
    }
    const metaOnly = Boolean(st && local && !local.deleted && sameContent(local, target));
    if (metaOnly) {
      if (target.type !== SYMLINK) chmodSync(file, target.mode);
      this.writeRow(node, key, target, lstatSync(file));
      return true;
    }
    let temp: string | undefined;
    if (!target.deleted && target.type === FILE) {
      const fetched = harness.readSource(node, key, target);
      if (!fetched) return false;
      temp = path.join(path.dirname(file), tempName(SHARE, key, target.sha256!));
      writeFileSync(temp, fetched.bytes);
      chmodSync(temp, target.mode);
      utimesSync(temp, target.mtimeMs / 1000, target.mtimeMs / 1000);
    }
    // What should be at the path once the old content is kept (the temp then replaces it, so the path never disappears).
    let remaining = st;
    if (st) {
      if (st.isDirectory()) {
        const refusal = this.clearDirectory(node, key, target.deleted);
        if (refusal === "kept") { this.writeRow(node, key, target, null); return true; }
        if (refusal) { if (temp) unlinkSync(temp); return this.block(blocked, key, refusal); }
        remaining = null;
      } else if (conflict && local && !local.deleted) {
        // The local loser stays as its deterministic conflict copy (§3.4), indexed as a new local entry.
        const copy = placeConflictCopy(key, local, (candidate) => db.entry(SHARE, candidate) ?? harness.diskContent(node, candidate));
        if (Buffer.byteLength(copy.path.slice(copy.path.lastIndexOf("/") + 1)) > 255) {
          // A conflict copy of a conflict copy of ... : the name no longer fits (§1 Paths), so nothing moves.
          if (temp) unlinkSync(temp);
          return this.block(blocked, key, "The conflict copy's name would be too long");
        }
        if (!copy.preserved) { renameSync(file, abs(node.root, copy.path)); scan.add(copy.path); remaining = null; } else if (!temp) unlinkSync(file);
      } else {
        node.core.trash.preserve(SHARE, key, file);
        if (!temp) unlinkSync(file);
      }
    }
    if (temp) {
      harness.fault(node, node.core, "beforeRename", file);
      // §5.5.5 again, right before the rename: a writer since the first check is scanned, never overwritten.
      if (!sameFile(lstatInTree(node.root, key), remaining)) { unlinkSync(temp); node.dirty.add(key); return false; }
      const placed = lstatSync(temp);
      renameSync(temp, file);
      harness.fault(node, node.core, "afterRename", file);
      // The row claims only what was renamed into place; whatever someone wrote since is the scanner's to find.
      const after = lstatInTree(node.root, key);
      if (!sameFile(after, placed)) { node.dirty.add(key); return true; }
      this.writeRow(node, key, target, after);
      return true;
    } else if (!target.deleted && target.type === DIRECTORY) {
      mkdirSync(file);
      chmodSync(file, target.mode);
    } else if (!target.deleted && target.type === SYMLINK) {
      symlinkSync(target.target!, file);
      lutimesSync(file, target.mtimeMs / 1000, target.mtimeMs / 1000);
    }
    this.writeRow(node, key, target, target.deleted ? null : lstatSync(file));
    return true;
  }

  /**
   * A folder that must go (deleted, or another type in its place): what is left below after the deletes ran is
   * either regenerable (removed), synced content no peer deleted (refused), or local-only (a delete keeps the
   * folder for it, as the scanner expects; a type change is refused). Never a recursive remove.
   */
  private clearDirectory(node: HarnessNode, key: string, deleting: boolean): string | "kept" | null {
    const leftovers: Array<{ key: string; dir: boolean }> = [];
    const visit = (dirKey: string): void => {
      for (const name of readdirSync(abs(node.root, dirKey)).sort()) {
        const child = joinKey(dirKey, name.normalize("NFC"));
        const st = lstatSync(abs(node.root, child));
        if (st.isDirectory()) visit(child);
        leftovers.push({ key: child, dir: st.isDirectory() });
      }
    };
    visit(key);
    let localOnly = false;
    for (const entry of leftovers) {
      const ignoreClass = this.harness.matcher.classify(entry.key, entry.dir);
      if (ignoreClass === null) {
        // A folder below that an earlier delete kept for its local-only files goes the same way; anything else synced is someone's.
        const row = node.core.db.entry(SHARE, entry.key);
        if (entry.dir && row?.deleted && row.type === DIRECTORY) continue;
        return "A folder with files to keep is in the way";
      }
      if (!isDeletableClass(ignoreClass)) localOnly = true;
    }
    if (localOnly) return deleting ? "kept" : "A folder with local-only files is in the way";
    for (const entry of leftovers) {
      if (entry.dir) rmdirSync(abs(node.root, entry.key)); else unlinkSync(abs(node.root, entry.key));
    }
    rmdirSync(abs(node.root, key));
    return null;
  }

  /** §5.5.9: the local row takes the target's content, version = merge(local, target), a new seq, a fresh fingerprint. */
  private writeRow(node: HarnessNode, key: string, target: IndexEntry, st: Stats | null): void {
    const { db, need } = node.core;
    db.writeTx(() => {
      const row = db.entry(SHARE, key);
      const share = db.share(SHARE)!;
      let { liveFiles, liveBytes } = share;
      const next: LocalEntry = {
        path: key, fsName: null, type: target.type, size: st ? (st.isDirectory() ? 0 : st.size) : target.size, mtimeMs: target.mtimeMs, mode: target.mode,
        sha256: target.sha256, target: target.target, deleted: target.deleted, version: mergeVectors(row?.version ?? {}, target.version),
        modifiedBy: target.modifiedBy, seq: share.maxSeq + 1, ino: st?.ino ?? 0, ctimeMs: st?.ctimeMs ?? 0, fsMtimeMs: st?.mtimeMs ?? 0,
        deletedAt: target.deleted ? this.harness.clock.now() : null,
      };
      for (const [entry, sign] of [[row, -1], [next, 1]] as const) {
        if (entry && !entry.deleted && entry.type === FILE) { liveFiles += sign; liveBytes += sign * entry.size; }
      }
      db.putEntry(SHARE, next);
      db.updateShare(SHARE, { maxSeq: next.seq, digest: new Digest(share.digest).change(row, next).toString(), liveFiles, liveBytes });
      need.localChangesInTx(SHARE, [{ path: key, after: next }]);
    });
    node.core.sync?.localCommitted(SHARE);
  }
}

/** The same file as before: identity, size and mtime (a link into the trash moves ctime, a write moves mtime). */
function sameFile(a: Stats | null, b: Stats | null): boolean {
  if (!a || !b) return a === b;
  return typeOf(a) === typeOf(b) && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function matchesRow(st: Stats | null, row: LocalEntry | undefined): boolean {
  if (!row || row.deleted) return st === null;
  if (!st || typeOf(st) !== row.type) return false;
  if (row.type === DIRECTORY) return (st.mode & 0o777) === row.mode;
  if (row.type === SYMLINK) return st.size === row.size && st.mtimeMs === row.fsMtimeMs && st.ino === row.ino && st.ctimeMs === row.ctimeMs;
  return st.size === row.size && st.mtimeMs === row.fsMtimeMs && st.ino === row.ino && st.ctimeMs === row.ctimeMs && (st.mode & 0o777) === row.mode;
}

// ---------------------------------------------------------------- the harness

export interface HarnessOptions {
  seed: number;
  /** A fresh directory the harness owns (the caller removes it). */
  dir: string;
  nodes?: number;
  engine?: EngineMode;
  rules?: Partial<RuleSettings>;
  /** Per node; default all "builtin". A node in another phase must never be written by the engine. */
  phases?: Phase[];
  faults?: Partial<FaultRates>;
  /** Extra core dependencies (scanner options, page size, ...). */
  core?: Partial<CoreDeps>;
  /** Occasional files above 1 MiB (the `file` endpoint and its Range resume). */
  largeFiles?: boolean;
  /** Prints the operation log as it is written. */
  verbose?: boolean;
  /** Scheduler weights by action (0 turns one off). */
  weights?: Partial<Record<ActionName, number>>;
  /**
   * Chance that someone writes the target in place at the apply's rename hooks (an agent saving the file while sync
   * places it). Off by default: what a correct apply must do inside that window is the safety review's question.
   * FILE_SYNC_RACES=<p> sets both.
   */
  races?: Partial<Record<"beforeRename" | "afterRename", number>>;
  /** Chance that someone writes the path inside apply's section: right after the old content is kept, right before a temp or link goes into an empty name. FILE_SYNC_RACES_INNER. */
  innerRaces?: number;
  /** Chance that someone edits the path while its apply is prepared, scanned before the section runs. FILE_SYNC_PERTURB. */
  perturb?: number;
}

/** What runSeed adds unless the caller says otherwise: a little of every race, so the default seeds exercise them. */
export const SEED_DEFAULTS = { races: 0.05, innerRaces: 0.05, perturb: 0.1 } as const;

export type ActionName =
  | "fs" | "concurrentEdit" | "editVsDelete" | "caseVariant" | "scanSome" | "scanFull" | "deliver" | "deliverNotices" | "deliverPulls" | "deliverAll"
  | "transfer" | "advance" | "catchUp" | "crash" | "wipeIndex" | "dropShare" | "replaceRoot" | "rootAway" | "rules" | "phase" | "revoke";

/** How often the scheduler picks each action (relative). People's operations dominate; the rest is the engines' world. */
export const ACTION_WEIGHTS: Readonly<Record<ActionName, number>> = {
  fs: 30, concurrentEdit: 4, editVsDelete: 2.5, caseVariant: 1, scanSome: 9.5, scanFull: 2, deliver: 20, deliverNotices: 2, deliverPulls: 2, deliverAll: 3,
  transfer: 7, advance: 12, catchUp: 8, crash: 1.5, wipeIndex: 1, dropShare: 1.5, replaceRoot: 1, rootAway: 1, rules: 1.5, phase: 0.75, revoke: 0.75,
};

export interface CheckResult {
  problems: string[];
  blocked: BlockedItem[];
  stats: Record<string, number | string>;
}

const POOL = ["", "x", "same", "hello world\n", "same\n"];
const FILE_MODES = [0o644, 0o600, 0o755, 0o640, 0o664];
const DIR_MODES = [0o755, 0o700, 0o750, 0o775];

export class Harness {
  readonly seed: number;
  readonly random: () => number;
  readonly clock = new FakeClock();
  readonly net: Network;
  readonly nodes: HarnessNode[] = [];
  readonly log: string[] = [];
  readonly engine: EngineMode;
  readonly driver: Driver;
  readonly matcher: IgnoreMatcher;
  readonly violations: string[] = [];
  /** Harness filesystem operations so far; oracle (c) compares a scan's start with it. */
  ops = 0;
  stepNo = 0;
  faults: FaultRates;
  private readonly races: Partial<Record<"beforeRename" | "afterRename", number>>;
  private readonly innerRaces: number;
  private readonly perturbRate: number;
  private readonly rules: Partial<RuleSettings>;
  /** Closes of crashed cores, started at the crash (a dead process runs nothing more), awaited when the node is reaped. */
  private readonly closing = new WeakMap<FileSyncCore, Promise<void>>();
  private readonly options: HarnessOptions;
  private readonly ledger = new Ledger();
  private readonly hashes = new HashCache();
  private readonly dead = new WeakSet<FileSyncCore>();
  private readonly scanStarts = new WeakMap<ShareScanner, number>();
  private readonly counters = { contents: 0, mtimes: 0, replaced: 0, crashes: 0, wipes: 0, drops: 0, raced: 0, innerRaced: 0, perturbed: 0, ruleChanges: 0, phaseChanges: 0, revocations: 0, kept: 0, copies: 0 };
  private closed = false;
  /** quiesce() runs: sharing is whole again and stays so (writers may still race the applies). */
  private quiescing = false;

  constructor(options: HarnessOptions) {
    this.options = options;
    this.seed = options.seed;
    this.random = prng(options.seed);
    this.net = new Network(this);
    this.engine = options.engine ?? detectEngine();
    this.driver = this.engine === "stub" ? new StubDriver(this) : this.engine === "ops" ? new OpsDriver(this) : new CoreDriver(this);
    this.rules = options.rules ?? { userRules: ["*.skip"] };
    this.matcher = compileRules(effectiveRules("project", this.rules));
    this.faults = { ...DEFAULT_FAULTS, ...options.faults };
    const races = Number(process.env.FILE_SYNC_RACES ?? 0);
    this.races = process.env.FILE_SYNC_RACES !== undefined ? { beforeRename: races, afterRename: races } : options.races ?? {};
    this.innerRaces = process.env.FILE_SYNC_RACES_INNER !== undefined ? Number(process.env.FILE_SYNC_RACES_INNER) : options.innerRaces ?? 0;
    this.perturbRate = process.env.FILE_SYNC_PERTURB !== undefined ? Number(process.env.FILE_SYNC_PERTURB) : options.perturb ?? 0;
    install();
    harnesses.add(this);
    const count = options.nodes ?? 2;
    mkdirSync(path.join(options.dir, "outside"), { recursive: true });
    for (let index = 0; index < count; index++) {
      const id = `node-${String.fromCharCode(97 + index)}`;
      const root = path.join(options.dir, id);
      mkdirSync(root, { recursive: true });
      const node = {
        id, index, root, dataDir: path.join(options.dir, `${id}.data`), generation: 0, phase: options.phases?.[index] ?? "builtin", shared: true,
        dirty: new Set<string>(), touches: [], engineWrites: [], pages: 0, pagesSince: 0, events: 0, warnings: [], rules: this.rules,
      } as unknown as HarnessNode;
      node.core = this.openCore(node);
      this.nodes.push(node);
    }
  }

  static async create(options: HarnessOptions): Promise<Harness> {
    const harness = new Harness(options);
    await harness.start();
    return harness;
  }

  note(text: string): void {
    const line = `${String(this.stepNo).padStart(4)} ${text}`;
    this.log.push(line);
    if (this.options.verbose) console.log(line);
  }

  nodeById(id: string): HarnessNode | undefined { return this.nodes.find((node) => node.id === id); }
  peersOf(node: HarnessNode): string[] { return this.nodes.filter((other) => other !== node).map((other) => other.id); }
  isDead(core: FileSyncCore): boolean { return this.dead.has(core); }
  ignored(key: string, isDirectory: boolean): boolean { return this.matcher.classify(key, isDirectory) !== null; }

  // ---- cores ----

  private openCore(node: HarnessNode): FileSyncCore {
    node.generation += 1;
    const holder: { core?: FileSyncCore } = {};
    const core = createWorkerCore({
      nodeId: node.id, dataDir: node.dataDir, clock: this.clock, random: prng(mixSeed(this.seed, node.id, node.generation)), watch: false,
      transport: this.net.transport(node, holder),
      emit: (event) => this.onEvent(node, holder.core!, event),
      faults: {
        beforeRename: (target) => this.fault(node, holder.core!, "beforeRename", target),
        afterRename: (target) => this.fault(node, holder.core!, "afterRename", target),
      },
      diskFree: () => 1e12,
      pageLimit: 3 + Math.floor(prng(mixSeed(this.seed, "page"))() * 40),
      ...this.options.core,
    });
    holder.core = core;
    return core;
  }

  private onEvent(node: HarnessNode, core: FileSyncCore, event: CoreEvent): void {
    if (core !== node.core) return;
    node.events++;
    if (event.event === "log" && event.level !== "info" && node.warnings.length < 200) node.warnings.push(event.message);
  }

  /** CoreDeps.faults: crashes armed by the scheduler, and which paths the engine wrote (oracle c diagnostics). */
  fault(node: HarnessNode, core: FileSyncCore, point: "beforeRename" | "afterRename", target: string): void {
    if (this.dead.has(core)) throw new HarnessCrash(`${point} after the crash`);
    const relative = path.isAbsolute(target) ? path.relative(node.root, target).split(path.sep).join("/") : target;
    node.engineWrites.push({ op: this.ops, path: relative });
    if (core !== node.core) return;
    if (node.crashAt === point) {
      node.crashAt = undefined;
      node.crashed = core;
      this.dead.add(core);
      this.net.failFrom(core);
      this.note(`${node.id} CRASH at ${point} ${relative}`);
      // A dead process runs nothing more: stopped now (synchronously its sync layer, apply and scans), so no catch or
      // finally of the dead core retries, records or removes anything (its small temp stays for the restarted node).
      this.closing.set(core, core.close());
      throw new HarnessCrash(point);
    }
    const race = this.races[point] ?? 0;
    // Nobody edits a conflict copy the moment it arrives; racing those only nests copies until names get too long.
    if (race > 0 && this.random() < race && !relative.startsWith("..") && !relative.includes(".sync-conflict-") && this.canWrite(node, relative)) {
      this.write(node, relative, this.content(node), `racing write (${point})`);
    }
  }

  private async configure(node: HarnessNode, drop = false): Promise<void> {
    const peers = this.peersOf(node);
    // Revoked: the share lists no peer (the cluster still does; they just do not share this folder now).
    const sharing = peers.filter((peer) => !node.unshared?.has(peer));
    await node.core.call("configure", {
      enabled: true, hostId: `host-${node.id}`, records: { engines: [], settings: [] },
      peers: peers.map((nodeId) => ({ nodeId, publicKey: "unused", origins: [], present: true })),
      shares: node.shared ? [{ key: SHARE, projectId: PROJECT_ID, kind: "project", root: node.root, phase: node.phase, rules: node.rules, peers: sharing }] : [],
      ...(drop ? { dropShares: [SHARE] } : {}),
    } as ConfigureArgs);
  }

  // ---- oracles (g), (h) and the racing writers, called from the instrumentation ----

  /** Oracle (g): apply trashes a version only for a target (or a peer row) that supersedes it, holding what its row says, on a current decision. */
  trashing(trash: Trash, relative: string, absolute: string): void {
    const node = this.nodes.find((candidate) => candidate.core.trash === trash);
    // Conflict copies over the cap go oldest first: they are copies, not versions anyone replaced.
    if (!node || this.dead.has(node.core) || conflictCopyOriginal(relative) !== undefined) return;
    this.counters.kept++;
    const db = node.core.db;
    const local = db.entry(SHARE, relative);
    if (!local || local.deleted) return;
    const need = db.needRow(SHARE, relative);
    if (!need) { this.violations.push(`(g) ${node.id} trashed ${relative} (${canonicalVector(local.version)}) although nothing is wanted for it now (a stale decision) at step ${this.stepNo}`); return; }
    const st = lstatQuiet(absolute);
    if (st?.isFile() && local.type === FILE && local.sha256 && this.hashes.hash(absolute, st) !== local.sha256) {
      this.violations.push(`(g) ${node.id} trashed ${relative} holding content its index row does not have (an edit never indexed) at step ${this.stepNo}`);
      return;
    }
    const target = need.target;
    if (compareVectors(target.version, local.version) === "greater") return;
    if (target.deleted && target.type === local.type && (target.sha256 ?? target.target) === (local.sha256 ?? local.target)) return;
    if (this.nodes.some((peer) => { const row = db.remote(SHARE, peer.id, relative); return row !== undefined && compareVectors(row.version, local.version) === "greater"; })) return;
    // A conflict loser goes to the trash instead of a copy only when it would be the oldest copy beyond the cap.
    if (need.conflict && db.childPaths(SHARE, parentKey(relative)).filter((child) => conflictCopyOriginal(child) === relative).length >= CONFLICT_COPY_LIMIT) return;
    this.violations.push(`(g) ${node.id} trashed ${relative} (${canonicalVector(local.version)}) for a target that does not supersede it (${canonicalVector(target.version)}${target.deleted ? " deleted" : ""}): a concurrent version must stay as a conflict copy (step ${this.stepNo})`);
  }

  /** Oracle (h): identical content never conflicts (invariant 3). */
  copying(applier: Applier, shareKey: string, key: string, loser: LocalEntry): void {
    const node = this.nodes.find((candidate) => candidate.core.applier === applier);
    if (!node) return;
    this.counters.copies++;
    const target = node.core.db.needRow(shareKey, key)?.target;
    if (target && sameContent(loser, target)) this.violations.push(`(h) ${node.id} made a conflict copy of ${key} holding the same content as the version that replaces it (step ${this.stepNo})`);
  }

  /** People edit the path while its apply is prepared, and the watcher reports it before the section runs. */
  async perturb(applier: Applier, plan: { path?: string }): Promise<void> {
    const node = this.nodes.find((candidate) => candidate.core.applier === applier);
    if (!node || !plan?.path || this.dead.has(node.core) || this.perturbRate <= 0 || this.random() >= this.perturbRate) return;
    // Now and then the peers stop sharing the folder right here instead: the section must notice its source left (invariant 8).
    if (!this.quiescing && this.random() < 0.1) { await this.toggleRevocation(); return; }
    if (plan.path.includes(".sync-conflict-") || !this.canWrite(node, plan.path)) return;
    this.counters.perturbed++;
    this.write(node, plan.path, this.content(node), "edit while apply prepares");
    await this.scan(node, [spelling(node.root, plan.path)]);
  }

  /** Someone saves another file of the folder that `absolute` was just removed from, in place. */
  innerRaceSibling(absolute: string): void {
    if (this.innerRaces <= 0) return;
    const node = this.nodes.find((candidate) => absolute.startsWith(candidate.root + path.sep));
    if (!node || this.dead.has(node.core)) return;
    let siblings: string[];
    try { siblings = readdirSync(path.dirname(absolute)).filter((name) => !ENGINE_TEMP.test(name) && !name.includes(".sync-conflict-")).sort(); } catch { return; }
    const files = siblings.map((name) => path.join(path.dirname(absolute), name)).filter((file) => lstatQuiet(file)?.isFile());
    // More often than the other races: a folder delete is rare in a seed, and only a sibling still to be removed tests anything.
    if (!files.length || this.random() >= Math.min(1, this.innerRaces * 6)) return;
    this.innerRace(files[Math.floor(this.random() * files.length)], "in the folder being cleared", true);
  }

  /** Someone writes `absolute` inside an apply's synchronous section (see install). */
  innerRace(absolute: string, why: string, chosen = false): void {
    if (this.innerRaces <= 0) return;
    const node = this.nodes.find((candidate) => absolute.startsWith(candidate.root + path.sep));
    if (!node || this.dead.has(node.core) || (!chosen && this.random() >= this.innerRaces)) return;
    const relative = path.relative(node.root, absolute).split(path.sep).join("/");
    if (relative.includes(".sync-conflict-") || ENGINE_TEMP.test(path.basename(relative)) || !this.canWrite(node, relative)) return;
    this.counters.innerRaced++;
    this.write(node, relative, this.content(node), `racing write (${why})`);
  }

  async start(): Promise<void> {
    for (const node of this.nodes) await this.configure(node);
    for (const node of this.nodes) await this.scan(node, "full");
    await this.settle();
    this.snapshotShadows();
  }

  private async closeCore(core: FileSyncCore, why: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS); });
    try {
      const outcome = await Promise.race([(this.closing.get(core) ?? core.close()).then(() => "closed" as const, (error: Error) => error), timeout]);
      if (outcome === "timeout") this.violations.push(`a core did not stop within ${CLOSE_TIMEOUT_MS} ms (${why})`);
      else if (outcome instanceof Error) this.violations.push(`a core failed to stop (${why}): ${outcome.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A crashed core is abandoned (its process is dead) and the node starts again on the same data directory. */
  private async reap(): Promise<void> {
    for (const node of this.nodes) {
      const crashed = node.crashed;
      if (!crashed) continue;
      node.crashed = undefined;
      this.counters.crashes++;
      await this.closeCore(crashed, `${node.id} after a crash`);
      await this.restart(node, "after the crash");
    }
  }

  private async restart(node: HarnessNode, why: string): Promise<void> {
    node.core = this.openCore(node);
    this.note(`${node.id} restart #${node.generation} ${why}`);
    await this.configure(node);
    if (node.shared) await this.scan(node, "full");
  }

  // ---- people's filesystem operations ----

  private stamp(file: string, link = false): void {
    // Mtimes from the fake clock: the same seed writes the same mtimes, which conflict winners and copy names use.
    const seconds = (this.clock.now() + (this.counters.mtimes++ % 1000) / 1000) / 1000;
    if (link) lutimesSync(file, seconds, seconds); else utimesSync(file, seconds, seconds);
  }

  private touched(node: HarnessNode, keys: string[]): void {
    this.ops++;
    for (const key of keys) { node.dirty.add(key); node.touches.push({ op: this.ops, path: key }); }
    if (node.phase !== "builtin") node.snapshot = this.treeText(node);
  }

  /**
   * People are about to destroy these paths' contents on `node`: a content whose last copy goes leaves the ledger.
   * `inPlace` (a write into the existing file) destroys the inode, so a hard link to it elsewhere (a trash entry a
   * crash left linked to the live file) goes with it; an unlink or a rename over it leaves such a link holding it.
   */
  private destroying(node: HarnessNode, keys: string[], why: string, inPlace = false): void {
    const doomed: Array<{ key: string; hash: string; inode: string }> = [];
    for (const key of keys) {
      const st = lstatQuiet(abs(node.root, key));
      if (st?.isFile()) doomed.push({ key, hash: this.hashes.hash(abs(node.root, key), st), inode: `${st.dev}:${st.ino}` });
      else if (st?.isDirectory()) {
        eachFile(abs(node.root, key), (file, below, fileSt) => doomed.push({ key: joinKey(key, below), hash: this.hashes.hash(file, fileSt), inode: `${fileSt.dev}:${fileSt.ino}` }));
      }
    }
    if (!doomed.length) return;
    const where = this.contents();
    const gone = new Set(doomed.map((item) => `${node.id}:${item.key}`));
    const inodes = new Set(inPlace ? doomed.map((item) => item.inode) : []);
    for (const item of doomed) {
      // People destroyed a copy of a racing write themselves: it no longer has to stay live.
      this.ledger.live.delete(item.hash);
      const places = where.get(item.hash) ?? [];
      const last = !places.some((place) => !gone.has(place.place) && !inodes.has(place.inode));
      if (TRACE_HASH && item.hash.startsWith(TRACE_HASH)) this.note(`trace content ${TRACE_HASH}: ${why} ${node.id}:${item.key}; held at ${places.map((place) => place.place).join(", ")}${last ? " (last copy: released)" : ""}`);
      if (last) this.ledger.release(item.hash, `${why} ${node.id}:${item.key} at step ${this.stepNo}`);
    }
  }

  /** Where every content is now: trees (engine temps aside) and trashes. Tree contents are noted as required. */
  private contents(): Map<string, Array<{ place: string; inode: string }>> {
    const where = new Map<string, Array<{ place: string; inode: string }>>();
    const add = (hash: string, place: string, st: Stats) => {
      const entry = { place, inode: `${st.dev}:${st.ino}` };
      const list = where.get(hash);
      if (list) list.push(entry); else where.set(hash, [entry]);
    };
    for (const node of this.nodes) {
      eachFile(node.root, (file, key, st) => {
        if (ENGINE_TEMP.test(path.basename(file))) return;
        const hash = this.hashes.hash(file, st);
        add(hash, `${node.id}:${key}`, st);
        this.ledger.observe(hash, `seen at ${node.id}:${key} at step ${this.stepNo}`);
      });
      eachFile(path.join(node.dataDir, "file-sync", "trash"), (file, key, st) => add(this.hashes.hash(file, st), `${node.id}:trash/${key}`, st));
      // A root that went missing still holds its files where it went (its engine temps hold no version, as in the tree).
      if (node.away) eachFile(node.away, (file, key, st) => { if (!ENGINE_TEMP.test(path.basename(file))) add(this.hashes.hash(file, st), `${node.id}:away/${key}`, st); });
    }
    return where;
  }

  /** On-disk content as placeConflictCopy wants it, for a path the index does not hold yet. */
  diskContent(node: HarnessNode, key: string): Pick<IndexEntry, "type" | "sha256" | "target" | "deleted"> | undefined {
    const st = lstatInTree(node.root, key);
    if (!st) return undefined;
    const file = abs(node.root, key);
    return { type: typeOf(st), sha256: st.isFile() ? this.hashes.hash(file, st) : null, target: st.isSymbolicLink() ? readlinkSync(file) : null, deleted: false };
  }

  private content(node: HarnessNode, large = false): Buffer {
    const roll = this.random();
    if (!large && roll < 0.4) return Buffer.from(POOL[Math.floor(this.random() * POOL.length)]);
    const head = `${node.id} v${++this.counters.contents} seed ${this.seed}\n`;
    const size = large ? MiB + Math.floor(this.random() * MiB / 2) : roll < 0.95 ? Math.floor(this.random() * 2048) : 64 * 1024 + Math.floor(this.random() * 128 * 1024);
    const bytes = Buffer.alloc(head.length + size, head.charCodeAt(head.length - 2 - (this.counters.contents % 3)));
    bytes.write(head, 0, "utf8");
    return bytes;
  }

  /** People write a file; missing parent folders are created (never through a link or a file). */
  write(node: HarnessNode, name: string, content: string | Buffer, why = "write"): void {
    const key = spelling(node.root, name);
    const file = abs(node.root, key);
    let parent = "";
    for (const segment of parentKey(key) ? parentKey(key).split("/") : []) {
      parent = joinKey(parent, segment);
      const st = lstatInTree(node.root, parent);
      if (!st) { mkdirSync(abs(node.root, parent)); this.touched(node, [parent]); } else if (!st.isDirectory()) throw new Error(`${node.id}:${parent} is not a folder`);
    }
    const st = lstatInTree(node.root, key);
    if (st && !st.isFile()) throw new Error(`${node.id}:${key} is not a file`);
    // The same bytes again are a touch, not an edit: no version of its own that must stay live.
    const before = st ? this.hashes.hash(file, st) : undefined;
    // writeFileSync truncates the existing inode: whatever else links to it changes too.
    if (st) this.destroying(node, [key], why, true);
    writeFileSync(file, content);
    this.stamp(file);
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    this.ledger.write(sha256(bytes), `${why} ${node.id}:${key} at step ${this.stepNo}`);
    const place = `${node.id}:${key}`;
    const superseded = this.ledger.livePlaces.get(place);
    if (superseded !== undefined) { this.ledger.live.delete(superseded); this.ledger.livePlaces.delete(place); }
    if (why.startsWith("racing write") && sha256(bytes) !== before) {
      this.ledger.live.set(sha256(bytes), `${why} ${place} at step ${this.stepNo}`);
      this.ledger.livePlaces.set(place, sha256(bytes));
    }
    node.revoked?.add(sha256(bytes));
    this.touched(node, [key]);
    this.note(`${node.id} ${why} ${key} ${bytes.length > 40 ? `<${bytes.length} bytes ${sha256(bytes).slice(0, 8)}>` : JSON.stringify(bytes.toString())}`);
  }

  append(node: HarnessNode, key: string, content: string): void {
    const file = abs(node.root, key);
    this.write(node, key, Buffer.concat([readFileSync(file), Buffer.from(content)]), "append");
  }

  remove(node: HarnessNode, key: string): void {
    this.destroying(node, [key], "delete");
    unlinkSync(abs(node.root, key));
    this.touched(node, [key]);
    this.note(`${node.id} delete ${key}`);
  }

  removeTree(node: HarnessNode, key: string): void {
    this.destroying(node, [key], "rm -r");
    rmSync(abs(node.root, key), { recursive: true, force: true });
    this.touched(node, [key]);
    this.note(`${node.id} rm -r ${key}`);
  }

  mkdir(node: HarnessNode, key: string): void {
    mkdirSync(abs(node.root, key), { recursive: true });
    this.touched(node, [key]);
    this.note(`${node.id} mkdir ${key}`);
  }

  rename(node: HarnessNode, from: string, to: string): void {
    if (lstatQuiet(abs(node.root, to))) this.destroying(node, [to], "rename over");
    renameSync(abs(node.root, from), abs(node.root, to));
    this.touched(node, [from, to]);
    this.note(`${node.id} mv ${from} ${to}`);
  }

  chmod(node: HarnessNode, key: string, mode: number): void {
    chmodSync(abs(node.root, key), mode);
    this.touched(node, [key]);
    this.note(`${node.id} chmod ${mode.toString(8)} ${key}`);
  }

  touch(node: HarnessNode, key: string): void {
    this.stamp(abs(node.root, key));
    this.touched(node, [key]);
    this.note(`${node.id} touch ${key}`);
  }

  symlink(node: HarnessNode, key: string, target: string): void {
    const file = abs(node.root, key);
    if (lstatQuiet(file)) { this.destroying(node, [key], "replace by link"); rmSync(file, { recursive: true, force: true }); }
    peopleLinking++;
    try { symlinkSync(target, file); } finally { peopleLinking--; }
    this.stamp(file, true);
    this.touched(node, [key]);
    this.note(`${node.id} ln -s ${target} ${key}`);
  }

  fileToDir(node: HarnessNode, key: string): void {
    this.destroying(node, [key], "file to folder");
    unlinkSync(abs(node.root, key));
    mkdirSync(abs(node.root, key));
    this.note(`${node.id} file to folder ${key}`);
    this.write(node, `${key}/inner.txt`, this.content(node), "write");
    this.touched(node, [key]);
  }

  dirToFile(node: HarnessNode, key: string): void {
    this.destroying(node, [key], "folder to file");
    rmSync(abs(node.root, key), { recursive: true, force: true });
    this.note(`${node.id} folder to file ${key}`);
    this.write(node, key, this.content(node), "write");
  }

  /** The node's whole tree: files, folders ("" included) and links, engine temps aside. */
  listing(node: HarnessNode): { files: string[]; dirs: string[]; links: string[] } {
    const found = { files: [] as string[], dirs: [""], links: [] as string[] };
    const visit = (key: string) => {
      let names: string[];
      try { names = readdirSync(abs(node.root, key)).sort(); } catch { return; }
      for (const name of names) {
        if (ENGINE_TEMP.test(name)) continue;
        const child = joinKey(key, name);
        const st = lstatQuiet(abs(node.root, child));
        if (!st) continue;
        if (st.isDirectory()) { found.dirs.push(child); visit(child); } else if (st.isSymbolicLink()) found.links.push(child); else found.files.push(child);
      }
    };
    visit("");
    return found;
  }

  /** Whether people could write a file at `key`: it is a file or absent, and no parent is a link or a file. */
  canWrite(node: HarnessNode, name: string): boolean {
    if (node.away) return false;
    const key = spelling(node.root, name);
    let parent = "";
    for (const segment of parentKey(key) ? parentKey(key).split("/") : []) {
      parent = joinKey(parent, segment);
      const st = lstatInTree(node.root, parent);
      if (!st) return true;
      if (!st.isDirectory()) return false;
    }
    const st = lstatInTree(node.root, key);
    return !st || st.isFile();
  }

  private pick<T>(items: readonly T[]): T { return items[Math.floor(this.random() * items.length)]; }
  private int(n: number): number { return Math.floor(this.random() * n); }

  private fileName(): string { return `f${this.int(6)}${this.pick([".txt", ".txt", "", ".md", ".skip"])}`; }

  /** One random operation by people on `node`; the paths it touched, or null when it did not apply. */
  fsOperation(node: HarnessNode): string[] | null {
    if (node.away) return null;
    const tree = this.listing(node);
    const dirs = tree.dirs.filter((dir) => depthOf(dir) < 3);
    const file = () => tree.files.length ? this.pick(tree.files) : undefined;
    const roll = this.random() * 100;
    if (roll < 22 || roll >= 92) {
      const key = spelling(node.root, joinKey(this.pick(dirs), this.fileName()));
      const st = lstatQuiet(abs(node.root, key));
      if (st && !st.isFile()) return null;
      this.write(node, key, this.content(node), st ? "edit" : "create");
      return [key];
    }
    if (roll < 37) { const key = file(); if (!key) return null; this.write(node, key, this.content(node), "edit"); return [key]; }
    if (roll < 42) { const key = file(); if (!key) return null; this.append(node, key, `+${this.int(1000)}\n`); return [key]; }
    if (roll < 50) { const gone = [...tree.files, ...tree.links]; if (!gone.length) return null; const key = this.pick(gone); this.remove(node, key); return [key]; }
    if (roll < 59) {
      const movable = [...tree.files, ...tree.dirs.filter(Boolean), ...tree.links];
      if (!movable.length) return null;
      const from = this.pick(movable);
      const parent = this.pick(dirs);
      const base = from.slice(from.lastIndexOf("/") + 1);
      const to = joinKey(parent, this.random() < 0.5 ? (base.startsWith("m") ? base.slice(1) || "m" : `m${base}`) : base);
      if (to === from || parent === from || isAncestor(from, parent) || lstatQuiet(abs(node.root, to))) return null;
      this.rename(node, from, to);
      return [from, to];
    }
    if (roll < 65) {
      const targets = [...tree.files, ...tree.dirs.filter(Boolean)];
      if (!targets.length) return null;
      const key = this.pick(targets);
      this.chmod(node, key, lstatSync(abs(node.root, key)).isDirectory() ? this.pick(DIR_MODES) : this.pick(FILE_MODES));
      return [key];
    }
    if (roll < 71) { const key = joinKey(this.pick(dirs), `d${this.int(4)}`); if (lstatQuiet(abs(node.root, key))) return null; this.mkdir(node, key); return [key]; }
    if (roll < 74) { const candidates = tree.dirs.filter(Boolean); if (!candidates.length) return null; const key = this.pick(candidates); this.removeTree(node, key); return [key]; }
    if (roll < 77) { const key = file(); if (!key || depthOf(key) > 3) return null; this.fileToDir(node, key); return [key, `${key}/inner.txt`]; }
    if (roll < 79) { const candidates = tree.dirs.filter(Boolean); if (!candidates.length) return null; const key = this.pick(candidates); this.dirToFile(node, key); return [key]; }
    if (roll < 83) {
      const key = joinKey(this.pick(dirs), `l${this.int(3)}`);
      if (lstatQuiet(abs(node.root, key))) return null;
      this.symlink(node, key, this.pick(["f1.txt", "../outside/rel", "d0", "d0/f2.txt", path.join(this.options.dir, "outside", "abs"), "missing/target"]));
      return [key];
    }
    if (roll < 84) { const key = file(); if (!key) return null; this.symlink(node, key, "f0.txt"); return [key]; }
    if (roll < 88) { const key = file(); if (!key) return null; this.touch(node, key); return [key]; }
    if (!this.options.largeFiles) return null;
    const key = spelling(node.root, joinKey(this.pick(dirs), `big${this.int(2)}.bin`));
    const st = lstatQuiet(abs(node.root, key));
    if (st && !st.isFile()) return null;
    this.write(node, key, this.content(node, true), st ? "edit" : "create");
    return [key];
  }

  // ---- engine actions ----

  async scan(node: HarnessNode, scope: "full" | "dirty" | string[] = "dirty"): Promise<void> {
    if (!node.shared || this.dead.has(node.core)) return;
    const paths = scope === "full" ? [] : scope === "dirty" ? [...node.dirty] : scope;
    if (scope !== "full" && !paths.length) return;
    // A full scan sees everything; an event-scoped one what its events named (the rest stays for later).
    if (scope === "full") node.dirty.clear(); else for (const key of paths) node.dirty.delete(key);
    try {
      const result = await node.core.call("scan", { share: SHARE, scope: scope === "full" ? "full" : { paths }, reason: "harness" });
      if (result.error && !/stopped|changed during the scan|moved or replaced|folder is missing/i.test(result.error)) this.note(`${node.id} scan error: ${result.error}`);
    } catch (error) {
      if (!this.dead.has(node.core)) this.note(`${node.id} scan failed: ${(error as Error).message}`);
    }
  }

  async deliverParked(parked: Parked, faults = this.faults): Promise<void> {
    const line = await this.net.deliver(parked, this.random, faults);
    if (line) this.note(`net ${line}`);
  }

  /** Delivers up to `count` parked requests (or held answers), chosen at random, each with its fate. */
  async deliver(count = 1, filter?: (parked: Parked) => boolean, faults = this.faults): Promise<number> {
    let delivered = 0;
    for (; delivered < count; delivered++) {
      const parked = this.net.pending(filter);
      if (!parked.length) break;
      await this.deliverParked(parked[Math.floor(this.random() * parked.length)], faults);
      await this.settle();
    }
    return delivered;
  }

  /** One transfer step on the node (see Driver); true when it did something. */
  async transfer(node: HarnessNode): Promise<boolean> {
    if (this.dead.has(node.core)) return false;
    try {
      if (!await this.driver.step(node)) return false;
      this.note(`${node.id} transfer step`);
      return true;
    } catch (error) {
      if (!(error instanceof HarnessCrash)) throw error;
      return true;
    }
  }

  async advance(ms: number): Promise<void> {
    this.note(`clock +${ms} ms`);
    await this.clock.advance(ms);
  }

  /** The next rename this node's apply makes at `point` throws, and the core is abandoned and reopened. */
  armCrash(node: HarnessNode, point: "beforeRename" | "afterRename" = "beforeRename"): void {
    node.crashAt = point;
    this.note(`${node.id} arm crash ${point}`);
  }

  async wipeIndex(node: HarnessNode): Promise<void> {
    this.counters.wipes++;
    this.note(`${node.id} loses file-sync.db`);
    const core = node.core;
    this.dead.add(core);
    this.net.failFrom(core);
    await this.closeCore(core, `${node.id} index wipe`);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${fileSyncDbPath(node.dataDir)}${suffix}`, { force: true });
    // The node clock went with the index: a new one starts from wall time, which a real restart is always past (counters
    // are microseconds of it). On the frozen fake clock it would issue a counter again, one vector for two contents.
    await this.clock.advance(1);
    await this.restart(node, "with a new index");
  }

  async dropShare(node: HarnessNode): Promise<void> {
    if (!node.shared) return;
    this.counters.drops++;
    node.shared = false;
    this.note(`${node.id} drops the share`);
    await this.configure(node, true);
  }

  async addShare(node: HarnessNode): Promise<void> {
    if (node.shared) return;
    node.shared = true;
    if (node.away) node.awayFresh = true;
    this.note(`${node.id} adds the share again`);
    await this.configure(node);
    await this.scan(node, "full");
  }

  /** Another folder at the root path (new inode) holding a copy of the tree, a few files left behind. */
  replaceRoot(node: HarnessNode): void {
    if (node.away) return;
    this.counters.replaced++;
    node.replaced = node.core.db.share(SHARE)?.indexId ?? "";
    const old = `${node.root}.old-${this.counters.replaced}`;
    const tree = this.listing(node);
    const skipped = tree.files.filter(() => this.random() < 0.1);
    this.destroying(node, skipped, "left behind by a root replacement");
    renameSync(node.root, old);
    mkdirSync(node.root);
    const copy = (key: string): void => {
      for (const name of readdirSync(abs(old, key)).sort()) {
        const child = joinKey(key, name);
        if (skipped.includes(child)) continue;
        const from = abs(old, child);
        const to = abs(node.root, child);
        const st = lstatSync(from);
        if (st.isDirectory()) { mkdirSync(to); copy(child); chmodSync(to, st.mode & 0o777); } else if (st.isSymbolicLink()) {
          peopleLinking++;
          try { symlinkSync(readlinkSync(from), to); } finally { peopleLinking--; }
          lutimesSync(to, st.atime, st.mtime);
        } else {
          writeFileSync(to, readFileSync(from));
          chmodSync(to, st.mode & 0o777);
          utimesSync(to, st.atime, st.mtime);
        }
      }
    };
    copy("");
    chmodSync(node.root, lstatSync(old).mode & 0o777);
    rmSync(old, { recursive: true, force: true });
    this.touched(node, [""]);
    this.note(`${node.id} replaces its root (${skipped.length} files left behind${skipped.length ? `: ${skipped.join(", ")}` : ""})`);
  }

  /** The root goes missing for a while (an unmounted disk, a folder moved away): nothing may be deleted meanwhile. */
  rootAway(node: HarnessNode): void {
    if (node.away) return;
    node.away = `${node.root}.away`;
    node.awayIndexId = node.core.db.share(SHARE)?.indexId;
    node.awayFresh = false;
    renameSync(node.root, node.away);
    this.ops++;
    if (node.phase !== "builtin") node.snapshot = this.treeText(node);
    this.note(`${node.id} root goes missing`);
  }

  rootBack(node: HarnessNode): void {
    if (!node.away) return;
    if (lstatQuiet(node.root)) {
      // Builtin mode creates a root only for a share it never scanned (§5.2.1: a lost index, a share added again).
      const fresh = node.awayFresh === true || node.core.db.share(SHARE)?.indexId !== node.awayIndexId;
      if (!fresh) this.violations.push(`(c) ${node.id}: the engine created its missing root again (step ${this.stepNo}): ${readdirSync(node.root).join(", ")}`);
      this.note(`${node.id} folder the engine created at the missing root goes`);
      this.destroying(node, [""], "replaced by the returning root");
      rmSync(node.root, { recursive: true, force: true });
    }
    renameSync(node.away, node.root);
    node.away = undefined;
    this.touched(node, [""]);
    this.note(`${node.id} root is back`);
  }

  // ---- the scheduler ----

  private someNode(): HarnessNode { return this.pick(this.nodes); }
  private twoNodes(): [HarnessNode, HarnessNode] {
    const first = this.int(this.nodes.length);
    const second = (first + 1 + this.int(this.nodes.length - 1)) % this.nodes.length;
    return [this.nodes[first], this.nodes[second]];
  }

  private async afterOperation(node: HarnessNode, touched: string[] | null): Promise<void> {
    // The watcher's report: mostly soon, sometimes only with a later scan.
    if (touched && this.random() < 0.5) await this.scan(node, touched);
  }

  /** The scheduler's menu (HarnessOptions.weights overrides the weights by name). */
  private readonly actions: Record<ActionName, () => Promise<void>> = {
    fs: async () => { const node = this.someNode(); await this.afterOperation(node, this.fsOperation(node)); },
    concurrentEdit: () => this.concurrentEdit(),
    editVsDelete: () => this.editVersusDelete(),
    caseVariant: () => this.caseVariant(),
    scanSome: async () => {
      const node = this.someNode();
      const dirty = [...node.dirty].filter(() => this.random() < 0.7);
      if (dirty.length) { this.note(`${node.id} scan ${dirty.length} paths`); await this.scan(node, dirty); }
    },
    scanFull: async () => { const node = this.someNode(); this.note(`${node.id} full scan`); await this.scan(node, "full"); },
    deliver: async () => { await this.deliver(1 + this.int(4)); },
    deliverNotices: async () => { await this.deliver(1 + this.int(3), (parked) => parked.purpose === "notice"); },
    deliverPulls: async () => { await this.deliver(1 + this.int(3), (parked) => parked.purpose === "index"); },
    deliverAll: async () => { await this.deliver(this.net.parked.length); },
    transfer: async () => { await this.transfer(this.someNode()); },
    advance: () => this.advance(this.random() < 0.15 ? 30_000 + this.int(300_000) : this.int(3000)),
    catchUp: () => this.catchUp(1 + this.int(5)),
    crash: async () => this.armCrash(this.someNode(), this.random() < 0.75 ? "beforeRename" : "afterRename"),
    wipeIndex: () => this.wipeIndex(this.someNode()),
    dropShare: async () => { const node = this.someNode(); if (node.shared) await this.dropShare(node); else await this.addShare(node); },
    replaceRoot: async () => { const node = this.someNode(); this.replaceRoot(node); await this.afterOperation(node, [""]); },
    rootAway: async () => {
      const node = this.someNode();
      if (node.away) { this.rootBack(node); await this.afterOperation(node, [""]); return; }
      this.rootAway(node);
      // The watcher's view of a vanished root: events for whatever was dirty, or a walk.
      await this.scan(node, this.random() < 0.5 ? "full" : "dirty");
    },
    rules: () => this.changeRules(),
    phase: () => this.changePhase(this.someNode()),
    revoke: () => this.toggleRevocation(),
  };

  /** The Ignore rules tab on one node or on all: a pattern matching what is there now, added or taken away. Newly ignored paths must never become deletes (oracle c). */
  async changeRules(): Promise<void> {
    const pattern = this.pick(["*.md", "d1/", "f1*", "big*.bin"]);
    for (const node of this.random() < 0.5 ? [this.someNode()] : this.nodes) {
      const user = node.rules.userRules ?? [];
      node.rules = { ...node.rules, userRules: user.includes(pattern) ? user.filter((rule) => rule !== pattern) : [...user, pattern] };
      this.counters.ruleChanges++;
      this.note(`${node.id} rules now ${JSON.stringify(node.rules.userRules)}`);
      if (this.dead.has(node.core)) continue;
      await this.configure(node);
      // The rescan under the new rules (the engine walks the share after a rules change; the harness has no watcher).
      await this.scan(node, "full");
    }
  }

  /**
   * A builtin node goes back to Syncthing for a while (§7: restoring finishes the batch in flight, then the tree is
   * Syncthing's and the engine writes nothing there) and returns to builtin. Only nodes that started builtin.
   */
  async changePhase(node: HarnessNode): Promise<void> {
    if ((this.options.phases?.[node.index] ?? "builtin") !== "builtin" || this.dead.has(node.core)) return;
    this.counters.phaseChanges++;
    if (node.phase === "builtin") {
      node.phase = "syncthing";
      this.note(`${node.id} goes back to Syncthing`);
      if (node.shared) await this.configure(node);
      await this.settle();
      node.snapshot = this.treeText(node);
      return;
    }
    node.phase = "builtin";
    node.snapshot = undefined;
    this.note(`${node.id} is on built-in sync again`);
    if (node.shared) { await this.configure(node); await this.scan(node, "full"); }
  }

  /** Two nodes stop sharing the folder with each other, both ways (revocation wins, invariant 8), or every pair shares it again. */
  async toggleRevocation(): Promise<void> {
    const revoked = this.nodes.filter((node) => node.unshared?.size);
    if (revoked.length) {
      this.note(`${revoked.map((node) => node.id).join(" and ")} share the folder again`);
      for (const node of revoked) { node.unshared = undefined; node.revoked = undefined; }
      for (const node of revoked) if (!this.dead.has(node.core)) await this.configure(node);
      return;
    }
    this.counters.revocations++;
    const pair = this.twoNodes();
    this.note(`${pair[0].id} and ${pair[1].id} stop sharing the folder with each other`);
    pair[0].unshared = new Set([pair[1].id]);
    pair[1].unshared = new Set([pair[0].id]);
    // Sharing with nobody now: what it holds (and what people write there from now on) is all its tree may contain.
    for (const node of pair) if (node.unshared!.size === this.peersOf(node).length) node.revoked = this.treeHashes(node);
    for (const node of pair) if (!this.dead.has(node.core)) await this.configure(node);
  }

  /** Oracle (r): an item applied with a peer's bytes needs that peer in the share's peer set at that moment (invariant 8). */
  appliedFrom(applier: Applier, share: { key: string; peers(): readonly string[] }, plan: { input?: { source?: string }; path?: string }): void {
    const node = this.nodes.find((candidate) => candidate.core.applier === applier);
    const source = plan?.input?.source;
    if (!node || source === undefined || share.peers().includes(source)) return;
    this.violations.push(`(r) ${node.id} applied ${plan.path} with bytes from ${source}, which no longer shares the folder (step ${this.stepNo})`);
  }

  /** What the node holds: its tree, and where its root went while it is missing (it comes back with it). */
  private treeHashes(node: HarnessNode): Set<string> {
    const hashes = new Set<string>();
    for (const dir of [node.root, ...(node.away ? [node.away] : [])]) {
      eachFile(dir, (file, _key, st) => { if (!ENGINE_TEMP.test(path.basename(file))) hashes.add(this.hashes.hash(file, st)); });
    }
    return hashes;
  }

  /** Oracle (r): while it shares with nobody, a node's tree holds only what it held or people wrote there. */
  checkRevoked(): void {
    for (const node of this.nodes) {
      if (!node.revoked) continue;
      eachFile(node.root, (file, key, st) => {
        if (ENGINE_TEMP.test(path.basename(file))) return;
        const hash = this.hashes.hash(file, st);
        if (node.revoked!.has(hash)) return;
        node.revoked!.add(hash);
        this.violations.push(`(r) ${node.id} gained ${key} (${hash.slice(0, 12)}) while it shared the folder with nobody (step ${this.stepNo})`);
      });
    }
  }

  /** A while of sync with people idle: changes reach the peers, so the next edits race synced state, not their own. */
  private async catchUp(rounds: number): Promise<void> {
    this.note(`catch up for ${rounds} rounds`);
    for (let round = 0; round < rounds; round++) {
      await this.deliver(this.net.parked.length + 4);
      for (const node of this.nodes) { await this.transfer(node); await this.settle(); }
      await this.reap();
      await this.clock.advance(300 + this.int(700));
      await this.settle();
    }
  }

  private async concurrentEdit(): Promise<void> {
    const [a, b] = this.twoNodes();
    const files = this.listing(a).files.filter((key) => this.canWrite(b, key));
    const key = files.length && this.random() < 0.8 ? this.pick(files) : this.fileName();
    for (const node of [a, b]) {
      if (!this.canWrite(node, key)) continue;
      this.write(node, key, this.content(node), "concurrent edit");
      await this.afterOperation(node, [spelling(node.root, key)]);
    }
  }

  private async editVersusDelete(): Promise<void> {
    const [a, b] = this.twoNodes();
    if (a.away || b.away) return;
    const both = this.listing(a).files.filter((key) => lstatInTree(b.root, key)?.isFile());
    if (!both.length) return;
    const key = this.pick(both);
    this.write(a, key, this.content(a), "edit (vs delete)");
    this.remove(b, key);
    await this.afterOperation(a, [key]);
    await this.afterOperation(b, [key]);
  }

  /** A name on one node, its case variant on another (APFS: a collision; ext4: two files). */
  private async caseVariant(): Promise<void> {
    const [a, b] = this.twoNodes();
    if (a.away || b.away) return;
    const files = this.listing(a).files;
    if (!files.length) return;
    const key = this.pick(files);
    const base = key.slice(key.lastIndexOf("/") + 1);
    const first = base.slice(0, 1);
    const variant = joinKey(parentKey(key), (first.toUpperCase() === first ? first.toLowerCase() : first.toUpperCase()) + base.slice(1));
    if (variant === key || !realDirectory(b.root, parentKey(key)) || readdirSync(abs(b.root, parentKey(key))).some((name) => caseFoldKey(name) === caseFoldKey(base))) return;
    this.write(b, variant, this.content(b), "case variant");
    await this.afterOperation(b, [variant]);
  }

  /** One action chosen by the PRNG, then the engines run until they wait on the network again. */
  async randomStep(): Promise<void> {
    this.stepNo++;
    const weights = Object.entries({ ...ACTION_WEIGHTS, ...this.options.weights }) as Array<[ActionName, number]>;
    let roll = this.random() * weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [name, weight] of weights) {
      roll -= weight;
      if (roll >= 0 || weight <= 0) continue;
      await this.actions[name]();
      break;
    }
    await this.settle();
    await this.reap();
    this.checkShadows();
    this.checkRevoked();
  }

  async run(steps: number): Promise<void> {
    for (let step = 0; step < steps; step++) await this.randomStep();
  }

  // ---- settling and quiescence ----

  pageDelivered(nodeId: string): void {
    const node = this.nodeById(nodeId);
    if (!node) return;
    if (!node.pages) node.pagesSince = Date.now();
    node.pages++;
  }

  trace(db: FileSyncDb, what: string, entry: IndexEntry): void {
    const node = this.nodes.find((candidate) => candidate.core.db === db);
    if (!node) return;
    const content = entry.deleted ? "deleted" : entry.type === FILE ? `file ${entry.sha256?.slice(0, 8)}` : entry.type === SYMLINK ? `link ${entry.target}` : "dir";
    this.note(`trace ${node.id} ${what} ${entry.path} ${content} ${entry.mode.toString(8)} ${canonicalVector(entry.version)} by ${entry.modifiedBy} seq ${entry.seq}`);
  }

  pageDecoded(db: FileSyncDb): void {
    for (const node of this.nodes) if (node.core.db === db && node.pages > 0) node.pages--;
  }

  /** Whether a scan runs or is queued in the core (its own re-checks start scans too). */
  private scanning(node: HarnessNode): boolean {
    const shares = (node.core as unknown as { shares?: Map<string, { scanner: ShareScanner; draining?: unknown }> }).shares;
    return [...shares?.values() ?? []].some((runtime) => runtime.scanner.running || Boolean(runtime.draining));
  }

  private signature(): string {
    let text = `${this.net.parked.length}:${this.net.stats.served}:${writeCount}`;
    for (const node of this.nodes) text += `|${node.events}:${node.core.need.busy ? 1 : 0}:${this.scanning(node) ? 1 : 0}`;
    return text;
  }

  /** Work in flight that no turn of the event loop shows: file system calls, and pages still being decoded. */
  private waitingOnIo(): boolean {
    for (const node of this.nodes) {
      // A page whose pull went away without storing it (its core stopped) is not waited for long.
      if (node.pages > 0 && Date.now() - node.pagesSince > 500) node.pages = 0;
      if (node.pages > 0) return true;
    }
    return process.getActiveResourcesInfo().some((name) => name.startsWith("FSReq") || name === "CloseReq");
  }

  /** Lets the engines run until nothing moves: every core is idle or waits on the parked network. */
  async settle(): Promise<void> {
    let last = "";
    let stable = 0;
    for (let turn = 0; turn < SETTLE_TICKS; turn++) {
      await tick();
      const waiting = this.waitingOnIo();
      const signature = this.signature();
      if (signature === last && !waiting) {
        if (++stable >= 3) return;
      } else {
        stable = 0;
        last = signature;
      }
      if (waiting && turn % 32 === 31) await sleep(0);
    }
  }

  private inflight(node: HarnessNode): number {
    return (node.core.sync as unknown as { inflight?: Set<unknown> } | undefined)?.inflight?.size ?? 0;
  }

  /** Nothing parked, nothing running, nothing dirty, nothing left to transfer. */
  private idle(): boolean {
    if (this.net.parked.length) return false;
    for (const node of this.nodes) {
      if (node.crashed || node.dirty.size || this.inflight(node) || node.core.need.busy || this.scanning(node)) return false;
      if (this.driver.pending(node) > 0) return false;
    }
    return true;
  }

  private describeBusy(): string {
    const parts = [`parked ${this.net.parked.length} (${this.net.pending().slice(0, 8).map((parked) => `${parked.state === "response" ? "answer " : ""}${parked.from}>${parked.to} ${parked.endpoint}`).join(", ")})`, `timers ${this.clock.pending}`];
    for (const node of this.nodes) {
      const pending = this.driver.describe?.(node) ?? needRows(node.core).filter((row) => !row.blocked).map((row) => row.path);
      parts.push(`${node.id}: dirty ${node.dirty.size}, inflight ${this.inflight(node)}, need busy ${node.core.need.busy}, pending ${this.driver.pending(node)}${pending.length ? ` [${pending.slice(0, 5).join("; ")}]` : ""}, blocked ${this.driver.blocked(node).length}`);
    }
    return parts.join("; ");
  }

  /**
   * People stop; scans, deliveries, transfers and timers run until nothing is left (faults keep happening for the
   * first quarter of the rounds, then the network behaves). Returns the rounds it took; throws when it never ends.
   */
  async quiesce(maxRounds = 400, faultyRounds = 10): Promise<number> {
    this.stepNo++;
    this.note("quiesce");
    this.quiescing = true;
    // An armed crash stays armed: crashing while the engines catch up is as good a test as any.
    await this.reap();
    if (this.nodes.some((node) => node.unshared?.size)) await this.toggleRevocation();
    for (const node of this.nodes) {
      this.rootBack(node);
      if (node.phase !== (this.options.phases?.[node.index] ?? "builtin")) await this.changePhase(node);
      if (node.rules !== this.rules) {
        node.rules = this.rules;
        this.note(`${node.id} rules back to ${JSON.stringify(this.rules.userRules ?? [])}`);
        if (!this.dead.has(node.core)) await this.configure(node);
      }
      if (!node.shared) await this.addShare(node);
    }
    await this.settle();
    await this.reap();
    for (const node of this.nodes) await this.scan(node, "full");
    const faults = this.faults;
    try {
      for (let round = 0; round < maxRounds; round++) {
        this.faults = round < faultyRounds ? faults : NO_FAULTS;
        let progressed = await this.deliver(this.net.parked.length + 8) > 0;
        for (const node of this.nodes.map((node) => ({ node, order: this.random() })).sort((a, b) => a.order - b.order).map((entry) => entry.node)) {
          if (await this.transfer(node)) progressed = true;
          await this.settle();
        }
        await this.reap();
        for (const node of this.nodes) {
          if (!node.dirty.size) continue;
          progressed = true;
          await this.scan(node, "dirty");
        }
        await this.settle();
        this.checkShadows();
        const idle = this.idle();
        if (idle && !this.clock.pending) return round;
        // Coalescing windows, retries and settle checks are one-shot timers: when nothing else moves, the next one is due.
        if ((idle || !progressed) && this.clock.pending) {
          this.clock.fireNext();
          await this.settle();
        }
      }
    } finally {
      this.faults = faults;
    }
    throw new Error(`The engines did not quiesce within ${maxRounds} rounds: ${this.describeBusy()}`);
  }

  // ---- oracles ----

  scanStarted(scanner: ShareScanner): void {
    if (this.nodes.some((node) => scanner.context.root === node.root)) this.scanStarts.set(scanner, this.ops);
  }

  /** Oracle (c): a tombstone the scanner commits must name a path that is not on disk (exact spelling). */
  tombstoneWritten(db: FileSyncDb, scanner: ShareScanner, entry: LocalEntry): void {
    const node = this.nodes.find((candidate) => candidate.core.db === db && scanner.context.root === candidate.root);
    if (!node) return;
    // Invariant 1: a missing root, or another folder in its place, says nothing about the files.
    // (A share indexed afresh meanwhile may have created the root again, §5.2.1: that folder's rows are its own.)
    if (node.away && db.share(SHARE)?.indexId === node.awayIndexId) {
      this.violations.push(`(c) ${node.id} wrote a tombstone for ${entry.path} while its root was missing (step ${this.stepNo})`);
      return;
    }
    if (node.replaced !== undefined && db.share(SHARE)?.indexId === node.replaced) {
      this.violations.push(`(c) ${node.id} wrote a tombstone for ${entry.path} from the rows of the folder its root replaced (step ${this.stepNo})`);
      return;
    }
    const key = entry.fsName ?? entry.path;
    const st = lstatInTree(node.root, key);
    if (!st) return;
    const since = this.scanStarts.get(scanner) ?? 0;
    // People changed the path while the scan ran: it saw it gone, and it is back. Not the scanner's fault.
    if (node.touches.some((touch) => touch.op > since && related(touch.path, key))) { this.counters.raced++; return; }
    const engine = node.engineWrites.some((write) => write.op >= since && related(write.path, key));
    this.violations.push(`(c) ${node.id} wrote a tombstone for ${entry.path}, which exists on disk as a ${["file", "folder", "link"][typeOf(st)]} (step ${this.stepNo}${engine ? "; the engine wrote this path while the scan ran" : ""})`);
  }

  private treeText(node: HarnessNode): string {
    const lines: string[] = [];
    const visit = (key: string) => {
      let names: string[];
      try { names = readdirSync(abs(node.root, key)).sort(); } catch { return; }
      for (const name of names) {
        const child = joinKey(key, name);
        const file = abs(node.root, child);
        const st = lstatQuiet(file);
        if (!st) continue;
        lines.push(`${child} ${typeOf(st)} ${(st.mode & 0o777).toString(8)} ${st.isFile() ? this.hashes.hash(file, st) : st.isSymbolicLink() ? readlinkSync(file) : ""}`);
        if (st.isDirectory()) visit(child);
      }
    };
    visit("");
    return lines.join("\n");
  }

  private snapshotShadows(): void {
    for (const node of this.nodes) if (node.phase !== "builtin") node.snapshot = this.treeText(node);
  }

  /** Invariants 7 and 12: the engine writes into a tree only when its phase is builtin. */
  checkShadows(): void {
    for (const node of this.nodes) {
      if (node.phase === "builtin" || node.snapshot === undefined) continue;
      const now = this.treeText(node);
      if (now === node.snapshot) continue;
      const before = new Set(node.snapshot.split("\n"));
      const after = new Set(now.split("\n"));
      const changed = [...[...after].filter((line) => !before.has(line)).map((line) => `+${line}`), ...[...before].filter((line) => !after.has(line)).map((line) => `-${line}`)];
      this.violations.push(`(f) the engine wrote into ${node.id}'s tree in phase ${node.phase} at step ${this.stepNo}: ${changed.slice(0, 5).join(", ")}`);
      node.snapshot = now;
    }
  }

  /** The scanner's rule: in builtin mode a deleted folder holding only ignored content stays deleted. */
  private resurrects(node: HarnessNode, key: string): boolean {
    let names: string[];
    try { names = readdirSync(abs(node.root, key)); } catch { return true; }
    if (!names.length) return true;
    for (const name of names) {
      const child = joinKey(key, name.normalize("NFC"));
      const st = lstatQuiet(abs(node.root, child));
      if (!st || this.ignored(child, st.isDirectory())) continue;
      if (!st.isDirectory()) return true;
      const row = node.core.db.entry(SHARE, child);
      if (!(row && row.deleted && row.type === DIRECTORY) || this.resurrects(node, child)) return true;
    }
    return false;
  }

  /** Synced paths as the node's engine sees them on disk. */
  syncedTree(node: HarnessNode): Map<string, TreeItem> {
    const items = new Map<string, TreeItem>();
    const visit = (key: string) => {
      let names: string[];
      try { names = readdirSync(abs(node.root, key)).sort(); } catch { return; }
      for (const name of names) {
        const child = joinKey(key, name.normalize("NFC"));
        const file = abs(node.root, joinKey(key, name));
        const st = lstatQuiet(file);
        if (!st || this.ignored(child, st.isDirectory())) continue;
        if (st.isDirectory()) {
          const row = node.core.db.entry(SHARE, child);
          if (node.phase === "builtin" && row?.deleted && row.type === DIRECTORY && !this.resurrects(node, child)) continue;
          items.set(child, { type: DIRECTORY, mode: st.mode & 0o777, hash: null, target: null });
          visit(joinKey(key, name));
        } else if (st.isSymbolicLink()) items.set(child, { type: SYMLINK, mode: 0, hash: null, target: readlinkSync(file) });
        else if (st.isFile()) items.set(child, { type: FILE, mode: st.mode & 0o777, hash: this.hashes.hash(file, st), target: null });
      }
    };
    visit("");
    return items;
  }

  /** Which modelled situation explains a blocked item, from what is on disk now; undefined when none does. */
  private explain(item: BlockedItem, trees: Map<string, Map<string, TreeItem>>): string | undefined {
    const node = this.nodeById(item.node)!;
    const ancestors: string[] = [];
    for (let above = parentKey(item.path); above; above = parentKey(above)) ancestors.push(above);
    if (DARWIN) {
      const fold = caseFoldKey(item.path);
      for (const tree of trees.values()) {
        for (const key of tree.keys()) {
          if (key !== item.path && caseFoldKey(key) === fold) return "case collision";
          for (const above of ancestors) if (key !== above && caseFoldKey(key) === caseFoldKey(above)) return "case-variant parent";
        }
      }
    }
    for (const above of ancestors) {
      const st = lstatInTree(node.root, above);
      if (st?.isSymbolicLink()) return "link where a peer has a folder";
      if (st && !st.isDirectory()) return "file where a peer has a folder";
    }
    const st = lstatInTree(node.root, item.path);
    if (st?.isDirectory() && readdirSync(abs(node.root, item.path)).length) return "folder in the way";
    // Its local-only files were removed since: removing an ignored file changes no row, so it waits for "Rescan files".
    if (st?.isDirectory() && /local-only/.test(item.reason)) return "folder kept for local-only files until a rescan";
    return undefined;
  }

  /** Every oracle at once; call after quiesce(). */
  async check(): Promise<CheckResult> {
    this.checkShadows();
    const problems = [...this.violations];
    const builtin = this.nodes.filter((node) => node.phase === "builtin");
    // The index is the tree: a last full scan finds nothing to write.
    for (const node of builtin) {
      const before = node.core.db.share(SHARE)?.maxSeq ?? 0;
      const result = await node.core.call("scan", { share: SHARE, scope: "full", reason: "harness check" });
      if (result.error) problems.push(`(index) ${node.id}: the final scan failed: ${result.error}`);
      else if (result.changed) {
        const changed = node.core.db.entriesSince(SHARE, before, 10).map((entry) => `${entry.path}${entry.deleted ? " (deleted)" : ""}`);
        problems.push(`(index) ${node.id}: a final full scan changed ${result.changed} rows (${changed.join(", ")}): the index did not match the tree`);
      }
    }
    await this.settle();
    const trees = new Map(builtin.map((node) => [node.id, this.syncedTree(node)]));
    // Blocked items: listed, and each explained by the model.
    const blocked = builtin.flatMap((node) => this.driver.blocked(node));
    for (const item of blocked) {
      item.model = this.explain(item, trees);
      if (!item.model) problems.push(`(a) ${item.node}: ${item.path} is blocked (${item.reason}) and nothing on disk explains it`);
    }
    const covered = (key: string) => blocked.some((item) => related(item.path, key));
    // (a) identical synced trees.
    const union = new Set([...trees.values()].flatMap((tree) => [...tree.keys()]));
    for (const key of [...union].sort()) {
      const seen = builtin.map((node) => trees.get(node.id)!.get(key));
      const text = seen.map((item) => item ? `${["file", "dir", "link"][item.type]} ${item.mode.toString(8)} ${item.hash?.slice(0, 8) ?? item.target ?? ""}` : "absent");
      if (new Set(text).size === 1 || covered(key)) continue;
      problems.push(`(a) ${key} differs: ${builtin.map((node, index) => `${node.id} ${text[index]}`).join(" | ")}`);
    }
    // (b) every version is somewhere.
    const where = this.contents();
    for (const [hash, note] of this.ledger.required) {
      if (!where.has(hash)) problems.push(`(b) content ${hash.slice(0, 12)} is gone from every tree and trash (first ${note})`);
    }
    for (const [hash, note] of this.ledger.live) {
      const places = where.get(hash) ?? [];
      if (places.length && places.every((place) => place.place.includes(":trash/"))) problems.push(`(b) content ${hash.slice(0, 12)} written while apply placed a version is left only in a trash (${note}): a concurrent local edit must stay live`);
    }
    // (d) one version per path, equal digests.
    const rows = builtin.map((node) => new Map(node.core.db.entries(SHARE).map((entry) => [entry.path, entry])));
    for (const key of [...new Set(rows.flatMap((map) => [...map.keys()]))].sort()) {
      if (covered(key)) continue;
      const present = rows.map((map) => map.get(key)).filter((entry): entry is LocalEntry => entry !== undefined);
      const vectors = new Set(present.map((entry) => canonicalVector(entry.version)));
      if (vectors.size > 1) problems.push(`(d) ${key} has ${vectors.size} versions: ${builtin.map((node, index) => `${node.id} ${rows[index].get(key) ? `${canonicalVector(rows[index].get(key)!.version)}${rows[index].get(key)!.deleted ? " deleted" : ""}` : "none"}`).join(" | ")}`);
      // One version must mean one content: nothing ever moves a path whose vectors are equal, so a split here is for good.
      const contents = new Set(present.map((entry) => entry.deleted ? "deleted" : `${entry.type} ${entry.sha256 ?? entry.target ?? ""} ${entry.type === SYMLINK ? 0 : entry.mode}`));
      if (vectors.size === 1 && contents.size > 1) problems.push(`(d) ${key}: one version ${[...vectors][0]} holds different content or mode: ${builtin.map((node, index) => `${node.id} ${rows[index].get(key) ? `${rows[index].get(key)!.mode.toString(8)} ${rows[index].get(key)!.sha256?.slice(0, 8) ?? ""}` : "none"}`).join(" | ")}`);
    }
    if (!blocked.length) {
      const digests = new Set(builtin.map((node) => node.core.db.share(SHARE)?.digest));
      if (digests.size > 1) problems.push(`(d) digests differ: ${builtin.map((node) => `${node.id} ${node.core.db.share(SHARE)?.digest.slice(0, 12)}`).join(" | ")}`);
    }
    // Invariant 6: nothing was written through a link to outside the trees.
    const outside = path.join(this.options.dir, "outside");
    if (existsSync(outside) && readdirSync(outside).length) problems.push(`(e) something was written outside the trees: ${readdirSync(outside).join(", ")}`);
    const expected = new Set([...this.nodes.flatMap((node) => [path.basename(node.root), path.basename(node.dataDir)]), "outside"]);
    for (const name of readdirSync(this.options.dir)) if (!expected.has(name)) problems.push(`(e) unexpected ${name} next to the trees`);
    // A share in error (held deletes, a replaced-root confirmation, a digest mismatch) did not converge either.
    for (const node of builtin) {
      const status = (await node.core.call("status", { shares: [SHARE] }))[0] as ShareStatus | undefined;
      if (status?.state === "error") problems.push(`${node.id}: share state error: ${status.message ?? ""}`);
      const compare = node.warnings.filter((message) => /could not compare/.test(message));
      if (compare.length) problems.push(`${node.id}: ${compare[0]}`);
    }
    const stats: Record<string, number | string> = {
      engine: this.engine, steps: this.stepNo, required: this.ledger.required.size, released: this.ledger.released.size, blocked: blocked.length,
      ...this.counters, ...Object.fromEntries(Object.entries(this.net.stats).map(([key, value]) => [`net.${key}`, value])),
    };
    return { problems, blocked, stats };
  }

  // ---- reading and preparing trees (drivers) ----

  /** The target's bytes from a source peer's tree (any peer whose row has that content), hash-verified. */
  readSource(node: HarnessNode, key: string, target: IndexEntry, sources?: string[]): { peer: string; bytes: Buffer } | undefined {
    const candidates = sources ?? this.peersOf(node).filter((peer) => sameContent(node.core.db.remote(SHARE, peer, key), target));
    for (const peer of [...candidates].sort()) {
      const source = this.nodeById(peer);
      if (!source) continue;
      const st = lstatInTree(source.root, key);
      if (!st?.isFile()) continue;
      const bytes = readFileSync(abs(source.root, key));
      if (sha256(bytes) === target.sha256) return { peer, bytes };
    }
    return undefined;
  }

  /**
   * §5.5.3 for the drivers: every existing parent a real folder spelled exactly, missing ones created (when
   * `create`). `missing` says a parent is absent and nothing was created.
   */
  prepareParents(node: HarnessNode, dirKey: string, create: boolean): { created: string[]; reason?: string; missing?: boolean } {
    const created: string[] = [];
    let current = node.root;
    let key = "";
    for (const segment of dirKey ? dirKey.split("/") : []) {
      key = joinKey(key, segment);
      const next = path.join(current, segment);
      const st = lstatQuiet(next);
      if (!st) {
        if (!create) return { created, reason: "A parent folder is missing", missing: true };
        mkdirSync(next);
        created.push(key);
      } else if (st.isSymbolicLink()) return { created, reason: "A parent folder is a symbolic link here" };
      else if (!st.isDirectory()) return { created, reason: "A parent folder is a file here" };
      else if (DARWIN && !readdirSync(current).some((name) => name.normalize("NFC") === segment)) return { created, reason: "A parent folder differs only in case here" };
      current = next;
    }
    return { created };
  }

  /** The directory a temp for `dirKey` goes in, or undefined when a parent is not a real folder. */
  parentsFor(node: HarnessNode, dirKey: string): string | undefined {
    const prepared = this.prepareParents(node, dirKey, true);
    if (prepared.reason) return undefined;
    for (const key of prepared.created) node.dirty.add(key);
    return abs(node.root, dirKey);
  }

  // ---- reporting and teardown ----

  failureReport(problems: string[], logFile?: string): string {
    const lines = [
      `seed ${this.seed} (${this.nodes.length} nodes, engine ${this.engine}) failed:`,
      ...problems.slice(0, 40).map((problem) => `  - ${problem}`),
      ...(problems.length > 40 ? [`  ... ${problems.length - 40} more`] : []),
      `replay: FILE_SYNC_SEED=${this.seed} FILE_SYNC_NODES=${this.nodes.length}${["FILE_SYNC_ENGINE", "FILE_SYNC_RACES", "FILE_SYNC_RACES_INNER", "FILE_SYNC_PERTURB"].map((name) => process.env[name] ? ` ${name}=${process.env[name]}` : "").join("")} npm run test:file -- test/file-sync-convergence.test.ts`,
      `operation log (${this.log.length} lines${logFile ? `, all of it in ${logFile}` : ""}; last 60):`,
      ...this.log.slice(-60),
    ];
    return lines.join("\n");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.net.failAll();
    for (const node of this.nodes) {
      if (node.crashed && node.crashed !== node.core) await this.closeCore(node.crashed, `${node.id} at close`);
      await this.closeCore(node.core, `${node.id} at close`);
    }
    harnesses.delete(this);
  }
}

// ---------------------------------------------------------------- one seed

export interface SeedOptions extends Omit<HarnessOptions, "dir"> {
  /** Random steps before quiescence (default 25–60, from the seed). */
  steps?: number;
}

export interface SeedResult {
  seed: number;
  problems: string[];
  blocked: BlockedItem[];
  stats: Record<string, number | string>;
  report?: string;
  /** The operation log (the seed replays it). */
  log: string[];
  ms: number;
}

/** Runs one seed end to end in its own temp directory (removed afterwards); a failure carries its report and log file. */
export async function runSeed(options: SeedOptions): Promise<SeedResult> {
  const started = Date.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), `jb-fs-harness-${options.seed}-`));
  let harness: Harness | undefined;
  let problems: string[] = [];
  let result: CheckResult | undefined;
  try {
    harness = await Harness.create({
      ...options, dir,
      races: options.races ?? { beforeRename: SEED_DEFAULTS.races, afterRename: SEED_DEFAULTS.races },
      innerRaces: options.innerRaces ?? SEED_DEFAULTS.innerRaces,
      perturb: options.perturb ?? SEED_DEFAULTS.perturb,
    });
    await harness.run(options.steps ?? 25 + Math.floor(prng(mixSeed(options.seed, "steps"))() * 36));
    await harness.quiesce();
    result = await harness.check();
    problems = result.problems;
  } catch (error) {
    problems = [...harness?.violations ?? [], `${(error as Error).stack ?? error}`];
  } finally {
    await harness?.close().catch((error: Error) => problems.push(`close failed: ${error.message}`));
    // A core that would not stop at the end is a finding too.
    for (const violation of harness?.violations ?? []) if (!problems.includes(violation)) problems.push(violation);
    rmSync(dir, { recursive: true, force: true });
  }
  let report: string | undefined;
  if (problems.length && harness) {
    const logFile = path.join(os.tmpdir(), `file-sync-seed-${options.seed}-n${harness.nodes.length}-${process.pid}.log`);
    try { writeFileSync(logFile, `${harness.log.join("\n")}\n`); } catch { /* the report still has the tail */ }
    report = harness.failureReport(problems, logFile);
  }
  return {
    seed: options.seed, problems, blocked: result?.blocked ?? [], stats: result?.stats ?? {}, ...(report ? { report } : {}), log: harness?.log ?? [],
    ms: Date.now() - started,
  };
}
