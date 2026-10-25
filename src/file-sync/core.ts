import path from "node:path";
import { performance } from "node:perf_hooks";
import { FileSyncDb, fileSyncDbPath } from "./db.js";
import { compileRules, effectiveRules } from "./ignore.js";
import { normalizeRelativePath } from "./paths.js";
import {
  opSchemas, type ConfigureArgs, type CoreEvent, type ErrorItem, type FilesEndpoint, type OpArgs, type OpName, type OpResults, type PeerShareStatus,
  type ScanResult, type ServeAnswer, type ShareSpec, type ShareStatus,
} from "./protocol.js";
import { ShareScanner, SliceScheduler, Slicer, type EventScope, type InternalScope, type ScannerOptions, type ShareContext } from "./scanner.js";
import { statfsDisk, Trash } from "./trash.js";
import { shareKey, type Clock, type ShareState } from "./types.js";
import { BurstMonitor, inotifyBurstLimit, ShareWatcher, SuppressionRegistry, watchMode, type WatchTuning } from "./watch.js";

/* The worker's data plane as one object built from injected dependencies (FILE-SYNC design §5.1), so
   tests run it in-thread with a fake clock and explicit scans, and worker.ts only adapts messages.
   P1 is the local engine: configure, scans, the watcher, the guard and status. The network ops answer
   that they are not available yet; their seams (transport, FilesService, faults, diskFree) are here. */

export interface PeerRequest {
  method: "GET" | "POST";
  target: string;
  json?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  purpose: "notice" | "index" | "transfer" | "status" | "shares";
}
export interface PeerResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }
export interface PeerTransport { request(peer: string, request: PeerRequest): Promise<PeerResponse> }

/** Server logic of /api/cluster/v2/files/* (service.ts, P2+). */
export interface FilesService {
  serve(peer: string, endpoint: FilesEndpoint, query: Record<string, string>, body: unknown, range?: string): Promise<ServeAnswer>;
}

export interface CoreDeps {
  nodeId: string;
  dataDir: string;
  clock: Clock;
  random: () => number;
  /** false in randomized tests: no watchers, scans only when asked. */
  watch: boolean;
  transport?: PeerTransport;
  emit(event: CoreEvent): void;
  faults?: { beforeRename?(path: string): void; afterRename?(path: string): void; midStream?(path: string, bytes: number): void };
  diskFree?(dir: string): number;
  /** Tests: scanner thresholds, watcher timings, watch mode and the inotify burst limit. */
  scanner?: Partial<ScannerOptions>;
  watcher?: Partial<WatchTuning>;
  watchMode?: "recursive" | "directories";
  burstLimit?: number | null;
}

export interface WorkerCore {
  call<K extends OpName>(op: K, args: OpArgs[K]): Promise<OpResults[K]>;
  service: FilesService;
  close(): Promise<void>;
}

export class UnavailableOpError extends Error {
  readonly code = "unavailable";
  constructor(op: string) { super(`File sync cannot ${op} yet: this phase of the engine has no network part`); }
}

const FULL_SCAN_MAX_AGE_MS = 60 * 60_000;
/** Full walks at once: at start every share needs one, and dozens together only compete for the disk and the heap. */
const WALK_SLOTS = 2;
const STATE_EMIT_MS = 1000;
const NETWORK_OPS = new Set<OpName>(["prioritize", "peerPresence", "announce", "notice", "serve", "differences", "bootstrap", "repair"]);
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

interface Pending { paths: Set<string>; shallow: Set<string>; full: boolean; reason: string }

/** A counting semaphore; the release it hands out works once. */
class Slots {
  private readonly waiting: Array<() => void> = [];
  constructor(private free: number) {}

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next(); else this.free++;
    };
  }
}

interface ShareRuntime {
  key: string;
  spec: ShareSpec;
  scanner: ShareScanner;
  watcher?: ShareWatcher;
  slicer: Slicer;
  pending?: Pending;
  draining?: Promise<void>;
  rechecks: Map<string, { cancel(): void }>;
  subtreeScans: Map<string, number>;
  lastEmit: number;
  closed: boolean;
}

class Core implements WorkerCore {
  readonly db: FileSyncDb;
  readonly trash: Trash;
  readonly suppression: SuppressionRegistry;
  private readonly burst: BurstMonitor;
  /** One slice budget for every share's scans, so an RPC waits one slice, not one per scanning share. */
  private readonly slices = new SliceScheduler(() => this.sliceBudget());
  private readonly walkSlots = new Slots(WALK_SLOTS);
  private readonly shares = new Map<string, ShareRuntime>();
  private config: ConfigureArgs | undefined;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private readySent = false;
  private stopped = false;
  private closed = false;

