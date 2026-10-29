import { performance } from "node:perf_hooks";
import { decideGlobal, pickTarget, sameContent, sameMeta, type Decision } from "./conflicts.js";
import { HIDDEN_DIFF, type CursorRow, type FileSyncDb, type LocalEntry, type NeedAction, type NeedRow } from "./db.js";
import { caseFoldKey, isSameOrInside, normalizeRelativePath, parentKey } from "./paths.js";
import type { DifferenceItem, ListPage, LocalSource, NeedItem, PendingFiles } from "./protocol.js";
import { DIRECTORY, FILE, type Clock, type IndexEntry, type Phase, type ShareKind } from "./types.js";
import { compareVectors, mergeVectors, vectorsEqual } from "./vectors.js";
import { WireError, type IndexPage } from "./wire.js";

/* What peers' index rows mean for this node (FILE-SYNC design §5.4). In shadow mode pulled pages are
   stored, identical content merges version vectors (so every node ends up with the same version of a
   path Syncthing already copied), and every other difference only lands in `diffs`, which is what the
   switch to builtin mode is judged by. In the builtin phase the same decisions (decideGlobal over the
   local row and every eligible peer's row) also keep the need queue: one row per path holding the full
   target version, which the transfer loop takes in priority order and apply.ts writes to disk. */

/** Rows read per recompute query; how many of them one slice evaluates is up to its time budget. */
const RECOMPUTE_CHUNK = 500;
/** Rows between two looks at the clock inside a slice. */
const CLOCK_EVERY = 32;
/** The slice budget without a core to ask (§5.1: 10 ms while requests wait). */
const DEFAULT_SLICE_MS = 10;
export const DEFAULT_SETTLE_MS = 2 * 60_000;

export interface NeedShare {
  key: string;
  phase: Phase;
  /** Hash of the local effective rules (compared with each peer's announced one). */
  rulesHash: string;
  /** Peers whose rows count: the share's eligible peers minus same-folder ones. */
  peers(): readonly string[];
  /** Whether the local rules leave the path out of the share. */
  ignored(path: string, isDirectory: boolean): boolean;
  /** Need priorities and the worktree trash exemption depend on it; project when absent. */
  kind?: ShareKind;
  /** False while the share's folder is missing or unreadable: its rows wait, nothing is handed out for it. */
  available?(): boolean;
}

/** Worktree files below this size go early: a worktree's listing and metadata are made of them. */
export const SMALL_WORKTREE_FILE = 64 * 1024;
const MAX_RETRY_MS = 300_000;
/** A path changed on disk under an apply: tried again once the scan has had a look. */
export const CHANGED_RETRY_MS = 2000;
/** The switch to builtin decides every path again while pulls keep storing rows during its pass, this often at most. */
const BOOTSTRAP_PASSES = 3;

function hasSegment(path: string, test: (segment: string) => boolean): boolean {
  for (const segment of path.split("/")) if (test(segment)) return true;
  return false;
}

const isBaseline = (segment: string) => segment.startsWith(".joint-bob-baseline");

/** `.joint-bob-worktree/**` and `.joint-bob-baseline*`: kept like project files in every share (invariant 5). */
export function isWorktreeMetadata(path: string): boolean {
  return hasSegment(path, (segment) => segment === ".joint-bob-worktree" || isBaseline(segment));
}

/** The disposable bulk of a worktree share: everything but its metadata and baselines. Never trashed (D7). */
export function isWorktreeBulk(kind: ShareKind | undefined, path: string): boolean {
  return kind === "worktrees" && !isWorktreeMetadata(path);
}

/** §5.4: 1 worktree metadata and small worktree files, 2 project, 3 tickets, 4 worktree bulk, 5 baselines (0 = an explicit prioritize). */
export function needPriority(kind: ShareKind | undefined, path: string, size: number): number {
  if (hasSegment(path, isBaseline)) return 5;
  if (hasSegment(path, (segment) => segment === ".joint-bob-worktree")) return 1;
  if (kind === "worktrees") return size < SMALL_WORKTREE_FILE ? 1 : 4;
  return kind === "tickets" ? 3 : 2;
}

function depthOf(path: string): number {
  let count = 0;
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) count++;
  return count;
}

/** One version, exactly: vector, content, mode, and the mtime and producer conflict copies are named after. */
export function sameTarget(a: IndexEntry, b: IndexEntry): boolean {
  return vectorsEqual(a.version, b.version) && sameMeta(a, b) && a.mtimeMs === b.mtimeMs && a.modifiedBy === b.modifiedBy;
}

/**
 * Whether a newly derived target `next` replaces the stored one: it dominates it, or it won over it among the
 * current rows (decideGlobal's pick is the winner; pairwise conflictWinner can disagree with it once three
 * versions meet, and keeping the pairwise winner would leave a target apply can never re-derive). Only a
 * target the stored one dominates is refused: rows going back are a partial view (a peer's index being
 * pulled again), which the whole listing at its end corrects (recomputeNeed).
 */
export function supersedes(next: IndexEntry, stored: IndexEntry): boolean {
  return !sameTarget(next, stored) && compareVectors(stored.version, next.version) !== "greater";
}

/** Every row of the peer's current index is here: a whole listing of the generation it announces, up to its newest seq. */
export function peerCaughtUp(cursor: CursorRow | undefined): boolean {
  return Boolean(cursor?.indexId && cursor.listed && (cursor.peerIndexId ?? cursor.indexId) === cursor.indexId && cursor.seq >= cursor.peerMaxSeq);
}

function backoffMs(attempts: number): number { return Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.max(0, attempts - 1)); }

export type { LocalSource, NeedItem } from "./protocol.js";

export interface NextNeedsOptions {
  limit: number;
  /** Peers a transfer can reach now; every eligible peer when absent. */
  availablePeers?: readonly string[];
  /** `share\npath` keys (or {share, path}) a transfer is working on. */
  inFlight?: Iterable<string | { share: string; path: string }>;
  shares?: readonly string[];
}

/** What the rows say about one path now: apply re-derives with this before it writes (§5.5.1). */
export interface Derived {
  local: LocalEntry | undefined;
  remotes: Map<string, IndexEntry>;
  target: IndexEntry | undefined;
  decision: Decision;
  /** An apply the queue keeps: the share is builtin with a complete index, and the rules do not leave the path out. */
  wanted: boolean;
}

export interface BootstrapResult { merged: number; need: number }

export interface NeedDeps {
  db: FileSyncDb;
  nodeId: string;
  clock: Clock;
  /** Differences younger than this are still settling (Syncthing has not copied them yet) and are not counted. */
  settleMs: number;
  share(key: string): NeedShare | undefined;
  /** Local rows changed outside a scan (merges): peers are told and the status goes out. */
  localChanged(key: string): void;
  /** A peer's settled difference count or clean-since moved. */
  comparisonChanged(key: string, peer: string, differences: number, cleanSince: number | null): void;
  /** A comparison was computed in full: its differences are all there now (the live consistency check may look). */
  compared?(key: string, peer: string): void;
  /** The core's slice budget in ms (§5.1: 10 while requests wait, else 50). */
  sliceMs?(): number;
  /** Between slices of long work. */
  yieldNow?(): Promise<void>;
  warn?(key: string, message: string): void;
  /** Running shares (nextNeeds looks at these); the shares this engine saw ready when absent. */
  shareKeys?(): readonly string[];
  /** The share's need rows changed (status goes out; the transfer loop takes another look). */
  needChanged?(key: string): void;
}

export interface StoreResult {
  /** The page could not be stored on top of what we had (new generation, missed tombstones, a dropped share): pull again. */
  restart: boolean;
  stored: number;
  merged: number;
  cursor: number;
}

type Kind = DifferenceItem["kind"];
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Pages must move the cursor forward or the pull loop would never end; anything else is a broken peer. */
function checkPage(since: number, page: IndexPage): void {
  let previous = since;
  for (const entry of page.entries) {
    if (entry.seq <= previous || entry.seq > page.maxSeq) throw new WireError("Index page entries are out of order");
    previous = entry.seq;
  }
  if (page.more && !page.entries.length) throw new WireError("Index page says there is more but holds nothing");
}

