import { lstatSync, readFileSync, watch as fsWatch, type FSWatcher, type Stats } from "node:fs";
import path from "node:path";
import { isSameOrInside, normalizeRelativePath, parentKey } from "./paths.js";
import type { Clock } from "./types.js";

/* The watcher only says where to look (§5.3); the scanner decides what changed. macOS gets one
   recursive fs.watch (FSEvents) per share; Linux gets one non-recursive fs.watch per non-ignored
   directory, added by the scanner before it lists the directory, because Node's recursive mode there
   takes an inotify watch per file and ignores unref(). Every event name is classified before it counts,
   the engine's own writes are suppressed, and anything that can lose events (a burst, an inotify queue
   near overflow, ENOSPC/EMFILE, a watcher error) degrades the share: the watcher closes, and after a
   backoff it reopens and the share gets a full scan. Nothing here keeps the process alive. */

export type WatchState = "off" | "watching" | "degraded";

export interface WatchBatch {
  /** Event paths as spelled on disk, relative to the root. */
  paths: string[];
  /** Directories to list shallowly: parents of rename-type events, and directories with too many events. */
  shallow: string[];
  /** The watcher may have missed events: walk the whole share. */
  full: boolean;
}

export interface WatchTuning {
  debounceMs: number;
  maxDelayMs: number;
  /** Events in one directory per window before it is listed instead. */
  directoryLimit: number;
  /** Events per share per window before the share is degraded. */
  shareLimit: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export const WATCH_DEFAULTS: WatchTuning = { debounceMs: 1000, maxDelayMs: 5000, directoryLimit: 100, shareLimit: 5000, backoffMs: 15_000, maxBackoffMs: 10 * 60_000 };

/** Linux: half of the kernel's inotify queue, read once; the queue is per worker (one inotify instance). */
export function inotifyBurstLimit(platform: NodeJS.Platform = process.platform, read: () => string = () => readFileSync("/proc/sys/fs/inotify/max_queued_events", "utf8")): number | null {
  if (platform !== "linux") return null;
  let queued = 16_384;
  try { const value = Number.parseInt(read().trim(), 10); if (value > 0) queued = value; } catch { /* the kernel default */ }
  return Math.floor(queued / 2);
}

export interface Fingerprint { size: number; mtimeMs: number; ino?: number }

/** Paths the engine itself just wrote (apply), with what it wrote; matching events are dropped uncounted. */
export class SuppressionRegistry {
  private readonly entries = new Map<string, { fingerprint: Fingerprint | null; expiresAt: number }>();
  constructor(private readonly clock: Clock) {}

