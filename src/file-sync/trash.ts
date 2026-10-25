import { createHash } from "node:crypto";
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statfsSync, symlinkSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import type { Clock } from "./types.js";

/* Previous content is kept before any peer-caused overwrite or delete (invariant 5), under
   <dataDir>/file-sync/trash/<fsId>/<YYYYMMDD>/<shareHash>/<path> — never inside a repository. <fsId> is
   the filesystem the content came from. Disk rules (§1, §5.5.10): no download may take a filesystem
   below F = max(2 GiB, 1 % of it), counting reservations; the trash has one budget per filesystem
   (5 GiB on APFS, 1 GiB elsewhere, never more than 25 % of free space plus the trash itself) and is
   pruned oldest first, before any download is refused. */

export const GiB = 1024 ** 3;
const DAY = 86_400_000;
export const TRASH_RETENTION_MS = 7 * DAY;

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
}

export interface TrashItem { fsId: string; day: string; file: string; size: number; at: number }
export type SpaceCheck = { ok: true; freeBytes: number; floorBytes: number } | { ok: false; reason: string; freeBytes: number; floorBytes: number };

export class Trash {
  readonly root: string;
  private readonly retentionMs: number;
  private readonly budgetBytes: number;
  private readonly disk: (target: string) => DiskInfo;
  private readonly link: (from: string, to: string) => void;
  private readonly reservations = new Map<string, number>();
  /** Bytes per <fsId> directory; filled by the first listing and kept current by preserve/prune. */
  private sizes: Map<string, number> | undefined;

  constructor(private readonly options: TrashOptions) {
    this.root = path.join(options.dataDir, "file-sync", "trash");
    this.retentionMs = options.retentionMs ?? TRASH_RETENTION_MS;
    this.budgetBytes = options.budgetBytes ?? defaultTrashBudget();
    this.disk = options.disk ?? statfsDisk;
    this.link = options.link ?? linkSync;
  }

  /** The filesystem holding `target` (or its nearest existing parent). */
  fsId(target: string): string { return String(nearestExisting(target).stat.dev); }

  private day(now: number): string { return new Date(now).toISOString().slice(0, 10).replace(/-/g, ""); }

