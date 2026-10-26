import { lstatSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Applier, type ApplyShare } from "./apply.js";
import { FileSyncDb, fileSyncDbPath } from "./db.js";
import { compileRules, effectiveRules } from "./ignore.js";
import { DEFAULT_SETTLE_MS, NeedEngine, type NeedShare } from "./need.js";
import { normalizeRelativePath } from "./paths.js";
import {
  opSchemas, type ConfigureArgs, type CoreEvent, type DifferenceItem, type ErrorItem, type ListPage, type OpArgs, type OpName, type OpResults, type PeerShareStatus,
  type ScanResult, type ShareSpec, type ShareStatus,
} from "./protocol.js";
import { ShareScanner, SliceScheduler, Slicer, type EventScope, type InternalScope, type ScannerOptions, type ShareContext } from "./scanner.js";
import type { FrameLimits } from "./frames.js";
import { createFilesService, type FilesService, type ServedShare, type ServiceDeps } from "./service.js";
import { SyncLayer, type PeerTransport, type TransferApplyResult, type TransferDeps, type TransferQueue } from "./sync.js";
import { statfsDisk, Trash } from "./trash.js";
import { shareKey, type Clock, type ShareState } from "./types.js";
import { BurstMonitor, inotifyBurstLimit, ShareWatcher, SuppressionRegistry, watchMode, type WatchTuning } from "./watch.js";

/* The worker's data plane as one object built from injected dependencies (FILE-SYNC design §5.1), so
   tests run it in-thread with a fake clock and explicit scans, and worker.ts only adapts messages.
   P1 is the local engine: configure, scans, the watcher and status. P2 adds shadow mode:
   FilesService answers peers, the sync layer pulls their indexes and sends notices, and the need
   engine merges identical versions and tracks differences. Applying peers' changes is P3. */

export type { PeerRequest, PeerResponse, PeerTransport } from "./sync.js";
export type { FilesService } from "./service.js";

export interface CoreDeps {
  nodeId: string;
  dataDir: string;
  clock: Clock;
  random: () => number;
  /** false in randomized tests: no watchers, scans only when asked. */
  watch: boolean;
  /** How this core reaches peers; without one it has no network part (P1 tests, a node without peers). */
  transport?: PeerTransport;
  /** The direct origins this node's listener serves (the adapter owns the listener). */
  origins?(): string[];
  emit(event: CoreEvent): void;
  faults?: { beforeRename?(path: string): void; afterRename?(path: string): void; midStream?(path: string, bytes: number): void };
  diskFree?(dir: string): number;
  /** Tests: scanner thresholds, watcher timings, watch mode and the inotify burst limit. */
  scanner?: Partial<ScannerOptions>;
  watcher?: Partial<WatchTuning>;
  watchMode?: "recursive" | "directories";
  burstLimit?: number | null;
  /** How long a difference may last before it counts (default JOINT_BOB_FILE_SYNC_SETTLE_MS, else 2 min). */
  settleMs?: number;
  /** Tests: the notice coalescing window (250 ms) and the index page size the sync layer asks for. */
  noticeDelayMs?: number;
  pageLimit?: number;
  /** Tests: seams inside the service. */
  serviceHooks?: ServiceDeps["hooks"];
  /** Tests: fetch answer limits, served and accepted by this core. */
  frameLimits?: FrameLimits;
  /** Tests: parts of the transfer loop (a stand-in queue or applier, the stall guard, the fetch/file boundary). */
  transfers?: Partial<TransferDeps>;
  /** Tests: multi-user mode without configure saying so (configure's `multiUser` wins). */
  multiUser?: boolean;
  /** Tests: apply's platform rules (Linux's multi-user group bits, darwin's case checks) on another platform. */
  platform?: NodeJS.Platform;
}

/** The need engine as the transfer loop's queue, once it hands out need rows (need.ts, builtin phase). */
function isTransferQueue(value: object): value is TransferQueue {
  const queue = value as Partial<Record<keyof TransferQueue, unknown>>;
  return typeof queue.nextNeeds === "function" && typeof queue.retryLater === "function" && typeof queue.block === "function";
}

export interface WorkerCore {
  call<K extends OpName>(op: K, args: OpArgs[K]): Promise<OpResults[K]>;
  service: FilesService;
  close(): Promise<void>;
}