  /** `fingerprint` null: the engine deleted the path. */
  add(share: string, key: string, fingerprint: Fingerprint | null, ttlMs = 10_000): void {
    const now = this.clock.now();
    if (this.entries.size > 10_000) for (const [entryKey, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(entryKey);
    this.entries.set(`${share}\0${key}`, { fingerprint, expiresAt: now + ttlMs });
  }

  matches(share: string, key: string, stat: () => Stats | null): boolean {
    const entryKey = `${share}\0${key}`;
    const entry = this.entries.get(entryKey);
    if (!entry) return false;
    if (entry.expiresAt <= this.clock.now()) { this.entries.delete(entryKey); return false; }
    let current: Stats | null;
    try { current = stat(); } catch { return false; }
    if (!entry.fingerprint) return current === null;
    return current !== null && current.size === entry.fingerprint.size && current.mtimeMs === entry.fingerprint.mtimeMs
      && (entry.fingerprint.ino === undefined || current.ino === entry.fingerprint.ino);
  }

  get size(): number { return this.entries.size; }
}

/** Raw events across every share of the worker within one window; above the limit, every share that had events is degraded. */
export class BurstMonitor {
  private windowStart = 0;
  private events = 0;
  private readonly members = new Set<ShareWatcher>();
  constructor(private readonly limit: number | null, private readonly clock: Clock, private readonly windowMs = WATCH_DEFAULTS.maxDelayMs) {}

  record(watcher: ShareWatcher): void {
    if (this.limit === null) return;
    const now = this.clock.now();
    if (now - this.windowStart >= this.windowMs) { this.windowStart = now; this.events = 0; this.members.clear(); }
    this.events += 1;
    this.members.add(watcher);
    if (this.events <= this.limit) return;
    const affected = [...this.members];
    this.events = 0;
    this.members.clear();
    for (const member of affected) member.degrade("The inotify event queue was close to overflowing");
  }
}

export interface ShareWatcherOptions {
  key: string;
  root: string;
  clock: Clock;
  /** "recursive" (macOS FSEvents) or "directories" (Linux inotify, one watch per directory). */
  mode?: "recursive" | "directories";
  /** True when the rules ignore this NFC key as a file (its ancestors counted as directories). */
  ignored(key: string): boolean;
  suppression: SuppressionRegistry;
  burst: BurstMonitor;
  onBatch(batch: WatchBatch): void;
  onState?(state: WatchState, message?: string): void;
  tuning?: Partial<WatchTuning>;
  watch?: typeof fsWatch;
}

function errorCode(error: unknown): string { return (error as NodeJS.ErrnoException)?.code ?? "unknown"; }

export function watchMode(platform: NodeJS.Platform = process.platform): "recursive" | "directories" {
  return platform === "darwin" || platform === "win32" ? "recursive" : "directories";
}

export class ShareWatcher {
  private readonly tuning: WatchTuning;
  private readonly mode: "recursive" | "directories";
  private readonly watchFn: typeof fsWatch;
  private stateValue: WatchState = "off";
  private message: string | undefined;
  private root: FSWatcher | undefined;
  private readonly directories = new Map<string, { watcher: FSWatcher; ino: number }>();
  private dirty = new Map<string, "change" | "rename">();
  private listings = new Set<string>();
  private perDirectory = new Map<string, number>();
  private events = 0;
  private firstAt = 0;
  private lastAt = 0;
  private timer: { cancel(): void } | undefined;
  private resumeTimer: { cancel(): void } | undefined;
  private backoff = 0;
  private degradedAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(private readonly options: ShareWatcherOptions) {
    this.tuning = { ...WATCH_DEFAULTS, ...options.tuning };
    this.mode = options.mode ?? watchMode();
    this.watchFn = options.watch ?? fsWatch;
  }

  get state(): WatchState { return this.stateValue; }
  get stateMessage(): string | undefined { return this.message; }
  get watchedDirectories(): number { return this.mode === "recursive" ? (this.root ? 1 : 0) : this.directories.size; }

  private setState(state: WatchState, message?: string): void {
    this.stateValue = state;
    this.message = message;
    this.options.onState?.(state, message);
  }

  private abs(fsRelative: string): string { return fsRelative ? path.join(this.options.root, fsRelative) : this.options.root; }

  /** Recursive mode watches the root here; directory mode watches the root and lets the scanner add the rest. */
  start(): void {
    if (this.closed || this.stateValue === "watching") return;
    this.setState("watching");
    try {
      if (this.mode === "recursive") {
        const watcher = this.watchFn(this.options.root, { recursive: true, persistent: false }, (type, name) => this.handle(type, name === null ? null : String(name)));
        watcher.on("error", (error) => this.degrade(`The folder watcher failed (${errorCode(error)})`));
        this.root = watcher;
      } else {
        this.watchDirectory("", "", lstatSync(this.options.root).ino);
      }
    } catch (error) {
      // A missing root is not a lost event: the core starts the watcher again once a scan finds the root.
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") { this.closeWatchers(); this.setState("off", "The folder is missing"); return; }
      this.degrade(this.failureMessage(error));
    }
  }

  private failureMessage(error: unknown): string {
    const code = errorCode(error);
    if (code === "ENOSPC") return "This user is out of inotify watches (raise fs.inotify.max_user_watches)";
    if (code === "EMFILE") return "Too many open files to watch this folder";
    return `The folder watcher failed (${code})`;
  }

  /** Directory mode: watch `key` before it is listed. Idempotent; a replaced directory (new inode) is watched again. */
  watchDirectory(key: string, fsRelative: string, ino: number): void {
    if (this.mode !== "directories" || this.stateValue !== "watching") return;
    const existing = this.directories.get(key);
    if (existing && existing.ino === ino) return;
    existing?.watcher.close();
    try {
      const watcher = this.watchFn(this.abs(fsRelative), { persistent: false }, (type, name) => {
        // No name: something about the directory itself; listing it finds out what.
        if (name === null) this.handleDirectory(fsRelative);
        else this.handle(type, fsRelative ? `${fsRelative}/${String(name)}` : String(name));
      });
      watcher.on("error", (error) => {
        // A watched folder that was deleted only ends its own watch; anything else may lose events.
        if (key && (errorCode(error) === "ENOENT" || errorCode(error) === "EPERM")) this.unwatchDirectory(key);
        else this.degrade(this.failureMessage(error));
      });
      this.directories.set(key, { watcher, ino });
    } catch (error) {
      const code = errorCode(error);
      if (key && (code === "ENOENT" || code === "ENOTDIR")) { this.directories.delete(key); return; }
      this.degrade(this.failureMessage(error));
    }
  }

  unwatchDirectory(key: string): void {
    if (this.mode !== "directories" || !this.directories.has(key)) return;
    for (const [watched, entry] of this.directories) {
      if (!isSameOrInside(watched, key) || (key === "" && watched !== "")) continue;
      entry.watcher.close();
      this.directories.delete(watched);
    }
  }

  /** One fs.watch event. Public so tests can drive the classification, counting and debounce directly. */
  handle(eventType: string, relative: string | null): void {
    if (this.stateValue !== "watching") return;
    this.options.burst.record(this);
    if (this.stateValue !== "watching") return;
    // FSEvents without a name means it could not say what changed.
    if (relative === null || relative === "") { if (relative === null) this.degrade("The folder watcher lost track of changes"); return; }
    const spelled = path.sep === "/" ? relative : relative.split(path.sep).join("/");
    let key: string;
    try { key = normalizeRelativePath(spelled); } catch { return; }
    if (this.options.ignored(key)) return;
    if (this.options.suppression.matches(this.options.key, key, () => {
      try { return lstatSync(this.abs(spelled)); } catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null; throw error; }
    })) return;
    const now = this.options.clock.now();
    if (!this.timer) { this.firstAt = now; this.arm(this.tuning.debounceMs); }
    this.lastAt = now;
    this.events += 1;
    const directory = parentKey(spelled);
    this.perDirectory.set(directory, (this.perDirectory.get(directory) ?? 0) + 1);
    if (eventType === "rename") this.dirty.set(spelled, "rename");
    else if (!this.dirty.has(spelled)) this.dirty.set(spelled, "change");
    if (this.events > this.tuning.shareLimit) this.degrade("Too many changes at once");
  }

  private handleDirectory(fsRelative: string): void {
    if (this.stateValue !== "watching") return;
    this.options.burst.record(this);
    if (this.stateValue !== "watching") return;
    const now = this.options.clock.now();
    if (!this.timer) { this.firstAt = now; this.arm(this.tuning.debounceMs); }
    this.lastAt = now;
    this.events += 1;
    this.listings.add(fsRelative);
  }

  private arm(delay: number): void {
    this.timer = this.options.clock.setTimeout(() => this.fire(), Math.max(0, delay));
  }

  /** 1 s after the last event, 5 s after the first at most. */
  private fire(): void {
    this.timer = undefined;
    if (this.stateValue !== "watching") return;
    const now = this.options.clock.now();
    const quiet = now - this.lastAt;
    const waited = now - this.firstAt;
    if (quiet < this.tuning.debounceMs && waited < this.tuning.maxDelayMs) {
      this.arm(Math.min(this.tuning.debounceMs - quiet, this.tuning.maxDelayMs - waited));
      return;
    }
    const batch = this.takeDirty();
    if (batch) this.options.onBatch(batch);
  }

  /** What is pending, now (flush at turn end, project open, handoff); null when nothing is. */
  takeDirty(): WatchBatch | null {
    this.timer?.cancel();
    this.timer = undefined;
    if (!this.dirty.size && !this.listings.size) { this.resetWindow(); return null; }
    const crowded = new Set([...this.perDirectory].filter(([, count]) => count > this.tuning.directoryLimit).map(([directory]) => directory));
    const shallow = new Set([...crowded, ...this.listings]);
    const paths: string[] = [];
    for (const [spelled, kind] of this.dirty) {
      const directory = parentKey(spelled);
      if (crowded.has(directory)) continue;
      paths.push(spelled);
      if (kind === "rename") shallow.add(directory);
    }
    this.resetWindow();
    return { paths, shallow: [...shallow], full: false };
  }

  private resetWindow(): void {
    this.dirty = new Map();
    this.listings = new Set();
    this.perDirectory = new Map();
    this.events = 0;
  }

  private closeWatchers(): void {
    this.root?.close();
    this.root = undefined;
    for (const entry of this.directories.values()) entry.watcher.close();
    this.directories.clear();
  }

  /** Stop watching, drop what is pending, and come back after a backoff with a full scan. */
  degrade(message: string): void {
    if (this.closed || this.stateValue === "degraded") return;
    this.closeWatchers();
    this.timer?.cancel();
    this.timer = undefined;
    this.resetWindow();
    const now = this.options.clock.now();
    // A share that stayed healthy for the longest backoff starts again from the shortest.
    this.backoff = now - this.degradedAt > this.tuning.maxBackoffMs || !this.backoff ? this.tuning.backoffMs : Math.min(this.backoff * 2, this.tuning.maxBackoffMs);
    this.degradedAt = now;
    this.setState("degraded", message);
    this.resumeTimer = this.options.clock.setTimeout(() => this.resume(), this.backoff);
  }

  private resume(): void {
    this.resumeTimer = undefined;
    if (this.closed || this.stateValue !== "degraded") return;
    this.stateValue = "off";
    this.start();
    if (this.state === "watching") this.options.onBatch({ paths: [], shallow: [], full: true });
  }

  /** Reopen at once (the share was reconfigured, or the core wants a fresh start). */
  restart(): void {
    if (this.closed) return;
    this.resumeTimer?.cancel();
    this.resumeTimer = undefined;
    this.closeWatchers();
    this.stateValue = "off";
    this.start();
  }

  close(): void {
    this.closed = true;
    this.closeWatchers();
    this.timer?.cancel();
    this.resumeTimer?.cancel();
    this.timer = undefined;
    this.resumeTimer = undefined;
    this.resetWindow();
    this.stateValue = "off";
  }
}
