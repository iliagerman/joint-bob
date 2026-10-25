import type { Vector } from "./types.js";

/* Version vectors. A counter is the producing node's clock (FILE-SYNC design §1, in microseconds of
   wall time), never a share seq: seq restarts with a new index generation, the clock never goes back,
   so a node that lost file-sync.db still issues counters above the ones its peers hold. */

export type VectorOrder = "equal" | "greater" | "less" | "concurrent";

// Own properties only: a node id like "constructor" must not read Object.prototype.
function counter(vector: Vector, node: string): number {
  return Object.hasOwn(vector, node) ? vector[node] : 0;
}

/** How `a` relates to `b`; a missing node counts as 0. */
export function compareVectors(a: Vector, b: Vector): VectorOrder {
  let greater = false;
  let less = false;
  for (const node of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = counter(a, node);
    const right = counter(b, node);
    if (left > right) greater = true;
    else if (left < right) less = true;
    if (greater && less) return "concurrent";
  }
  return greater ? "greater" : less ? "less" : "equal";
}

export function vectorsEqual(a: Vector, b: Vector): boolean {
  return compareVectors(a, b) === "equal";
}

/** Per-node maximum, keys sorted (stable JSON in the index and on the wire). */
export function mergeVectors(a: Vector, b: Vector): Vector {
  const merged: Vector = {};
  for (const node of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const value = Math.max(counter(a, node), counter(b, node));
    if (value > 0) merged[node] = value;
  }
  return merged;
}

/** Canonical text of a vector: sorted keys, zero counters dropped. */
export function canonicalVector(vector: Vector): string {
  return JSON.stringify(mergeVectors(vector, {}));
}

/**
 * The counter for a new local version: above the persisted clock, above this node's counter in the
 * base, and at least the wall clock (`now` in ms) in microseconds. In milliseconds a big indexing run
 * (thousands of versions a second) pushed the clock seconds ahead of the wall clock, and a node that
 * then lost file-sync.db started over below counters it had issued; a thousand versions per ms never
 * happens, so after a lost index the wall clock alone is already above them.
 */
export function nextCounter(clock: number, base: Vector, self: string, now: number): number {
  const next = Math.max(clock + 1, counter(base, self) + 1, Math.floor(now * 1000));
  if (!Number.isSafeInteger(next)) throw new Error("Version counter is out of range");
  return next;
}

/** A new local version over `base`. Persist the returned clock in the same transaction as the row. */
export function bump(base: Vector, self: string, clock: number, now: number): { version: Vector; clock: number } {
  const next = nextCounter(clock, base, self, now);
  return { version: mergeVectors(base, { [self]: next }), clock: next };
}

/** The clock after seeing `vector`: never below a counter this node issued before (lost index, restored backup). */
export function raiseClock(clock: number, vector: Vector, self: string): number {
  return Math.max(clock, counter(vector, self));
}
