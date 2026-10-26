import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmdirSync, statfsSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import type { Clock } from "./types.js";

/* Previous content is kept before any peer-caused overwrite or delete (invariant 5), under
   <dataDir>/file-sync/trash/<fsId>/<YYYYMMDD>/<shareHash>/<path> — never inside a repository. <fsId> is
   the filesystem the content came from. Disk rules (§1, §5.5.10): no download may take a filesystem
   below F = max(2 GiB, 1 % of it), counting reservations; the trash has one budget per filesystem
   (5 GiB on APFS, 1 GiB elsewhere, never more than 25 % of free space plus the trash itself) and is
   pruned oldest first, before any download is refused. The budget is a soft cap: what the running
   apply just kept is never pruned (it may be the only copy of a version), so a file bigger than the
   budget stays until a later apply prunes. The items are listed once and then kept in memory, so
   keeping a file never walks the trash. */

export const GiB = 1024 ** 3;
const DAY = 86_400_000;
export const TRASH_RETENTION_MS = 7 * DAY;
/** Pruning for the budget goes down to this share of it, so a full trash is not pruned again on every keep. */
const LOW_WATER = 0.9;

export interface DiskInfo { freeBytes: number; totalBytes: number }

/** The free space a filesystem keeps: Syncthing's minDiskFree parity. */
export function applyFloorBytes(totalBytes: number): number {
  return Math.max(2 * GiB, Math.ceil(totalBytes * 0.01));
}

export function defaultTrashBudget(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? 5 * GiB : GiB;
}

function nearestExisting(target: string): { path: string; stat: Stats } {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try { return { path: current, stat: lstatSync(current) }; } catch (error) {
      if (current === path.dirname(current)) throw error;
    }
  }
}

export function statfsDisk(target: string): DiskInfo {
  const stats = statfsSync(nearestExisting(target).path);
  return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
}

export interface TrashOptions {
  dataDir: string;
  clock: Clock;
  retentionMs?: number;
  /** Per-filesystem budget before the 25 % cap. */
  budgetBytes?: number;
  disk?(target: string): DiskInfo;
  /** Injectable for tests (EXDEV fallback). */
  link?(from: string, to: string): void;
  /** Tests: darwin puts a taken file back without a hard link (renameIntoEmptyName). */
  platform?: NodeJS.Platform;
}

/** One trashed file. `order` grows with every keep: items at or above a mark() are what an apply kept since. */
export interface TrashItem { fsId: string; day: string; file: string; size: number; at: number; order: number }
export type SpaceCheck = { ok: true; freeBytes: number; floorBytes: number } | { ok: false; reason: string; freeBytes: number; floorBytes: number };
/** Items kept at or after this mark are never pruned (the running apply's). */
export interface KeepSince { keep?: number }

const LINK_FALLBACK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EMLINK"]);

/**
 * Moves `from` to the empty name `to` (EEXIST when something took it), as a hard link and an unlink would, for darwin:
 * there FSEvents never reports the later delete of a file that ever had a second link (measured on APFS, 2026-10-26),
 * so a delete of a file sync placed waited for the hourly walk. An empty placeholder taken exclusively holds the name,
 * and the rename replaces only it.
 */
export function renameIntoEmptyName(from: string, to: string): void {
  const fd = openSync(to, "wx");
  let ino: number;
  try { ino = fstatSync(fd).ino; } finally { closeSync(fd); }
  try { renameSync(from, to); } catch (error) {
    // Only the placeholder goes: whatever replaced it meanwhile stays.
    try { if (lstatSync(to).ino === ino) unlinkSync(to); } catch { /* gone already */ }
    throw error;
  }
}

function dayStart(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)));
}

export class Trash {
  readonly root: string;
  private readonly retentionMs: number;
  private readonly budgetBytes: number;
  private readonly disk: (target: string) => DiskInfo;
  private readonly link: (from: string, to: string) => void;
  private readonly darwin: boolean;
  private readonly reservations = new Map<string, number>();
  /** Every item by file, oldest kept first; listed from disk once, then kept current by every keep and removal. */
  private index: Map<string, TrashItem> | undefined;
  private readonly sizes = new Map<string, number>();
  private nextOrder = 0;