  readonly service: FilesService = {
    serve: async () => { throw new UnavailableOpError("serve peers"); },
  };

  constructor(private readonly deps: CoreDeps) {
    this.db = new FileSyncDb(fileSyncDbPath(deps.dataDir), deps.nodeId);
    this.suppression = new SuppressionRegistry(deps.clock);
    this.burst = new BurstMonitor(deps.burstLimit !== undefined ? deps.burstLimit : inotifyBurstLimit(), deps.clock);
    const diskFree = deps.diskFree;
    this.trash = new Trash({ dataDir: deps.dataDir, clock: deps.clock, ...(diskFree ? { disk: (dir: string) => ({ freeBytes: diskFree(dir), totalBytes: statfsDisk(dir).totalBytes }) } : {}) });
    try { this.trash.prune(); } catch (error) { this.emit({ event: "log", level: "warn", key: "fileSync:trash", message: `File sync could not prune its trash: ${(error as Error).message}` }); }
  }

  private emit(event: CoreEvent): void {
    if (this.closed) return;
    try { this.deps.emit(event); } catch { /* a listener's failure is not the engine's */ }
  }

  private newIndexId(): string {
    let id = "";
    for (let index = 0; index < 22; index++) id += ID_ALPHABET[Math.floor(this.deps.random() * 64) & 63];
    return id;
  }

  private sliceBudget(): number {
    // Requests arriving recently probably have company in the queue: shorter slices answer them sooner.
    return performance.now() - this.lastCallAt < 1000 ? 10 : 50;
  }

  async call<K extends OpName>(op: K, args: OpArgs[K]): Promise<OpResults[K]> {
    if (this.stopped && op !== "stop") throw new Error("File sync worker is stopped");
    const schema = opSchemas[op];
    if (!schema) throw new Error(`Unknown file sync op: ${String(op)}`);
    const parsed = (schema as { parse(value: unknown): unknown }).parse(args);
    this.lastCallAt = performance.now();
    return await this.dispatch(op, parsed) as OpResults[K];
  }

  // `args` was parsed with the op's schema in call().
  private async dispatch(op: OpName, args: any): Promise<unknown> {
    if (NETWORK_OPS.has(op)) throw new UnavailableOpError(op);
    switch (op) {
      case "configure": return this.configure(args as ConfigureArgs);
      case "scan": return this.scan(args.share, args.scope, args.reason);
      case "flush": return this.flush(args.share, args.subtree);
      case "expectDeletes": this.runtime(args.share).scanner.expectDeletes(args.prefix, args.ttlMs); return {};
      case "status": return this.status(args.shares);
      case "errors": return this.errors(args.share, args.offset, args.limit);
      case "releaseHeld": return this.afterScan(this.runtime(args.share), await this.runtime(args.share).scanner.releaseHeld());
      case "confirmReplacedRoot": return this.afterScan(this.runtime(args.share), await this.runtime(args.share).scanner.confirmReplacedRoot());
      case "stop": await this.stop(); return {};
      default: throw new UnavailableOpError(op);
    }
  }

  private runtime(key: string): ShareRuntime {
    const runtime = this.shares.get(key);
    if (!runtime) throw new Error(`File sync share not found: ${key}`);
    return runtime;
  }

  // ---- configure ----

