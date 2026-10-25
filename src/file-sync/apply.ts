import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync,
  rmdirSync, symlinkSync, unlinkSync, utimesSync, type Dirent, type Stats,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { conflictCopiesOverLimit, placeConflictCopy, type ApplyAction } from "./conflicts.js";
import type { FileSyncDb, LocalEntry, NeedRow } from "./db.js";
import { Digest } from "./digest.js";
import type { IgnoreClass } from "./ignore.js";
import { CHANGED_RETRY_MS, isWorktreeBulk, peerCaughtUp, sameTarget, type NeedEngine } from "./need.js";
import { caseFoldKey, joinInside, normalizeRelativePath, parentKey } from "./paths.js";
import type { ApplyBatchResult, ApplyItemInput, ApplyItemResult, ApplyOutcome } from "./protocol.js";
import type { Trash } from "./trash.js";
import { DIRECTORY, FILE, SYMLINK, type Clock, type IndexEntry, type Phase, type ShareKind } from "./types.js";
import { compareVectors, mergeVectors, vectorsEqual } from "./vectors.js";
import type { SuppressionRegistry } from "./watch.js";

/* Writing peers' versions into a share's tree (FILE-SYNC design §5.5), builtin phase only. Everything
   that can be slow (copies, hashing, fsync, clearing regenerable folders) happens first; then one
   synchronous section per batch re-derives each target, re-checks the source peer, the local row and
   the file on disk, keeps what is there (a conflict copy or the trash), renames, and commits every row
   in one writeTx. Nothing else in the worker runs inside that section, so a scan can never see half of
   an apply, and a crash anywhere leaves either a deterministic temp (resumed or cleaned) or the new
   content in place, which the next scan merges (same content, invariant 3). */

const MiB = 1024 * 1024;
/** Copies at least this big go chunk by chunk (or as a clone) so the worker loop keeps answering (§5.1). */
const BIG_COPY_BYTES = 64 * MiB;
const CHUNK_BYTES = MiB;
/** Not enough disk space: offered again after this. */
export const DISK_RETRY_MS = 60_000;
/** Items per synchronous section of a batch (a count, not a time: where sections end must not depend on timing). */
const SECTION_ITEMS = 32;
const ENGINE_TEMP = /^\.joint-bob-sync\..+\.tmp$/;

/** `.joint-bob-sync.<name40>.<hex16>.tmp` beside the target, hex16 = sha256(share\0path\0content)[0..16]: deterministic, so a download resumes. */
export function tempNameFor(share: string, relative: string, contentId: string): string {
  const base = relative.slice(relative.lastIndexOf("/") + 1);
  const name40 = Array.from(base).slice(0, 40).join("");
  const hex16 = createHash("sha256").update(`${share}\0${relative}\0${contentId}`).digest("hex").slice(0, 16);
  return `.joint-bob-sync.${name40}.${hex16}.tmp`;
}

/** Where a temp may be written: the parent directory (on-disk spelling), created symlink-safely, or why not. */
export type ParentCheck = { ok: true; directory: string } | { ok: false; reason: string; permanent?: boolean };

/** What apply needs of a running share. */
export interface ApplyShare {
  key: string;
  kind: ShareKind;
  root: string;
  phase: Phase;
  /** Eligible peers now (same-folder ones left out): a download's source must still be one at the rename (invariant 8). */
  peers(): readonly string[];
  /** The rules' class of a path (null = synced), .gitignore option included. */
  ignoreClass(path: string, isDirectory: boolean): IgnoreClass | null;
  /** Rows keep on-disk spellings (fs_name, Linux). */
  fsNames: boolean;
}

export interface ApplierDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  need: NeedEngine;
  trash: Trash;
  suppression: SuppressionRegistry;
  share(key: string): ApplyShare | undefined;
  /** "changed": the path is scanned now (on-disk spellings). */
  scanPaths(key: string, fsPaths: string[]): void;
  /** Rows were written: peers are told, the status goes out. */
  committed(key: string): void;
  faults?: { beforeRename?(path: string): void; afterRename?(path: string): void };
  /** Multi-user mode on Linux: group bits are never lowered. */
  multiUser?(): boolean;
  /** Between chunks of hashing and copying (the core's slice budget). */
  maybeYield?(): Promise<void>;
  /** Tests: the case-insensitive checks are darwin's. */
  platform?: NodeJS.Platform;
}

/** An item's end before its rename, with what the caller records; `scan` names more on-disk paths to look at. */
class Outcome extends Error {
  plan?: Partial<Plan>;
  constructor(readonly outcome: Exclude<ApplyOutcome, "applied">, reason: string, readonly retryAfterMs?: number, readonly scan: string[] = []) { super(reason); }
}

/** The rows give another target than the stored one: decided again, and not offered at once if that changes nothing. */
class TargetMoved extends Outcome {
  constructor() { super("stale", "Its target changed"); }
}

/** A folder a peer deleted (or replaced) holds synced files nobody deleted: created or changed here meanwhile. */
class NewerInside extends Outcome {
  constructor() { super("retry", "The folder still holds files that are not deleted elsewhere"); }
}

/** A fault hook threw: a simulated crash, which must leave applyBatch exactly where it happened. */
class FaultCrash extends Error {
  constructor(readonly original: unknown) { super("fault"); }
}

