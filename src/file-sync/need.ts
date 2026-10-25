import { performance } from "node:perf_hooks";
import { pickTarget, sameContent, sameMeta } from "./conflicts.js";
import { HIDDEN_DIFF, type FileSyncDb, type LocalEntry } from "./db.js";
import type { DifferenceItem, ListPage } from "./protocol.js";
import { DIRECTORY, type Clock, type IndexEntry, type Phase } from "./types.js";
import { mergeVectors, vectorsEqual } from "./vectors.js";
import { WireError, type IndexPage } from "./wire.js";

/* What peers' index rows mean for this node (FILE-SYNC design §5.4). P2 is shadow mode: pulled pages
   are stored, identical content merges version vectors (so every node ends up with the same version
   of a path Syncthing already copied), and every other difference only lands in `diffs`, which is
   what the switch to builtin mode is judged by. P3 adds the need queue on top of the same decisions. */

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
}

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
    return { restart: false, stored: entries.length, merged, cursor: cursorAfter };
  }

  /** Drops what this node holds of one peer's index (rows, cursor, differences); the next pull starts at 0. */
  resetPeer(key: string, peer: string): void {
    this.deps.db.writeTx(() => this.deps.db.resetPeer(key, peer));
    this.queueRefresh(key);
  }

  /**
   * Inside a writeTx: decides paths against every eligible peer's row. Identical content merges into
   * the local row (a new seq when it changes anything); every other difference only lands in `diffs`
   * in shadow mode. finish() records the seqs taken and returns how many rows merged.
   */
  private reconciler(key: string, now: number): { reconcile(path: string): void; finish(): number } {
    const share = this.deps.share(key);
    const { db } = this.deps;
    const peers = share?.peers() ?? [];
    const compared = share ? peers.filter((peer) => db.shadowClean(key, peer) !== undefined) : [];
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
          // P3: decideGlobal on the merged row turns an "apply" into a need row in builtin mode; shadow mode only records `diffs`.
        }
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
  }
}