  private items(fsId?: string): TrashItem[] {
    const items: TrashItem[] = [];
    let filesystems: string[];
    try { filesystems = fsId ? [fsId] : readdirSync(this.root); } catch { return items; }
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
            // ctime moves when the file is linked in, so it is the time it entered the trash.
            else items.push({ fsId: filesystem, day, file, size: stat.isSymbolicLink() ? 0 : stat.size, at: stat.ctimeMs });
          }
        }
      }
    }
    return items;
  }

  private sizeMap(): Map<string, number> {
    if (!this.sizes) {
      this.sizes = new Map();
      for (const item of this.items()) this.sizes.set(item.fsId, (this.sizes.get(item.fsId) ?? 0) + item.size);
    }
    return this.sizes;
  }

  /** Trash bytes from one filesystem, or all of it. */
  sizeBytes(fsId?: string): number {
    const sizes = this.sizeMap();
    if (fsId !== undefined) return sizes.get(fsId) ?? 0;
    let total = 0;
    for (const size of sizes.values()) total += size;
    return total;
  }

  /** The budget of one <fsId> directory: the default, capped at 25 % of free space plus what the trash holds. */
  budget(fsId: string): number {
    let free = 0;
    try { free = this.disk(this.root).freeBytes; } catch { /* no trash yet: the parent answers below */ }
    return Math.min(this.budgetBytes, Math.floor(0.25 * (free + this.sizeBytes(fsId))));
  }

  private unique(target: string): string {
    for (let attempt = 0; ; attempt++) {
      const candidate = attempt ? `${target}~${attempt}` : target;
      try { lstatSync(candidate); } catch { return candidate; }
    }
  }

  /**
   * Keeps the current content of `absolute` (a file or a symbolic link) and returns where. A hard link
   * when the trash shares the filesystem, so apply can rename the new file over the original and the
   * path never disappears; a copy across filesystems.
   */
  preserve(shareKey: string, relative: string, absolute: string): string {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) throw new Error("A folder is preserved through its files");
    // Sizes are listed before the new item exists, so it is counted once.
    const sizes = this.sizeMap();
    const fsId = String(stat.dev);
    const shareHash = createHash("sha256").update(shareKey).digest("hex").slice(0, 16);
    const target = this.unique(path.join(this.root, fsId, this.day(this.options.clock.now()), shareHash, ...relative.split("/")));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(absolute), target);
    else {
      try {
        this.link(absolute, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EMLINK") throw error;
        copyFileSync(absolute, target, constants.COPYFILE_FICLONE);
      }
    }
    sizes.set(fsId, (sizes.get(fsId) ?? 0) + (stat.isSymbolicLink() ? 0 : stat.size));
    if (this.sizeBytes(fsId) > this.budget(fsId)) this.prune(fsId);
    return target;
  }

  private remove(items: TrashItem[]): number {
    let freed = 0;
    const sizes = this.sizeMap();
    for (const item of items) {
      try { unlinkSync(item.file); } catch { continue; }
      freed += item.size;
      sizes.set(item.fsId, Math.max(0, (sizes.get(item.fsId) ?? 0) - item.size));
    }
    return freed;
  }

  private removeEmptyDirectories(): void {
    const sweep = (directory: string): boolean => {
      let names: string[];
      try { names = readdirSync(directory); } catch { return false; }
      let empty = true;
      for (const name of names) {
        const child = path.join(directory, name);
        let stat: Stats;
        try { stat = lstatSync(child); } catch { continue; }
        if (!stat.isDirectory() || !sweep(child)) { empty = false; continue; }
        try { rmdirSync(child); } catch { empty = false; }
      }
      return empty;
    };
    sweep(this.root);
  }

  /** Retention first, then the budget, oldest first. Runs at worker start and after each write. */
  prune(fsId?: string): { removed: number; freedBytes: number } {
    const now = this.options.clock.now();
    const items = this.items(fsId).sort((a, b) => a.day.localeCompare(b.day) || a.at - b.at);
    const expired = items.filter((item) => {
      const start = Date.UTC(Number(item.day.slice(0, 4)), Number(item.day.slice(4, 6)) - 1, Number(item.day.slice(6, 8)));
      return Number.isNaN(start) || start + DAY + this.retentionMs <= now;
    });
    let freedBytes = this.remove(expired);
    let removed = expired.length;
    const gone = new Set(expired);
    const remaining = items.filter((item) => !gone.has(item));
    for (const filesystem of new Set(remaining.map((item) => item.fsId))) {
      const own = remaining.filter((item) => item.fsId === filesystem);
      const budget = this.budget(filesystem);
      let size = this.sizeBytes(filesystem);
      const victims: TrashItem[] = [];
      for (const item of own) {
        if (size <= budget) break;
        victims.push(item);
        size -= item.size;
      }
      freedBytes += this.remove(victims);
      removed += victims.length;
    }
    if (removed) this.removeEmptyDirectories();
    return { removed, freedBytes };
  }

  /** Room for `bytes` more on the filesystem of `directory`, after reservations; prunes this filesystem's trash before refusing. */
  ensureSpace(directory: string, bytes: number): SpaceCheck {
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
    // Only trash bytes that live on that filesystem help: hard-linked items from it, when the trash is there too.
    if (this.fsId(this.root) !== fsId) return first;
    let deficit = first.floorBytes - (first.freeBytes - (this.reservations.get(fsId) ?? 0) - bytes);
    const victims: TrashItem[] = [];
    for (const item of this.items().sort((a, b) => a.day.localeCompare(b.day) || a.at - b.at)) {
      if (deficit <= 0) break;
      victims.push(item);
      deficit -= item.size;
    }
    if (!victims.length) return first;
    this.remove(victims);
    this.removeEmptyDirectories();
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
