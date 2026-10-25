import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  renameSync, unlinkSync, type Dirent, type Stats,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { FileSyncDb, LocalEntry } from "./db.js";
import { Digest } from "./digest.js";
import { GitignoreTree, type GitignoreSource, type IgnoreMatcher } from "./ignore.js";
import { isSameOrInside, MAX_PATH_BYTES, MAX_SEGMENT_BYTES, normalizeRelativePath, parentKey } from "./paths.js";
import type { CoreEvent, ScanResult, ScanScope } from "./protocol.js";
import { DIRECTORY, FILE, SYMLINK, type Clock, type Phase, type ShareKind } from "./types.js";

/* The scanner turns what is on disk into index rows (FILE-SYNC design §5.2). It is the only source of
   local versions and tombstones, so invariant 1 lives here: a tombstone needs a readable root whose
   identity a complete scan confirmed, a synced path that is really gone, and the mass-delete guard's
   consent. Everything else (missing roots, replaced roots, unreadable folders, newly ignored paths)
   leaves rows alone or drops them without telling peers. */

const MiB = 1024 * 1024;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ScannerOptions {
  /** Files up to this size are hashed at once (and re-checked once if just modified). */
  smallFileBytes: number;
  settleMs: number;
  maxSettleMs: number;
  /** Changes per writeTx. */
  batchSize: number;
  guardMinimum: number;
  guardRatio: number;
  guardWindowMs: number;
  replacedMinimum: number;
  replacedRatio: number;
  tombstoneRetentionMs: number;
  staleTempMs: number;
  /** Keep on-disk spellings that differ from the NFC key (Linux); APFS finds a file by any normalization. */
  fsNames: boolean;
  hashChunkBytes: number;
  hashCheckBytes: number;
}

export const SCANNER_DEFAULTS: ScannerOptions = {
  smallFileBytes: 8 * MiB, settleMs: 2000, maxSettleMs: 60_000, batchSize: 1000,
  guardMinimum: 500, guardRatio: 0.5, guardWindowMs: 10 * 60_000, replacedMinimum: 500, replacedRatio: 0.5,
  tombstoneRetentionMs: 30 * DAY, staleTempMs: HOUR, fsNames: process.platform !== "darwin", hashChunkBytes: MiB, hashCheckBytes: 64 * MiB,
};

export const REPLACED_MESSAGE = "This folder looks replaced; confirm in Settings → File sync";
const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;
const ENGINE_TEMP_EXCLUDE = ".joint-bob-sync.*.tmp";
/** Git reads a .gitignore whole; one this large is not a list of patterns anyone maintains. */
const GITIGNORE_MAX_BYTES = MiB;

export interface ShareContext {
  key: string;
  projectId: string;
  kind: ShareKind;
  root: string;
  phase: Phase;
  matcher: IgnoreMatcher;
  /** Peers currently eligible for the share: tombstones are pruned only once all of them acknowledged. */
  peers: readonly string[];
}

/** Event-scoped work as the watcher hands it over; the op schema only carries `paths`. */
export interface EventScope { paths: string[]; shallow?: string[]; subtrees?: string[] }
export type InternalScope = ScanScope | EventScope;

export interface ScannerDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  emit(event: CoreEvent): void;
  slicer: Slicer;
  /** Arms a one-shot re-scan of these on-disk paths after `delayMs` (settle re-checks, compare-and-set retries). */
  recheck?(paths: string[], delayMs: number): void;
  /** Linux: called before a directory is listed, so nothing created between listing and watching is missed. */
  watchDirectory?(key: string, fsRelative: string, ino: number): void;
  unwatchDirectory?(key: string): void;
  /** Inside the commit's writeTx, after the rows are written: need and diffs move in the same transaction (§5.4). */
  inTransaction?(changes: ReadonlyArray<{ path: string; before: LocalEntry | undefined; after: LocalEntry | undefined }>): void;
  /** After a commit that wrote rows. */
  committed?(paths: readonly string[]): void;
  newIndexId(): string;
  options?: Partial<ScannerOptions>;
  hooks?: { beforeCommit?(): void };
}

export class ScanAborted extends Error {
  constructor() { super("Scan stopped"); }
}

/** The folder or the share's settings changed under a running scan: nothing more it read is written. */
class RunStale extends Error {}

/**
 * One time budget for every scan in the worker (§5.1): a scan runs until the current slice is used up,
 * then queues, and each turn of the event loop resumes one waiter. RPCs and timers therefore wait at
 * most one slice however many shares are scanning, not one slice per share.
 */
export class SliceScheduler {
  private started = performance.now();
  private readonly waiting: Array<() => void> = [];
  private scheduled = false;

  constructor(private readonly budgetMs: () => number = () => 50) {}

  get due(): boolean { return performance.now() - this.started >= this.budgetMs(); }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled || !this.waiting.length) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.started = performance.now();
      this.waiting.shift()?.();
      // Queued from inside the check phase, the next resume runs in the next turn, after I/O had its own.
      this.schedule();
    });
  }
}

/** Long work yields between slices (≤ 10 ms while RPCs wait, ≤ 50 ms otherwise); aborting stops one share's scans. */
export class Slicer {
  aborted = false;

  constructor(private readonly scheduler: SliceScheduler = new SliceScheduler()) {}

  async maybeYield(): Promise<void> {
    if (this.aborted) throw new ScanAborted();
    if (!this.scheduler.due) return;
    await this.scheduler.wait();
    if (this.aborted) throw new ScanAborted();
  }
}

// One read buffer for the whole worker: a chunk is hashed before the next await, so another scan cannot overwrite it in between.
let readBuffer: Buffer | undefined;
function hashBuffer(bytes: number): Buffer {
  if (readBuffer?.length !== bytes) readBuffer = Buffer.allocUnsafe(bytes);
  return readBuffer;
}

type FsFields = Pick<LocalEntry, "fsName" | "ino" | "ctimeMs" | "fsMtimeMs" | "size">;
type Change =
  | { kind: "version"; path: string; expect: number | null; next: Omit<LocalEntry, "version" | "modifiedBy" | "seq"> }
  | { kind: "touch"; path: string; expect: number | null; fs: FsFields }
  | { kind: "drop"; path: string; expect: number | null }
  | { kind: "tombstone"; path: string; expect: number | null };

interface Run {
  files: number;
  hashedBytes: number;
  changed: number;
  tombstones: number;
  held: number;
  pending: Change[];
  /** Tombstone candidates, decided by the guard once the walk is complete. */
  gone: Map<string, LocalEntry>;
  /** Directories marked gone with their subtree: seeing one again re-walks it. */
  goneDirs: Set<string>;
  visited: Set<string>;
  /** Held paths seen on disk again. */
  reappeared: Set<string>;
  errorKeys: Set<string>;
  errorOps: Map<string, { kind: "error" | "notice"; reason: string } | null>;
  /** Rows another writer changed between read and commit; scanned again. */
  conflicts: Set<string>;
  gitignoreDirs: Set<string>;
  /** The root's identity when the run started: nothing more is written once the folder is moved or replaced. */
  identity: { dev: number; ino: number } | null;
  /** The scanner's settings epoch when the run started (a new root or new rules end the run). */
  epoch: number;
  /** A complete scan of this generation finished before this run: only then may it write tombstones (§0.1). */
  complete: boolean;
  /** Ancestors this run looked at: a real directory, missing, or something else (a link, a file). */
  ancestors: Map<string, "dir" | "missing" | "other">;
}

type RootCheck = { state: "ok"; dev: number; ino: number } | { state: "unavailable" | "error"; message: string };