function errorCode(error: unknown): string { return (error as NodeJS.ErrnoException)?.code ?? ""; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function lstatQuiet(file: string): Stats | null {
  try { return lstatSync(file); } catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null; throw error; }
}
function unlinkQuiet(file: string): void { try { unlinkSync(file); } catch { /* gone already */ } }
function depth(key: string): number { let count = 0; for (const char of key) if (char === "/") count++; return count; }
function joinKey(parent: string, name: string): string { return parent ? `${parent}/${name}` : name; }
function typeOf(st: Stats | Dirent): number { return st.isDirectory() ? DIRECTORY : st.isSymbolicLink() ? SYMLINK : FILE; }
/** Both absent, or one entry whose stat says nothing changed. */
function sameStat(a: Stats | null, b: Stats | null): boolean {
  if (!a || !b) return a === b;
  return typeOf(a) === typeOf(b) && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** An fs error as an outcome: no space waits for space, a name this filesystem cannot hold is permanent, anything else is tried again. */
function failure(error: unknown): Outcome {
  if (error instanceof Outcome) return error;
  const code = errorCode(error);
  if (code === "ENOSPC" || code === "EDQUOT") return new Outcome("blocked", "Not enough free disk space", DISK_RETRY_MS);
  if (code === "ENAMETOOLONG" || code === "EILSEQ" || code === "EINVAL") return new Outcome("blocked", "The path is not valid here");
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EEXIST" || code === "ENOTEMPTY") return new Outcome("changed", `Something changed on disk (${code})`);
  return new Outcome("retry", `Could not write (${code || errorText(error)})`);
}

/** The scanner's "unchanged" for a live row: same type and stat fingerprint (a directory by its inode). */
function matchesRow(st: Stats | null, row: LocalEntry): boolean {
  if (!st || typeOf(st) !== row.type) return false;
  if (row.type === DIRECTORY) return st.ino === row.ino;
  return st.size === row.size && st.mtimeMs === row.fsMtimeMs && st.ino === row.ino && st.ctimeMs === row.ctimeMs;
}

/** Directory listings for the darwin spelling checks, kept for one batch and dropped where it writes. */
class DirNames {
  private readonly cache = new Map<string, string[]>();
  list(directory: string): string[] {
    let names = this.cache.get(directory);
    if (!names) { names = readdirSync(directory); this.cache.set(directory, names); }
    return names;
  }
  forget(directory: string): void { this.cache.delete(directory); }
  /** `name` is there with exactly this spelling (normalization aside: APFS finds either form). */
  spelled(directory: string, name: string): boolean {
    const nfc = name.normalize("NFC");
    return this.list(directory).some((entry) => entry === name || entry.normalize("NFC") === nfc);
  }
  /** Another entry that APFS would take for `name`. */
  caseTwin(directory: string, name: string): string | undefined {
    const nfc = name.normalize("NFC");
    const fold = caseFoldKey(nfc);
    return this.list(directory).find((entry) => entry.normalize("NFC") !== nfc && caseFoldKey(entry) === fold);
  }
  /** Live index paths of a folder by case fold, read once per batch: per item it was every row of the folder, O(n²) for a big one. */
  private readonly folds = new Map<string, Map<string, string[]>>();
  rowsFolded(parent: string, read: () => string[]): Map<string, string[]> {
    let folds = this.folds.get(parent);
    if (!folds) {
      folds = new Map();
      for (const child of read()) {
        const fold = caseFoldKey(child);
        const list = folds.get(fold);
        if (list) list.push(child); else folds.set(fold, [child]);
      }
      this.folds.set(parent, folds);
    }
    return folds;
  }
}

interface MovePlan { path: string; fsRel: string; abs: string; seq: number; local: LocalEntry; row: NeedRow }
interface TreeEntry { key: string; fsRel: string; abs: string; type: number; depth: number; ignore: IgnoreClass | null }

interface Plan {
  index: number;
  input: ApplyItemInput;
  path: string;
  row: NeedRow;
  target: IndexEntry;
  localSeq: number | null;
  action: ApplyAction | "move";
  fsRel: string;
  abs: string;
  parentAbs: string;
  /** Content ready beside the target (a verified file, or a link). */
  temp?: string;
  tempIno?: number;
  /** The temp as it was put in place (fetch): the file there afterwards must still be it. */
  placed?: Stats;
  from?: MovePlan;
  failed?: Outcome;
}

type Change =
  /** The local row takes `target` (version merged); its need row goes when it still holds that target. `overwritten`: written over
      once in place, so its row gets a fingerprint no stat matches and the next scan hashes what is there. */
  | { kind: "target"; path: string; target: IndexEntry; st: Stats | null; fsName: string | null; overwritten?: boolean }
  /** A conflict copy: a new local version of the loser's content under the copy's name. */
  | { kind: "copy"; path: string; loser: LocalEntry; st: Stats; fsName: string | null }
  /** A copy over the cap went to the trash: a local delete. */
  | { kind: "removed"; path: string }
  /** A folder apply made (or found) for what it wrote, with no target of its own: a local version, as a scan writes it. */
  | { kind: "folder"; path: string; st: Stats; fsName: string | null };

/** A previous version just put in the trash; indexed for local reuse only once the file it came from is known not to have changed meanwhile. */
interface Kept { file: string; sha256: string | null; size: number }

interface Section {
  changes: Change[];
  trashed: Array<{ file: string; sha256: string; size: number }>;
  done: Map<string, IndexEntry>;
  names: DirNames;
  now: number;
  rescan: string[];
  /** Trash items from this mark on are this batch's: no space check may prune them (they can be the only copy of a version). */
  trashMark: number;
}

export class Applier {
  private closed = false;
  private readonly darwin: boolean;
  /** Folders made for an item's content (by `share\npath` of the item), until they hold something indexed or are removed again. */
  private readonly madeDirs = new Map<string, Array<{ abs: string; key: string; ino: number }>>();

  constructor(private readonly deps: ApplierDeps) {
    this.darwin = (deps.platform ?? process.platform) === "darwin";
  }

  close(): void { this.closed = true; this.madeDirs.clear(); }

  /** Between slices: a stop ends the item, and so does the share leaving builtin (invariant 12: nothing more is removed from its tree). */
  private async yieldNow(share?: ApplyShare): Promise<void> {
    if (this.closed) throw new Outcome("retry", "File sync is stopping");
    await this.deps.maybeYield?.();
    if (this.closed) throw new Outcome("retry", "File sync is stopping");
    if (share) this.stillBuiltin(share);
  }

  /** `phase` reads the running share's phase at each look (configure may change it mid-batch). */
  private stillBuiltin(share: ApplyShare): void {
    if (share.phase !== "builtin") throw new Outcome("stale", "The folder is not on built-in sync here");
  }

  private fault(name: "beforeRename" | "afterRename", file: string): void {
    const hook = this.deps.faults?.[name];
    if (!hook) return;
    try { hook(file); } catch (error) { throw new FaultCrash(error); }
  }

  private modeFor(remote: number, existing: number): number {
    if (this.deps.multiUser?.() && (this.deps.platform ?? process.platform) === "linux") return (remote & 0o707) | (existing & 0o070);
    return remote & 0o777;
  }

  /** The on-disk spelling of a key: the row's fs_name, else its parent's spelling and the NFC name. */
  private fsRelOf(share: ApplyShare, key: string): string {
    if (!share.fsNames || key === "") return key;
    const row = this.deps.db.entry(share.key, key);
    if (row?.fsName) return row.fsName;
    const parent = parentKey(key);
    return parent ? `${this.fsRelOf(share, parent)}/${key.slice(parent.length + 1)}` : key;
  }

  /**
   * §5.5.3: every existing segment above `key` must be a real directory with exactly that spelling;
   * missing ones are created when `create`. A link or a case variant is permanent until someone fixes it;
   * a file in the way may be another need row's to replace (tried again).
   */
  private checkParents(share: ApplyShare, key: string, create: boolean, names: DirNames, madeFor?: string): { directory: string; created: string[] } {
    let current = path.resolve(share.root);
    const root = lstatQuiet(current);
    if (!root) throw new Outcome("retry", "The shared folder is missing");
    if (!root.isDirectory()) throw new Outcome("blocked", "The shared folder is not a folder");
    const parent = parentKey(key);
    const created: string[] = [];
    if (!parent) return { directory: current, created };
    const keys = parent.split("/");
    const spellings = this.fsRelOf(share, parent).split("/");
    for (let index = 0; index < spellings.length; index++) {
      const next = path.join(current, spellings[index]);
      let st = lstatQuiet(next);
      if (!st) {
        if (!create) throw new Outcome("changed", "A folder above it is gone");
        let made = true;
        try { mkdirSync(next); } catch (error) { if (errorCode(error) !== "EEXIST") throw failure(error); made = false; }
        names.forget(current);
        created.push(keys.slice(0, index + 1).join("/"));
        st = lstatSync(next);
        if (made && madeFor !== undefined) this.noteMade(share.key, madeFor, next, keys.slice(0, index + 1).join("/"), st.ino);
      }
      // First: on APFS lstat finds a case twin under this name, and what that twin is says nothing about this folder.
      if (this.darwin && !names.spelled(current, spellings[index])) throw new Outcome("blocked", "A folder above it differs only in case here");
      if (st.isSymbolicLink()) throw new Outcome("blocked", "A folder above it is a symbolic link here");
      if (!st.isDirectory()) {
        // A file another need row will replace with a folder (or delete) is waited for; one nothing here will replace stays
        // in the way until something changes it (a local change there lifts the block).
        const row = this.deps.db.needRow(share.key, keys.slice(0, index + 1).join("/"));
        if (row && !row.blocked && (row.target.deleted || row.target.type === DIRECTORY)) throw new Outcome("retry", "A folder above it is a file here");
        throw new Outcome("blocked", "A folder above it is a file here");
      }
      current = next;
    }
    return { directory: current, created };
  }

  /** The symlink-safe parent preparation the transfer loop runs before it writes a temp (§5.5.3). */
  ensureParents(shareKey: string, relative: string): ParentCheck {
    const share = this.deps.share(shareKey);
    if (!share || share.phase !== "builtin") return { ok: false, reason: "The folder is not on built-in sync here" };
    let key: string;
    try { key = normalizeRelativePath(relative); } catch { return { ok: false, reason: "The path is not valid here", permanent: true }; }
    try {
      return { ok: true, directory: this.checkParents(share, key, true, new DirNames(), key).directory };
    } catch (error) {
      const outcome = failure(error);
      return { ok: false, reason: outcome.message, permanent: outcome.outcome === "blocked" };
    }
  }

  private noteMade(shareKey: string, item: string, abs: string, key: string, ino: number): void {
    const id = `${shareKey}\n${item}`;
    const entry = { abs, key, ino };
    const list = this.madeDirs.get(id);
    if (list) list.push(entry); else this.madeDirs.set(id, [entry]);
  }

  /**
   * Folders made for an item that is no longer wanted (its need row gone: decided away, or applied elsewhere) are
   * removed again while they are empty and not indexed. Left behind, the next scan would read one as a new local
   * folder and bring a folder deleted everywhere back on every node. A folder that holds something stays until that
   * is indexed (then it is the share's) or gone; one replaced by another inode is not ours. Builtin phase only.
   */
  sweepMadeDirs(shareKey: string, options: { leaving?: boolean } = {}): void {
    if (!this.madeDirs.size || this.closed) return;
    const share = this.deps.share(shareKey);
    if (!share || share.phase !== "builtin") return;
    const { db, suppression } = this.deps;
    const prefix = `${shareKey}\n`;
    for (const [id, dirs] of [...this.madeDirs]) {
      // `leaving`: the share is about to leave builtin (configure calls this first), so no item is wanted any more: afterwards
      // nothing may be removed from a tree Syncthing owns again, and an empty folder left there would spread as a new one.
      if (!id.startsWith(prefix) || (!options.leaving && db.needRow(shareKey, id.slice(prefix.length)))) continue;
      const left = [...dirs].sort((a, b) => depth(b.key) - depth(a.key)).filter((dir) => {
        const entry = db.entry(shareKey, dir.key);
        if (entry && !entry.deleted) return false;
        const st = lstatQuiet(dir.abs);
        if (!st?.isDirectory() || st.ino !== dir.ino) return false;
        try {
          if (readdirSync(dir.abs).length) return true;
          rmdirSync(dir.abs);
          suppression.add(shareKey, dir.key, null);
        } catch { /* in use again, or gone meanwhile */ }
        return false;
      });
      if (left.length) this.madeDirs.set(id, left); else this.madeDirs.delete(id);
    }
  }

  // ---- the batch ----

  /**
   * §5.5 for one batch of a share: re-derive, get the content, check parents and case, keep what is there,
   * fsync, rename creates and updates, then deletes deepest first, and commit every row in one writeTx.
   * Every outcome is recorded in the need row here (backoff, blocked), so any caller can just call again.
   */
  async applyBatch(args: { share: string; items: readonly ApplyItemInput[] }): Promise<ApplyBatchResult> {
    try {
      return await this.run(args);
    } catch (error) {
      if (error instanceof FaultCrash) throw error.original;
      throw error;
    }
  }

  private async run(args: { share: string; items: readonly ApplyItemInput[] }): Promise<ApplyBatchResult> {
    const share = this.deps.share(args.share);
    // Invariant 12: nothing is written into a tree whose phase is not builtin, not even a temp removed. A batch already
    // running when the phase leaves (§7 restoring) stops before its next item and section and only removes its own temps.
    if (!share || share.phase !== "builtin") return { applied: 0, recorded: true, items: args.items.map((item) => ({ path: item.path, outcome: "stale", reason: "The folder is not on built-in sync here" })) };
    const results: Array<ApplyItemResult | undefined> = new Array(args.items.length);
    const names = new DirNames();
    const plans: Plan[] = [];
    const seen = new Set<string>();
    for (const [index, input] of args.items.entries()) {
      try {
        let key: string;
        try { key = normalizeRelativePath(input.path); } catch { throw new Outcome("stale", "The path is not valid"); }
        if (seen.has(key)) throw new Outcome("retry", "The same path came twice in one batch");
        seen.add(key);
        plans.push(await this.prepare(share, index, input, key, names));
      } catch (error) {
        if (error instanceof FaultCrash) throw error;
        const outcome = failure(error);
        results[index] = this.settle(share, { ...outcome.plan, input }, outcome);
      }
    }
    // §5.5.7: temps get their final mode and are flushed before any rename, one at a time with synchronous calls between
    // slices: concurrent FileHandle calls filled libuv's pool, which main shares (its own fs and DNS waited behind
    // 256 fsyncs), while a synchronous fsync blocks only this worker.
    for (const plan of plans) {
      try {
        await this.finishTemp(plan);
        await this.yieldNow(share);
      } catch (error) {
        if (error instanceof FaultCrash) throw error;
        plan.failed = failure(error);
      }
    }
    const ready = plans.filter((plan) => !plan.failed);
    for (const plan of plans) if (plan.failed) results[plan.index] = this.settle(share, plan, plan.failed);
    const { trash } = this.deps;
    const mark = trash.mark();
    const outcomes = await this.commit(share, ready, names, mark);
    for (const plan of ready) results[plan.index] = outcomes.get(plan.index) ?? { path: plan.input.path, outcome: "retry", reason: "Not applied" };
    const items = results.map((result, index) => result ?? { path: args.items[index].path, outcome: "retry" as const, reason: "Not applied" });
    // Pruned once the batch is done, outside its section, and never what it just kept: that can be the only copy of a version
    // bigger than the budget (the budget is a soft cap; the next batch prunes it if the trash is still over).
    if (trash.mark() !== mark) {
      try { trash.prune(undefined, { keep: mark }); } catch { /* the next batch prunes again */ }
    }
    // Temps of items that ended here are gone: folders made for those no longer wanted are empty again.
    this.sweepMadeDirs(share.key);
    return { applied: items.filter((item) => item.outcome === "applied").length, items, recorded: true };
  }

  /** What became of an item that ends before (or instead of) its rename. */
  private settle(share: ApplyShare, plan: Partial<Plan> & { input: ApplyItemInput }, outcome: Outcome): ApplyItemResult {
    const { input } = plan;
    // A temp holding the right bytes is kept while the path is only rescanned; anything else it holds is of no use (a link is made again for nothing).
    if (outcome.outcome !== "changed" || plan.action === "symlink") {
      if (plan.temp) unlinkQuiet(plan.temp);
      else if (input.tempPath && this.ownTemp(share, input.tempPath)) unlinkQuiet(input.tempPath);
    }
    if (outcome.outcome === "changed") {
      const paths = [...(plan.fsRel !== undefined ? [plan.fsRel] : []), ...(plan.from ? [plan.from.fsRel] : []), ...outcome.scan];
      if (paths.length) this.deps.scanPaths(share.key, paths);
    }
    const { need, db } = this.deps;
    if (outcome instanceof NewerInside && plan.path && this.keepFolder(share, plan.path)) {
      return { path: input.path, outcome: "stale", reason: "The folder holds files changed here: it stays" };
    }
    if (plan.path && plan.row) {
      const target = plan.row.target;
      if (outcome instanceof TargetMoved) {
        need.reconcilePaths(share.key, [plan.path]);
        // Decided again and still holding the target apply cannot re-derive (rows mid-repull): not offered again at once.
        const row = db.needRow(share.key, plan.path);
        if (row && sameTarget(row.target, target)) need.retryLater(share.key, plan.path, outcome.message);
      }
      // Recorded against the target it was about (a newer one that arrived meanwhile is not held back); a caller that
      // records too finds the row blocked or backing off already.
      else if (outcome.outcome === "blocked") need.block(share.key, plan.path, outcome.message, { target, ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}) });
      else if (outcome.outcome === "retry") need.retryLater(share.key, plan.path, outcome.message, { target });
      else if (outcome.outcome === "changed") need.retryLater(share.key, plan.path, outcome.message, { target, delayMs: CHANGED_RETRY_MS });
    }
    return { path: input.path, outcome: outcome.outcome, reason: outcome.message, ...(outcome.retryAfterMs ? { retryAfterMs: outcome.retryAfterMs } : {}) };
  }

  /** An engine temp inside the share (never anything else is removed on a caller's word). */
  private ownTemp(share: ApplyShare, file: string): boolean {
    const resolved = path.resolve(file);
    const relative = path.relative(path.resolve(share.root), resolved);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && ENGINE_TEMP.test(path.basename(resolved));
  }

  // ---- before the rename: target, parents, content ----

  private async prepare(share: ApplyShare, index: number, input: ApplyItemInput, key: string, names: DirNames): Promise<Plan> {
    const { db, need } = this.deps;
    // The phase may have left builtin while earlier items were prepared: nothing more is made in the tree (not even a parent folder).
    this.stillBuiltin(share);
    const row = db.needRow(share.key, key);
    if (!row || row.blocked) throw new Outcome("stale", "Nothing to apply here any more");
    // Every end from here on carries the plan so far: settle records it against this row's target.
    const plan = { index, input, path: key, row, target: row.target } as Plan;
    try {
      // §5.5.1: the target now, from the rows as they are; and a download's source must still share the folder.
      const derived = need.derive(share.key, key);
      if (!derived?.wanted || !derived.target || derived.decision.kind !== "apply" || !sameTarget(derived.target, row.target)) throw new TargetMoved();
      if (input.source !== undefined && !share.peers().includes(input.source)) throw new Outcome("stale", `${input.source} does not share this folder now`);
      let action: Plan["action"] = derived.decision.action;
      if (input.move) {
        if (row.action !== "move" || row.fromPath === null || action !== "fetch") throw new Outcome("stale", "The rename is not wanted any more");
        action = "move";
      }
      plan.action = action;
      plan.localSeq = derived.local?.seq ?? null;
      plan.fsRel = this.fsRelOf(share, key);
      plan.abs = joinInside(share.root, plan.fsRel);
      plan.parentAbs = path.dirname(plan.abs);
      const fsRel = plan.fsRel;
      plan.parentAbs = this.checkParents(share, key, action !== "delete" && action !== "meta", names, key).directory;
      if (action === "move") plan.from = this.prepareMove(share, plan, names);
      if (this.darwin && action !== "delete" && action !== "meta") this.checkCase(share, plan, names);
      if (action === "fetch") plan.temp = await this.prepareContent(share, plan);
      const local = derived.local;
      // A folder in the way of a delete or a type change: refused early, its regenerable content removed now.
      if (local && !local.deleted && local.type === DIRECTORY && (plan.target.deleted || plan.target.type !== DIRECTORY)) await this.prepareClear(share, key, fsRel);
      return plan;
    } catch (error) {
      if (error instanceof FaultCrash) throw error;
      // Through settle with the plan so far: its temp goes, a changed path is scanned.
      throw Object.assign(failure(error), { plan });
    }
  }

  /**
   * §5.5.4 (darwin): APFS takes a name that differs only in case for this one, so writing would replace
   * that file. A case-only rename is the exception: its move renames exactly that file. A twin that is
   * itself a pending delete goes first (deletes run after creates), so this one waits instead.
   */
  private checkCase(share: ApplyShare, plan: Plan, names: DirNames): void {
    const { db } = this.deps;
    const name = path.basename(plan.abs);
    const fromName = plan.from && path.dirname(plan.from.abs) === plan.parentAbs ? path.basename(plan.from.abs).normalize("NFC") : undefined;
    const onDisk = names.caseTwin(plan.parentAbs, name);
    const parent = parentKey(plan.path);
    const twinKey = onDisk !== undefined ? joinKey(parent, onDisk.normalize("NFC"))
      : names.rowsFolded(parent, () => db.childPaths(share.key, parent)).get(caseFoldKey(plan.path))?.find((child) => child !== plan.path);
    if (twinKey === undefined) return;
    if (fromName !== undefined && twinKey.slice(twinKey.lastIndexOf("/") + 1) === fromName) return;
    const twinNeed = db.needRow(share.key, twinKey);
    if (twinNeed?.action === "delete" && !twinNeed.blocked) throw new Outcome("retry", "Waiting for a name that differs only in case to go");
    throw new Outcome("blocked", `Another name in this folder differs only in case (${twinKey.slice(twinKey.lastIndexOf("/") + 1)})`);
  }

  private prepareMove(share: ApplyShare, plan: Plan, names: DirNames): MovePlan {
    const { db, need } = this.deps;
    const fromPath = plan.row.fromPath!;
    const fromRow = db.needRow(share.key, fromPath);
    const derived = need.derive(share.key, fromPath);
    const local = derived?.local;
    const valid = fromRow?.action === "delete" && !fromRow.blocked && derived?.wanted === true && derived.target?.deleted === true && sameTarget(derived.target, fromRow.target)
      && local !== undefined && !local.deleted && local.type === FILE && local.sha256 === plan.target.sha256;
    if (!valid) {
      // A plain fetch next time, which may still copy the file from there.
      need.unpair(share.key, plan.path);
      throw new Outcome("stale", "The rename's source is no longer a pending delete of this content");
    }
    try { this.checkParents(share, fromPath, false, names); } catch (error) {
      // The source's folders are not what its row says (the index is behind the disk there): whatever is wrong is the
      // source's, never the target's to be blocked for. A plain fetch next time, once the scan had a look.
      need.unpair(share.key, plan.path);
      const parentFs = this.fsRelOf(share, parentKey(fromPath));
      throw new Outcome("changed", `The rename's source cannot be reached: ${failure(error).message}`, undefined, [this.fsRelOf(share, fromPath), ...(parentFs ? [parentFs] : [])]);
    }
    const fsRel = this.fsRelOf(share, fromPath);
    const abs = joinInside(share.root, fsRel);
    if (!matchesRow(lstatQuiet(abs), local!)) throw new Outcome("changed", "The rename's source changed on disk", undefined, [fsRel]);
    return { path: fromPath, fsRel, abs, seq: local!.seq, local: local!, row: fromRow! };
  }

  /** §5.5.2 (b, c): a downloaded temp, or a local copy (any share, the trash) cloned or copied beside the target; hash-verified either way. */
  private async prepareContent(share: ApplyShare, plan: Plan): Promise<string> {
    const { db, trash } = this.deps;
    const { input, target } = plan;
    const sha = target.sha256!;
    if (input.tempPath !== undefined) {
      const temp = path.resolve(input.tempPath);
      if (path.dirname(temp) !== plan.parentAbs || !ENGINE_TEMP.test(path.basename(temp))) throw new Outcome("retry", "The download is not where apply expects it");
      plan.temp = temp;
      // The deterministic name carries the content it was downloaded for: another one is an older (or newer) version's.
      if (path.basename(temp) !== tempNameFor(share.key, plan.path, sha)) throw new Outcome("stale", "The download is of another version");
      // Hashed byte by byte as the transfer wrote it whole: still that very file (inode, size, both times), it is not read again.
      const verified = input.verified;
      const st = verified ? lstatQuiet(temp) : null;
      if (verified && st?.isFile() && st.size === target.size && st.ino === verified.ino && st.size === verified.size && st.mtimeMs === verified.mtimeMs && st.ctimeMs === verified.ctimeMs) {
        plan.tempIno = st.ino;
        return temp;
      }
      plan.tempIno = await this.verify(share, temp, target);
      return temp;
    }
    const source = input.localSource;
    if (!source) throw new Outcome("retry", "No content was given for it");
    const space = trash.ensureSpace(plan.parentAbs, target.size);
    if (!space.ok) throw new Outcome("blocked", space.reason, DISK_RETRY_MS);
    let from: string;
    if ("trash" in source) {
      from = path.resolve(source.trash);
      const relative = path.relative(path.resolve(trash.root), from);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Outcome("retry", "That copy is not in the trash");
    } else {
      const other = this.deps.share(source.share);
      const entry = db.entry(source.share, source.path);
      if (!other || !entry || entry.deleted || entry.type !== FILE || entry.sha256 !== sha) throw new Outcome("retry", "The local copy changed");
      from = joinInside(other.root, this.fsRelOf(other, source.path));
    }
    const st = lstatQuiet(from);
    if (!st || !st.isFile() || st.size !== target.size) {
      if (!st && "trash" in source) db.writeTx(() => db.deleteTrashItem(source.trash));
      throw new Outcome("retry", "The local copy is gone or changed");
    }
    const temp = path.join(plan.parentAbs, tempNameFor(share.key, plan.path, sha));
    plan.temp = temp;
    await this.copy(share, from, temp, target.size);
    plan.tempIno = await this.verify(share, temp, target);
    return temp;
  }

  /** A clone where the filesystem can (APFS, reflinks), else a copy; a big one chunk by chunk between slices. */
  private async copy(share: ApplyShare, from: string, temp: string, size: number): Promise<void> {
    unlinkQuiet(temp);
    // EXCL: a link planted at the temp name is never written through.
    if (size < BIG_COPY_BYTES) { copyFileSync(from, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE); return; }
    try { copyFileSync(from, temp, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE); return; } catch { unlinkQuiet(temp); }
    const source = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const output = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        for (let position = 0; ;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          await output.write(buffer, 0, bytesRead, position);
          position += bytesRead;
          await this.yieldNow(share);
        }
      } finally { await output.close(); }
    } finally { await source.close(); }
  }

  /** The temp's bytes hash to the target's sha256 (never through a link); its inode, so the rename can tell it is still the same file. */
  private async verify(share: ApplyShare, file: string, target: IndexEntry): Promise<number> {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) { throw new Outcome("retry", `The content is not there (${errorCode(error) || errorText(error)})`); }
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size !== target.size) throw new Outcome("retry", "The content is not the size the index says");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      for (let position = 0; ;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
        position += bytesRead;
        await this.yieldNow(share);
      }
      if (hash.digest("hex") !== target.sha256) throw new Outcome("retry", "The content did not match its hash");
      return st.ino;
    } finally { await handle.close(); }
  }

  /** A link is made right before its rename (in the section): the scan's temp cleanup only removes files, so none may be left behind. */
  private linkTemp(share: ApplyShare, plan: Plan): string {
    const temp = path.join(plan.parentAbs, tempNameFor(share.key, plan.path, `link\0${plan.target.target}`));
    unlinkQuiet(temp);
    symlinkSync(plan.target.target!, temp);
    return temp;
  }

  /**
   * The final mode (the multi-user rule) on the temp, then fsync. The mtime is set after the rename: an old
   * mtime on a temp reads as an abandoned download, which the scan's housekeeping removes (§5.2.9).
   */
  private async finishTemp(plan: Plan): Promise<void> {
    if (!plan.temp || plan.target.type !== FILE) return;
    const fd = openSync(plan.temp, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== plan.target.size || (plan.tempIno !== undefined && st.ino !== plan.tempIno)) throw new Outcome("retry", "The download changed before it was put in place");
      // A new file takes the peer's group bits: the temp's (0600) would make the ACL mask --- in multi-user mode, and that
      // stripped mode would become this node's own version and travel to every peer.
      const existing = lstatQuiet(plan.abs);
      const mode = this.modeFor(plan.target.mode, (existing?.isFile() ? existing.mode : plan.target.mode) & 0o777);
      fchmodSync(fd, mode);
      fsyncSync(fd);
      plan.tempIno = st.ino;
    } finally { closeSync(fd); }
  }

  // ---- folders in the way (§5.5.8) ----

  /** Every entry below a directory, one directory at a time, never through a link; each with its class. */
  private *tree(share: ApplyShare, dirKey: string, dirFs: string): Generator<TreeEntry[]> {
    const stack: Array<{ key: string; fs: string }> = [{ key: dirKey, fs: dirFs }];
    while (stack.length) {
      const dir = stack.pop()!;
      const entries: TreeEntry[] = [];
      for (const dirent of readdirSync(joinInside(share.root, dir.fs), { withFileTypes: true })) {
        const key = joinKey(dir.key, dirent.name.normalize("NFC"));
        const fsRel = joinKey(dir.fs, dirent.name);
        const type = typeOf(dirent);
        entries.push({ key, fsRel, abs: joinInside(share.root, fsRel), type, depth: depth(key), ignore: share.ignoreClass(key, type === DIRECTORY) });
        if (type === DIRECTORY) stack.push({ key, fs: fsRel });
      }
      yield entries;
    }
  }

  /** Whether a synced entry below a folder being removed is a pending delete apply may carry out now. */
  private deletable(share: ApplyShare, entry: TreeEntry): Outcome | null {
    const { db, need } = this.deps;
    if (entry.ignore === "local" || entry.ignore === "user") return new Outcome("blocked", "A folder with local-only files is in the way");
    if (entry.ignore !== null) return null;
    const row = db.entry(share.key, entry.key);
    if (!row || row.deleted || row.type !== entry.type) return new Outcome("changed", "The folder holds files that are not indexed yet");
    const needRow = db.needRow(share.key, entry.key);
    const derived = need.derive(share.key, entry.key);
    const valid = needRow?.action === "delete" && !needRow.blocked && derived?.wanted === true && derived.target?.deleted === true && sameTarget(derived.target, needRow.target);
    return valid ? null : new NewerInside();
  }

  /**
   * A modification beats a delete (invariant 4), and a folder's content is its files: one holding synced files no
   * peer deleted stays, with a local version above every peer's tombstone of it, so the peers get it back (a file
   * that replaced it there becomes a conflict copy on that node). Only once every peer's index is here whole: a
   * delete still being paged in would otherwise be undone. Returns whether it was kept.
   */
  private keepFolder(share: ApplyShare, key: string): boolean {
    const { db, need, nodeId } = this.deps;
    if (!share.peers().every((peer) => peerCaughtUp(db.cursor(share.key, peer)))) return false;
    const kept = db.writeTx(() => {
      const before = db.entry(share.key, key);
      if (!before || before.deleted || before.type !== DIRECTORY) return false;
      let base = before.version;
      let mtimeMs = before.mtimeMs;
      for (const peer of share.peers()) {
        const remote = db.remote(share.key, peer, key);
        if (!remote) continue;
        // A file or link that took the folder's place there is a modification too, not a delete: the folder stays concurrent
        // with it, and newer, so it wins everywhere while that file is kept as a conflict copy on its side (invariant 4)
        // instead of going to the trash under a version that dominates it.
        if (!remote.deleted && remote.type !== DIRECTORY) {
          if (compareVectors(remote.version, before.version) !== "less") mtimeMs = Math.max(mtimeMs, remote.mtimeMs + 1);
          continue;
        }
        base = mergeVectors(base, remote.version);
      }
      const row = db.share(share.key)!;
      const now = this.deps.clock.now();
      const next: LocalEntry = { ...before, version: db.nextVersion(base, nodeId, now), mtimeMs, modifiedBy: nodeId, seq: row.maxSeq + 1 };
      db.putEntry(share.key, next);
      db.updateShare(share.key, { maxSeq: next.seq, digest: new Digest(row.digest).change(before, next).toString() });
      need.appliedInTx(share.key, [], [{ path: key, after: next }]);
      return true;
    });
    if (kept) this.deps.committed(share.key);
    return kept;
  }

  /**
   * Why a folder cannot go, one entry at a time: what is not indexed yet and synced files nobody deleted end the look
   * at once; local-only content is remembered and the look goes on, because a synced file nobody deleted further in
   * keeps the folder (a modification beats a delete) instead of leaving it blocked here and its file a stranger on
   * every peer, where its new files then wait under a file forever.
   */
  private refusal(): { note(refused: Outcome | null): void; readonly blocked: Outcome | undefined } {
    let blocked: Outcome | undefined;
    return {
      note(refused) {
        if (!refused) return;
        if (refused.outcome !== "blocked") throw refused;
        blocked ??= refused;
      },
      get blocked() { return blocked; },
    };
  }

  /** Before the section: refuse early, and remove regenerable content (no trash, no rows) between slices. */
  private async prepareClear(share: ApplyShare, dirKey: string, dirFs: string): Promise<void> {
    const regenerable: TreeEntry[] = [];
    const refusal = this.refusal();
    for (const entries of this.tree(share, dirKey, dirFs)) {
      for (const entry of entries) {
        refusal.note(this.deletable(share, entry));
        if (entry.ignore !== null) regenerable.push(entry);
      }
      await this.yieldNow(share);
    }
    if (refusal.blocked) throw refusal.blocked;
    regenerable.sort((a, b) => b.depth - a.depth);
    // Looked at again right before anything goes, and between slices: a tree handed back to Syncthing keeps its node_modules.
    this.stillBuiltin(share);
    for (const [count, entry] of regenerable.entries()) {
      if (entry.type === DIRECTORY) rmdirSync(entry.abs); else unlinkSync(entry.abs);
      if (count % 256 === 255) await this.yieldNow(share);
    }
  }

  /**
   * In the section: what is left below the folder must be pending deletes (each kept in the trash first)
   * or regenerable; anything local-only or not deleted elsewhere refuses the whole folder before
   * anything synced is touched. Never a recursive rm.
   */
  private clearDirectory(share: ApplyShare, dirKey: string, dirFs: string, section: Section): void {
    const entries: TreeEntry[] = [];
    const refusal = this.refusal();
    for (const batch of this.tree(share, dirKey, dirFs)) {
      for (const entry of batch) {
        const refused = this.deletable(share, entry);
        refusal.note(refused);
        if (refused) continue;
        if (entry.ignore === null) {
          const row = this.deps.db.entry(share.key, entry.key)!;
          if (!matchesRow(lstatQuiet(entry.abs), row)) throw new Outcome("changed", "A file in the folder changed on disk");
        }
        entries.push(entry);
      }
    }
    if (refusal.blocked) throw refusal.blocked;
    entries.sort((a, b) => b.depth - a.depth || (a.key < b.key ? 1 : -1));
    for (const entry of entries) {
      if (entry.ignore !== null) {
        if (entry.type === DIRECTORY) rmdirSync(entry.abs); else unlinkSync(entry.abs);
        continue;
      }
      const row = this.deps.db.entry(share.key, entry.key)!;
      const target = this.deps.db.needRow(share.key, entry.key)!.target;
      // A folder that gained something since the walk refuses its rmdir (ENOTEMPTY: changed). A file is looked at again right
      // before it goes: the walk and every removal before it take time, and an agent saving it meanwhile must keep its edit
      // (a modification beats a delete): what went so far is committed, the path is scanned, and the folder stays for it.
      if (entry.type === DIRECTORY) rmdirSync(entry.abs);
      else {
        const now = lstatQuiet(entry.abs);
        if (!matchesRow(now, row)) throw new Outcome("changed", "A file in the folder changed on disk", undefined, [entry.fsRel]);
        this.trashAway(share, entry.key, entry.abs, row, section, now!);
      }
      this.deps.suppression.add(share.key, entry.key, null);
      section.changes.push({ kind: "target", path: entry.key, target, st: null, fsName: row.fsName });
      section.done.set(entry.key, target);
    }
    rmdirSync(joinInside(share.root, dirFs));
    section.names.forget(path.dirname(joinInside(share.root, dirFs)));
  }

  // ---- keeping what is there (§5.5.6) ----

  /** A copy into a trash on another filesystem needs room there (never by pruning what this batch kept); a hard link or a rename needs none. */
  private roomInTrash(st: Stats, section: Section): void {
    const { trash } = this.deps;
    if (trash.fsId(trash.root) === String(st.dev)) return;
    const space = trash.ensureSpace(trash.root, st.size, { keep: section.trashMark });
    if (!space.ok) throw new Outcome("blocked", `Not enough room to keep the previous version (${space.reason.toLowerCase()})`, DISK_RETRY_MS);
  }

  /**
   * A peer-caused overwrite keeps the previous content in the trash (a hard link: the path never disappears), except worktree
   * bulk (D7); `always` for conflict copies over the cap. The caller checks the file did not change meanwhile, then notes it.
   */
  private preserveOld(share: ApplyShare, key: string, abs: string, row: LocalEntry, section: Section, always = false): Kept | undefined {
    if (!always && isWorktreeBulk(share.kind, key)) return undefined;
    const st = lstatSync(abs);
    this.roomInTrash(st, section);
    return { file: this.deps.trash.preserve(share.key, key, abs), sha256: row.type === FILE ? row.sha256 : null, size: st.size };
  }

  /** A kept version whose file held still: indexed for local reuse (§5.5.2). One that moved meanwhile holds no version and goes. */
  private noteKept(section: Section, kept: Kept | undefined, steady: () => void): void {
    try { steady(); } catch (error) {
      if (kept) this.deps.trash.discard(kept.file);
      throw error;
    }
    if (kept?.sha256) section.trashed.push({ file: kept.file, sha256: kept.sha256, size: kept.size });
  }

  /**
   * A peer-caused delete of a file or link that was `expected` when looked at: it moves into the trash (one rename; worktree
   * bulk is just removed), and only that file may go. Written right before the move (same inode, other size or mtime), the
   * edit goes back where it was and the item stops as changed; on another filesystem the trash holds a copy and the
   * original goes once the copy is known to be of it.
   */
  private trashAway(share: ApplyShare, key: string, abs: string, row: LocalEntry, section: Section, expected: Stats, always = false): void {
    const same = (now: Stats | null) => now !== null && typeOf(now) === typeOf(expected) && now.ino === expected.ino && now.size === expected.size && now.mtimeMs === expected.mtimeMs;
    const changed = () => new Outcome("changed", "It changed on disk while it was put in place", undefined, [this.fsRelOf(share, key)]);
    if (!same(lstatQuiet(abs))) throw changed();
    if (!always && isWorktreeBulk(share.kind, key)) { unlinkSync(abs); return; }
    const { trash } = this.deps;
    this.roomInTrash(expected, section);
    const taken = trash.take(share.key, key, abs);
    if (taken.moved) {
      if (!same(taken.stat)) { trash.restore(taken.file, abs); throw changed(); }
    } else {
      if (!same(lstatQuiet(abs))) { trash.discard(taken.file); throw changed(); }
      unlinkSync(abs);
    }
    if (row.type === FILE && row.sha256) section.trashed.push({ file: taken.file, sha256: row.sha256, size: expected.size });
  }

  /**
   * The losing local version stays beside it under the deterministic conflict name; ten copies at most, the oldest go to the
   * trash. `expected` is the file as checked: one written while it was cloned is no copy of the loser (its row would claim the
   * loser's sha256 for other bytes, and no scan would ever hash it again), so the copy goes and the item stops as changed.
   * Returns what went to the trash instead when the loser itself is the oldest copy beyond the cap.
   */
  private conflictCopy(share: ApplyShare, key: string, abs: string, loser: LocalEntry, section: Section, expected: Stats): Kept | undefined {
    const { db } = this.deps;
    const parentFs = parentKey(this.fsRelOf(share, key));
    const fsOf = (candidate: string) => joinKey(parentFs, candidate.slice(candidate.lastIndexOf("/") + 1));
    const placed = placeConflictCopy(key, loser, (candidate) => {
      const row = db.entry(share.key, candidate);
      if (row && !row.deleted) return row;
      // On disk but not indexed: unknown content, never "the same".
      return lstatQuiet(joinInside(share.root, fsOf(candidate))) ? { type: FILE, sha256: null, target: null, deleted: false } : undefined;
    });
    if (placed.preserved) return undefined;
    const siblings = db.childPaths(share.key, parentKey(key));
    const over = conflictCopiesOverLimit(key, [...siblings, placed.path]);
    // The loser would be the oldest copy beyond the cap at once: it goes to the trash instead.
    if (over.includes(placed.path)) return this.preserveOld(share, key, abs, loser, section, true);
    const copyFs = fsOf(placed.path);
    const copyAbs = joinInside(share.root, copyFs);
    // A clone (or a copy) rather than a hard link: should the rename not follow, a link would leave the copy and the
    // file one inode, and an edit of either would change both. A big file nothing can clone is linked (the rename
    // follows at once) so this section never copies gigabytes in one go (§5.1).
    if (loser.type === SYMLINK) symlinkSync(readlinkSync(abs), copyAbs);
    else if (loser.size < BIG_COPY_BYTES) copyFileSync(abs, copyAbs, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    else {
      try { copyFileSync(abs, copyAbs, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE); } catch {
        try { linkSync(abs, copyAbs); } catch (error) {
          if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK"].includes(errorCode(error))) throw error;
          copyFileSync(abs, copyAbs, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        }
      }
    }
    const now = lstatQuiet(abs);
    if (!now || typeOf(now) !== typeOf(expected) || now.ino !== expected.ino || now.size !== expected.size || now.mtimeMs !== expected.mtimeMs) {
      unlinkQuiet(copyAbs);
      throw new Outcome("changed", "It changed on disk while its conflict copy was made");
    }
    if (loser.type !== SYMLINK) utimesSync(copyAbs, loser.mtimeMs / 1000, loser.mtimeMs / 1000);
    const st = lstatSync(copyAbs);
    this.deps.suppression.add(share.key, placed.path, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    section.changes.push({ kind: "copy", path: placed.path, loser, st, fsName: share.fsNames && copyFs !== placed.path ? copyFs : null });
    section.names.forget(path.dirname(copyAbs));
    for (const victim of over) {
      const row = db.entry(share.key, victim);
      if (!row || row.deleted) continue;
      const victimAbs = joinInside(share.root, row.fsName ?? fsOf(victim));
      const victimSt = lstatQuiet(victimAbs);
      if (!matchesRow(victimSt, row)) continue;
      // Someone's edit of an old copy keeps that copy (it changed between the look and the move: skipped, the scan indexes it).
      try { this.trashAway(share, victim, victimAbs, row, section, victimSt!, true); } catch (error) {
        if (error instanceof Outcome && error.outcome === "changed") { section.rescan.push(row.fsName ?? fsOf(victim)); continue; }
        throw error;
      }
      this.deps.suppression.add(share.key, victim, null);
      section.changes.push({ kind: "removed", path: victim });
    }
    return undefined;
  }

  // ---- the section ----

  /**
   * The batch's synchronous sections, SECTION_ITEMS items each with a turn of the worker loop between them (§5.1): one
   * section of 256 items kept the worker from answering main and peers for seconds. Each item is re-derived and checked
   * in its own section, so whatever ran in between is seen; each section commits its rows in one writeTx.
   */
  private async commit(share: ApplyShare, plans: Plan[], names: DirNames, trashMark: number): Promise<Map<number, ApplyItemResult>> {
    const outcomes = new Map<number, ApplyItemResult>();
    // Creates and updates parents first, then deletes deepest first (§5.5.7).
    const ordered = [...plans].sort((a, b) => {
      const deleteA = a.target.deleted ? 1 : 0, deleteB = b.target.deleted ? 1 : 0;
      if (deleteA !== deleteB) return deleteA - deleteB;
      return deleteA ? depth(b.path) - depth(a.path) : depth(a.path) - depth(b.path);
    });
    const done = new Map<string, IndexEntry>();
    for (let at = 0; at < ordered.length; at += SECTION_ITEMS) {
      const part = ordered.slice(at, at + SECTION_ITEMS);
      if (at > 0) {
        // Always a turn (not only when the slice budget ran out), so where sections end never depends on timing.
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          if (this.closed) throw new Outcome("retry", "File sync is stopping");
          this.stillBuiltin(share);
        } catch (error) {
          const outcome = failure(error);
          for (const plan of ordered.slice(at)) outcomes.set(plan.index, this.settle(share, plan, outcome));
          return outcomes;
        }
        // Listings cached for the first section may be out of date after the turn.
        names = new DirNames();
      }
      this.commitSection(share, part, { changes: [], trashed: [], done, names, now: this.deps.clock.now(), rescan: [], trashMark }, outcomes);
    }
    return outcomes;
  }

  private commitSection(share: ApplyShare, plans: Plan[], section: Section, outcomes: Map<number, ApplyItemResult>): void {
    const failed: Array<{ plan: Plan; outcome: Outcome }> = [];
    for (const plan of plans) {
      try {
        this.commitPlan(share, plan, section);
        outcomes.set(plan.index, { path: plan.input.path, outcome: "applied" });
      } catch (error) {
        if (error instanceof FaultCrash) throw error;
        // What it already did stays done (those rows are committed below); the item itself waits.
        failed.push({ plan, outcome: failure(error) });
      }
    }
    // Folders above what was written: shallowest first, so a resurrected folder's own parent is recorded before it.
    const written = plans.filter((plan) => outcomes.get(plan.index)?.outcome === "applied" && !plan.target.deleted);
    for (const parent of [...new Set(written.flatMap((plan) => ancestors(plan.path)))].sort((a, b) => depth(a) - depth(b))) this.adoptDirectory(share, parent, section);
    if (section.changes.length) this.write(share, section);
    if (section.rescan.length) this.deps.scanPaths(share.key, section.rescan);
    for (const { plan, outcome } of failed) outcomes.set(plan.index, this.settle(share, plan, outcome));
  }

  /** §5.5.5–7 for one item, synchronously: checks again, keeps what is there, renames, records. */
  private commitPlan(share: ApplyShare, plan: Plan, section: Section): void {
    const { db, need, suppression } = this.deps;
    const key = share.key;
    const applied = section.done.get(plan.path);
    if (applied && sameTarget(applied, plan.target)) return;
    if (share.phase !== "builtin") throw new Outcome("stale", "The folder is not on built-in sync here");
    const derived = need.derive(key, plan.path);
    if (!derived?.wanted || !derived.target || derived.decision.kind !== "apply" || !sameTarget(derived.target, plan.target)) throw new TargetMoved();
    if (plan.input.source !== undefined && !share.peers().includes(plan.input.source)) throw new Outcome("stale", `${plan.input.source} does not share this folder now`);
    const local = db.entry(key, plan.path);
    if ((local?.seq ?? null) !== plan.localSeq) throw new Outcome("changed", "Its index row changed meanwhile");
    const conflict = derived.decision.conflict;
    this.checkParents(share, plan.path, false, section.names);
    const live = local && !local.deleted ? local : undefined;
    const target = plan.target;
    const abs = plan.abs;
    // §5.5.5: the file is what the index says, right before anything happens to it.
    const check = (): Stats | null => {
      const found = lstatQuiet(abs);
      // On darwin lstat also finds a name that differs only in case; only an exactly spelled entry is this path's.
      const exact = !found || !this.darwin || section.names.spelled(plan.parentAbs, path.basename(abs));
      if (live) {
        if (!exact || !matchesRow(found, live)) throw new Outcome("changed", "It changed on disk");
      } else if (found && !exact) {
        const caseRename = plan.from !== undefined && path.dirname(plan.from.abs) === plan.parentAbs && caseFoldKey(path.basename(plan.from.abs)) === caseFoldKey(path.basename(abs));
        if (!caseRename) throw new Outcome("blocked", "Another name in this folder differs only in case");
      } else if (found && !(found.isDirectory() && !target.deleted && target.type === DIRECTORY)) {
        // What the scan could not index (unreadable, two names for one key) stays in the way until someone looks.
        if (db.hasError(key, plan.path)) throw new Outcome("blocked", "Local-only content is in the way");
        throw new Outcome("changed", "Something not indexed yet is in its place");
      }
      return found;
    };
    let st = check();
    // Looked at again where something else may have written it meanwhile (an agent saving the file while sync places it):
    // an unchanged stat needs no listing, anything else is checked in full.
    const again = () => {
      if (sameStat(lstatQuiet(abs), st)) return;
      section.names.forget(plan.parentAbs);
      st = check();
    };
    // Keeping what is there (a link into the trash, a clone, a folder cleared) takes time: nothing may have written it
    // since. The trash's hard link moves only the ctime.
    const steady = () => {
      const now = lstatQuiet(abs);
      const expected = live?.type === DIRECTORY ? null : st;
      const same = expected === null ? now === null
        : now !== null && typeOf(now) === typeOf(expected) && now.ino === expected.ino && now.size === expected.size && now.mtimeMs === expected.mtimeMs;
      if (!same) throw new Outcome("changed", "It changed on disk while it was put in place");
    };
    // Whether nothing is at the name once keep() ran: nothing was there, or a folder it cleared. A case-only rename's name
    // "holds" its own source (found, no live row), and keep() leaves an old file or link in place (the rename replaces it).
    const emptyName = () => st === null || live?.type === DIRECTORY;
    // Into an empty name a hard link (or the link itself), which fails if something took the name since the look, where a
    // rename would replace it unseen; filesystems without hard links rename.
    const place = (from: string) => {
      if (emptyName()) {
        try { linkSync(from, abs); } catch (error) {
          const code = errorCode(error);
          if (code === "EEXIST") throw new Outcome("changed", "Something was written in its place meanwhile");
          if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"].includes(code)) throw error;
          renameSync(from, abs);
          return;
        }
        unlinkSync(from);
        return;
      }
      renameSync(from, abs);
    };
    /** `overwritten`: someone wrote it after it was placed: indexed so that the scan hashes it, never suppressed. */
    const record = (fresh: Stats | null, overwritten = false) => {
      if (!overwritten) suppression.add(key, plan.path, fresh ? { size: fresh.size, mtimeMs: fresh.mtimeMs, ino: fresh.ino } : null);
      else section.rescan.push(plan.fsRel);
      section.changes.push({ kind: "target", path: plan.path, target, st: fresh, fsName: share.fsNames && plan.fsRel !== plan.path ? plan.fsRel : null, overwritten });
      section.done.set(plan.path, target);
      section.names.forget(plan.parentAbs);
    };
    // What is there goes first: a loser becomes a conflict copy, anything else goes to the trash (or a folder is cleared).
    const keep = () => {
      if (!live) return;
      if (live.type === DIRECTORY) { this.clearDirectory(share, plan.path, plan.fsRel, section); steady(); return; }
      const kept = conflict ? this.conflictCopy(share, plan.path, abs, live, section, st!) : this.preserveOld(share, plan.path, abs, live, section);
      this.noteKept(section, kept, steady);
    };
    switch (plan.action) {
      case "meta": {
        this.fault("beforeRename", abs);
        again();
        const before = st!;
        if (target.type !== SYMLINK) chmodSync(abs, this.modeFor(target.mode, before.mode & 0o777));
        this.fault("afterRename", abs);
        const fresh = lstatSync(abs);
        record(fresh, !(fresh.ino === before.ino && fresh.size === before.size && fresh.mtimeMs === before.mtimeMs));
        return;
      }
      case "mkdir": {
        this.fault("beforeRename", abs);
        again();
        // A file or link in the way: a conflict loser stays as its copy, anything else moves into the trash.
        if (live && live.type !== DIRECTORY) {
          if (conflict) { keep(); unlinkSync(abs); } else this.trashAway(share, plan.path, abs, live, section, st!);
        }
        if (!live || live.type !== DIRECTORY) {
          // An unindexed folder there is adopted; anything else that took the name meanwhile stops the item (EEXIST: changed).
          try { mkdirSync(abs); } catch (error) { if (errorCode(error) !== "EEXIST" || !lstatQuiet(abs)?.isDirectory()) throw error; }
        }
        chmodSync(abs, this.modeFor(target.mode, lstatSync(abs).mode & 0o777));
        this.fault("afterRename", abs);
        const fresh = lstatSync(abs);
        record(fresh, !fresh.isDirectory());
        return;
      }
      case "delete": {
        if (!live) throw new Outcome("changed", "It is already gone here");
        this.fault("beforeRename", abs);
        again();
        if (live.type === DIRECTORY) this.clearDirectory(share, plan.path, plan.fsRel, section);
        else this.trashAway(share, plan.path, abs, live, section, st!);
        this.fault("afterRename", abs);
        record(null);
        return;
      }
      case "move": {
        const from = plan.from!;
        const fromRow = db.needRow(key, from.path);
        const fromDerived = need.derive(key, from.path);
        const fromLocal = db.entry(key, from.path);
        if (!fromRow || !sameTarget(fromRow.target, from.row.target) || !fromDerived?.wanted || !fromDerived.target || !sameTarget(fromDerived.target, fromRow.target)
          || fromLocal?.seq !== from.seq) throw new Outcome("stale", "The rename's source is no longer a pending delete of this content");
        if (!matchesRow(lstatQuiet(from.abs), from.local)) throw new Outcome("changed", "The rename's source changed on disk");
        this.fault("beforeRename", abs);
        again();
        if (!matchesRow(lstatQuiet(from.abs), from.local)) throw new Outcome("changed", "The rename's source changed on disk");
        keep();
        place(from.abs);
        this.fault("afterRename", abs);
        // A rename keeps inode, size and mtime: anything else means someone wrote the file once it was here.
        let moved = lstatSync(abs);
        const untouched = moved.isFile() && moved.ino === from.local.ino && moved.size === from.local.size && moved.mtimeMs === from.local.fsMtimeMs;
        if (untouched) {
          // It keeps mode and mtime, which the peer's rename kept too: set only what differs.
          const mode = this.modeFor(target.mode, moved.mode & 0o777);
          if ((moved.mode & 0o777) !== mode) chmodSync(abs, mode);
          if (Math.abs(moved.mtimeMs - target.mtimeMs) >= 1) utimesSync(abs, target.mtimeMs / 1000, target.mtimeMs / 1000);
          moved = lstatSync(abs);
        }
        suppression.add(key, from.path, null);
        section.changes.push({ kind: "target", path: from.path, target: fromRow.target, st: null, fsName: from.local.fsName });
        section.done.set(from.path, fromRow.target);
        section.names.forget(path.dirname(from.abs));
        record(moved, !untouched);
        return;
      }
      case "fetch":
      case "symlink": {
        if (plan.action === "fetch") {
          const tempSt = lstatQuiet(plan.temp!);
          if (!tempSt?.isFile() || tempSt.size !== target.size || (plan.tempIno !== undefined && tempSt.ino !== plan.tempIno)) throw new Outcome("retry", "The content changed before it was put in place");
        }
        // The fault hook stands for a crash between the temp and the rename: nothing kept or replaced yet (a link's temp not made yet).
        this.fault("beforeRename", abs);
        again();
        if (plan.action === "symlink" && emptyName()) {
          // Into an empty name the link is made there directly: symlink fails if something took the name meanwhile.
          keep();
          try { symlinkSync(target.target!, abs); } catch (error) {
            if (errorCode(error) === "EEXIST") throw new Outcome("changed", "Something was written in its place meanwhile");
            throw error;
          }
        } else {
          if (plan.action === "symlink") plan.temp = this.linkTemp(share, plan);
          const temp = plan.temp!;
          const placed = lstatSync(temp);
          plan.placed = placed;
          keep();
          place(temp);
          plan.temp = undefined;
        }
        this.fault("afterRename", abs);
        // The temp's inode, size and mtime (a link: its target) are what was placed; anything else was written over it since.
        let fresh = lstatSync(abs);
        const placed = plan.placed;
        const untouched = plan.action === "fetch"
          ? fresh.isFile() && placed !== undefined && fresh.ino === placed.ino && fresh.size === placed.size && fresh.mtimeMs === placed.mtimeMs
          : fresh.isSymbolicLink() && readlinkSync(abs) === target.target;
        // A crash before this leaves the right bytes with another mtime: the scan merges them (same content).
        if (untouched && target.type === FILE) {
          utimesSync(abs, target.mtimeMs / 1000, target.mtimeMs / 1000);
          fresh = lstatSync(abs);
        }
        record(fresh, !untouched);
        return;
      }
    }
  }

  /**
   * A folder above something just written that has no live row (created for it, or deleted here before): its
   * pending mkdir is applied with it; without one it is recorded as a scan would record it, a new local
   * version (a deleted folder that holds synced content again is live, §5.2), so the index never says
   * "a live file in a deleted folder".
   */
  private adoptDirectory(share: ApplyShare, dirKey: string, section: Section): void {
    const { db, need } = this.deps;
    if (section.done.has(dirKey)) return;
    const local = db.entry(share.key, dirKey);
    if (local && !local.deleted) return;
    const fsRel = this.fsRelOf(share, dirKey);
    const abs = joinInside(share.root, fsRel);
    const st = lstatQuiet(abs);
    if (!st?.isDirectory() || share.ignoreClass(dirKey, true) !== null) return;
    const fsName = share.fsNames && fsRel !== dirKey ? fsRel : null;
    const row = db.needRow(share.key, dirKey);
    const derived = row && !row.blocked && row.action === "mkdir" ? need.derive(share.key, dirKey) : undefined;
    if (row && derived?.wanted && derived.target && sameTarget(derived.target, row.target)) {
      try { chmodSync(abs, this.modeFor(row.target.mode, st.mode & 0o777)); } catch { return; }
      const fresh = lstatSync(abs);
      this.deps.suppression.add(share.key, dirKey, { size: fresh.size, mtimeMs: fresh.mtimeMs, ino: fresh.ino });
      section.changes.push({ kind: "target", path: dirKey, target: row.target, st: fresh, fsName });
      section.done.set(dirKey, row.target);
      return;
    }
    section.changes.push({ kind: "folder", path: dirKey, st, fsName });
  }

  /** §5.5.9: one writeTx for the batch: rows, digest, live counts, seqs; need rows consumed and decided again; diffs. */
  private write(share: ApplyShare, section: Section): void {
    const { db, need, nodeId } = this.deps;
    const key = share.key;
    const now = section.now;
    db.writeTx(() => {
      const row = db.share(key)!;
      let maxSeq = row.maxSeq;
      let liveFiles = row.liveFiles;
      let liveBytes = row.liveBytes;
      const digest = new Digest(row.digest);
      const count = (entry: LocalEntry | undefined, sign: number) => {
        if (entry && !entry.deleted && entry.type === FILE) { liveFiles += sign; liveBytes += sign * entry.size; }
      };
      const applied: Array<{ path: string; target: IndexEntry }> = [];
      const moved: Array<{ path: string; before: LocalEntry | undefined; after: LocalEntry | undefined }> = [];
      for (const change of section.changes) {
        const before = db.entry(key, change.path);
        let next: LocalEntry;
        if (change.kind === "target") {
          const { target, st } = change;
          const merged = mergeVectors(before?.version ?? {}, target.version);
          // The local version was concurrent with the target (a conflict it lost): the union alone could be the very
          // vector another node reaches by deciding the other way over other rows (three nodes, a tombstone in play),
          // one vector for two contents that then never change again. A bump makes this outcome a version of its own.
          const lost = !vectorsEqual(merged, target.version);
          if (target.deleted || !st) {
            next = {
              ...(before ?? { fsName: null, ino: 0, ctimeMs: 0, fsMtimeMs: 0 }), path: change.path, type: target.type, size: target.size, mtimeMs: target.mtimeMs,
              mode: target.mode, sha256: target.sha256, target: target.target, deleted: true, version: lost ? db.nextVersion(merged, nodeId, now) : merged,
              modifiedBy: target.modifiedBy, seq: ++maxSeq, deletedAt: now,
            } as LocalEntry;
          } else if (change.overwritten) {
            // What it holds now is someone's newer edit: no stat matches a -1 fingerprint, so the scan hashes it and makes it a version of its own.
            next = {
              path: change.path, fsName: change.fsName, type: target.type, size: target.size, mtimeMs: target.mtimeMs, mode: target.mode,
              sha256: target.sha256, target: target.target, deleted: false, version: lost ? db.nextVersion(merged, nodeId, now) : merged,
              modifiedBy: target.modifiedBy, seq: ++maxSeq, ino: st.ino, ctimeMs: -1, fsMtimeMs: -1, deletedAt: null,
            };
          } else {
            const mode = st.isSymbolicLink() ? 0 : st.mode & 0o777;
            // Group bits kept in multi-user mode make this node's mode its own version, as a scan would.
            const own = target.type !== SYMLINK && mode !== target.mode;
            next = {
              path: change.path, fsName: change.fsName, type: target.type, size: st.isDirectory() ? 0 : st.size, mtimeMs: target.mtimeMs, mode,
              sha256: target.sha256, target: target.target, deleted: false, version: own || lost ? db.nextVersion(merged, nodeId, now) : merged,
              modifiedBy: own ? nodeId : target.modifiedBy, seq: ++maxSeq, ino: st.ino, ctimeMs: st.ctimeMs, fsMtimeMs: st.mtimeMs, deletedAt: null,
            };
          }
          applied.push({ path: change.path, target });
        } else if (change.kind === "copy") {
          const { loser, st } = change;
          next = {
            path: change.path, fsName: change.fsName, type: loser.type, size: st.size, mtimeMs: loser.mtimeMs, mode: loser.type === SYMLINK ? 0 : st.mode & 0o777,
            sha256: loser.sha256, target: loser.target, deleted: false, version: db.nextVersion(before?.version ?? {}, nodeId, now), modifiedBy: nodeId,
            seq: ++maxSeq, ino: st.ino, ctimeMs: st.ctimeMs, fsMtimeMs: st.mtimeMs, deletedAt: null,
          };
        } else if (change.kind === "folder") {
          const { st } = change;
          if (before && !before.deleted) continue;
          next = {
            path: change.path, fsName: change.fsName, type: DIRECTORY, size: 0, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, sha256: null, target: null, deleted: false,
            version: db.nextVersion(before?.version ?? {}, nodeId, now), modifiedBy: nodeId, seq: ++maxSeq, ino: st.ino, ctimeMs: st.ctimeMs, fsMtimeMs: st.mtimeMs, deletedAt: null,
          };
        } else {
          if (!before || before.deleted) continue;
          next = { ...before, deleted: true, mtimeMs: now, deletedAt: now, version: db.nextVersion(before.version, nodeId, now), modifiedBy: nodeId, seq: ++maxSeq };
        }
        digest.change(before, next);
        count(before, -1);
        count(next, 1);
        db.putEntry(key, next);
        moved.push({ path: change.path, before, after: next });
      }
      for (const item of section.trashed) db.putTrashItem(item.file, item.sha256, item.size, now);
      if (section.trashed.length) db.pruneTrashIndex(now - 8 * 86_400_000);
      db.updateShare(key, { maxSeq, digest: digest.toString(), liveFiles, liveBytes });
      need.appliedInTx(key, applied, moved);
    });
    this.deps.committed(key);
  }
}

function ancestors(key: string): string[] {
  const list: string[] = [];
  for (let parent = parentKey(key); parent; parent = parentKey(parent)) list.push(parent);
  return list;
}