  private async configure(args: ConfigureArgs): Promise<OpResults["configure"]> {
    this.config = args;
    for (const key of args.dropShares ?? []) {
      const runtime = this.shares.get(key);
      if (runtime) { this.closeRuntime(runtime); this.shares.delete(key); }
      this.db.writeTx(() => this.db.deleteShare(key));
      this.emit({ event: "shareRemoved", share: key });
    }
    const desired = new Map<string, ShareSpec>();
    if (args.enabled) {
      for (const spec of args.shares as ShareSpec[]) {
        if (spec.key !== shareKey(spec)) throw new Error(`Share key ${spec.key} does not match ${shareKey(spec)}`);
        if (!path.isAbsolute(spec.root)) throw new Error(`Share root must be absolute: ${spec.root}`);
        desired.set(spec.key, spec);
      }
    }
    for (const [key, runtime] of this.shares) {
      if (desired.has(key)) continue;
      // Not wanted right now (ineligible, engine off): its rows stay, a later configure resumes them.
      this.closeRuntime(runtime);
      this.shares.delete(key);
      this.emit({ event: "shareRemoved", share: key });
    }
    for (const spec of desired.values()) {
      const context: ShareContext = {
        key: spec.key, projectId: spec.projectId, kind: spec.kind, root: path.resolve(spec.root), phase: spec.phase,
        matcher: compileRules(effectiveRules(spec.kind, spec.rules)), peers: spec.peers,
      };
      this.ensureShareRow(spec, context.root);
      const existing = this.shares.get(spec.key);
      if (existing) {
        const rootChanged = existing.scanner.context.root !== context.root;
        const rulesChanged = existing.scanner.context.matcher.hash !== context.matcher.hash;
        existing.spec = spec;
        existing.scanner.update(context);
        if (rootChanged && existing.watcher) {
          existing.watcher.close();
          existing.watcher = this.createWatcher(existing);
          existing.watcher.start();
        }
        if ((rootChanged || rulesChanged) && this.deps.watch) {
          existing.scanner.requireFullScan();
          this.enqueue(existing, { full: true, reason: "configure" });
        }
        this.emitState(existing);
        continue;
      }
      const runtime = this.createRuntime(spec, context);
      this.shares.set(spec.key, runtime);
      if (runtime.watcher) {
        // A share watched for the first time in this worker: whatever happened while nobody watched needs a walk.
        runtime.watcher.start();
        runtime.scanner.requireFullScan();
        this.enqueue(runtime, { full: true, reason: "start" });
      }
      this.emitState(runtime);
    }
    if (!this.readySent) { this.readySent = true; this.emit({ event: "ready", origins: [] }); }
    return { origins: [] };
  }

  private ensureShareRow(spec: ShareSpec, root: string): void {
    const row = this.db.share(spec.key);
    if (!row) this.db.writeTx(() => this.db.insertShare({ share: spec.key, projectId: spec.projectId, kind: spec.kind, root, indexId: this.newIndexId() }));
    else if (row.root !== root) this.db.writeTx(() => this.db.updateShare(spec.key, { root }));
  }

  private createRuntime(spec: ShareSpec, context: ShareContext): ShareRuntime {
    const slicer = new Slicer(this.slices);
    const runtime = { key: spec.key, spec, slicer, rechecks: new Map(), subtreeScans: new Map(), lastEmit: Number.NEGATIVE_INFINITY, closed: false } as unknown as ShareRuntime;
    runtime.scanner = new ShareScanner({
      db: this.db,
      nodeId: this.deps.nodeId,
      clock: this.deps.clock,
      emit: (event) => this.emit(event),
      slicer,
      recheck: (paths, delayMs) => this.recheck(runtime, paths, delayMs),
      watchDirectory: (key, fsRelative, ino) => runtime.watcher?.watchDirectory(key, fsRelative, ino),
      unwatchDirectory: (key) => runtime.watcher?.unwatchDirectory(key),
      committed: () => this.committed(runtime),
      newIndexId: () => this.newIndexId(),
      options: this.deps.scanner,
    }, context);
    if (this.deps.watch) runtime.watcher = this.createWatcher(runtime);
    return runtime;
  }

  private createWatcher(runtime: ShareRuntime): ShareWatcher {
    return new ShareWatcher({
      key: runtime.key,
      root: runtime.scanner.context.root,
      clock: this.deps.clock,
      mode: this.deps.watchMode ?? watchMode(),
      ignored: (key) => runtime.scanner.ignoresEvent(key),
      suppression: this.suppression,
      burst: this.burst,
      onBatch: (batch) => this.enqueue(runtime, batch.full ? { full: true, reason: "watch" } : { paths: batch.paths, shallow: batch.shallow, reason: "watch" }),
      onState: (state) => {
        if (state === "degraded") runtime.scanner.requireFullScan();
        if (this.shares.get(runtime.key) === runtime) this.emitState(runtime);
      },
      tuning: this.deps.watcher,
    });
  }

  private closeRuntime(runtime: ShareRuntime): void {
    runtime.closed = true;
    runtime.slicer.aborted = true;
    runtime.watcher?.close();
    for (const timer of runtime.rechecks.values()) timer.cancel();
    runtime.rechecks.clear();
    runtime.pending = undefined;
  }

  // ---- scans ----

  /** One-shot re-checks armed by the scanner (settle, retries): event-driven, never periodic. */
  private recheck(runtime: ShareRuntime, paths: string[], delayMs: number): void {
    if (runtime.closed) return;
    for (const fsPath of paths) {
      runtime.rechecks.get(fsPath)?.cancel();
      runtime.rechecks.set(fsPath, this.deps.clock.setTimeout(() => {
        runtime.rechecks.delete(fsPath);
        this.enqueue(runtime, { paths: [fsPath], reason: "settle" });
      }, delayMs));
    }
  }

