import { performance } from "node:perf_hooks";
import type { ShareSpec, ShareStatus } from "./protocol.js";
import { systemClock, type Clock } from "./types.js";

/* auto-transition: with every shared project compared by default, the first full index of all of
   them at once was too much for one machine. Projects never indexed here join the worker's shares
   one at a time, smallest first by Syncthing's file count (by name when Syncthing does not say);
   the next one goes in only once main's event loop is calm, or after a few busy windows anyway. A
   project indexed once (or moved by built-in sync, or switched by its owner) joins at once at every
   later start. Nothing polls: the queue moves on the current project's share reports, plus one
   one-shot timer at a time while main is busy. */

export interface FirstIndexDeps {
  /** Projects whose first index finished here (node.db). */
  indexed: () => ReadonlySet<string>;
  markIndexed: (projectId: string) => void;
  /** The current project changed: derive again so the worker gets its shares. */
  changed: () => void;
  name: (projectId: string) => string;
  clock?: Clock;
  /** Main's event-loop utilization from now until the returned function is called. */
  loopUtilization?: () => () => number;
  /** How long main is watched before the next project goes in; 0 lets it go at once. */
  calmWindowMs?: number;
}

export interface IndexingStatus { projectId: string; name: string; position: number; total: number }

const CALM_WINDOW_MS = 2_000;
const BUSY = 0.7;
/** fix: a main thread busy for this many windows in a row lets the next project go anyway: the queue must not wait for good. */
const BUSY_WINDOWS = 5;

function loopUtilization(): () => number {
  const start = performance.eventLoopUtilization();
  return () => performance.eventLoopUtilization(performance.eventLoopUtilization(), start).utilization;
}

export class FirstIndexQueue {
  private current?: string;
  /** Syncthing's file count per project, where it said. */
  private counts = new Map<string, number>();
  private candidates: string[] = [];
  private waiting?: { cancel(): void };
  /** The current project's shares, as last derived. */
  private currentShares: string[] = [];
  private stopped = false;

  constructor(private readonly deps: FirstIndexDeps) {}

  setCounts(counts: ReadonlyMap<string, number>): void { this.counts = new Map(counts); }

  /**
   * The shares the worker gets now: those of projects `always` admits (indexed, past Syncthing,
   * switched) and of the one project indexing. `derived` is every share the project list allows.
   */
  admit(derived: readonly ShareSpec[], always: (projectId: string) => boolean): ShareSpec[] {
    const indexed = this.deps.indexed();
    const projects = [...new Set(derived.map((share) => share.projectId))];
    this.candidates = projects;
    const pending = projects.filter((id) => !always(id) && !indexed.has(id));
    if (this.current && !pending.includes(this.current)) this.current = undefined;
    if (!this.current && !this.waiting && pending.length) this.current = this.pick(pending);
    this.currentShares = derived.filter((share) => share.projectId === this.current).map((share) => share.key);
    return derived.filter((share) => share.projectId === this.current || always(share.projectId) || indexed.has(share.projectId));
  }

  /** A share report: once every share of the project indexing has a complete index (or cannot have one), the next goes in. */
  reported(status: ShareStatus, all: (key: string) => ShareStatus | undefined): void {
    if (this.stopped || !this.current || status.projectId !== this.current) return;
    if (!this.currentShares.every((key) => finished(all(key)))) return;
    const done = this.current;
    this.current = undefined;
    this.deps.markIndexed(done);
    this.calmThen(() => this.deps.changed());
  }

  status(): IndexingStatus | null {
    if (!this.current) return null;
    const indexed = this.deps.indexed();
    const done = this.candidates.filter((id) => id !== this.current && indexed.has(id)).length;
    return { projectId: this.current, name: this.deps.name(this.current), position: done + 1, total: this.candidates.length };
  }

  stop(): void { this.stopped = true; this.waiting?.cancel(); this.waiting = undefined; }

  /** Smallest known first, then by name. */
  private pick(pending: readonly string[]): string {
    return [...pending].sort((a, b) => (this.counts.get(a) ?? Infinity) - (this.counts.get(b) ?? Infinity)
      || this.deps.name(a).localeCompare(this.deps.name(b)) || a.localeCompare(b))[0];
  }

  /** Runs `then` once main's event loop was calm over one window; a busy window waits for another, up to BUSY_WINDOWS of them. */
  private calmThen(then: () => void, busyWindows = 0): void {
    const windowMs = this.deps.calmWindowMs ?? CALM_WINDOW_MS;
    if (windowMs <= 0) { then(); return; }
    const measure = (this.deps.loopUtilization ?? loopUtilization)();
    this.waiting = (this.deps.clock ?? systemClock).setTimeout(() => {
      this.waiting = undefined;
      if (this.stopped) return;
      if (measure() > BUSY && busyWindows + 1 < BUSY_WINDOWS) { this.calmThen(then, busyWindows + 1); return; }
      then();
    }, windowMs);
  }
}

/**
 * The first full scan is done (fix: later scanning does not count: a file rewritten every second
 * keeps a share scanning for good), or it never can be here (its folder is missing, the scan
 * failed): the queue goes on either way.
 */
function finished(status: ShareStatus | undefined): boolean {
  if (!status) return false;
  if (status.state === "unavailable" || status.state === "error") return true;
  return status.indexed === true;
}