export class UnavailableOpError extends Error {
  readonly code = "unavailable";
  constructor(op: string, reason = "this phase of the engine has no network part") { super(`File sync cannot ${op} yet: ${reason}`); }
}

const FULL_SCAN_MAX_AGE_MS = 60 * 60_000;
/** Full walks at once: at start every share needs one, and dozens together only compete for the disk and the heap. */
const WALK_SLOTS = 2;
const STATE_EMIT_MS = 1000;
/** Ops of later phases (none left since P3). */
const LATER_OPS = new Set<OpName>([]);
/** Ops that only mean something with peers to talk to. */
const NETWORK_OPS = new Set<OpName>(["peerPresence", "announce", "notice", "differences", "repair"]);

function settleWindow(value: number | undefined): number {
  if (value !== undefined) return value;
  const raw = process.env.JOINT_BOB_FILE_SYNC_SETTLE_MS;
  const fromEnv = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_SETTLE_MS;
}
function rootIsDirectory(root: string): boolean {
  try { return lstatSync(root).isDirectory(); } catch { return false; }
}

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
  /** The root check after the last scan (need rows wait while the folder is missing). */
  rootState?: string;
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
  readonly need: NeedEngine;
  /** Writes peers' versions into builtin shares (§5.5); the applyBatch op and the transfer loop use it. */
  readonly applier: Applier;
  /** Apply's hashing and copying share the scans' slice budget. */
  private readonly applySlicer = new Slicer(this.slices);
  readonly sync: SyncLayer | undefined;
  readonly service: FilesService;
  private config: ConfigureArgs | undefined;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private readySent = false;
  private stopped = false;
  private closed = false;

  constructor(private readonly deps: CoreDeps) {
    this.db = new FileSyncDb(fileSyncDbPath(deps.dataDir), deps.nodeId);
    this.suppression = new SuppressionRegistry(deps.clock);
    this.burst = new BurstMonitor(deps.burstLimit !== undefined ? deps.burstLimit : inotifyBurstLimit(), deps.clock);
    const diskFree = deps.diskFree;
    this.trash = new Trash({ dataDir: deps.dataDir, clock: deps.clock, ...(diskFree ? { disk: (dir: string) => ({ freeBytes: diskFree(dir), totalBytes: statfsDisk(dir).totalBytes }) } : {}) });
    try { this.trash.prune(); } catch (error) { this.emit({ event: "log", level: "warn", key: "fileSync:trash", message: `File sync could not prune its trash: ${(error as Error).message}` }); }
    this.need = new NeedEngine({
      db: this.db, nodeId: deps.nodeId, clock: deps.clock, settleMs: settleWindow(deps.settleMs),
      share: (key) => this.needShare(key),
      localChanged: (key) => this.localChanged(key),
      comparisonChanged: (key, peer, differences, cleanSince) => this.comparisonChanged(key, peer, differences, cleanSince),
      compared: (key, peer) => this.sync?.liveCheck(key, peer),
      // Index exchange shares the scans' budget: 10 ms slices while requests wait, else 50.
      sliceMs: () => this.sliceBudget(),
      warn: (key, message) => this.emit({ event: "log", level: "warn", key, message }),
      shareKeys: () => [...this.shares.keys()],
      // Need counts are part of the status.
      needChanged: (key) => this.stateChanged(key),
    });
    this.applier = new Applier({
      db: this.db, nodeId: deps.nodeId, clock: deps.clock, need: this.need, trash: this.trash, suppression: this.suppression,
      share: (key) => this.applyShare(key),
      scanPaths: (key, fsPaths) => { const runtime = this.shares.get(key); if (runtime) this.enqueue(runtime, { paths: fsPaths, reason: "apply" }); },
      committed: (key) => this.localChanged(key),
      faults: deps.faults,
      multiUser: () => this.config?.multiUser ?? deps.multiUser ?? false,
      maybeYield: () => this.applySlicer.maybeYield(),
      ...(deps.platform ? { platform: deps.platform } : {}),
    });
    // Folders made for a download that is no longer wanted go again (an empty, unindexed folder would come back as new).
    this.need.onNeedChanged((key) => this.applier.sweepMadeDirs(key));
    this.sync = deps.transport ? new SyncLayer({
      db: this.db, nodeId: deps.nodeId, clock: deps.clock, transport: deps.transport, need: this.need, emit: (event) => this.emit(event),
      shares: () => this.served(),
      hostId: () => this.config?.hostId ?? "",
      stateChanged: (key) => this.stateChanged(key),
      noticeDelayMs: deps.noticeDelayMs,
      pageLimit: deps.pageLimit,
      transfers: this.transferDeps(),
    }) : undefined;
    this.service = createFilesService({
      db: this.db, nodeId: deps.nodeId, clock: deps.clock,
      config: () => this.config,
      origins: () => deps.origins?.() ?? [],
      shares: () => this.served(),
      changed: (peer, shares, records) => this.sync?.noticeReceived(peer, shares, records),
      status: (peer, shares) => this.sync?.statusReceived(peer, shares),
      // Serving bytes shares the scans' slice budget: a long answer waits its turn between files.
      yieldSlice: async () => { if (this.slices.due) await this.slices.wait(); },
      hooks: deps.serviceHooks,
      frameLimits: deps.frameLimits,
    });
  }

  /**
   * The transfer loop's parts: the need queue (need.ts), apply (the applyBatch op), the disk rules (trash.ts).
   * Without a queue and an applier the sync layer only pulls and notices.
   */
  private transferDeps(): TransferDeps | undefined {
    const given = this.deps.transfers ?? {};
    const queue = given.queue ?? (isTransferQueue(this.need) ? this.need : undefined);
    const apply = given.apply ?? ("applyBatch" in opSchemas
      ? {
        applyBatch: (args: { share: string; items: unknown[] }) => this.dispatch("applyBatch" as OpName, args) as Promise<TransferApplyResult>,
        // apply.ts's symlink- and case-safe parents for temps (§5.5.3).
        ensureParents: (share: string, relative: string) => this.applier.ensureParents(share, relative),
        sweep: (share: string) => this.applier.sweepMadeDirs(share),
      }
      : undefined);
    if (!queue || !apply) return undefined;
    return {
      queue, apply, disk: given.disk ?? this.trash, faults: given.faults ?? this.deps.faults,
      stallMs: given.stallMs, smallFileBytes: given.smallFileBytes, frameLimits: given.frameLimits ?? this.deps.frameLimits,
    };
  }

  // ---- what the sync layer and the service see of the shares ----

  /** Running shares, as the service authorizes and announces them. Closed (stopping) shares are not served. */
  private served(): ReadonlyMap<string, ServedShare> {
    const served = new Map<string, ServedShare>();
    if (this.stopped) return served;
    for (const [key, runtime] of this.shares) {
      served.set(key, {
        spec: runtime.spec, rulesHash: runtime.scanner.context.matcher.hash, state: () => this.statusOf(runtime).state,
        ignored: (relative) => runtime.scanner.classify(relative, false),
      });
    }
    return served;
  }

  private needShare(key: string): NeedShare | undefined {
    const runtime = this.shares.get(key);
    if (!runtime || runtime.closed) return undefined;
    const scanner = runtime.scanner;
    return {
      key, phase: runtime.spec.phase, rulesHash: scanner.context.matcher.hash, kind: runtime.spec.kind,
      // A missing or unreadable folder gets nothing written or downloaded for it: the last root check, and one lstat now
      // (it may have gone since the last scan).
      available: () => scanner.root?.state !== "unavailable" && scanner.root?.state !== "error" && rootIsDirectory(scanner.context.root),
      peers: () => runtime.spec.peers.filter((peer) => !this.sync?.isExcluded(key, peer)),
      // The scanner's classification, .gitignore option included: one implementation for both.
      ignored: (relative, isDirectory) => scanner.classify(relative, isDirectory),
    };
  }

  /** A running share as apply sees it; the phase is read at each look (configure may change it mid-batch). */
  private applyShare(key: string): ApplyShare | undefined {
    const runtime = this.shares.get(key);
    if (!runtime || runtime.closed || this.stopped) return undefined;
    const scanner = runtime.scanner;
    return {
      key, kind: runtime.spec.kind, root: scanner.context.root, fsNames: scanner.fsNames,
      get phase() { return runtime.closed ? "syncthing" : runtime.spec.phase; },
      peers: () => runtime.spec.peers.filter((peer) => !this.sync?.isExcluded(key, peer)),
      ignoreClass: (relative, isDirectory) => scanner.ignoreClass(relative, isDirectory),
    };
  }

  /** Merges wrote local rows outside a scan: peers are told, and the status goes out. */
  private localChanged(key: string): void {
    this.sync?.localCommitted(key);
    this.stateChanged(key);
  }

  private comparisonChanged(key: string, peer: string, differences: number, cleanSince: number | null): void {
    this.emit({ event: "diffChanged", share: key, peer, differences, cleanSince: cleanSince === null ? null : new Date(cleanSince).toISOString() });
    // Back to nothing differing while the share reports a mismatch: the check looks again instead of waiting for the next pull.
    if (differences === 0 && this.sync && (this.sync.mismatch(key).includes(peer) || this.db.hasError(key, ""))) this.sync.liveCheck(key, peer);
    this.stateChanged(key);
  }

  private stateChanged(key: string): void {
    const runtime = this.shares.get(key);
    if (runtime) this.emitState(runtime);
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
    if (LATER_OPS.has(op)) throw new UnavailableOpError(op, "a later phase of the engine adds it");
    if (NETWORK_OPS.has(op) && !this.sync) throw new UnavailableOpError(op);
    switch (op) {
      case "configure": return this.configure(args as ConfigureArgs);
      case "scan": return this.scan(args.share, args.scope, args.reason);
      case "flush": return this.flush(args.share, args.subtree);
      case "status": return this.status(args.shares);
      case "errors": return this.errors(args.share, args.offset, args.limit);
      case "confirmReplacedRoot": return this.afterScan(this.runtime(args.share), await this.runtime(args.share).scanner.confirmReplacedRoot());
      case "announce": this.sync!.announce(args.slept); return {};
      case "peerPresence": this.sync!.presence(args.peer, args.present, args.origins); return {};
      case "notice": await this.service.serve(args.peer, "changed", {}, args.body); return {};
      case "serve": return this.service.serve(args.peer, args.endpoint, args.query, args.body, args.range);
      case "differences": return this.differences(args.share, args.peer, args.offset, args.limit);
      case "repair": this.runtime(args.share); this.sync!.repair(args.share, args.peer); return {};
      case "prioritize":
        this.runtime(args.share);
        if (this.sync) this.sync.prioritize(args.share, args.prefix, args.untilMs);
        else if (isTransferQueue(this.need)) this.need.prioritize?.(args.share, args.prefix, args.untilMs);
        return {};
      case "pace": this.sync?.pace(args.relayPaused); return {};
      // fix (P4+P5): a worktree merge asks what of the worktree is still on its way, and from whom.
      case "pending": this.runtime(args.share); return this.need.pendingUnder(args.share, args.prefix, args.availablePeers);
      case "nextNeeds": return this.need.nextNeeds(args);
      case "applyBatch": this.runtime(args.share); return this.applier.applyBatch(args);
      case "bootstrap": {
        const runtime = this.runtime(args.share);
        const result = await this.need.bootstrap(args.share, args.builtinSinceByPeer);
        this.emitState(runtime);
        return result;
      }
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
      this.need.forgetNeed(key);
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
      this.need.forgetNeed(key);
      this.emit({ event: "shareRemoved", share: key });
    }
    for (const spec of desired.values()) {
      const context: ShareContext = {
        key: spec.key, projectId: spec.projectId, kind: spec.kind, root: path.resolve(spec.root), phase: spec.phase,
        matcher: compileRules(effectiveRules(spec.kind, spec.rules)), peers: spec.peers,
      };
      this.ensureShareRow(spec, context.root);
      // cutover-engine (P5): back on Syncthing (or on the way), this node's rows are Syncthing's again: a later switch must
      // decide them as such, so the builtin_since served to peers goes until the next bootstrap sets it.
      if ((spec.phase === "syncthing" || spec.phase === "restoring") && this.db.share(spec.key)?.builtinSince != null) {
        this.db.writeTx(() => this.db.updateShare(spec.key, { builtinSince: null }));
      }
      const existing = this.shares.get(spec.key);
      if (existing) {
        const rootChanged = existing.scanner.context.root !== context.root;
        const rulesChanged = existing.scanner.context.matcher.hash !== context.matcher.hash;
        const peersChanged = existing.spec.peers.join("\n") !== spec.peers.join("\n");
        // Into builtin with a folder that was missing: builtin creates a root it never saw (§5.2.1), and nothing else would look again.
        const rootWaits = spec.phase === "builtin" && existing.spec.phase !== "builtin" && existing.scanner.root?.state !== "ok";
        // Out of builtin: folders apply made for items in flight go while it still may remove them (empty and unindexed only).
        if (existing.spec.phase === "builtin" && spec.phase !== "builtin") this.applier.sweepMadeDirs(spec.key, { leaving: true });
        existing.spec = spec;
        existing.scanner.update(context);
        // Differences under other rules (or with peers no longer in the share) stop counting until compared again.
        if (rulesChanged || peersChanged) this.need.syncComparison(spec.key);
        if (rulesChanged) {
          // A seq without a row orders the new rules hash after everything announced under the old one: a page or an
          // answer built before the change (still on its way) can then never override what the notice below says.
          this.db.writeTx(() => { const row = this.db.share(spec.key); if (row) this.db.updateShare(spec.key, { maxSeq: row.maxSeq + 1 }); });
          // Peers compare only under equal rules; a rules change may write no row, so only a notice tells them.
          this.sync?.localCommitted(spec.key);
        }
        if (rootChanged && existing.watcher) {
          existing.watcher.close();
          existing.watcher = this.createWatcher(existing);
          existing.watcher.start();
        }
        if ((rootChanged || rulesChanged || rootWaits) && this.deps.watch) {
          existing.scanner.requireFullScan();
          this.enqueue(existing, { full: true, reason: "configure" });
        }
        // Builtin or not (need rows go when it leaves), and complete under these rules; other peers recompute from the stored rows.
        this.syncNeed(spec.key);
        if (peersChanged && !rulesChanged) this.need.recomputeNeed(spec.key);
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
      this.syncNeed(spec.key);
      this.emitState(runtime);
    }
    this.sync?.configure(args);
    const origins = this.deps.origins?.() ?? [];
    if (!this.readySent) { this.readySent = true; this.emit({ event: "ready", origins }); }
    return { origins };
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
      // Differences move in the scan's own transaction (§5.4); notices go out once it committed.
      inTransaction: (changes) => this.need.localChangesInTx(runtime.key, changes),
      committed: () => { this.committed(runtime); this.sync?.localCommitted(runtime.key); },
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
    // A new generation must reach peers even when the folder is empty (no commit told them); a finished
    // full scan may make the share comparable (complete under the current rules) or a reset one not.
    if (result.newGeneration) this.sync?.localCommitted(runtime.key);
    // A first full scan (or one under new rules) completes the index: a builtin share's need is computed then.
    this.syncNeed(runtime.key);
    // The folder is back: the need rows that waited for it are handed out again.
    const rootState = runtime.scanner.root?.state;
    if (rootState === "ok" && runtime.rootState !== undefined && runtime.rootState !== "ok") this.need.wake(runtime.key);
    else if (rootState === "ok") this.need.rootAvailable(runtime.key);
    runtime.rootState = rootState;
    try { this.need.syncComparison(runtime.key); } catch (error) {
      this.emit({ event: "log", level: "warn", key: `fileSync:${runtime.key}:diffs`, message: `File sync could not compare ${runtime.key}: ${(error as Error).message}` });
    }
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
    const result = this.afterScan(runtime, await runtime.scanner.scan(scope, reason));
    // "Rescan files" (reason "manual"): blocked items get another try (local-only content cleared away changes no row).
    // Other full scans leave them blocked: a block that flips back to pending at every walk would never read as settled.
    if (scope === "full" && reason === "manual" && !result.error) this.need.retryBlocked(key);
    return result;
  }

  private syncNeed(key: string): void {
    try { this.need.syncNeed(key); } catch (error) {
      this.emit({ event: "log", level: "warn", key: `fileSync:${key}:need`, message: `File sync could not update what ${key} needs: ${(error as Error).message}` });
    }
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
    const need = this.db.needSummary(runtime.key);
    const errors = this.db.errorCount(runtime.key);
    let state: ShareState;
    let message: string | undefined;
    if (!share) { state = "starting"; message = "Starting file sync"; }
    else if (root?.state === "unavailable") { state = "unavailable"; message = root.message; }
    else if (root?.state === "error") { state = "error"; message = root.message; }
    else if (share.pendingDev !== null || share.scanError) { state = "error"; message = share.scanError ?? undefined; }
    else if (this.sync?.mismatch(runtime.key).length) { state = "error"; message = `The index from ${this.sync.mismatch(runtime.key).join(", ")} does not match its files`; }
    else if (scanner.running || runtime.draining || scanner.settlingCount > 0) { state = "scanning"; message = "Checking files"; }
    else if (!root) { state = "starting"; message = "Starting file sync"; }
    else state = "idle";
    const cursors = new Map(this.db.cursors(runtime.key).map((cursor) => [cursor.peer, cursor]));
    const peers: PeerShareStatus[] = runtime.spec.peers.filter((peer) => !this.sync?.isExcluded(runtime.key, peer)).map((peer) => {
      const cursor = cursors.get(peer);
      const indexId = cursor?.indexId ?? null;
      const comparison = this.need.comparison(runtime.key, peer);
      return {
        peer, cursor: indexId ? cursor!.seq : 0, peerMaxSeq: cursor?.peerMaxSeq ?? 0, peerIndexId: cursor?.peerIndexId ?? indexId, peerDigest: cursor?.peerDigest ?? null,
        rulesMatch: cursor?.peerRulesHash === scanner.context.matcher.hash,
        // Within one generation only: a cursor of the old index says nothing about a new one.
        caughtUp: indexId !== null && (cursor!.peerIndexId ?? indexId) === indexId && cursor!.seq >= cursor!.peerMaxSeq,
        differences: comparison?.differences ?? 0, cleanSince: comparison?.cleanSince ? new Date(comparison.cleanSince).toISOString() : null,
        route: this.sync?.route(peer) ?? "none",
        ...(this.sync?.transferCounters(runtime.key, peer) ? { transfer: { ...this.sync.transferCounters(runtime.key, peer)! } } : {}),
        // cutover-engine (P5): what the switch's bootstrap passes for this peer.
        builtinSince: cursor?.peerBuiltinSince ?? null,
      };
    });
    return {
      share: runtime.key, projectId: runtime.spec.projectId, kind: runtime.spec.kind, state, phase: runtime.spec.phase,
      maxSeq: share?.maxSeq ?? 0, indexId: share?.indexId ?? "", digest: share?.digest ?? "", rulesHash: scanner.context.matcher.hash,
      liveFiles: share?.liveFiles ?? 0, liveBytes: share?.liveBytes ?? 0, need: { files: need.files, bytes: need.bytes }, blocked: need.blocked,
      errors, scanning: scanner.running || Boolean(runtime.draining) || scanner.settlingCount > 0, watch: runtime.watcher?.state ?? "off",
      ...(message ? { message } : {}), peers,
      // cutover-engine (P5): set by the bootstrap of the switch, recorded in node.db by main.
      builtinSince: share?.builtinSince ?? null,
      // auto-transition: main's first-index queue moves on once a project's shares say so.
      indexed: share?.fullScanAt != null && share.pendingDev === null,
    };
  }

  private status(keys?: string[]): ShareStatus[] {
    const runtimes = keys ? keys.map((key) => this.shares.get(key)).filter((runtime): runtime is ShareRuntime => Boolean(runtime)) : [...this.shares.values()];
    return runtimes.map((runtime) => this.statusOf(runtime));
  }

  private differences(key: string, peer: string, offset: number, limit: number): ListPage<DifferenceItem> {
    this.runtime(key);
    return this.need.differences(key, peer, offset, limit);
  }

  private errors(key: string, offset: number, limit: number): OpResults["errors"] {
    this.runtime(key);
    // Blocked need rows are listed with the errors (§5.4): both are what someone has to look at.
    const page = this.db.problemsPage(key, offset, limit);
    return { total: page.total, items: page.items.map((item): ErrorItem => ({ path: item.path, kind: item.kind, reason: item.reason, at: new Date(item.at).toISOString() })) };
  }

  // ---- lifecycle ----

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const running = [...this.shares.values()];
    for (const runtime of running) this.closeRuntime(runtime);
    // An apply between its hashing slices stops there (its temps stay for the next start); its synchronous section always finishes.
    this.applier.close();
    this.applySlicer.aborted = true;
    // Requests in flight are aborted; nothing new starts. Then scans stop at their next slice; a writeTx in progress always finishes (it cannot span an await).
    await this.sync?.close();
    this.need.close();
    await this.need.idle();
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

export type FileSyncCore = WorkerCore & {
  readonly db: FileSyncDb; readonly trash: Trash; readonly suppression: SuppressionRegistry;
  readonly need: NeedEngine; readonly sync: SyncLayer | undefined; readonly applier: Applier;
};

export function createWorkerCore(deps: CoreDeps): FileSyncCore {
  return new Core(deps);
}