  private enqueue(runtime: ShareRuntime, work: { paths?: string[]; shallow?: string[]; full?: boolean; reason: string }): void {
    if (runtime.closed || this.stopped) return;
    const pending = runtime.pending ??= { paths: new Set(), shallow: new Set(), full: false, reason: work.reason };
    for (const fsPath of work.paths ?? []) pending.paths.add(fsPath);
    for (const directory of work.shallow ?? []) pending.shallow.add(directory);
    pending.full ||= Boolean(work.full);
    runtime.draining ??= this.drain(runtime);
  }

  private async drain(runtime: ShareRuntime): Promise<void> {
    try {
      while (runtime.pending && !runtime.closed && !this.stopped) {
        const walks = runtime.pending.full || runtime.scanner.fullScanRequired || !this.db.share(runtime.key)?.fullScanAt;
        const release = walks ? await this.walkSlots.acquire() : undefined;
        try {
          // What arrived while it waited for a slot goes in the same scan.
          const work = runtime.pending;
          runtime.pending = undefined;
          if (!work || runtime.closed || this.stopped) break;
          const scope: InternalScope = work.full ? "full" : { paths: [...work.paths], shallow: [...work.shallow] };
          this.afterScan(runtime, await runtime.scanner.scan(scope, work.reason));
        } finally {
          release?.();
        }
      }
    } catch (error) {
      this.emit({ event: "log", level: "warn", key: `fileSync:${runtime.key}:drain`, message: `File sync could not scan ${runtime.key}: ${(error as Error).message}` });
    } finally {
      runtime.draining = undefined;
      this.emitState(runtime);
    }
  }

  private afterScan(runtime: ShareRuntime, result: ScanResult): ScanResult {
    if (runtime.closed) return result;
    // The watcher could not open a missing root; once the root is there, start over with a walk.
    const watcher = runtime.watcher;
    if (watcher?.state === "off" && runtime.scanner.root?.state === "ok") {
      watcher.start();
      if ((watcher.state as string) === "watching") { runtime.scanner.requireFullScan(); this.enqueue(runtime, { full: true, reason: "watch" }); }
    }
    this.emitState(runtime);
    return result;
  }

  private async scan(key: string, scope: InternalScope, reason: string): Promise<ScanResult> {
    const runtime = this.runtime(key);
    return this.afterScan(runtime, await runtime.scanner.scan(scope, reason));
  }

  /** Turn end, project open, handoff: what the watcher holds is scanned now; a stale or degraded share is walked. */
  private async flush(key: string, subtree?: string): Promise<ScanResult> {
    const runtime = this.runtime(key);
    const batch = runtime.watcher?.takeDirty();
    const pending = runtime.pending;
    runtime.pending = undefined;
    const paths = new Set([...batch?.paths ?? [], ...pending?.paths ?? []]);
    const shallow = new Set([...batch?.shallow ?? [], ...pending?.shallow ?? []]);
    let full = Boolean(pending?.full || runtime.watcher?.state === "degraded" || runtime.scanner.fullScanRequired);
    const subtrees: string[] = [];
    const share = this.db.share(key);
    const now = this.deps.clock.now();
    if (!full && (!share?.fullScanAt || now - share.fullScanAt > FULL_SCAN_MAX_AGE_MS)) {
      // Syncthing's hourly safety net, triggered by the event instead of a timer; a turn walks only its subtree.
      const relative = share?.fullScanAt ? this.subtreeKey(runtime, subtree) : undefined;
      if (relative === undefined) full = true;
      else if (now - (runtime.subtreeScans.get(relative) ?? share!.fullScanAt!) > FULL_SCAN_MAX_AGE_MS) {
        subtrees.push(relative);
        runtime.subtreeScans.set(relative, now);
      }
    }
    const scope: EventScope | "full" = full ? "full" : { paths: [...paths], shallow: [...shallow], subtrees };
    return this.afterScan(runtime, await runtime.scanner.scan(scope, "flush"));
  }

  private subtreeKey(runtime: ShareRuntime, subtree: string | undefined): string | undefined {
    if (subtree === undefined) return undefined;
    const root = runtime.scanner.context.root;
    const relative = path.isAbsolute(subtree) ? path.relative(root, subtree) : subtree;
    if (relative === "" || relative === ".") return undefined;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    try { return normalizeRelativePath(relative.split(path.sep).join("/")); } catch { return undefined; }
  }

  private committed(runtime: ShareRuntime): void {
    // During a long scan peers and the UI see progress about once a second; the scan's end always reports.
    if (performance.now() - runtime.lastEmit >= STATE_EMIT_MS) this.emitState(runtime);
  }