  constructor(private readonly options: TrashOptions) {
    this.root = path.join(options.dataDir, "file-sync", "trash");
    this.retentionMs = options.retentionMs ?? TRASH_RETENTION_MS;
    this.budgetBytes = options.budgetBytes ?? defaultTrashBudget();
    this.disk = options.disk ?? statfsDisk;
    this.link = options.link ?? linkSync;
    this.darwin = (options.platform ?? process.platform) === "darwin";
  }

  /** The filesystem holding `target` (or its nearest existing parent). */
  fsId(target: string): string { return String(nearestExisting(target).stat.dev); }

  private day(now: number): string { return new Date(now).toISOString().slice(0, 10).replace(/-/g, ""); }

  /** What is on disk, oldest first (by day, then ctime: it moves when the file is linked in, so it is the time it entered the trash). */
  private walk(): Array<Omit<TrashItem, "order">> {
    const items: Array<Omit<TrashItem, "order">> = [];
    let filesystems: string[];
    try { filesystems = readdirSync(this.root); } catch { return items; }
    for (const filesystem of filesystems) {
      let days: string[];
      try { days = readdirSync(path.join(this.root, filesystem)); } catch { continue; }
      for (const day of days) {
        const stack = [path.join(this.root, filesystem, day)];
        while (stack.length) {
          const directory = stack.pop()!;
          let names: string[];
          try { names = readdirSync(directory); } catch { continue; }
          for (const name of names) {
            const file = path.join(directory, name);
            let stat: Stats;
            try { stat = lstatSync(file); } catch { continue; }
            if (stat.isDirectory()) stack.push(file);
            else items.push({ fsId: filesystem, day, file, size: stat.isSymbolicLink() ? 0 : stat.size, at: stat.ctimeMs });
          }
        }
      }
    }
    return items.sort((a, b) => a.day.localeCompare(b.day) || a.at - b.at);
  }

  private items(): Map<string, TrashItem> {
    if (!this.index) {
      this.index = new Map();
      for (const item of this.walk()) this.track(item);
    }
    return this.index;
  }

  private track(item: Omit<TrashItem, "order">): TrashItem {
    const tracked = { ...item, order: this.nextOrder++ };
    this.items().set(tracked.file, tracked);
    this.sizes.set(tracked.fsId, (this.sizes.get(tracked.fsId) ?? 0) + tracked.size);
    return tracked;
  }

  private untrack(item: TrashItem): void {
    if (!this.index?.delete(item.file)) return;
    this.sizes.set(item.fsId, Math.max(0, (this.sizes.get(item.fsId) ?? 0) - item.size));
  }

  /** The order the next kept item gets: pass it as `keep` to leave everything kept from now on alone. */
  mark(): number { this.items(); return this.nextOrder; }

  /** Trash bytes from one filesystem, or all of it. */
  sizeBytes(fsId?: string): number {
    this.items();
    if (fsId !== undefined) return this.sizes.get(fsId) ?? 0;
    let total = 0;
    for (const size of this.sizes.values()) total += size;
    return total;
  }

  /** The budget of one <fsId> directory: the default, capped at 25 % of free space plus what the trash holds. */
  budget(fsId: string): number {
    let free = 0;
    try { free = this.disk(this.root).freeBytes; } catch { /* no trash yet: the parent answers below */ }
    return Math.min(this.budgetBytes, Math.floor(0.25 * (free + this.sizeBytes(fsId))));
  }

  /**
   * The trash folder for `segments` below `base`. A component that is a file there already (a file of that name was
   * trashed the same day, then a folder took its name) gets a `~N` twin, so the next preserve never fails on it.
   */
  private directoryFor(base: string, segments: readonly string[]): string {
    let current = base;
    mkdirSync(current, { recursive: true, mode: 0o700 });
    for (const segment of segments) {
      for (let attempt = 0; ; attempt++) {
        const candidate = path.join(current, attempt ? `${segment}~${attempt}` : segment);
        let st: Stats | undefined;
        try { st = lstatSync(candidate); } catch { /* free */ }
        if (st?.isDirectory()) { current = candidate; break; }
        if (!st) { mkdirSync(candidate, { mode: 0o700 }); current = candidate; break; }
      }
    }
    return current;
  }