function errorCode(error: unknown): string { return (error as NodeJS.ErrnoException)?.code ?? "unknown"; }
function isMissing(error: unknown): boolean { const code = errorCode(error); return code === "ENOENT" || code === "ENOTDIR"; }
function joinKey(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
function depth(key: string): number { if (!key) return -1; let count = 0; for (const char of key) if (char === "/") count++; return count; }
function typeName(st: Stats): number { return st.isDirectory() ? DIRECTORY : st.isSymbolicLink() ? SYMLINK : FILE; }
function fingerprint(st: Stats): string { return `${st.size}:${st.mtimeMs}:${st.ino}:${st.ctimeMs}`; }
function isGitignore(key: string): boolean { return key === ".gitignore" || key.endsWith("/.gitignore"); }

async function runGit(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd), GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_NAMESPACE"]) delete env[key];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 65_536) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git ${args[0]} failed (${code ?? "signal"}): ${stderr.trim()}`)));
  });
}

export class ShareScanner {
  private ctx: ShareContext;
  private readonly options: ScannerOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private gitIgnored: GitignoreTree | undefined;
  private fullRequired = false;
  private excludeChecked = false;
  /** Bumped when the root or the rules change: a scan started before stops writing. */
  private epoch = 0;
  /** Held paths (the guard's sticky set), loaded once; only this scanner writes them. */
  private heldPaths: Set<string> | undefined;
  /** Undeclared tombstones per guard unit in the sliding window. */
  private window: Array<{ at: number; unit: string; count: number }> = [];
  /** Large files waiting for two agreeing lstats. */
  private readonly settling = new Map<string, { fingerprint: string; at: number; delay: number }>();
  private rootCheck: RootCheck | undefined;
  running = false;

  constructor(private readonly deps: ScannerDeps, context: ShareContext) {
    this.ctx = context;
    this.options = { ...SCANNER_DEFAULTS, ...deps.options };
  }

  get context(): ShareContext { return this.ctx; }
  get key(): string { return this.ctx.key; }
  get settlingCount(): number { return this.settling.size; }
  /** The last root check: null before the first scan. */
  get root(): RootCheck | undefined { return this.rootCheck; }

  /**
   * New spec from configure. A new root or new rules end a scan in progress (it read the old ones) and
   * make the next scan a full one (a scan compares rules_hash too).
   */
  update(context: ShareContext): void {
    if (context.matcher.hash !== this.ctx.matcher.hash || context.root !== this.ctx.root) {
      this.epoch++;
      this.gitIgnored = undefined;
    }
    if (context.phase !== this.ctx.phase) this.excludeChecked = false;
    this.ctx = context;
  }

  /** After the watcher was degraded or a worker restart: the next scan walks the whole share. */
  requireFullScan(): void { this.fullRequired = true; }
  get fullScanRequired(): boolean { return this.fullRequired; }

  /** The watcher's filter: an event path the rules ignore as a file (directory-only rules wait for the scan). */
  ignoresEvent(key: string): boolean {
    // Git reads a .gitignore the rules ignore too: its change must still reach the scan (unless its whole folder is ignored).
    if (this.gitIgnored && isGitignore(key) && !this.classify(parentKey(key), true)) return false;
    return this.classify(key, false);
  }

  private now(): number { return this.deps.clock.now(); }
  private abs(fsRelative: string): string { return fsRelative ? `${this.ctx.root}${path.sep}${fsRelative}` : this.ctx.root; }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Resolves once the scans queued so far have finished (or stopped). */
  idle(): Promise<void> { return this.chain.then(() => undefined); }

  /** Whether the share's rules (the .gitignore option included) leave the path out; the need engine compares with the same answer. */
  classify(key: string, isDirectory: boolean): boolean {
    return this.ctx.matcher.classify(key, isDirectory, this.gitIgnored) !== null;
  }

  private unitOf(key: string): string {
    if (this.ctx.kind === "project") return "";
    const slash = key.indexOf("/");
    return slash < 0 ? key : key.slice(0, slash);
  }

  private lstat(fsRelative: string): Stats | null {
    try { return lstatSync(this.abs(fsRelative)); } catch (error) { if (isMissing(error)) return null; throw error; }
  }

  private heldSet(): Set<string> {
    return this.heldPaths ??= new Set(this.deps.db.held(this.ctx.key));
  }

  private newRun(): Run {
    // Loaded once per scanner, not per scan: a visit must see that a held path came back.
    this.heldSet();
    return {
      files: 0, hashedBytes: 0, changed: 0, tombstones: 0, held: 0, pending: [], gone: new Map(), goneDirs: new Set(), visited: new Set(),
      reappeared: new Set(), errorKeys: new Set(this.deps.db.errorPaths(this.ctx.key)), errorOps: new Map(), conflicts: new Set(), gitignoreDirs: new Set(),
      identity: null, epoch: this.epoch, complete: false, ancestors: new Map(),
    };
  }

  scan(scope: InternalScope, reason = "manual"): Promise<ScanResult> {
    return this.exclusive(() => this.scanNow(scope, reason));
  }

  private newGeneration(identity: { dev: number; ino: number }): void {
    const { db } = this.deps;
    db.writeTx(() => db.resetGeneration(this.ctx.key, this.deps.newIndexId(), identity, this.ctx.phase === "builtin" ? 0 : null));
    this.window = [];
    this.settling.clear();
    this.heldPaths = undefined;
    this.gitIgnored?.clear();
  }

  private checkRoot(neverScanned: boolean): RootCheck {
    const root = this.ctx.root;
    let st: Stats;
    try {
      st = lstatSync(root);
    } catch (error) {
      if (!isMissing(error)) return { state: "error", message: `Cannot read the folder (${errorCode(error)})` };
      // Builtin mode creates a root it never saw, so a share added on this node can receive files.
      if (!(this.ctx.phase === "builtin" && neverScanned)) return { state: "unavailable", message: "The folder is missing" };
      try { mkdirSync(root, { recursive: true, mode: 0o755 }); st = lstatSync(root); } catch (made) { return { state: "error", message: `Cannot create the folder (${errorCode(made)})` }; }
    }
    if (st.isSymbolicLink()) return { state: "error", message: "The folder is a symbolic link" };
    if (!st.isDirectory()) return { state: "error", message: "The folder is not a directory" };
    return { state: "ok", dev: st.dev, ino: st.ino };
  }

  /**
   * Before anything this run read is written: the same settings, and the same folder at the root path.
   * A folder moved away mid-walk makes every path below it look deleted, and another folder put in its
   * place would hand its files to this generation (invariant 1).
   */
  private assertCurrent(run: Run): void {
    if (run.epoch !== this.epoch) throw new RunStale("The share's folder or rules changed during the scan");
    if (!run.identity) return;
    let st: Stats | undefined;
    try { st = lstatSync(this.ctx.root); } catch { /* missing or unreadable: not the folder this run started in */ }
    if (!st || !st.isDirectory() || st.dev !== run.identity.dev || st.ino !== run.identity.ino) throw new RunStale("The folder was moved or replaced during the scan");
  }