  // ---- status ----

  private emitState(runtime: ShareRuntime): void {
    if (runtime.closed || this.closed) return;
    runtime.lastEmit = performance.now();
    try { this.emit({ event: "shareState", status: this.statusOf(runtime) }); } catch (error) {
      this.emit({ event: "log", level: "warn", key: `fileSync:${runtime.key}:status`, message: `File sync could not read the status of ${runtime.key}: ${(error as Error).message}` });
    }
  }

  private statusOf(runtime: ShareRuntime): ShareStatus {
    const share = this.db.share(runtime.key);
    const scanner = runtime.scanner;
    const root = scanner.root;
    const held = this.db.heldCount(runtime.key);
    const need = this.db.needSummary(runtime.key);
    const errors = this.db.errorCount(runtime.key);
    let state: ShareState;
    let message: string | undefined;
    if (!share) { state = "starting"; message = "Starting file sync"; }
    else if (root?.state === "unavailable") { state = "unavailable"; message = root.message; }
    else if (root?.state === "error") { state = "error"; message = root.message; }
    else if (share.pendingDev !== null || share.scanError) { state = "error"; message = share.scanError ?? undefined; }
    else if (held > 0) { state = "error"; message = `${held} deletion${held === 1 ? " is" : "s are"} held; confirm in Settings → File sync`; }
    else if (scanner.running || runtime.draining || scanner.settlingCount > 0) { state = "scanning"; message = "Checking files"; }
    else if (!root) { state = "starting"; message = "Starting file sync"; }
    else state = "idle";
    const cursors = new Map(this.db.cursors(runtime.key).map((cursor) => [cursor.peer, cursor]));
    const peers: PeerShareStatus[] = runtime.spec.peers.map((peer) => {
      const cursor = cursors.get(peer);
      return {
        peer, cursor: cursor?.seq ?? 0, peerMaxSeq: cursor?.peerMaxSeq ?? 0, peerIndexId: cursor?.indexId ?? null, peerDigest: cursor?.peerDigest ?? null,
        rulesMatch: cursor?.peerRulesHash === scanner.context.matcher.hash, caughtUp: Boolean(cursor?.indexId) && (cursor?.seq ?? 0) >= (cursor?.peerMaxSeq ?? 0),
        differences: 0, cleanSince: null, route: "none",
      };
    });
    return {
      share: runtime.key, projectId: runtime.spec.projectId, kind: runtime.spec.kind, state, phase: runtime.spec.phase,
      maxSeq: share?.maxSeq ?? 0, indexId: share?.indexId ?? "", digest: share?.digest ?? "", rulesHash: scanner.context.matcher.hash,
      liveFiles: share?.liveFiles ?? 0, liveBytes: share?.liveBytes ?? 0, need: { files: need.files, bytes: need.bytes }, blocked: need.blocked,
      errors, held, scanning: scanner.running || Boolean(runtime.draining) || scanner.settlingCount > 0, watch: runtime.watcher?.state ?? "off",
      ...(message ? { message } : {}), peers,
    };
  }

  private status(keys?: string[]): ShareStatus[] {
    const runtimes = keys ? keys.map((key) => this.shares.get(key)).filter((runtime): runtime is ShareRuntime => Boolean(runtime)) : [...this.shares.values()];
    return runtimes.map((runtime) => this.statusOf(runtime));
  }

  private errors(key: string, offset: number, limit: number): OpResults["errors"] {
    this.runtime(key);
    const page = this.db.errorsPage(key, offset, limit);
    return { total: page.total, items: page.items.map((item): ErrorItem => ({ path: item.path, kind: item.kind, reason: item.reason, at: new Date(item.at).toISOString() })) };
  }

  // ---- lifecycle ----

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const running = [...this.shares.values()];
    for (const runtime of running) this.closeRuntime(runtime);
    // Scans stop at their next slice; a writeTx in progress always finishes (it cannot span an await).
    await Promise.allSettled(running.map((runtime) => runtime.draining));
    await Promise.allSettled(running.map((runtime) => runtime.scanner.idle()));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.shares.clear();
    this.db.close();
  }

  /** Read-only view for tests and later phases (apply registers suppressions, sync reads config). */
  get configured(): ConfigureArgs | undefined { return this.config; }
}

export type FileSyncCore = WorkerCore & { readonly db: FileSyncDb; readonly trash: Trash; readonly suppression: SuppressionRegistry };

export function createWorkerCore(deps: CoreDeps): FileSyncCore {
  return new Core(deps);
}