  private unique(target: string): string {
    for (let attempt = 0; ; attempt++) {
      const candidate = attempt ? `${target}~${attempt}` : target;
      try { lstatSync(candidate); } catch { return candidate; }
    }
  }

  private place(shareKey: string, relative: string, stat: Stats): { fsId: string; day: string; target: string } {
    if (stat.isDirectory()) throw new Error("A folder is preserved through its files");
    this.items();
    const fsId = String(stat.dev);
    const day = this.day(this.options.clock.now());
    const shareHash = createHash("sha256").update(shareKey).digest("hex").slice(0, 16);
    const segments = relative.split("/");
    const name = segments.pop()!;
    return { fsId, day, target: this.unique(path.join(this.directoryFor(path.join(this.root, fsId, day, shareHash), segments), name)) };
  }

  /**
   * Keeps the current content of `absolute` (a file or a symbolic link) and returns where. A hard link
   * when the trash shares the filesystem, so apply can rename the new file over the original and the
   * path never disappears; a copy across filesystems. Never prunes: the caller prunes once its apply is done.
   */
  preserve(shareKey: string, relative: string, absolute: string): string {
    const stat = lstatSync(absolute);
    const { fsId, day, target } = this.place(shareKey, relative, stat);
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(absolute), target);
    else {
      try {
        this.link(absolute, target);
      } catch (error) {
        if (!LINK_FALLBACK.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        copyFileSync(absolute, target, constants.COPYFILE_FICLONE);
      }
    }
    this.track({ fsId, day, file: target, size: stat.isSymbolicLink() ? 0 : stat.size, at: this.options.clock.now() });
    return target;
  }