  private async scanNow(scope: InternalScope, reason: string): Promise<ScanResult> {
    const started = performance.now();
    const { db } = this.deps;
    const key = this.ctx.key;
    const run = this.newRun();
    let newGeneration = false;
    let full = scope === "full";
    const result = (error?: string): ScanResult => ({
      share: key, changed: run.changed, tombstones: run.tombstones, held: run.held, newGeneration, files: run.files,
      hashedBytes: run.hashedBytes, durationMs: Math.round(performance.now() - started), ...(error ? { error } : {}),
    });
    if (this.deps.slicer.aborted) return result(new ScanAborted().message);
    this.running = true;
    try {
      let share = db.share(key);
      if (!share) throw new Error(`Share ${key} is not configured`);
      const root = this.checkRoot(share.rootDev === null);
      this.rootCheck = root;
      if (root.state !== "ok") {
        // No changes at all: a missing or unreadable root says nothing about its files (invariant 1).
        const stored = root.state === "error" ? root.message : null;
        if (share.scanError !== stored && share.pendingDev === null) db.writeTx(() => db.updateShare(key, { scanError: stored }));
        return result(root.message);
      }
      run.identity = { dev: root.dev, ino: root.ino };
      if (share.rootDev === null) {
        db.writeTx(() => db.updateShare(key, { rootDev: root.dev, rootIno: root.ino, scanError: null, root: this.ctx.root }));
        newGeneration = true;
      } else if (share.rootDev !== root.dev || share.rootIno !== root.ino) {
        if (share.pendingDev === root.dev && share.pendingIno === root.ino && !full) return result(share.scanError ?? REPLACED_MESSAGE);
        // The .gitignore files read so far belong to the folder that was here before.
        this.gitIgnored?.clear();
        this.loadGitignore();
        const previous = db.liveCount(key);
        const needed = Math.ceil(previous * this.options.replacedRatio);
        if (previous >= this.options.replacedMinimum && await this.countEntries(needed) < needed) {
          this.assertCurrent(run);
          db.writeTx(() => db.updateShare(key, { pendingDev: root.dev, pendingIno: root.ino, scanError: REPLACED_MESSAGE }));
          this.deps.emit({ event: "log", level: "warn", key: `fileSync:${key}:replaced`, message: `File sync paused ${key}: the folder holds far fewer files than before (${previous} indexed)` });
          return result(REPLACED_MESSAGE);
        }
        this.assertCurrent(run);
        // Another directory at the root path: its contents are a new generation, nothing was deleted.
        this.newGeneration({ dev: root.dev, ino: root.ino });
        newGeneration = true;
      } else if (share.pendingDev !== null || share.scanError !== null) {
        db.writeTx(() => db.updateShare(key, { pendingDev: null, pendingIno: null, scanError: null }));
      }
      share = db.share(key)!;
      run.complete = share.fullScanAt !== null;
      if (!run.complete || share.rulesHash !== this.ctx.matcher.hash || this.fullRequired) full = true;
      this.loadGitignore();
      void this.ensureGitExclude();
      if (full) {
        await this.walk(run, "", "", root.ino, true);
      } else {
        await this.processScope(run, scope as EventScope);
      }
      await this.afterGitignoreChanges(run);
      this.commit(run);
      if (full) {
        this.assertCurrent(run);
        db.writeTx(() => db.updateShare(key, { fullScanAt: this.now(), rulesHash: this.ctx.matcher.hash }));
        this.fullRequired = false;
      }
      this.settleDeletes(run);
      for (let attempt = 0; run.conflicts.size && attempt < 3; attempt++) {
        const paths = [...run.conflicts];
        run.conflicts.clear();
        run.visited.clear();
        run.ancestors.clear();
        // markGone puts every gone path in goneDirs, files included; left there, a conflicting tombstone would be skipped as already covered.
        run.goneDirs.clear();
        await this.processScope(run, { paths });
        this.commit(run);
        this.settleDeletes(run);
      }
      if (run.conflicts.size) this.deps.recheck?.([...run.conflicts], 0);
      if (full) this.pruneTombstones();
      return result();
    } catch (error) {
      run.pending.length = 0;
      run.gone.clear();
      if (error instanceof ScanAborted) return result(error.message);
      if (error instanceof RunStale) {
        // What it read may belong to another folder or other rules: the next scan (armed now) walks everything again.
        this.fullRequired = true;
        this.deps.recheck?.([""], 0);
        return result(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.deps.emit({ event: "log", level: "warn", key: `fileSync:${key}:scan`, message: `File scan of ${key} failed: ${message}` });
      return result(message);
    } finally {
      this.running = false;
      this.deps.emit({
        event: "metric", operation: "fileSync.scan", durationMs: performance.now() - started,
        fields: { files: run.files, hashedBytes: run.hashedBytes, changed: run.changed, tombstones: run.tombstones, scope: full ? "full" : "paths", reason: reason.slice(0, 32) },
      });
    }
  }

  // ---- event-scoped work (§5.2.2) ----

  private fsOfKey(key: string): string {
    if (!key) return "";
    return this.deps.db.entry(this.ctx.key, key)?.fsName ?? key;
  }

  /** The nearest directory at or above `key` that the index holds live (or the root): listing it finds `key`. */
  private listingFor(key: string): string {
    const { db } = this.deps;
    let current = key;
    while (current) {
      const row = db.entry(this.ctx.key, current);
      if (row && !row.deleted && row.type === DIRECTORY) return current;
      current = parentKey(current);
    }
    return "";
  }

  /**
   * The highest ancestor of `key` that is on disk but not a real directory (a link, a file). lstat and
   * open follow links in every component but the last, so what lies below it is outside the share and
   * must not be read through it. null when every ancestor is a directory, or one is missing (then so is
   * the path). An unreadable ancestor throws.
   */
  private linkedAncestor(run: Run, key: string, fs: string): string | null {
    for (let end = key.indexOf("/"), fsEnd = fs.indexOf("/"); end >= 0; end = key.indexOf("/", end + 1), fsEnd = fsEnd < 0 ? -1 : fs.indexOf("/", fsEnd + 1)) {
      const ancestor = key.slice(0, end);
      let state = run.ancestors.get(ancestor);
      if (state === undefined) {
        const st = this.lstat(fsEnd >= 0 ? fs.slice(0, fsEnd) : this.fsOfKey(ancestor));
        state = !st ? "missing" : st.isDirectory() ? "dir" : "other";
        run.ancestors.set(ancestor, state);
      }
      if (state === "missing") return null;
      if (state === "other") return ancestor;
    }
    return null;
  }

  /** Whether `key` and every folder above it are real directories on disk now (no link, no file on the way). */
  private realDirectory(key: string): boolean {
    if (!key) return true;
    const fs = this.fsOfKey(key);
    for (let end = fs.indexOf("/"); ; end = fs.indexOf("/", end + 1)) {
      if (!this.lstatQuiet(end < 0 ? fs : fs.slice(0, end))?.isDirectory()) return false;
      if (end < 0) return true;
    }
  }

  /** listingFor, moved above an ancestor that is no longer a real directory: listing that folder records the change. */
  private safeListing(run: Run, key: string, fs: string): string {
    let linked: string | null = null;
    try { linked = this.linkedAncestor(run, key, fs); } catch { /* unreadable: the listing reports it */ }
    return this.listingFor(linked === null ? key : parentKey(linked));
  }

  private parseEventPath(raw: string): { key: string; fs: string } | null {
    if (raw === "") return { key: "", fs: "" };
    try {
      const key = normalizeRelativePath(raw);
      return { key, fs: this.options.fsNames ? raw : key };
    } catch {
      return null;
    }
  }

  private async processScope(run: Run, scope: EventScope): Promise<void> {
    const { db } = this.deps;
    const share = this.ctx.key;
    const listings = new Set<string>();
    const direct = new Map<string, string>();
    for (const raw of scope.shallow ?? []) {
      const parsed = this.parseEventPath(raw);
      if (parsed) listings.add(this.safeListing(run, parsed.key, parsed.fs));
    }
    const work = [...scope.paths];
    const queued = new Set<string>();
    while (work.length) {
      await this.deps.slicer.maybeYield();
      const parsed = this.parseEventPath(work.pop()!);
      if (!parsed || queued.has(parsed.key)) continue;
      queued.add(parsed.key);
      const { key } = parsed;
      if (key === "") { listings.add(""); continue; }
      if (isGitignore(key)) this.noteGitignore(run, parentKey(key));
      const row = db.entry(share, key);
      // On Linux a spelling other than the key, or a key two names fight over, is settled by listing.
      if (this.options.fsNames && (parsed.fs !== key || run.errorKeys.has(key) || (row?.fsName ?? key) !== parsed.fs)) {
        listings.add(this.safeListing(run, parentKey(key), parentKey(parsed.fs)));
        continue;
      }
      const fs = row?.fsName ?? parsed.fs;
      let st: Stats | null;
      try {
        const linked = this.linkedAncestor(run, key, fs);
        // Below a link or a file now: listing the folder above it records that (and what was below goes).
        if (linked !== null) { listings.add(this.listingFor(parentKey(linked))); continue; }
        st = this.lstat(fs);
      } catch (error) {
        run.errorOps.set(key, { kind: "error", reason: `Cannot read (${errorCode(error)})` });
        continue;
      }
      if (!st) {
        const parent = parentKey(key);
        const parentStat = parent ? this.lstatQuiet(this.fsOfKey(parent)) : null;
        // A parent that is a file now is a type change its own visit records (and clears what was below).
        if (parentStat && !parentStat.isDirectory()) { work.push(this.fsOfKey(parent)); continue; }
        this.markGoneUpwards(run, key);
        // Something created and removed again inside new folders: the folders stay and are synced.
        if (parentStat && this.listingFor(parent) !== parent) listings.add(this.listingFor(parent));
        continue;
      }
      if (this.classify(key, st.isDirectory())) {
        this.dropIgnored(run, key);
        // Ignored content can be the only sign of new folders above it (events coalesce): those are synced.
        const parent = parentKey(key);
        if (parent && this.listingFor(parent) !== parent) listings.add(this.listingFor(parent));
        continue;
      }
      if (!row || row.deleted || row.type !== typeName(st)) { listings.add(this.listingFor(parentKey(key))); continue; }
      direct.set(key, fs);
    }
    const listed = new Set<string>();
    const ordered = [...listings].sort((a, b) => depth(a) - depth(b));
    for (const key of ordered) {
      if (listed.has(key)) continue;
      listed.add(key);
      await this.listDirectory(run, key, this.fsOfKey(key));
    }
    for (const [key, fs] of direct) {
      // A listing may have found a folder above it gone (or a link now): what was below went with it.
      if (run.visited.has(key) || listed.has(parentKey(key)) || this.underGone(run, key)) continue;
      await this.deps.slicer.maybeYield();
      let st: Stats | null;
      try {
        st = this.linkedAncestor(run, key, fs) === null ? this.lstat(fs) : null;
      } catch (error) {
        run.errorOps.set(key, { kind: "error", reason: `Cannot read (${errorCode(error)})` });
        continue;
      }
      if (!st) { this.markGone(run, key); continue; }
      const descend = await this.visit(run, key, fs, st, db.entry(share, key));
      if (descend === 2 || descend === 3) await this.walk(run, key, fs, st.ino, descend === 2);
    }
    for (const raw of scope.subtrees ?? []) {
      const parsed = this.parseEventPath(raw);
      if (!parsed) continue;
      // A subtree the index does not hold yet is found as a new directory by listing its nearest indexed parent.
      const target = this.safeListing(run, parsed.key, parsed.fs);
      await this.listDirectory(run, target, this.fsOfKey(target), target === parsed.key);
    }
  }

  private underGone(run: Run, key: string): boolean {
    for (let above = parentKey(key); above; above = parentKey(above)) if (run.goneDirs.has(above)) return true;
    return false;
  }

  private lstatQuiet(fsRelative: string): Stats | null {
    try { return this.lstat(fsRelative); } catch { return null; }
  }

  /** `key` is gone: the highest missing ancestor is what was deleted (its subtree goes with it). */
  private markGoneUpwards(run: Run, key: string): void {
    // A deleted folder sends one event per file below it; the first one collected the whole subtree.
    for (let covered = key; covered; covered = parentKey(covered)) if (run.goneDirs.has(covered)) return;
    let missing = key;
    for (let parent = parentKey(missing); parent; parent = parentKey(missing)) {
      if (this.lstatQuiet(this.fsOfKey(parent))) break;
      missing = parent;
    }
    this.markGone(run, missing);
  }

  /** A listing named by an event: the directory's own entry first (its parent is not being listed), then its children. */
  private async listDirectory(run: Run, key: string, fs: string, recursive = false): Promise<void> {
    if (key === "") {
      const st = this.lstatQuiet("");
      if (st) await this.walk(run, "", "", st.ino, recursive);
      return;
    }
    if (run.visited.has(key)) {
      const st = this.lstatQuiet(fs);
      if (st?.isDirectory()) await this.walk(run, key, fs, st.ino, recursive);
      return;
    }
    let st: Stats | null;
    try { st = this.lstat(fs); } catch (error) { run.errorOps.set(key, { kind: "error", reason: `Cannot read (${errorCode(error)})` }); return; }
    if (!st) { this.markGoneUpwards(run, key); return; }
    if (this.classify(key, st.isDirectory())) { this.dropIgnored(run, key); return; }
    const row = this.deps.db.entry(this.ctx.key, key);
    const descend = await this.visit(run, key, fs, st, row);
    if (!st.isDirectory() || descend === 0) return;
    await this.walk(run, key, fs, st.ino, recursive || descend === 2);
  }

  // ---- walking (§5.2.3) ----

  /** Lists `key` and its children; directories below are listed too when `recursive` or new to the index. */
  private async walk(run: Run, startKey: string, startFs: string, startIno: number, recursive: boolean): Promise<void> {
    const { db } = this.deps;
    const share = this.ctx.key;
    const stack: Array<{ key: string; fs: string; ino: number; recursive: boolean }> = [{ key: startKey, fs: startFs, ino: startIno, recursive }];
    while (stack.length) {
      await this.deps.slicer.maybeYield();
      const dir = stack.pop()!;
      // Pushed as a directory: listing it after it became a link would list whatever the link points at.
      if (!dir.key) this.assertCurrent(run);
      else {
        let here: Stats | null;
        try { here = this.lstat(dir.fs); } catch (error) {
          run.errorOps.set(dir.key, { kind: "error", reason: `Cannot read this folder (${errorCode(error)})` });
          continue;
        }
        if (!here) { this.markGone(run, dir.key); continue; }
        // Replaced since its parent was listed: looked at again once this pass is committed.
        if (!here.isDirectory() || here.ino !== dir.ino) { run.conflicts.add(dir.fs); continue; }
      }
      this.deps.watchDirectory?.(dir.key, dir.fs, dir.ino);
      let dirents: Dirent[];
      try {
        dirents = readdirSync(this.abs(dir.fs), { withFileTypes: true });
      } catch (error) {
        if (isMissing(error) && dir.key) { this.markGone(run, dir.key); continue; }
        // Unreadable: its children are unknown, never gone.
        if (dir.key) run.errorOps.set(dir.key, { kind: "error", reason: `Cannot read this folder (${errorCode(error)})` });
        else throw error;
        continue;
      }
      if (dir.key && run.errorKeys.has(dir.key) && !run.errorOps.has(dir.key)) run.errorOps.set(dir.key, null);
      const groups = new Map<string, Dirent[]>();
      for (const dirent of dirents) {
        const nfc = dirent.name.normalize("NFC");
        const group = groups.get(nfc);
        if (group) group.push(dirent); else groups.set(nfc, [dirent]);
      }
      if (this.gitIgnored && (groups.has(".gitignore") || this.gitIgnored.read(dir.key))) this.noteGitignore(run, dir.key);
      const rows = new Map(db.children(share, dir.key).map((row) => [row.path, row]));
      const seen = new Set<string>();
      for (const [nfc, group] of groups) {
        await this.deps.slicer.maybeYield();
        const childKey = joinKey(dir.key, nfc);
        seen.add(childKey);
        if (Buffer.byteLength(nfc) > MAX_SEGMENT_BYTES || Buffer.byteLength(childKey) > MAX_PATH_BYTES) {
          run.errorOps.set(childKey, { kind: "notice", reason: "Not synced: the name or path is too long" });
          continue;
        }
        if (group.length > 1) {
          // Two names, one key (NFC/NFD twins on Linux): neither can be synced, neither is gone.
          run.visited.add(childKey);
          run.errorOps.set(childKey, { kind: "error", reason: `Not synced: ${group.length} names in this folder mean the same path` });
          continue;
        }
        const dirent = group[0];
        let childFs = joinKey(dir.fs, dirent.name);
        const known = dirent.isDirectory() || dirent.isFile() || dirent.isSymbolicLink();
        let st: Stats | null = null;
        try {
          if (!known) st = this.lstat(childFs);
        } catch (error) {
          run.errorOps.set(childKey, { kind: "error", reason: `Cannot read (${errorCode(error)})` });
          continue;
        }
        if (!known && !st) { seen.delete(childKey); continue; }
        const isDirectory = known ? dirent.isDirectory() : st!.isDirectory();
        if (this.classify(childKey, isDirectory)) {
          run.visited.add(childKey);
          if (rows.has(childKey)) this.dropIgnored(run, childKey);
          this.housekeepIgnored(dirent, childFs);
          continue;
        }
        if (this.options.fsNames && dirent.name !== nfc && this.ctx.phase === "builtin") {
          // Syncthing's autoNormalize: builtin mode renames a lone non-NFC name to its key.
          const renamed = joinKey(dir.fs, nfc);
          try { renameSync(this.abs(childFs), this.abs(renamed)); childFs = renamed; } catch { /* keeps the fs_name mapping */ }
        }
        try {
          st = this.lstat(childFs);
        } catch (error) {
          run.errorOps.set(childKey, { kind: "error", reason: `Cannot read (${errorCode(error)})` });
          continue;
        }
        if (!st) { seen.delete(childKey); continue; }
        const descend = await this.visit(run, childKey, childFs, st, rows.get(childKey));
        if (descend >= 2 || (descend === 1 && dir.recursive)) stack.push({ key: childKey, fs: childFs, ino: st.ino, recursive: dir.recursive || descend === 2 });
      }
      for (const [childKey, row] of rows) {
        if (seen.has(childKey)) continue;
        if (this.classify(childKey, row.type === DIRECTORY)) this.dropIgnored(run, childKey);
        else if (!row.deleted) this.markGone(run, childKey);
        else if (row.type === DIRECTORY && db.hasLiveBelow(share, childKey)) this.markDescendantsGone(run, childKey);
      }
    }
  }

  /**
   * 0: nothing below to look at; 1: an indexed directory as it was (list it when walking); 2: new or
   * replaced directory (walk it); 3: an indexed directory whose entries changed (list it).
   */
  private async visit(run: Run, key: string, fs: string, st: Stats, row: LocalEntry | undefined): Promise<0 | 1 | 2 | 3> {
    run.visited.add(key);
    run.files += 1;
    run.gone.delete(key);
    if (this.heldPaths?.has(key)) run.reappeared.add(key);
    if (run.errorKeys.has(key)) run.errorOps.set(key, null);
    const fsName = this.options.fsNames && fs !== key ? fs : null;
    if (st.isDirectory()) return this.visitDirectory(run, key, fsName, st, row);
    try {
      if (st.isFile()) await this.visitFile(run, key, fs, fsName, st, row);
      else if (st.isSymbolicLink()) this.visitSymlink(run, key, fs, fsName, st, row);
      else run.errorOps.set(key, { kind: "notice", reason: "Not synced: not a file, folder or link" });
    } catch (error) {
      if (error instanceof ScanAborted || error instanceof RunStale) throw error;
      if (isMissing(error)) { this.markGone(run, key); return 0; }
      run.errorOps.set(key, { kind: "error", reason: `Cannot read (${errorCode(error)})` });
    }
    return 0;
  }

  private fsFields(fsName: string | null, st: Stats): FsFields {
    return { fsName, ino: st.ino, ctimeMs: st.ctimeMs, fsMtimeMs: st.mtimeMs, size: st.isDirectory() ? 0 : st.size };
  }

  private visitDirectory(run: Run, key: string, fsName: string | null, st: Stats, row: LocalEntry | undefined): 0 | 1 | 2 | 3 {
    const mode = st.mode & 0o777;
    const regone = run.goneDirs.delete(key);
    if (row && !row.deleted && row.type === DIRECTORY) {
      // Its ctime moves when entries are added, removed or renamed in it, or when it is renamed itself: moved away
      // and back between two events, say, with changes made under the other name. Such a folder is listed, and so is
      // every folder below whose ctime moved too.
      const changed = row.ctimeMs !== st.ctimeMs;
      if (row.mode !== mode) this.queue(run, { kind: "version", path: key, expect: row.seq, next: { ...row, ...this.fsFields(fsName, st), mode, mtimeMs: st.mtimeMs } });
      else if (row.ino !== st.ino || row.fsName !== fsName || changed) this.queue(run, { kind: "touch", path: key, expect: row.seq, fs: this.fsFields(fsName, st) });
      // A different inode is another directory in its place: what is below must be looked at again.
      return row.ino !== st.ino || regone ? 2 : changed ? 3 : 1;
    }
    // In builtin mode a deleted folder that came back holding only ignored files stays deleted (apply cleared it for a
    // peer and could not remove local-only content). In shadow mode Syncthing copies such a folder empty, so a folder
    // on disk is live whatever it holds; otherwise two nodes with the same tree would index it differently for good.
    if (row && row.deleted && row.type === DIRECTORY && this.ctx.phase === "builtin" && !this.resurrects(key, fsName ?? key)) return 0;
    this.queue(run, {
      kind: "version", path: key, expect: row?.seq ?? null,
      next: { path: key, ...this.fsFields(fsName, st), type: DIRECTORY, mtimeMs: st.mtimeMs, mode, sha256: null, target: null, deleted: false, deletedAt: null },
    });
    return 2;
  }

  private resurrects(key: string, fs: string): boolean {
    let dirents: Dirent[];
    try { dirents = readdirSync(this.abs(fs), { withFileTypes: true }); } catch { return true; }
    if (!dirents.length) return true;
    for (const dirent of dirents) {
      const childKey = joinKey(key, dirent.name.normalize("NFC"));
      const childFs = joinKey(fs, dirent.name);
      const st = this.lstatQuiet(childFs);
      if (!st || this.classify(childKey, st.isDirectory())) continue;
      if (!st.isDirectory()) return true;
      const row = this.deps.db.entry(this.ctx.key, childKey);
      if (!(row && row.deleted && row.type === DIRECTORY) || this.resurrects(childKey, childFs)) return true;
    }
    return false;
  }

  private async visitFile(run: Run, key: string, fs: string, fsName: string | null, st: Stats, row: LocalEntry | undefined): Promise<void> {
    const mode = st.mode & 0o777;
    if (row && !row.deleted && row.type === DIRECTORY) this.markDescendantsGone(run, key);
    const live = row && !row.deleted && row.type === FILE ? row : undefined;
    if (live && live.size === st.size && live.fsMtimeMs === st.mtimeMs && live.mode === mode && live.ino === st.ino && live.ctimeMs === st.ctimeMs) {
      if (live.fsName !== fsName) this.queue(run, { kind: "touch", path: key, expect: live.seq, fs: this.fsFields(fsName, st) });
      return;
    }
    if (st.size > this.options.smallFileBytes && !this.largeSettled(key, fs, st)) return;
    const sha = await this.hash(run, fs, st);
    if (sha === null) {
      // It changed while being read: look again once it has had time to settle.
      this.deps.recheck?.([fs], this.options.settleMs);
      return;
    }
    if (st.size <= this.options.smallFileBytes && this.now() - st.mtimeMs < this.options.settleMs) this.deps.recheck?.([fs], this.options.settleMs);
    if (isGitignore(key)) run.gitignoreDirs.add(parentKey(key));
    if (live && live.sha256 === sha && live.mode === mode) {
      // A touch is not a change: the version (and its mtime) stays, only the fingerprint moves.
      this.queue(run, { kind: "touch", path: key, expect: live.seq, fs: this.fsFields(fsName, st) });
      return;
    }
    this.queue(run, {
      kind: "version", path: key, expect: row?.seq ?? null,
      next: { path: key, ...this.fsFields(fsName, st), type: FILE, mtimeMs: st.mtimeMs, mode, sha256: sha, target: null, deleted: false, deletedAt: null },
    });
  }

  private visitSymlink(run: Run, key: string, fs: string, fsName: string | null, st: Stats, row: LocalEntry | undefined): void {
    if (row && !row.deleted && row.type === DIRECTORY) this.markDescendantsGone(run, key);
    const live = row && !row.deleted && row.type === SYMLINK ? row : undefined;
    if (live && live.size === st.size && live.fsMtimeMs === st.mtimeMs && live.ino === st.ino && live.ctimeMs === st.ctimeMs && live.fsName === fsName) return;
    const target = readlinkSync(this.abs(fs), "utf8");
    if (!target || Buffer.byteLength(target) > 4096) {
      run.errorOps.set(key, { kind: "notice", reason: "Not synced: the link text is longer than 4096 bytes" });
      return;
    }
    if (live && live.target === target) {
      this.queue(run, { kind: "touch", path: key, expect: live.seq, fs: this.fsFields(fsName, st) });
      return;
    }
    this.queue(run, {
      kind: "version", path: key, expect: row?.seq ?? null,
      next: { path: key, ...this.fsFields(fsName, st), type: SYMLINK, mtimeMs: st.mtimeMs, mode: 0, sha256: null, target, deleted: false, deletedAt: null },
    });
  }

  /** Large files are hashed only after two lstats ≥ settleMs apart agree; the wait doubles while it keeps changing. */
  private largeSettled(key: string, fs: string, st: Stats): boolean {
    const now = this.now();
    const fingerprint = `${st.size}:${st.mtimeMs}:${st.ino}:${st.ctimeMs}:${st.mode}`;
    const pending = this.settling.get(key);
    if (pending && pending.fingerprint === fingerprint) {
      if (now - pending.at < this.options.settleMs) return false;
      this.settling.delete(key);
      return true;
    }
    const delay = pending ? Math.min(pending.delay * 2, this.options.maxSettleMs) : this.options.settleMs;
    this.settling.set(key, { fingerprint, at: now, delay });
    this.deps.recheck?.([fs], delay);
    return false;
  }

  private async hash(run: Run, fs: string, st: Stats): Promise<string | null> {
    const fd = openSync(this.abs(fs), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (opened.ino !== st.ino || opened.size !== st.size || opened.mtimeMs !== st.mtimeMs) return null;
      const buffer = hashBuffer(this.options.hashChunkBytes);
      const hash = createHash("sha256");
      let total = 0, sinceCheck = 0, checkStarted = performance.now();
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(read === buffer.length ? buffer : buffer.subarray(0, read));
        total += read;
        sinceCheck += read;
        if (sinceCheck >= this.options.hashCheckBytes) {
          this.deps.emit({ event: "metric", operation: "fileSync.hash", durationMs: performance.now() - checkStarted, fields: { bytes: sinceCheck } });
          sinceCheck = 0;
          checkStarted = performance.now();
          const now = fstatSync(fd);
          if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) return null;
        }
        await this.deps.slicer.maybeYield();
      }
      const after = fstatSync(fd);
      if (total !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return null;
      run.hashedBytes += total;
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  // ---- gone, ignored and the guard (§5.2.5–6) ----

  private markGone(run: Run, key: string): void {
    const row = this.deps.db.entry(this.ctx.key, key);
    if (row && !row.deleted && this.heldPaths?.has(key) && !this.classify(key, row.type === DIRECTORY)) {
      // Held already, with everything that was below it then; nothing can have been indexed below a missing folder since.
      run.goneDirs.add(key);
      this.settling.delete(key);
      return;
    }
    if (row) {
      if (this.classify(key, row.type === DIRECTORY)) this.queueDrop(run, row);
      else if (!row.deleted) run.gone.set(key, row);
      if (isGitignore(key)) run.gitignoreDirs.add(parentKey(key));
    }
    this.settling.delete(key);
    this.markDescendantsGone(run, key);
  }

  private markDescendantsGone(run: Run, key: string): void {
    run.goneDirs.add(key);
    for (const row of this.deps.db.descendants(this.ctx.key, key)) {
      if (this.classify(row.path, row.type === DIRECTORY)) this.queueDrop(run, row);
      else if (!row.deleted) run.gone.set(row.path, row);
    }
    this.deps.unwatchDirectory?.(key);
  }

  /** A path the rules now ignore leaves the index without a tombstone: peers must not delete their copy. */
  private dropIgnored(run: Run, key: string): void {
    const row = this.deps.db.entry(this.ctx.key, key);
    if (row) this.queueDrop(run, row);
    for (const below of this.deps.db.descendants(this.ctx.key, key)) this.queueDrop(run, below);
    this.deps.unwatchDirectory?.(key);
  }

  private queueDrop(run: Run, row: LocalEntry): void {
    run.gone.delete(row.path);
    this.queue(run, { kind: "drop", path: row.path, expect: row.seq });
  }

  private queue(run: Run, change: Change): void {
    run.pending.push(change);
    if (run.pending.length >= this.options.batchSize) this.commit(run);
  }

  /** One writeTx per ≤ batchSize changes, compare-and-set on each row's seq (§5.2.5). */
  private commit(run: Run): void {
    if (!run.pending.length && !run.errorOps.size && !run.reappeared.size) return;
    this.assertCurrent(run);
    const changes = run.pending.splice(0);
    this.deps.hooks?.beforeCommit?.();
    const { db, nodeId } = this.deps;
    const key = this.ctx.key;
    const now = this.now();
    const written: string[] = [];
    const moved: Array<{ path: string; before: LocalEntry | undefined; after: LocalEntry | undefined }> = [];
    const held = this.heldPaths;
    const unheld: string[] = [];
    const unhold = (relative: string) => { if (held?.has(relative)) { db.unhold(key, relative); unheld.push(relative); } };
    let dropped = 0;
    db.writeTx(() => {
      const share = db.share(key)!;
      let maxSeq = share.maxSeq;
      let liveFiles = share.liveFiles;
      let liveBytes = share.liveBytes;
      const digest = new Digest(share.digest);
      const count = (entry: LocalEntry | undefined, sign: number) => {
        if (entry && !entry.deleted && entry.type === FILE) { liveFiles += sign; liveBytes += sign * entry.size; }
      };
      for (const change of changes) {
        const row = db.entry(key, change.path);
        if ((row?.seq ?? null) !== change.expect) { run.conflicts.add(row?.fsName ?? change.path); continue; }
        if (change.kind === "drop") {
          if (row) { digest.change(row, undefined); count(row, -1); db.deleteEntry(key, change.path); moved.push({ path: change.path, before: row, after: undefined }); dropped += 1; }
          unhold(change.path);
          continue;
        }
        if (change.kind === "touch") {
          if (row) db.putEntry(key, { ...row, ...change.fs });
          continue;
        }
        if (change.kind === "tombstone" && (!row || row.deleted)) continue;
        const base = change.kind === "tombstone" ? { ...row!, deleted: true, mtimeMs: now, deletedAt: now } : change.next;
        const next: LocalEntry = { ...base, version: db.nextVersion(row?.version ?? {}, nodeId, now), modifiedBy: nodeId, seq: ++maxSeq };
        digest.change(row, next);
        count(row, -1);
        count(next, 1);
        db.putEntry(key, next);
        unhold(change.path);
        run.changed += 1;
        if (change.kind === "tombstone") run.tombstones += 1;
        written.push(change.path);
        moved.push({ path: change.path, before: row, after: next });
      }
      if (moved.length) this.deps.inTransaction?.(moved);
      for (const back of run.reappeared) unhold(back);
      for (const [errorPath, problem] of run.errorOps) {
        if (problem) db.setError(key, errorPath, problem.kind, problem.reason, now);
        else db.clearError(key, errorPath);
      }
      // A dropped row leaves no tombstone (peers must not delete their copy), so peers learn of it like of a prune:
      // a seq without a row, and prunedBelow above every cursor, which makes them list the index again from 0
      // and lose the rows it no longer has (§5.4) instead of keeping a live row nobody will ever send again.
      const prunedBelow = dropped ? ++maxSeq : share.prunedBelow;
      db.updateShare(key, { maxSeq, digest: digest.toString(), liveFiles, liveBytes, prunedBelow });
    });
    run.reappeared.clear();
    run.errorOps.clear();
    for (const relative of unheld) held!.delete(relative);
    if (written.length || dropped) this.deps.committed?.(written);
  }

  /**
   * Tombstones for the candidates of a complete scan, through the mass-delete guard: per unit (the
   * share, or each top-level worktree / ticket directory), undeclared deletes in the sliding window
   * that reach the minimum and the ratio of the unit's live entries are held instead, and while a unit
   * holds rows, every new delete there is held too. Announced prefixes bypass the guard.
   */
  private settleDeletes(run: Run): void {
    if (!run.gone.size) return;
    this.assertCurrent(run);
    // Candidates collected before a .gitignore change in the same run: what the rules ignore now leaves silently.
    for (const row of [...run.gone.values()]) if (this.classify(row.path, row.type === DIRECTORY)) this.queueDrop(run, row);
    if (!run.complete) {
      // No complete scan of this generation yet: rows an interrupted first scan indexed leave without telling peers.
      const rows = [...run.gone.values()];
      run.gone.clear();
      for (const row of rows) this.queue(run, { kind: "drop", path: row.path, expect: row.seq });
      this.commit(run);
      return;
    }
    const { db } = this.deps;
    const key = this.ctx.key;
    const now = this.now();
    const expected = db.writeTx(() => db.expectedPrefixes(key, now));
    this.window = this.window.filter((entry) => now - entry.at < this.options.guardWindowMs);
    const held = this.heldSet();
    const byUnit = new Map<string, LocalEntry[]>();
    const tombstones: LocalEntry[] = [];
    for (const [candidate, row] of run.gone) {
      if (held.has(candidate)) continue;
      if (expected.some((prefix) => isSameOrInside(candidate, prefix))) { tombstones.push(row); continue; }
      const unit = this.unitOf(candidate);
      const rows = byUnit.get(unit);
      if (rows) rows.push(row); else byUnit.set(unit, [row]);
    }
    run.gone.clear();
    const holds: string[] = [];
    for (const [unit, rows] of byUnit) {
      const sticky = held.size > 0 && db.hasHeld(key, unit);
      if (!sticky) {
        const recent = this.window.reduce((sum, entry) => entry.unit === unit ? sum + entry.count : sum, 0);
        const total = recent + rows.length;
        // The unit's live count only matters at the minimum: a few deletes never count the share.
        if (total < this.options.guardMinimum || total < this.options.guardRatio * (db.liveCount(key, unit) + recent)) {
          tombstones.push(...rows);
          this.window.push({ at: now, unit, count: rows.length });
          continue;
        }
        this.deps.emit({ event: "log", level: "warn", key: `fileSync:${key}:guard`, message: `File sync held ${rows.length} deletions in ${key}${unit ? ` (${unit})` : ""}: confirm them in Settings → File sync` });
      }
      holds.push(...rows.map((row) => row.path));
    }
    for (const row of tombstones) this.queue(run, { kind: "tombstone", path: row.path, expect: row.seq });
    this.commit(run);
    if (holds.length) {
      this.assertCurrent(run);
      db.writeTx(() => { for (const path of holds) db.hold(key, path, now); });
      for (const path of holds) held.add(path);
      run.held += holds.length;
    }
  }

  /** Paths still missing are deleted now; those that came back leave the held set (§5.2.6). */
  releaseHeld(): Promise<ScanResult> {
    return this.exclusive(async () => {
      const started = performance.now();
      const { db } = this.deps;
      const key = this.ctx.key;
      const run = this.newRun();
      const outcome = (error?: string, rescan?: ScanResult): ScanResult => ({
        share: key, changed: run.changed + (rescan?.changed ?? 0), tombstones: run.tombstones + (rescan?.tombstones ?? 0),
        held: error ? this.heldSet().size : rescan?.held ?? 0, newGeneration: false, files: run.files + (rescan?.files ?? 0),
        hashedBytes: rescan?.hashedBytes ?? 0, durationMs: Math.round(performance.now() - started), ...(error ? { error } : {}),
      });
      const share = db.share(key);
      const root = this.checkRoot(false);
      // A folder that is missing, moved or replaced says nothing about the held paths: they stay held.
      if (root.state !== "ok") return outcome(root.message);
      if (!share || share.rootDev !== root.dev || share.rootIno !== root.ino) return outcome("The folder was moved or replaced; it is scanned again before deletions can be confirmed");
      run.identity = { dev: root.dev, ino: root.ino };
      run.complete = true;
      const held = [...this.heldSet()];
      const back: string[] = [];
      try {
        for (const path of held) {
          await this.deps.slicer.maybeYield();
          const row = db.entry(key, path);
          if (!row || row.deleted) { run.reappeared.add(path); continue; }
          // Ignored meanwhile: it leaves the index without a tombstone, as any newly ignored path does.
          if (this.classify(path, row.type === DIRECTORY)) { this.queueDrop(run, row); continue; }
          const fs = row.fsName ?? path;
          let present: boolean;
          // Below a link or a file now counts as gone; an unreadable path stays held.
          try { present = this.linkedAncestor(run, path, fs) === null && this.lstat(fs) !== null; } catch { continue; }
          if (present) { run.reappeared.add(path); back.push(fs); continue; }
          this.queue(run, { kind: "tombstone", path, expect: row.seq });
        }
        this.commit(run);
      } catch (error) {
        run.pending.length = 0;
        if (error instanceof ScanAborted || error instanceof RunStale) return outcome(error.message);
        throw error;
      }
      const released = new Set(held.map((path) => this.unitOf(path)));
      this.window = this.window.filter((entry) => !released.has(entry.unit));
      return outcome(undefined, back.length ? await this.scanNow({ paths: back }, "release") : undefined);
    });
  }

  /** The person confirmed that the replaced-looking folder is the share now: a new generation, then a full scan. */
  confirmReplacedRoot(): Promise<ScanResult> {
    return this.exclusive(async () => {
      const { db } = this.deps;
      const share = db.share(this.ctx.key);
      if (share && share.pendingDev !== null && share.pendingIno !== null) {
        this.newGeneration({ dev: share.pendingDev, ino: share.pendingIno });
        return { ...await this.scanNow("full", "confirm"), newGeneration: true };
      }
      return this.scanNow("full", "confirm");
    });
  }

  /** App-initiated deletes under `prefix` bypass the guard until the time-to-live ends. */
  expectDeletes(prefix: string, ttlMs: number): void {
    const key = prefix === "" ? "" : normalizeRelativePath(prefix.replace(/\/+$/, ""));
    this.deps.db.writeTx(() => this.deps.db.expect(this.ctx.key, key, this.now() + ttlMs));
  }

  /** Tombstones every eligible peer acknowledged and older than the retention go; pruned_below records it (§5.2.8). */
  pruneTombstones(peers: readonly string[] = this.ctx.peers): number {
    if (!peers.length) return 0;
    const { db } = this.deps;
    const share = db.share(this.ctx.key);
    if (!share) return 0;
    const acks = new Map(db.acks(this.ctx.key).filter((ack) => ack.indexId === share.indexId).map((ack) => [ack.peer, ack.seq]));
    if (peers.some((peer) => !acks.has(peer))) return 0;
    const acknowledged = peers.reduce((min, peer) => Math.min(min, acks.get(peer)!), Number.MAX_SAFE_INTEGER);
    const rows = db.prunableTombstones(this.ctx.key, acknowledged, this.now() - this.options.tombstoneRetentionMs);
    if (!rows.length) return 0;
    const highest = rows.reduce((max, row) => Math.max(max, row.seq), share.prunedBelow);
    db.writeTx(() => {
      for (const row of rows) db.deleteEntry(this.ctx.key, row.path);
      db.updateShare(this.ctx.key, { prunedBelow: highest });
    });
    return rows.length;
  }

  // ---- .gitignore option, replaced-root count, builtin housekeeping ----

  private loadGitignore(): void {
    if (!this.ctx.matcher.rules.gitignore) { this.gitIgnored = undefined; return; }
    this.gitIgnored ??= new GitignoreTree((dir) => this.readGitignore(dir));
  }

  /** A folder's own .gitignore, never through a link (git does not follow in-tree ones either); null when there is none. */
  private readGitignore(dir: string): GitignoreSource | null {
    // A folder replaced by a link: the file behind it is not part of the share.
    if (!this.realDirectory(dir)) return null;
    const fs = this.fsOfKey(dir);
    const file = this.abs(fs ? `${fs}/.gitignore` : ".gitignore");
    let fd: number;
    try {
      // A FIFO would block an open: only a regular file is read.
      if (!lstatSync(file).isFile()) return null;
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch {
      return null;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const buffer = Buffer.alloc(Math.min(st.size, GITIGNORE_MAX_BYTES));
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      return { text: buffer.subarray(0, length).toString("utf8"), fingerprint: fingerprint(st) };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** `dir`'s .gitignore no longer matches what classify read: the scan looks at that folder again with the new one. */
  private noteGitignore(run: Run, dir: string): void {
    const tree = this.gitIgnored;
    if (!tree || !this.realDirectory(dir)) return;
    const fs = this.fsOfKey(dir);
    const st = this.lstatQuiet(fs ? `${fs}/.gitignore` : ".gitignore");
    if (tree.changed(dir, st?.isFile() ? fingerprint(st) : null)) run.gitignoreDirs.add(dir);
  }

  /** A .gitignore changed: read it again and look again below its directory (what that turns up may change another). */
  private async afterGitignoreChanges(run: Run): Promise<void> {
    const tree = this.gitIgnored;
    if (!tree || !this.ctx.matcher.rules.gitignore) { run.gitignoreDirs.clear(); return; }
    for (let pass = 0; run.gitignoreDirs.size && pass < 3; pass++) {
      // The new .gitignore rows go in first, so the walk below does not take them for changes again.
      this.commit(run);
      const dirs = [...run.gitignoreDirs].sort((a, b) => depth(a) - depth(b));
      run.gitignoreDirs.clear();
      for (const dir of dirs) tree.invalidate(dir);
      for (const dir of dirs) {
        if (dirs.some((other) => other !== dir && isSameOrInside(dir, other))) continue;
        const fs = this.fsOfKey(dir);
        const st = this.lstatQuiet(fs);
        if (!st?.isDirectory() || !this.realDirectory(dir)) continue;
        run.visited.clear();
        await this.walk(run, dir, fs, st.ino, true);
      }
    }
    run.gitignoreDirs.clear();
  }

  private async countEntries(stopAt: number): Promise<number> {
    let count = 0;
    const stack: Array<{ key: string; fs: string }> = [{ key: "", fs: "" }];
    while (stack.length) {
      const dir = stack.pop()!;
      let dirents: Dirent[];
      try { dirents = readdirSync(this.abs(dir.fs), { withFileTypes: true }); } catch { continue; }
      for (const dirent of dirents) {
        await this.deps.slicer.maybeYield();
        const key = joinKey(dir.key, dirent.name.normalize("NFC"));
        if (this.classify(key, dirent.isDirectory())) continue;
        if (++count >= stopAt) return count;
        if (dirent.isDirectory()) stack.push({ key, fs: joinKey(dir.fs, dirent.name) });
      }
    }
    return count;
  }

  /** Builtin mode only (invariant 7): this engine's abandoned download temps go after an hour idle. */
  private housekeepIgnored(dirent: Dirent, fs: string): void {
    if (this.ctx.phase !== "builtin" || !dirent.isFile() || !ENGINE_TEMP.test(dirent.name)) return;
    try {
      if (this.now() - lstatSync(this.abs(fs)).mtimeMs > this.options.staleTempMs) unlinkSync(this.abs(fs));
    } catch { /* gone already, or the next scan tries again */ }
  }

  /** Builtin mode only: keep this engine's temps out of `git status` through the repository's info/exclude. */
  private async ensureGitExclude(): Promise<void> {
    if (this.excludeChecked || this.ctx.phase !== "builtin") return;
    this.excludeChecked = true;
    const root = this.ctx.root;
    if (!existsSync(path.join(root, ".git"))) return;
    try {
      const file = path.resolve(root, (await runGit(root, ["rev-parse", "--git-path", "info/exclude"])).trim());
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch (error) { if (!isMissing(error)) throw error; }
      if (text.split(/\r?\n/).includes(ENGINE_TEMP_EXCLUDE)) return;
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${ENGINE_TEMP_EXCLUDE}\n`);
    } catch (error) {
      this.deps.emit({ event: "log", level: "warn", key: `fileSync:${this.ctx.key}:exclude`, message: `File sync could not update .git/info/exclude in ${root}: ${(error as Error).message}` });
    }
  }
}