function picked(entry: IndexEntry | undefined): DifferenceItem["local"] {
  return entry ? { size: entry.size, mtimeMs: entry.mtimeMs, sha256: entry.sha256, deleted: entry.deleted } : undefined;
}

/**
 * Identical content held elsewhere (invariant 3): the union of every such version, with the mtime and
 * producer of the pick among them, so every node holding the content ends with one version and one
 * (mtimeMs, modifiedBy), which conflict copies are named after (§3.4). Only rows with the local
 * content count: a third version of the path may come and go (an index reset, a peer leaving the
 * share) without anything deciding the merge again. Undefined when the local row says it all already.
 */
export function mergeIdentical(local: IndexEntry, remotes: Iterable<IndexEntry>): Pick<IndexEntry, "version" | "mtimeMs" | "modifiedBy"> | undefined {
  const group: IndexEntry[] = [local];
  for (const remote of remotes) if (sameMeta(local, remote)) group.push(remote);
  if (group.length === 1) return undefined;
  const version = group.reduce((merged, entry) => mergeVectors(merged, entry.version), local.version);
  const source = pickTarget(group)!;
  if (vectorsEqual(version, local.version) && source.mtimeMs === local.mtimeMs && source.modifiedBy === local.modifiedBy) return undefined;
  return { version, mtimeMs: source.mtimeMs, modifiedBy: source.modifiedBy };
}

export class NeedEngine {
  private readonly recomputing = new Set<string>();
  /** Tracked peers that left the share's peer set for a while: their differences were not kept up to date meanwhile. */
  private readonly stale = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private readonly timers = new Map<string, { at: number; timer: { cancel(): void } }>();
  private readonly dirty = new Set<string>();
  private refreshQueued = false;
  private closed = false;
  /** Builtin shares whose need rows are kept, with the index generation that was complete under the current rules (§5.4). */
  private readonly ready = new Map<string, string>();
  /** Full need recomputes: single flight per share, once more when asked during one. */
  private readonly needRuns = new Map<string, { again: boolean }>();
  private readonly prioritized = new Map<string, Array<{ prefix: string; until: number }>>();
  private priorityTimer: { at: number; timer: { cancel(): void } } | undefined;
  /** Local rows a scan changed that now merge with identical remote content, once the scan's transaction committed. */
  private readonly mergeLater = new Map<string, Set<string>>();
  private mergeQueued = false;
  private readonly needTouched = new Set<string>();
  private notifyQueued = false;
  private readonly needListeners = new Set<(key: string) => void>();
  /** Shares nextNeeds left out because their folder was missing: the scan that finds it back hands their rows out again. */
  private readonly waitingForRoot = new Set<string>();

  constructor(private readonly deps: NeedDeps) {}

  private now(): number { return this.deps.clock.now(); }
  private yieldNow(): Promise<void> { return (this.deps.yieldNow ?? yieldTurn)(); }
  private sliceMs(): number { return this.deps.sliceMs?.() ?? DEFAULT_SLICE_MS; }

  // ---- storing pulled pages (§5.4) ----

  /**
   * Stores one page pulled with `since`. A page of another index generation, an index that shrank, or
   * a prune since our last page that reached above our cursor (tombstones we never saw are gone, so
   * rows we hold may be deleted there) resets the peer's rows first; with since > 0 the page is then
   * useless and the caller pulls again from 0. A listing from 0 that passes an older prunedBelow is
   * fine: what was pruned before it started has no row there to miss. The page goes in time slices;
   * a share dropped (or given a new generation) between two of them ends it, so the rest cannot land
   * in its place.
   */
  async storeRemote(key: string, peer: string, since: number, page: IndexPage): Promise<StoreResult> {
    const { db, nodeId } = this.deps;
    checkPage(since, page);
    const cursor = db.cursor(key, peer);
    const otherGeneration = cursor?.indexId !== undefined && cursor.indexId !== null && cursor.indexId !== page.indexId;
    const missedPrune = since > 0 && since < page.prunedBelow && page.prunedBelow > (cursor?.peerPrunedBelow ?? 0);
    const shrank = since > page.maxSeq;
    if (otherGeneration || missedPrune || shrank || (since > 0 && !cursor?.indexId)) {
      this.resetPeer(key, peer);
      if (since > 0) return { restart: true, stored: 0, merged: 0, cursor: 0 };
    }
    const entries = page.entries;
    const cursorAfter = page.more ? entries[entries.length - 1].seq : page.maxSeq;
    const generation = db.share(key)?.indexId;
    let merged = 0;
    let relisted = false;
    for (let start = 0; ;) {
      if (this.closed || generation === undefined || !this.deps.share(key) || db.share(key)?.indexId !== generation) {
        if (merged) this.deps.localChanged(key);
        return { restart: true, stored: start, merged, cursor: since };
      }
      const deadline = performance.now() + this.sliceMs();
      const now = this.now();
      const slice = db.writeTx(() => {
        const reconciler = this.reconciler(key, now);
        let at = start;
        while (at < entries.length) {
          const entry = entries[at++];
          // Counters this node issued and forgot (lost index) come back here: never issue them again.
          db.raiseClock(entry.version, nodeId);
          db.putRemote(key, peer, entry);
          reconciler.reconcile(entry.path);
          if ((at - start) % CLOCK_EVERY === 0 && performance.now() >= deadline) break;
        }
        const count = reconciler.finish();
        if (at >= entries.length) {
          const before = db.cursor(key, peer);
          relisted = !page.more && !before?.listed;
          const sameAnnounced = before?.peerIndexId === page.indexId;
          // A notice may have announced more than this snapshot holds; the snapshot's digest and rules stay paired with its
          // own maxSeq, so they count only when it is the newest (a rules change takes a seq of its own on the sender).
          const newer = !sameAnnounced || page.maxSeq >= (before?.peerMaxSeq ?? 0);
          db.updateCursor(key, peer, {
            indexId: page.indexId, seq: cursorAfter, peerIndexId: page.indexId,
            peerMaxSeq: newer ? page.maxSeq : before!.peerMaxSeq, ...(newer ? { peerDigest: page.digest } : {}),
            peerBuiltinSince: page.builtinSince, listed: page.more ? before?.listed ?? false : true, peerPrunedBelow: page.prunedBelow,
            ...(page.rulesHash && newer ? { peerRulesHash: page.rulesHash } : {}),
          }, now);
        }
        return { at, count };
      });
      merged += slice.count;
      start = slice.at;
      if (start >= entries.length) break;
      await this.yieldNow();
    }
    if (merged) this.deps.localChanged(key);
    // A whole listing again (first pull, or after a reset): stored targets that only the forgotten rows explained are decided anew.
    if (relisted && this.isNeedActive(key)) this.recomputeNeed(key);
    return { restart: false, stored: entries.length, merged, cursor: cursorAfter };
  }

  /** Drops what this node holds of one peer's index (rows, cursor, differences); the next pull starts at 0. */
  resetPeer(key: string, peer: string): void {
    this.deps.db.writeTx(() => this.deps.db.resetPeer(key, peer));
    this.queueRefresh(key);
  }