  /**
   * Moves `absolute` into the trash (a delete: the path goes anyway, and one rename is far cheaper than a link
   * and an unlink on APFS). `moved` false: the trash is on another filesystem, so it holds a copy and the
   * caller removes the original. `stat` is what was moved, for the caller's check that it was the file it meant.
   */
  take(shareKey: string, relative: string, absolute: string): { file: string; moved: boolean; stat: Stats } {
    const before = lstatSync(absolute);
    const { fsId, day, target } = this.place(shareKey, relative, before);
    try {
      renameSync(absolute, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      return { file: this.preserve(shareKey, relative, absolute), moved: false, stat: before };
    }
    const stat = lstatSync(target);
    this.track({ fsId, day, file: target, size: stat.isSymbolicLink() ? 0 : stat.size, at: this.options.clock.now() });
    return { file: target, moved: true, stat };
  }

  /** Puts a taken file back at `absolute` when nothing took that name since (a hard link, on darwin a held name and a rename: never over something); false when something did. */
  restore(file: string, absolute: string): boolean {
    try {
      if (this.darwin) renameIntoEmptyName(file, absolute);
      else linkSync(file, absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    this.discard(file);
    return true;
  }

  /** Drops an item that keeps nothing (its original never went). */
  discard(file: string): void {
    try { unlinkSync(file); } catch { /* gone already */ }
    const item = this.items().get(file);
    if (item) this.untrack(item);
    this.sweep([file]);
  }

  private remove(items: TrashItem[]): number {
    let freed = 0;
    for (const item of items) {
      try { unlinkSync(item.file); } catch (error) {
        // Gone already (someone took it back out): it frees nothing, but it is no longer the trash's either.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
        this.untrack(item);
        continue;
      }
      freed += item.size;
      this.untrack(item);
    }
    this.sweep(items.map((item) => item.file));
    return freed;
  }

  /** Removes the folders that held `files` once they are empty, up to the trash root (never a walk of the whole trash). */
  private sweep(files: string[]): void {
    const directories = new Set(files.map((file) => path.dirname(file)));
    for (const start of [...directories].sort((a, b) => b.length - a.length)) {
      for (let directory = start; directory.startsWith(this.root + path.sep); directory = path.dirname(directory)) {
        try { rmdirSync(directory); } catch { break; }
      }
    }
  }

  private byAge(fsId?: string, keep?: number): TrashItem[] {
    const items = [...this.items().values()].filter((item) => (fsId === undefined || item.fsId === fsId) && (keep === undefined || item.order < keep));
    return items.sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order);
  }

  /**
   * Retention first, then the budget, oldest first, down to LOW_WATER of it. Runs at worker start and after each apply
   * that kept something; items kept at or after `keep` are never removed, even when the trash stays over its budget.
   */
  prune(fsId?: string, options: KeepSince = {}): { removed: number; freedBytes: number } {
    const now = this.options.clock.now();
    const items = this.byAge(fsId, options.keep);
    const expired = items.filter((item) => {
      const start = dayStart(item.day);
      return Number.isNaN(start) || start + DAY + this.retentionMs <= now;
    });
    let freedBytes = this.remove(expired);
    let removed = expired.length;
    const gone = new Set(expired);
    const remaining = items.filter((item) => !gone.has(item));
    for (const filesystem of new Set(remaining.map((item) => item.fsId))) {
      const budget = this.budget(filesystem);
      let size = this.sizeBytes(filesystem);
      if (size <= budget) continue;
      const victims: TrashItem[] = [];
      for (const item of remaining) {
        if (item.fsId !== filesystem) continue;
        if (size <= budget * LOW_WATER) break;
        victims.push(item);
        size -= item.size;
      }
      freedBytes += this.remove(victims);
      removed += victims.length;
    }
    return { removed, freedBytes };
  }

  /**
   * Room for `bytes` more on the filesystem of `directory`, after reservations; prunes the trash before refusing, but only
   * when that can close the gap (otherwise the trash would be emptied for a refusal anyway, every time the item is offered).
   */
  ensureSpace(directory: string, bytes: number, options: KeepSince = {}): SpaceCheck {
    const fsId = this.fsId(directory);
    const check = (): SpaceCheck => {
      const disk = this.disk(directory);
      const floorBytes = applyFloorBytes(disk.totalBytes);
      const available = disk.freeBytes - (this.reservations.get(fsId) ?? 0) - bytes;
      return available >= floorBytes
        ? { ok: true, freeBytes: disk.freeBytes, floorBytes }
        : { ok: false, reason: "Not enough free disk space", freeBytes: disk.freeBytes, floorBytes };
    };
    const first = check();
    if (first.ok) return first;
    // Only trash bytes on that filesystem help, which is all of them when the trash is there (copies from elsewhere included).
    if (this.fsId(this.root) !== fsId) return first;
    let deficit = first.floorBytes - (first.freeBytes - (this.reservations.get(fsId) ?? 0) - bytes);
    const candidates = this.byAge(undefined, options.keep);
    if (candidates.reduce((sum, item) => sum + item.size, 0) < deficit) return first;
    const victims: TrashItem[] = [];
    for (const item of candidates) {
      if (deficit <= 0) break;
      victims.push(item);
      deficit -= item.size;
    }
    if (!victims.length) return first;
    this.remove(victims);
    return check();
  }

  /** Counts `bytes` against the filesystem of `directory` until released (an in-flight download). */
  reserve(directory: string, bytes: number): { fsId: string; release(): void } {
    const fsId = this.fsId(directory);
    this.reservations.set(fsId, (this.reservations.get(fsId) ?? 0) + bytes);
    let released = false;
    return {
      fsId,
      release: () => {
        if (released) return;
        released = true;
        const left = (this.reservations.get(fsId) ?? 0) - bytes;
        if (left > 0) this.reservations.set(fsId, left); else this.reservations.delete(fsId);
      },
    };
  }

  reserved(fsId: string): number { return this.reservations.get(fsId) ?? 0; }
}