  /**
   * Inside a writeTx: decides paths against every eligible peer's row. Identical content merges into
   * the local row (a new seq when it changes anything); in the builtin phase an apply decision keeps
   * the path's need row, in shadow mode every other difference only lands in `diffs`. finish() records
   * the seqs taken and returns how many rows merged. `force` replaces stored need targets even with
   * older ones (rules or peers changed: what the rows say now is the whole truth).
   */
  private reconciler(key: string, now: number, force = false): { reconcile(path: string): void; finish(): number } {
    const share = this.deps.share(key);
    const { db } = this.deps;
    const peers = share?.peers() ?? [];
    const compared = share ? peers.filter((peer) => db.shadowClean(key, peer) !== undefined) : [];
    const needs = share !== undefined && this.needActive(share);
    let maxSeq: number | undefined;
    let merged = 0;
    return {
      reconcile: (path) => {
        if (!share) return;
        let local: LocalEntry | undefined = db.entry(key, path);
        const rows = new Map<string, IndexEntry>();
        for (const peer of peers) {
          const row = db.remote(key, peer, path);
          if (row) rows.set(peer, row);
        }
        // Paths the local rules ignore never move anything here (their rows are kept for a rules change).
        if (local && !share.ignored(path, local.type === DIRECTORY)) {
          const merge = mergeIdentical(local, rows.values());
          if (merge) {
            maxSeq ??= db.share(key)!.maxSeq;
            local = { ...local, ...merge, seq: ++maxSeq };
            db.putEntry(key, local);
            merged += 1;
          }
        }
        if (needs) this.updateNeed(share, path, local, rows, force);
        for (const peer of compared) this.evaluate(share, peer, path, local, rows.get(peer), now);
      },
      finish: () => {
        if (maxSeq !== undefined) db.updateShare(key, { maxSeq });
        return merged;
      },
    };
  }

  // ---- differences (§5.4) ----

  /**
   * What kind of difference there is for one peer, or null: absent counts as deleted. A live side the local rules
   * ignore is no difference, but a hidden row: under the rules both announce, only an index that is not rescanned
   * yet holds one, and that index's digest counts it.
   */
  private differenceKind(share: NeedShare, path: string, local: IndexEntry | undefined, remote: IndexEntry | undefined): Kind | typeof HIDDEN_DIFF | null {
    const localLive = local !== undefined && !local.deleted;
    const remoteLive = remote !== undefined && !remote.deleted;
    if (!localLive && !remoteLive) return null;
    if (localLive && share.ignored(path, local.type === DIRECTORY)) return HIDDEN_DIFF;
    if (remoteLive && share.ignored(path, remote.type === DIRECTORY)) return HIDDEN_DIFF;
    if (localLive && remoteLive) {
      if (sameMeta(local, remote)) return null;
      return sameContent(local, remote) ? "mode" : "content";
    }
    return localLive ? "only-here" : "only-there";
  }

  /** Inside a writeTx: brings one path's difference row for one peer up to date; `since` keeps when it started. */
  private evaluate(share: NeedShare, peer: string, path: string, local: IndexEntry | undefined, remote: IndexEntry | undefined, now: number): void {
    const { db } = this.deps;
    const kind = this.differenceKind(share, path, local, remote);
    const existing = db.diff(share.key, peer, path);
    if (kind === null) {
      if (existing) { db.deleteDiff(share.key, peer, path); this.queueRefresh(share.key); }
      return;
    }
    if (!existing) { db.putDiff(share.key, peer, path, now, kind); this.queueRefresh(share.key); }
    else if (existing.kind !== kind && (existing.kind === HIDDEN_DIFF || kind === HIDDEN_DIFF)) {
      // Hidden time is no time spent differing: a real difference starts settling when it appears.
      db.deleteDiff(share.key, peer, path);
      db.putDiff(share.key, peer, path, now, kind);
      this.queueRefresh(share.key);
    } else if (existing.kind !== kind) db.putDiff(share.key, peer, path, existing.since, kind);
  }

  /** The scanner's inTransaction seam: local rows moved, so their differences move in the same transaction. */
  localChangesInTx(key: string, changes: ReadonlyArray<{ path: string; after: LocalEntry | undefined }>): void {
    const share = this.deps.share(key);
    if (!share) return;
    const { db } = this.deps;
    if (this.needActive(share)) {
      // Need moves in the same transaction as the local rows it depends on (§5.4). A merge takes a seq of its own,
      // which the caller is counting right now: it is written once this transaction committed.
      const peers = share.peers();
      for (const change of changes) {
        const rows = new Map<string, IndexEntry>();
        for (const peer of peers) {
          const row = db.remote(key, peer, change.path);
          if (row) rows.set(peer, row);
        }
        if (this.updateNeed(share, change.path, change.after, rows, false) === "merge") this.queueMerge(key, change.path);
      }
      this.unblockRelated(key, changes.map((change) => change.path));
    }
    const compared = share.peers().filter((peer) => db.shadowClean(key, peer) !== undefined);
    if (!compared.length) return;
    const now = this.now();
    for (const change of changes) {
      for (const peer of compared) this.evaluate(share, peer, change.path, change.after, db.remote(key, peer, change.path), now);
    }
  }

  /**
   * Differences are tracked for a peer only while they mean something: our index is complete under
   * the current rules, we hold a whole listing of the peer's index, and both use the same rules.
   * A shadow_clean row marks a tracked peer; becoming comparable recomputes from the stored rows.
   */
  private comparable(share: NeedShare, peer: string): boolean {
    const { db } = this.deps;
    const row = db.share(share.key);
    if (!row?.fullScanAt || row.rulesHash !== share.rulesHash || row.pendingDev !== null) return false;
    const cursor = db.cursor(share.key, peer);
    return Boolean(cursor?.indexId && cursor.listed && cursor.peerRulesHash === share.rulesHash);
  }

  /**
   * Starts or stops tracking differences for the share's peers (and peers it no longer has). Rules
   * that differ, a reset or incomplete copy of either index end the comparison (and its clean
   * streak). A share that is not running changes nowhere, so its rows stay as they are; a peer that
   * is out of the share's peer set for a while (a lapsed relay lease) keeps its streak and is compared
   * again from the stored rows when it is back.
   */
  syncComparison(key: string, only?: string): void {
    const share = this.deps.share(key);
    if (!share) return;
    const { db } = this.deps;
    const members = share.peers();
    const peers = new Set(only !== undefined ? [only] : [...members, ...db.comparedPeers(key)]);
    for (const peer of peers) {
      const id = `${key}\n${peer}`;
      const tracked = db.shadowClean(key, peer) !== undefined;
      if (!members.includes(peer)) { if (tracked) this.stale.add(id); continue; }
      const wanted = this.comparable(share, peer);
      if (tracked && !wanted && !this.recomputing.has(id)) {
        this.stale.delete(id);
        db.writeTx(() => db.clearComparison(key, peer));
        this.deps.comparisonChanged(key, peer, 0, null);
      } else if (wanted && (!tracked || this.stale.has(id))) {
        const resume = tracked;
        this.stale.delete(id);
        const run: Promise<void> = this.recompute(key, peer, resume).finally(() => this.running.delete(run));
        this.running.add(run);
      }
    }
  }

  /** Whether the pair's differences are being computed from the stored rows right now (not all there yet). */
  comparing(key: string, peer: string): boolean { return this.recomputing.has(`${key}\n${peer}`); }

  /**
   * Every path of both indexes once, in time slices. The shadow_clean row goes in first, so changes
   * that land between slices are kept up to date by the incremental path; each slice evaluates from
   * what is stored then, so both paths agree. Local paths are reconciled whole on the way: what made
   * the pair comparable again (rules that no longer ignore a path, a re-listed index, a peer back in
   * the share) can leave identical content that no stored page ever merged.
   */
  private async recompute(key: string, peer: string, resume: boolean): Promise<void> {
    const id = `${key}\n${peer}`;
    if (this.recomputing.has(id) || this.closed) return;
    this.recomputing.add(id);
    const { db } = this.deps;
    let complete = false;
    let merged = 0;
    try {
      // Resumed after a gap, the streak goes on unless a difference found now outlives the settle window.
      const cleanSince = resume ? db.shadowClean(key, peer)?.cleanSince ?? null : null;
      db.writeTx(() => { db.clearComparison(key, peer); db.putShadowClean(key, peer, cleanSince, 0, this.now()); });
      for (const pass of ["local", "remote"] as const) {
        let after = "";
        for (;;) {
          const share = this.deps.share(key);
          if (this.closed || !share || !db.shadowClean(key, peer)) return;
          const paths = pass === "local" ? db.entriesAfter(key, after, RECOMPUTE_CHUNK).map((row) => row.path) : db.remoteAfter(key, peer, after, RECOMPUTE_CHUNK).map((row) => row.path);
          if (!paths.length) break;
          const deadline = performance.now() + this.sliceMs();
          const now = this.now();
          let done = 0;
          db.writeTx(() => {
            const reconciler = pass === "local" ? this.reconciler(key, now) : undefined;
            while (done < paths.length) {
              const path = paths[done++];
              if (reconciler) reconciler.reconcile(path);
              // The remote pass only adds what the local pass could not see: paths with no local row.
              else if (!db.entry(key, path)) this.evaluate(share, peer, path, undefined, db.remote(key, peer, path), now);
              if (done % CLOCK_EVERY === 0 && performance.now() >= deadline) break;
            }
            if (reconciler) merged += reconciler.finish();
          });
          after = paths[done - 1];
          await this.yieldNow();
        }
      }
      complete = true;
    } catch (error) {
      // Started without an await by its caller: a failure is reported, the next trigger tries again.
      if (this.closed) return;
      this.deps.warn?.(`fileSync:${key}:diffs`, `File sync could not compare ${key} with ${peer}: ${(error as Error).message}`);
      // Half-computed differences would read as real ones: untracked until the next trigger compares again.
      try { db.writeTx(() => db.clearComparison(key, peer)); } catch { /* the database is going away */ }
      return;
    } finally {
      this.recomputing.delete(id);
      this.queueRefresh(key);
      if (merged && !this.closed) this.deps.localChanged(key);
    }
    if (this.closed) return;
    // It may have stopped being comparable while it ran.
    this.syncComparison(key, peer);
    if (complete && !this.recomputing.has(id) && db.shadowClean(key, peer)) this.deps.compared?.(key, peer);
  }

  // ---- settling and clean-since ----

  private queueRefresh(key: string): void {
    if (this.closed) return;
    this.dirty.add(key);
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    // After the writeTx that changed `diffs` has committed (a microtask never runs inside one).
    queueMicrotask(() => {
      this.refreshQueued = false;
      const keys = [...this.dirty];
      this.dirty.clear();
      for (const share of keys) {
        try { this.refresh(share); } catch { /* the share went away meanwhile */ }
      }
    });
  }

  /**
   * Settled counts and clean-since per tracked peer, then one one-shot timer at the earliest settle
   * expiry. A clean streak starts when nothing differs at all, survives differences that resolve
   * within the settle window, and ends when one outlives it.
   */
  refresh(key: string): void {
    if (this.closed) return;
    const { db } = this.deps;
    const now = this.now();
    const settledAt = now - this.deps.settleMs;
    for (const peer of db.comparedPeers(key)) {
      const row = db.shadowClean(key, peer)!;
      const settled = db.diffCount(key, peer, settledAt);
      const cleanSince = settled > 0 ? null : row.cleanSince ?? (db.diffCount(key, peer) === 0 && !this.recomputing.has(`${key}\n${peer}`) ? now : null);
      if (settled === row.differences && cleanSince === row.cleanSince) continue;
      db.writeTx(() => db.putShadowClean(key, peer, cleanSince, settled, now));
      this.deps.comparisonChanged(key, peer, settled, cleanSince);
    }
    const earliest = db.earliestSettling(key, settledAt);
    const existing = this.timers.get(key);
    if (earliest === undefined) { existing?.timer.cancel(); this.timers.delete(key); return; }
    const at = earliest + this.deps.settleMs;
    if (existing?.at === at) return;
    existing?.timer.cancel();
    this.timers.set(key, {
      at,
      timer: this.deps.clock.setTimeout(() => {
        if (this.timers.get(key)?.at === at) this.timers.delete(key);
        try { this.refresh(key); } catch { /* the share went away meanwhile */ }
      }, Math.max(0, at - now) + 1),
    });
  }

  /** The settled difference count and clean-since for one peer; undefined while it is not compared. */
  comparison(key: string, peer: string): { differences: number; cleanSince: number | null } | undefined {
    const row = this.deps.db.shadowClean(key, peer);
    if (!row) return undefined;
    return { differences: this.deps.db.diffCount(key, peer, this.now() - this.deps.settleMs), cleanSince: row.cleanSince };
  }

  /** Settled differences in path order, with both sides' entries. */
  differences(key: string, peer: string, offset: number, limit: number): ListPage<DifferenceItem> {
    const { db } = this.deps;
    if (!db.shadowClean(key, peer)) return { total: 0, items: [] };
    const settledAt = this.now() - this.deps.settleMs;
    const total = db.diffCount(key, peer, settledAt);
    const items = db.diffsPage(key, peer, settledAt, offset, limit).map((row): DifferenceItem => {
      const local = db.entry(key, row.path);
      const remote = db.remote(key, peer, row.path);
      return {
        path: row.path, kind: row.kind as Kind, since: new Date(row.since).toISOString(),
        ...(local ? { local: picked(local) } : {}), ...(remote ? { remote: picked(remote) } : {}),
      };
    });
    return { total, items };
  }

  /** Every difference for one peer, settled or not, hidden rows included (the live consistency check wants none at all). */
  pendingDifferences(key: string, peer: string): number { return this.deps.db.pendingCount(key, peer); }

  // ---- need queue (builtin phase, §5.4) ----

  /** Called with the share key whenever its need rows changed (after the transaction). Returns the unsubscribe. */
  onNeedChanged(listener: (key: string) => void): () => void {
    this.needListeners.add(listener);
    return () => { this.needListeners.delete(listener); };
  }

  // A new generation (replaced root, lost index) starts incomplete: until its first full scan ends, nothing is decided.
  private needActive(share: NeedShare): boolean {
    if (share.phase !== "builtin") return false;
    const generation = this.ready.get(share.key);
    return generation !== undefined && generation === this.deps.db.share(share.key)?.indexId;
  }

  /** Whether the share keeps a need queue now (builtin, local index complete under the current rules). */
  isNeedActive(key: string): boolean {
    const share = this.deps.share(key);
    return share !== undefined && this.needActive(share);
  }

  // Decisions against an index that is not complete (first scan, a rescan under new rules, a replaced root waiting for
  // confirmation) would fetch over files that are only not indexed yet: apply refuses those, but each would be downloaded first.
  private indexComplete(share: NeedShare): boolean {
    const row = this.deps.db.share(share.key);
    return Boolean(row && row.fullScanAt !== null && row.pendingDev === null && row.rulesHash === share.rulesHash);
  }

  /**
   * Brings the share's need queue in line with its phase and index (after configure and scans). Out of
   * builtin its rows go (only builtin shares ever hold any); a builtin share whose index just became
   * complete (first full scan, the full scan under new rules, a worker start) is computed in full from
   * the stored rows, no pull needed.
   */
  syncNeed(key: string): void {
    const share = this.deps.share(key);
    if (!share || this.closed) return;
    const { db } = this.deps;
    if (share.phase !== "builtin") {
      this.ready.delete(key);
      if (db.needCount(key)) { db.writeTx(() => db.deleteNeeds(key)); this.touchNeed(key); }
      return;
    }
    const generation = db.share(key)?.indexId;
    if (!this.indexComplete(share) || generation === undefined) { this.ready.delete(key); return; }
    if (this.ready.get(key) === generation) return;
    // Complete now, or a new generation completed: every path is decided from the stored rows.
    this.ready.set(key, generation);
    this.recomputeNeed(key);
    // Rows it kept while incomplete (a rescan under new rules) are handed out again: if the recompute changes none of them,
    // nothing else would tell the transfer loop they are wanted again.
    if (db.needCount(key)) this.touchNeed(key);
  }

  /** Nothing changed in the rows, but they can be worked on again (the share's folder is back): listeners take another look. */
  wake(key: string): void { this.waitingForRoot.delete(key); this.touchNeed(key); }

  /**
   * A scan found the share's folder there. Rows left out while it was missing are handed out again, even when no
   * scan ever saw it gone (it went and came back between two scans, while need rows arrived).
   */
  rootAvailable(key: string): void { if (this.waitingForRoot.has(key)) this.wake(key); }

  /** The share stopped running here: its rows stay, the next syncNeed decides again. */
  forgetNeed(key: string): void { this.ready.delete(key); }

  /**
   * Every path of the share decided again from the stored rows, replacing stored targets even with older
   * ones: peers left the share (their rows no longer count), rules changed, or a peer's index was listed
   * whole again. Single flight per share.
   */
  recomputeNeed(key: string): void {
    if (this.closed || !this.isNeedActive(key)) return;
    const run = this.needRuns.get(key);
    if (run) { run.again = true; return; }
    const state = { again: false };
    this.needRuns.set(key, state);
    const work: Promise<void> = (async () => {
      try {
        do {
          state.again = false;
          await this.recomputeNeedOnce(key);
        } while (state.again && !this.closed);
      } catch (error) {
        if (!this.closed) this.deps.warn?.(`fileSync:${key}:need`, `File sync could not work out what ${key} needs: ${(error as Error).message}`);
      } finally {
        this.needRuns.delete(key);
      }
    })();
    const tracked: Promise<void> = work.finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private async recomputeNeedOnce(key: string): Promise<void> {
    const { db } = this.deps;
    const start = this.deps.share(key);
    if (!start) return;
    const lists: Array<{ list: (after: string) => string[]; remoteOnly: boolean }> = [
      { list: (after) => db.entriesAfter(key, after, RECOMPUTE_CHUNK).map((row) => row.path), remoteOnly: false },
      // Remote paths without a local row; the local pass decided the others.
      ...start.peers().map((peer) => ({ list: (after: string) => db.remoteAfter(key, peer, after, RECOMPUTE_CHUNK).map((row) => row.path), remoteOnly: true })),
      // Rows no stored row explains any more (a peer that left): dropped or replaced.
      { list: (after: string) => db.needAfter(key, after, RECOMPUTE_CHUNK).map((row) => row.path), remoteOnly: false },
    ];
    for (const { list, remoteOnly } of lists) {
      let after = "";
      for (;;) {
        const share = this.deps.share(key);
        if (this.closed || !share || !this.needActive(share)) return;
        const paths = list(after);
        if (!paths.length) break;
        const deadline = performance.now() + this.sliceMs();
        let done = 0;
        let merged = 0;
        db.writeTx(() => {
          const reconciler = this.reconciler(key, this.now(), true);
          while (done < paths.length) {
            const path = paths[done++];
            if (!remoteOnly || !db.entry(key, path)) reconciler.reconcile(path);
            if (done % CLOCK_EVERY === 0 && performance.now() >= deadline) break;
          }
          merged = reconciler.finish();
        });
        if (merged) this.deps.localChanged(key);
        after = paths[done - 1];
        await this.yieldNow();
      }
    }
  }

  // A target, or a local version of another type, that the local rules ignore: nothing here may touch it.
  private ignoredFor(share: NeedShare, path: string, local: IndexEntry | undefined, target: IndexEntry): boolean {
    return share.ignored(path, target.type === DIRECTORY) || (local !== undefined && local.type !== target.type && share.ignored(path, local.type === DIRECTORY));
  }

  /** What the rows say about one path now (apply re-derives its target with this, §5.5.1). */
  derive(key: string, path: string): Derived | undefined {
    const share = this.deps.share(key);
    if (!share) return undefined;
    const { db } = this.deps;
    const local = db.entry(key, path);
    const remotes = new Map<string, IndexEntry>();
    for (const peer of share.peers()) {
      const row = db.remote(key, peer, path);
      if (row) remotes.set(peer, row);
    }
    const { target, decision } = decideGlobal(local, [...remotes.values()]);
    const wanted = this.needActive(share) && decision.kind === "apply" && target !== undefined && !this.ignoredFor(share, path, local, target);
    return { local, remotes, target, decision, wanted };
  }

  private priorityFor(share: NeedShare, path: string, target: IndexEntry): number {
    const now = this.now();
    if (this.prioritized.get(share.key)?.some((entry) => entry.until > now && isSameOrInside(path, entry.prefix))) return 0;
    return needPriority(share.kind, path, target.deleted ? 0 : target.size);
  }

  /**
   * Inside a writeTx: the path's need row after its rows changed. An apply decision stores the full target,
   * replacing a stored one only when the new target dominates or wins over it (a target going back is a
   * partial view, such as a peer's index being pulled again), unless `force`. Returns the decision's kind.
   */
  private updateNeed(share: NeedShare, path: string, local: LocalEntry | undefined, rows: Map<string, IndexEntry>, force: boolean): Decision["kind"] {
    const { db } = this.deps;
    const key = share.key;
    const { target, decision } = decideGlobal(local, [...rows.values()]);
    const existing = db.needRow(key, path);
    if (decision.kind !== "apply" || !target || this.ignoredFor(share, path, local, target)) {
      if (existing) this.dropNeedRow(key, existing);
      this.revalidateMoves(key, path, local);
      return decision.kind;
    }
    if (existing && sameTarget(existing.target, target)) {
      // The same version; what it means here may have moved with the local row (a conflict now, a mode change).
      const action: NeedAction = existing.action === "move" && decision.action === "fetch" ? "move" : decision.action;
      if (existing.action !== action || existing.conflict !== decision.conflict) {
        const fromPath = action === "move" ? existing.fromPath : null;
        db.updateNeed(key, path, { action, conflict: decision.conflict, fromPath });
        if (existing.action === "delete" && action !== "delete") this.unpairFrom(key, path);
        this.touchNeed(key);
        this.pair(key, { ...existing, action, conflict: decision.conflict, fromPath }, local);
      }
      this.revalidateMoves(key, path, local);
      return decision.kind;
    }
    if (existing && !force && !supersedes(target, existing.target)) return decision.kind;
    if (existing?.action === "delete") this.unpairFrom(key, path);
    const row: NeedRow = {
      path, action: decision.action, fromPath: null, conflict: decision.conflict, priority: this.priorityFor(share, path, target),
      attempts: 0, nextAt: 0, lastError: null, blocked: false, blockedAt: null, target: { ...target, path, seq: 0 },
    };
    db.putNeed(key, row);
    this.touchNeed(key);
    this.pair(key, row, local);
    this.revalidateMoves(key, path, local);
    return decision.kind;
  }

  private dropNeedRow(key: string, row: NeedRow): void {
    this.deps.db.deleteNeed(key, row.path);
    if (row.action === "delete") this.unpairFrom(key, row.path);
    this.touchNeed(key);
  }

  /**
   * Renames (§5.4): a delete of P whose local live file has content S and a fetch of Q with target S in
   * the same share become one move (Q from P), so the bytes never cross the network. Whichever half is
   * stored second pairs them; apply checks P's fingerprint before it renames.
   */
  private pair(key: string, row: NeedRow, local: IndexEntry | undefined): void {
    const { db } = this.deps;
    if (row.blocked) return;
    if (row.action === "fetch" && row.target.type === FILE && !row.target.deleted && row.target.sha256) {
      const from = db.pairableDeletes(key, row.target.sha256, row.path)[0];
      if (from !== undefined) { db.updateNeed(key, row.path, { action: "move", fromPath: from }); this.touchNeed(key); }
    } else if (row.action === "delete" && local && !local.deleted && local.type === FILE && local.sha256 && !db.movesFrom(key, row.path).length) {
      const to = db.unpairedFetch(key, local.sha256, row.path);
      if (to !== undefined) { db.updateNeed(key, to, { action: "move", fromPath: row.path }); this.touchNeed(key); }
    }
  }

  /** P stopped being a pending delete: moves from it fetch again (or pair with another delete of the same content). */
  private unpairFrom(key: string, from: string): void {
    const { db } = this.deps;
    for (const path of db.movesFrom(key, from)) {
      db.updateNeed(key, path, { action: "fetch", fromPath: null });
      this.touchNeed(key);
      const row = db.needRow(key, path);
      if (row) this.pair(key, row, undefined);
    }
  }

  /** A move apply could not do (P changed, or its delete is no longer wanted): a plain fetch, which may copy P instead. */
  unpair(key: string, path: string): void {
    this.inTx(() => {
      const { db } = this.deps;
      const row = db.needRow(key, path);
      if (row?.action !== "move") return;
      db.updateNeed(key, path, { action: "fetch", fromPath: null });
      this.touchNeed(key);
    });
  }

  /** P's rows changed: a move from it holds only while P is still a pending delete of a live file with the move's content. */
  private revalidateMoves(key: string, from: string, local: IndexEntry | undefined): void {
    const { db } = this.deps;
    const moves = db.movesFrom(key, from);
    if (!moves.length) return;
    const fromRow = db.needRow(key, from);
    for (const path of moves) {
      const row = db.needRow(key, path);
      const valid = row !== undefined && fromRow?.action === "delete" && !fromRow.blocked && local !== undefined && !local.deleted && local.type === FILE
        && local.sha256 !== null && local.sha256 === row.target.sha256;
      if (valid) continue;
      db.updateNeed(key, path, { action: "fetch", fromPath: null });
      this.touchNeed(key);
    }
  }

  /** Blocked rows whose cause may be gone after these local changes: the path, a folder above or below it, a case twin beside it. */
  private unblockRelated(key: string, paths: readonly string[]): void {
    const { db } = this.deps;
    if (!paths.length) return;
    for (const row of db.blockedNeeds(key)) {
      // Waiting for disk space is tried again by time, not by what changed.
      if (row.nextAt > 0) continue;
      const fold = caseFoldKey(row.path);
      const related = paths.some((changed) => isSameOrInside(row.path, changed) || isSameOrInside(changed, row.path)
        || (parentKey(changed) === parentKey(row.path) && caseFoldKey(changed) === fold));
      if (!related) continue;
      db.updateNeed(key, row.path, { blocked: false, blockedAt: null, lastError: null, attempts: 0, nextAt: 0 });
      this.touchNeed(key);
    }
  }

  /** A full scan or a manual rescan: blocked rows get another try (local-only content removed from a folder changes no row). */
  retryBlocked(key: string): number {
    const { db } = this.deps;
    const blocked = db.blockedNeeds(key);
    if (!blocked.length) return 0;
    db.writeTx(() => { for (const row of blocked) db.updateNeed(key, row.path, { blocked: false, blockedAt: null, lastError: null, attempts: 0, nextAt: 0 }); });
    this.touchNeed(key);
    return blocked.length;
  }

  private inTx(run: () => void): void {
    const { db } = this.deps;
    if (db.inTransaction) run(); else db.writeTx(run);
  }

  /** A transfer or an apply could not finish the item: offered again with backoff (or after `delayMs`), while the row still holds `target`. */
  retryLater(key: string, path: string, reason: string, options: { delayMs?: number; target?: IndexEntry } = {}): void {
    this.inTx(() => {
      const { db } = this.deps;
      const row = db.needRow(key, path);
      if (!row || (options.target && !sameTarget(row.target, options.target))) return;
      const attempts = row.attempts + 1;
      db.updateNeed(key, path, { attempts, lastError: reason, nextAt: this.now() + (options.delayMs ?? backoffMs(attempts)) });
      this.touchNeed(key);
    });
  }

  /**
   * A permanent failure (case collision, a symlinked or case-variant parent, local-only content in the way, a
   * path not valid here): shown as an error, not counted as pending, until a related local change or a full
   * scan. `retryAfterMs` (not enough disk space) offers it again after that time.
   */
  block(key: string, path: string, reason: string, options: { retryAfterMs?: number; target?: IndexEntry } = {}): void {
    this.inTx(() => {
      const { db } = this.deps;
      const row = db.needRow(key, path);
      if (!row || (options.target && !sameTarget(row.target, options.target))) return;
      const now = this.now();
      db.updateNeed(key, path, {
        blocked: true, blockedAt: row.blocked ? row.blockedAt ?? now : now, lastError: reason, nextAt: options.retryAfterMs ? now + options.retryAfterMs : 0,
        ...(row.action === "move" ? { action: "fetch" as const, fromPath: null } : {}),
      });
      if (row.action === "delete") this.unpairFrom(key, path);
      this.touchNeed(key);
    });
  }

  /**
   * Inside apply's writeTx, after the local rows took the applied targets: need rows go only where the stored
   * target is what was applied (a newer one that arrived meanwhile stays), then the paths are decided again.
   */
  appliedInTx(key: string, applied: ReadonlyArray<{ path: string; target: IndexEntry }>, changes: ReadonlyArray<{ path: string; after: LocalEntry | undefined }>): void {
    const { db } = this.deps;
    for (const item of applied) {
      const row = db.needRow(key, item.path);
      if (row && sameTarget(row.target, item.target)) this.dropNeedRow(key, row);
    }
    this.localChangesInTx(key, changes);
  }

  /** Paths decided again now (merges, need, differences), outside any transaction. */
  reconcilePaths(key: string, paths: readonly string[], force = false): void {
    if (this.closed || !paths.length) return;
    const { db } = this.deps;
    let merged = 0;
    try {
      db.writeTx(() => {
        const reconciler = this.reconciler(key, this.now(), force);
        for (const path of paths) reconciler.reconcile(path);
        merged = reconciler.finish();
      });
    } catch (error) {
      if (!this.closed) this.deps.warn?.(`fileSync:${key}:need`, `File sync could not decide ${paths.length} path(s) of ${key}: ${(error as Error).message}`);
      return;
    }
    if (merged) this.deps.localChanged(key);
  }

  private queueMerge(key: string, path: string): void {
    let paths = this.mergeLater.get(key);
    if (!paths) { paths = new Set(); this.mergeLater.set(key, paths); }
    paths.add(path);
    if (this.mergeQueued) return;
    this.mergeQueued = true;
    // A microtask never runs inside the synchronous writeTx that queued it.
    queueMicrotask(() => {
      this.mergeQueued = false;
      const batches = [...this.mergeLater];
      this.mergeLater.clear();
      for (const [share, set] of batches) this.reconcilePaths(share, [...set]);
    });
  }

  private touchNeed(key: string): void {
    if (this.closed) return;
    this.needTouched.add(key);
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      const keys = [...this.needTouched];
      this.needTouched.clear();
      for (const share of keys) {
        try { this.deps.needChanged?.(share); } catch { /* a listener's failure is not the queue's */ }
        for (const listener of this.needListeners) {
          try { listener(share); } catch { /* likewise */ }
        }
      }
    });
  }

  /**
   * Handoff and "do this first" (§5.4 priority 0): rows at `prefix` and below ("" or absent = the whole
   * share) go first until `until` (the core clock's time); one one-shot timer puts them back.
   */
  prioritize(key: string, prefix: string | undefined, until: number): void {
    const now = this.now();
    if (until <= now || this.closed) return;
    const trimmed = (prefix ?? "").replace(/\/+$/, "");
    const normalized = trimmed === "" ? "" : normalizeRelativePath(trimmed);
    const list = this.prioritized.get(key) ?? [];
    list.push({ prefix: normalized, until });
    this.prioritized.set(key, list);
    const { db } = this.deps;
    db.writeTx(() => {
      for (const row of db.needsUnder(key, normalized)) if (row.priority !== 0) db.updateNeed(key, row.path, { priority: 0 });
    });
    this.touchNeed(key);
    this.armPriorityTimer();
  }

  private armPriorityTimer(): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const list of this.prioritized.values()) for (const entry of list) earliest = Math.min(earliest, entry.until);
    if (this.priorityTimer && this.priorityTimer.at === earliest) return;
    this.priorityTimer?.timer.cancel();
    this.priorityTimer = undefined;
    if (!Number.isFinite(earliest) || this.closed) return;
    const at = earliest;
    this.priorityTimer = { at, timer: this.deps.clock.setTimeout(() => { this.priorityTimer = undefined; this.expirePriorities(); }, Math.max(0, at - this.now()) + 1) };
  }

  /** Expired priorities go back to what §5.4 gives each row. */
  expirePriorities(): void {
    if (this.closed) return;
    const now = this.now();
    const { db } = this.deps;
    for (const [key, list] of [...this.prioritized]) {
      const active = list.filter((entry) => entry.until > now);
      const expired = list.filter((entry) => entry.until <= now);
      if (active.length) this.prioritized.set(key, active); else this.prioritized.delete(key);
      if (!expired.length) continue;
      const share = this.deps.share(key);
      try {
        db.writeTx(() => {
          for (const entry of expired) {
            for (const row of db.needsUnder(key, entry.prefix)) {
              if (active.some((other) => isSameOrInside(row.path, other.prefix))) continue;
              const priority = needPriority(share?.kind, row.path, row.target.deleted ? 0 : row.target.size);
              if (row.priority !== priority) db.updateNeed(key, row.path, { priority });
            }
          }
        });
        this.touchNeed(key);
      } catch { /* the share went away meanwhile */ }
    }
    this.armPriorityTimer();
  }

  /**
   * fix (P4+P5): need rows at `prefix` and below, blocked ones left out (they wait for a person, not a
   * peer). A delete, a folder, a link, a mode change, a rename or content held locally can be applied
   * now; other content counts as arriving only while one of `availablePeers` has it. What only peers
   * outside that set have waits for them: a worktree merge does not hold for a machine that is away.
   */
  pendingUnder(key: string, prefix: string, availablePeers: readonly string[]): PendingFiles {
    const result: PendingFiles = { files: 0, bytes: 0, blocked: 0, errors: 0, waiting: { files: 0, bytes: 0, peers: [] } };
    const share = this.deps.share(key);
    if (!share) return result;
    const trimmed = prefix.replace(/\/+$/, "");
    const available = new Set(availablePeers);
    const waitingFor = new Set<string>();
    const normalized = trimmed === "" ? "" : normalizeRelativePath(trimmed);
    result.errors = this.deps.db.errorCount(key, normalized);
    for (const row of this.deps.db.needsUnder(key, normalized)) {
      if (row.blocked) { result.blocked++; continue; }
      const size = !row.target.deleted && row.target.type === FILE ? row.target.size : 0;
      if (row.action === "delete" || this.contentItem({ ...row, share: key }, share, available)) { result.files++; result.bytes += size; continue; }
      result.waiting.files++;
      result.waiting.bytes += size;
      for (const peer of share.peers()) if (sameContent(this.deps.db.remote(key, peer, row.path), row.target)) waitingFor.add(peer);
    }
    result.waiting.peers = [...waitingFor].sort();
    return result;
  }

  /**
   * The next items to transfer or apply (§5.4, §6.2), in order: priority, then within it creates and updates
   * smallest first, then deletes deepest first. Blocked rows, rows in backoff, rows in flight, a delete whose
   * local content a pending create still wants, and content no available peer or local copy has are left out.
   */
  nextNeeds(options: NextNeedsOptions): { items: NeedItem[]; nextRetryAt?: number } {
    const { db } = this.deps;
    const now = this.now();
    const limit = Math.max(0, Math.floor(options.limit));
    // Waiting for disk space: offered again once its time came (the transfer checks the space before it starts).
    const due = db.blockedDue(now);
    if (due.length) {
      db.writeTx(() => { for (const row of due) db.updateNeed(row.share, row.path, { blocked: false, blockedAt: null, nextAt: 0, lastError: null }); });
      for (const row of due) this.touchNeed(row.share);
    }
    const only = options.shares ? new Set(options.shares) : undefined;
    const active = new Map<string, NeedShare>();
    for (const key of this.deps.shareKeys?.() ?? [...this.ready.keys()]) {
      if (only && !only.has(key)) continue;
      const share = this.deps.share(key);
      if (!share || !this.needActive(share)) continue;
      if (share.available?.() !== false) active.set(key, share);
      else this.waitingForRoot.add(key);
    }
    const inFlight = new Set<string>();
    for (const item of options.inFlight ?? []) inFlight.add(typeof item === "string" ? item : `${item.share}\n${item.path}`);
    const available = options.availablePeers ? new Set(options.availablePeers) : undefined;
    const items: NeedItem[] = [];
    const nextRetryAt = db.nextNeedRetry(now);
    const result = () => nextRetryAt === undefined ? { items } : { items, nextRetryAt };
    if (!limit || !active.size) return result();
    const skip = (row: NeedRow & { share: string }) => !active.has(row.share) || row.nextAt > now || inFlight.has(`${row.share}\n${row.path}`);
    const deletesTaken = new Set<number>();
    for (let offset = 0; items.length < limit; offset += RECOMPUTE_CHUNK) {
      const rows = db.needCandidates(offset, RECOMPUTE_CHUNK);
      if (!rows.length) break;
      for (const row of rows) {
        if (items.length >= limit) break;
        if (row.action !== "delete") {
          if (skip(row)) continue;
          const item = this.contentItem(row, active.get(row.share)!, available);
          if (item) items.push(item);
          continue;
        }
        // Creates and updates of this priority are all behind us: its deletes go now, deepest first.
        if (deletesTaken.has(row.priority)) continue;
        deletesTaken.add(row.priority);
        const deletes = db.needDeletes(row.priority).filter((candidate) => !skip(candidate))
          .sort((a, b) => depthOf(b.path) - depthOf(a.path) || (a.share < b.share ? -1 : a.share > b.share ? 1 : 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const candidate of deletes) {
          if (items.length >= limit) break;
          const local = db.entry(candidate.share, candidate.path);
          // The other half of a rename (or a copy elsewhere) still wants these bytes: deleting them first would cost a transfer.
          if (local && !local.deleted && local.type === FILE && local.sha256 && db.sharesWanting(local.sha256).some((share) => active.has(share))) continue;
          items.push(this.itemOf(candidate, "delete", [], []));
        }
      }
    }
    return result();
  }

  private itemOf(row: NeedRow & { share: string }, action: NeedAction, sources: string[], localSources: LocalSource[], fromPath?: string): NeedItem {
    const target = row.target;
    return {
      share: row.share, path: row.path, action, ...(fromPath !== undefined ? { fromPath } : {}), target, sources, localSources,
      conflict: row.conflict, priority: row.priority, size: !target.deleted && target.type === FILE ? target.size : 0, attempts: row.attempts,
    };
  }

  private contentItem(row: NeedRow & { share: string }, share: NeedShare, available: Set<string> | undefined): NeedItem | undefined {
    if (row.action === "mkdir" || row.action === "symlink" || row.action === "meta") return this.itemOf(row, row.action, [], []);
    const { db } = this.deps;
    const target = row.target;
    const sources = share.peers().filter((peer) => sameContent(db.remote(row.share, peer, row.path), target));
    let fromPath: string | undefined;
    if (row.action === "move" && row.fromPath !== null) {
      const fromRow = db.needRow(row.share, row.fromPath);
      const from = db.entry(row.share, row.fromPath);
      if (fromRow?.action === "delete" && !fromRow.blocked && from && !from.deleted && from.type === FILE && from.sha256 === target.sha256) fromPath = row.fromPath;
    }
    const localSources = target.sha256 ? this.localSourcesFor(row.share, row.path, target.sha256) : [];
    if (fromPath === undefined && !localSources.length && !sources.some((peer) => !available || available.has(peer))) return undefined;
    return this.itemOf(row, fromPath !== undefined ? "move" : "fetch", sources, localSources, fromPath);
  }

  private localSourcesFor(key: string, path: string, sha256: string): LocalSource[] {
    const { db } = this.deps;
    const sources: LocalSource[] = [];
    for (const { share, entry } of db.entriesWithContent(sha256, 8)) {
      if (share === key && entry.path === path) continue;
      // Another share's root is only known while it runs here.
      if (!this.deps.share(share)) continue;
      sources.push({ share, path: entry.path });
    }
    for (const file of db.trashWithContent(sha256, 4)) sources.push({ trash: file });
    return sources;
  }

  // ---- bootstrap (§7.3) ----

  /**
   * The switch to builtin on this node (P5): every path is decided once with one extra rule. Entries a peer
   * wrote before it ran builtin (seq ≤ its builtinSince, or every entry of a peer not builtin yet) and every
   * local entry were made while Syncthing copied files without telling this engine, so they never delete a
   * live file, and never replace one with other content without keeping it:
   * - a weak tombstone that would delete a live local file raises the local version above it (peers fetch the file);
   * - a local tombstone that would delete a peer's live file leaves the index (as a prune does), so the file is fetched here;
   * - weak other content that would replace a live local file without a conflict makes the local version concurrent
   *   with it, so the loser (on whichever side) is kept as a conflict copy.
   * A tombstone that deleted exactly the live content still wins; identical content merges. Afterwards
   * builtin_since = this node's maxSeq (served in /files/shares and index pages).
   */
  async bootstrap(key: string, builtinSinceByPeer: Readonly<Record<string, number>>): Promise<BootstrapResult> {
    const { db, nodeId } = this.deps;
    const start = this.deps.share(key);
    if (!start) throw new Error(`File sync share not found: ${key}`);
    const notReady = (message: string) => Object.assign(new Error(message), { code: "not-ready" });
    // Decisions against a partial index would raise or drop rows for files that are only not indexed yet.
    if (!this.indexComplete(start)) throw notReady(`File sync has not finished indexing ${key} under its current rules`);
    // The extra rule is applied once, to the rows stored now: a peer's rows still being paged in would arrive after the
    // switch and be decided by the ordinary rule, where a Syncthing-era tombstone deletes a live file. So every peer's
    // whole index must be here first (P5 runs the switch again once those pulls are done), and none may move meanwhile.
    const cursors = () => start.peers().map((peer) => { const cursor = db.cursor(key, peer); return `${peer}:${cursor?.indexId ?? ""}:${cursor?.seq ?? -1}:${cursor?.listed ? 1 : 0}`; }).join("\n");
    const behind = start.peers().filter((peer) => !peerCaughtUp(db.cursor(key, peer)));
    if (behind.length) throw notReady(`File sync has not pulled the whole index of ${behind.join(", ")} for ${key} yet`);
    const weakRow = (peer: string, row: IndexEntry): boolean => {
      const since = Object.hasOwn(builtinSinceByPeer, peer) ? builtinSinceByPeer[peer] : undefined;
      return since === undefined || row.seq <= since;
    };
    const peers = start.peers();
    // A version counts as weak when every peer row holding it is.
    const weakVersion = (rows: Map<string, IndexEntry>, version: IndexEntry["version"]): boolean => {
      const holders = [...rows].filter(([, row]) => vectorsEqual(row.version, version));
      return holders.length > 0 && holders.every(([peer, row]) => weakRow(peer, row));
    };
    let merged = 0;
    let need = 0;
    // Rows a pull stores during the pass were not decided under the rule: the pass runs again (it changes nothing twice).
    for (let attempt = 1; ; attempt++) {
      const before = cursors();
      need = 0;
      const lists: Array<(after: string) => string[]> = [
        (after) => db.entriesAfter(key, after, RECOMPUTE_CHUNK).map((row) => row.path),
        ...peers.map((peer) => (after: string) => db.remoteAfter(key, peer, after, RECOMPUTE_CHUNK).map((row) => row.path)),
      ];
      const decided = new Set<string>();
      for (const [index, list] of lists.entries()) {
        let after = "";
        for (;;) {
          const share = this.deps.share(key);
          if (this.closed || !share) throw new Error(`File sync share ${key} stopped during the switch to builtin`);
          const paths = list(after);
          if (!paths.length) break;
          const deadline = performance.now() + this.sliceMs();
          let done = 0;
          let wrote = 0;
          db.writeTx(() => {
            const now = this.now();
            let maxSeq = db.share(key)!.maxSeq;
            let dropped = false;
            const needs = this.needActive(share);
            while (done < paths.length) {
              if (done > 0 && done % CLOCK_EVERY === 0 && performance.now() >= deadline) break;
              const path = paths[done++];
              if (index > 0 && (decided.has(path) || db.entry(key, path))) continue;
              if (index > 0) decided.add(path);
              let local: LocalEntry | undefined = db.entry(key, path);
              const rows = new Map<string, IndexEntry>();
              for (const peer of peers) {
                const remote = db.remote(key, peer, path);
                if (remote) rows.set(peer, remote);
              }
              if (local && share.ignored(path, local.type === DIRECTORY)) continue;
              const put = (next: LocalEntry) => { local = next; db.putEntry(key, next); wrote++; };
              if (local) {
                const merge = mergeIdentical(local, rows.values());
                if (merge) put({ ...local, ...merge, seq: ++maxSeq });
              }
              let { target, decision } = decideGlobal(local, [...rows.values()]);
              const current = local;
              if (current && !current.deleted && decision.kind === "apply" && target?.deleted && !sameContent({ ...target, deleted: false }, current)
                && weakVersion(rows, target.version)) {
                // A weak tombstone of other content: the live file stays and wins over every tombstone seen.
                const base = [...rows.values()].filter((remote) => remote.deleted).reduce((version, remote) => mergeVectors(version, remote.version), current.version);
                put({ ...current, version: db.nextVersion(base, nodeId, now), modifiedBy: nodeId, seq: ++maxSeq });
                ({ target, decision } = decideGlobal(local, [...rows.values()]));
              } else if (current && !current.deleted && current.type !== DIRECTORY && decision.kind === "apply" && !decision.conflict && target && !target.deleted
                && !sameContent(current, target) && weakVersion(rows, target.version)) {
                // Weak other content would replace this file outright: concurrent now, so the loser is kept as a conflict copy.
                put({ ...current, version: db.nextVersion(current.version, nodeId, now), modifiedBy: nodeId, seq: ++maxSeq });
                ({ target, decision } = decideGlobal(local, [...rows.values()]));
              } else if (current?.deleted && target?.deleted && (target === current || weakVersion(rows, target.version))
                && [...rows.values()].some((remote) => !remote.deleted && !share.ignored(path, remote.type === DIRECTORY) && !sameContent({ ...current, deleted: false }, remote))) {
                // A local tombstone of other content would delete a peer's file: it leaves the index. Peers learn of it like
                // of a prune (prunedBelow above their cursors makes them list again and forget it); the file comes here.
                db.deleteEntry(key, path);
                dropped = true;
                wrote++;
                local = undefined;
                ({ target, decision } = decideGlobal(undefined, [...rows.values()]));
              }
              if (decision.kind === "apply" && target && !this.ignoredFor(share, path, local, target)) need++;
              if (needs) this.updateNeed(share, path, local, rows, true);
            }
            if (dropped) maxSeq += 1;
            if (wrote) db.updateShare(key, { maxSeq, ...(dropped ? { prunedBelow: maxSeq } : {}) });
          });
          merged += wrote;
          if (wrote) this.deps.localChanged(key);
          after = paths[done - 1];
          await this.yieldNow();
        }
      }
      if (cursors() === before) break;
      const lagging = start.peers().filter((peer) => !peerCaughtUp(db.cursor(key, peer)));
      if (lagging.length || attempt >= BOOTSTRAP_PASSES) throw notReady(`Peers' indexes of ${key} kept changing during the switch to builtin: it runs again later`);
    }
    db.writeTx(() => db.updateShare(key, { builtinSince: db.share(key)!.maxSeq }));
    this.deps.localChanged(key);
    return { merged, need };
  }

  /** Whether a recompute is running (tests wait for quiescence; stop waits before the database closes). */
  get busy(): boolean { return this.running.size > 0; }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  close(): void {
    this.closed = true;
    for (const { timer } of this.timers.values()) timer.cancel();
    this.timers.clear();
    this.dirty.clear();
    this.priorityTimer?.timer.cancel();
    this.priorityTimer = undefined;
    this.mergeLater.clear();
    this.needTouched.clear();
    this.needListeners.clear();
    this.waitingForRoot.clear();
  }
}
