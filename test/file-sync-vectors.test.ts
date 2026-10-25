import assert from "node:assert/strict";
import test from "node:test";
import { decide, decideGlobal, pickTarget, sameContent, sameMeta, type Decision } from "../src/file-sync/conflicts.js";
import type { IndexEntry, Vector } from "../src/file-sync/types.js";
import { bump, canonicalVector, compareVectors, mergeVectors, nextCounter, raiseClock, vectorsEqual } from "../src/file-sync/vectors.js";

const X = "a".repeat(64);
const Y = "b".repeat(64);

function entry(fields: Partial<IndexEntry> = {}): IndexEntry {
  return { path: "f.txt", type: 0, size: 1, mtimeMs: 1000, mode: 0o644, sha256: X, target: null, deleted: false, version: { a: 1 }, modifiedBy: "a", seq: 1, ...fields };
}

test("compareVectors treats a missing node as zero", () => {
  assert.equal(compareVectors({ a: 1 }, { a: 1 }), "equal");
  assert.equal(compareVectors({ a: 1 }, { a: 1, b: 0 }), "equal", "an explicit zero is the same as absent");
  assert.equal(compareVectors({ a: 2 }, { a: 1 }), "greater");
  assert.equal(compareVectors({ a: 1, b: 1 }, { a: 1 }), "greater");
  assert.equal(compareVectors({ a: 1 }, { a: 1, b: 1 }), "less");
  assert.equal(compareVectors({ a: 2 }, { b: 1 }), "concurrent");
  assert.equal(compareVectors({ a: 2, b: 1 }, { a: 1, b: 2 }), "concurrent");
  assert.equal(compareVectors({}, {}), "equal");
});

test("compareVectors reads only own properties", () => {
  assert.equal(compareVectors({ constructor: 1 } as Vector, { constructor: 1 } as Vector), "equal");
  assert.equal(compareVectors({ a: 1 }, { a: 1, toString: 1 } as Vector), "less", "a node named like a prototype member must count as its own counter");
});

test("mergeVectors takes the per-node maximum with sorted keys", () => {
  const merged = mergeVectors({ b: 3, a: 1 }, { a: 2, c: 1, d: 0 });
  assert.deepEqual(merged, { a: 2, b: 3, c: 1 }, `got ${JSON.stringify(merged)}`);
  assert.deepEqual(Object.keys(merged), ["a", "b", "c"], "keys must be sorted for stable JSON");
  assert.deepEqual(mergeVectors({ a: 2 }, { b: 1 }), mergeVectors({ b: 1 }, { a: 2 }), "merge must be commutative");
  assert.equal(canonicalVector({ z: 1, a: 2, m: 0 }), '{"a":2,"z":1}');
  assert.equal(vectorsEqual({ a: 1, b: 0 }, { a: 1 }), true);
});

test("nextCounter is above the clock, above the base counter, and at least now in microseconds", () => {
  assert.equal(nextCounter(10_000, { a: 5 }, "a", 3), 10_001, "the persisted clock wins when it is highest");
  assert.equal(nextCounter(10, { a: 50_000 }, "a", 3), 50_001, "a counter this node issued before must be exceeded");
  assert.equal(nextCounter(10, { a: 5 }, "a", 1_700_000_000_000.5), 1_700_000_000_000_500, "wall time wins, in whole microseconds");
  assert.equal(nextCounter(0, { b: 9_999_999 }, "a", 1), 1000, "other nodes' counters do not matter");
  assert.equal(nextCounter(0, {}, "constructor", 1), 1000, "a node id like a prototype member must read as absent");
  assert.throws(() => nextCounter(Number.MAX_SAFE_INTEGER, {}, "a", 0), /out of range/);
});

test("bump sets this node's counter, keeps the others and returns the new clock", () => {
  const base = { a: 7, b: 3 };
  const { version, clock } = bump(base, "a", 9, 0);
  assert.deepEqual(version, { a: 10, b: 3 });
  assert.equal(clock, 10);
  assert.equal(compareVectors(version, base), "greater", "a bumped version must dominate its base");
  const fresh = bump({ b: 3 }, "c", 0, 5);
  assert.deepEqual(fresh, { version: { b: 3, c: 5000 }, clock: 5000 });
});

test("a burst of versions keeps the clock within a millisecond of the wall clock", () => {
  const now = 1_792_884_991_300;
  let clock = 0;
  for (let index = 0; index < 5000; index++) clock = bump({}, "a", clock, now).clock;
  assert.equal(clock, now * 1000 + 4999, `5000 versions in one ms lead the wall clock by ${clock - now * 1000} µs`);
  // file-sync.db lost: a fresh clock a few ms later is already above every counter of the burst.
  const afterLoss = bump({}, "a", 0, now + 5).clock;
  assert.ok(afterLoss > clock, `after a lost index ${afterLoss} must exceed ${clock}`);
});

test("raiseClock never goes below a counter this node issued", () => {
  assert.equal(raiseClock(100, { a: 500, b: 900 }, "a"), 500);
  assert.equal(raiseClock(100, { a: 50 }, "a"), 100);
  assert.equal(raiseClock(100, { b: 900 }, "a"), 100, "another node's counter must not move this node's clock");
});

test("a node that lost its index issues counters its peers do not dominate", () => {
  // The peer still holds {a: 400}; this node starts over with clock 0 but raises it on the first pull.
  const peer = { a: 400, b: 120 };
  const clock = raiseClock(0, peer, "a");
  const { version } = bump({}, "a", clock, 0);
  assert.equal(version.a, 401);
  assert.notEqual(compareVectors(peer, version), "greater", "a stale peer version must never dominate a new local edit");
});

// ---- Exhaustive small model -------------------------------------------------------------------

const VERSIONS: Vector[] = [{ a: 1 }, { b: 1 }, { a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }, { c: 1 }];
const CONTENTS: Array<Partial<IndexEntry>> = [
  { type: 0, sha256: X, mode: 0o644 },
  { type: 0, sha256: Y, mode: 0o644 },
  { type: 0, sha256: X, mode: 0o755 },
  { type: 0, sha256: X, deleted: true },
  { type: 1, sha256: null, mode: 0o755 },
  { type: 2, sha256: null, target: "elsewhere", mode: 0 },
];
const MTIMES = [1000, 2000];

function modifier(version: Vector): string {
  return Object.entries(version).sort(([leftNode, left], [rightNode, right]) => right - left || (rightNode < leftNode ? -1 : 1))[0][0];
}

const UNIVERSE: IndexEntry[] = VERSIONS.flatMap((version) => CONTENTS.flatMap((content) => MTIMES.map((mtimeMs) => entry({ ...content, version, mtimeMs, modifiedBy: modifier(version) }))));

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

function multisets<T>(items: T[], size: number, start = 0): T[][] {
  if (size === 0) return [[]];
  const result: T[][] = [];
  for (let index = start; index < items.length; index += 1) {
    for (const rest of multisets(items, size - 1, index)) result.push([items[index], ...rest]);
  }
  return result;
}

// One version names one state: two rows with an equal vector but different content cannot both exist.
function consistent(entries: Array<IndexEntry | undefined>): boolean {
  const live = entries.filter((value): value is IndexEntry => value !== undefined);
  return live.every((left) => live.every((right) => !vectorsEqual(left.version, right.version) || (sameMeta(left, right) && left.mtimeMs === right.mtimeMs)));
}

function describe(entries: Array<IndexEntry | undefined>): string {
  return JSON.stringify(entries.map((value) => value && { v: value.version, t: value.type, h: value.sha256?.[0] ?? null, l: value.target, d: value.deleted, o: value.mode, m: value.mtimeMs }));
}

function clone(value: IndexEntry | undefined): IndexEntry | undefined {
  if (!value) return undefined;
  // Reversed vector keys: the decision must not depend on property order or object identity.
  return { ...structuredClone(value), version: Object.fromEntries(Object.entries(value.version).reverse()) };
}

test("decide is a deterministic function of its inputs over the whole model", () => {
  const sides = [undefined, ...UNIVERSE];
  let checked = 0;
  for (const local of sides) {
    for (const target of sides) {
      const first = decide(local, target);
      assert.deepEqual(decide(local, target), first, `repeat call differs for ${describe([local, target])}`);
      assert.deepEqual(decide(clone(local), clone(target)), first, `cloned inputs differ for ${describe([local, target])}`);
      checked += 1;
    }
  }
  assert.equal(checked, (UNIVERSE.length + 1) ** 2);
});

test("pickTarget is order-independent for every triple of the model", () => {
  let sets = 0;
  for (const set of multisets(UNIVERSE, 3)) {
    const expected = pickTarget(set);
    for (const order of permutations(set)) {
      assert.equal(pickTarget(order), expected, `order ${describe(order)} picked ${describe([pickTarget(order)])}, expected ${describe([expected])}`);
    }
    sets += 1;
  }
  assert.ok(sets > 40_000, `expected the full triple model, checked ${sets}`);
});

test("pickTarget is order-independent for sampled sets of four and five", () => {
  let seed = 0x5eed;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  for (let sample = 0; sample < 3000; sample += 1) {
    const size = sample % 2 ? 4 : 5;
    const set = Array.from({ length: size }, () => UNIVERSE[Math.floor(random() * UNIVERSE.length)]);
    const expected = pickTarget(set);
    for (const order of permutations(set)) assert.equal(pickTarget(order), expected, `order ${describe(order)}`);
  }
});

test("pickTarget never returns a dominated version", () => {
  for (const set of multisets(UNIVERSE, 3)) {
    const target = pickTarget(set)!;
    for (const other of set) assert.notEqual(compareVectors(other.version, target.version), "greater", `${describe([target])} is dominated in ${describe(set)}`);
  }
});

function afterDecision(local: IndexEntry | undefined, target: IndexEntry | undefined, decision: Decision): IndexEntry | undefined {
  if (decision.kind === "merge") return { ...local!, version: decision.version };
  if (decision.kind === "none") return local;
  return { ...target!, version: mergeVectors(local?.version ?? {}, target!.version) };
}

// Absent and deleted are the same state on disk.
function state(value: IndexEntry | undefined): string {
  if (!value || value.deleted) return "absent";
  return JSON.stringify([value.type, value.sha256, value.target, value.type === 2 ? 0 : value.mode]);
}

test("two nodes deciding against each other agree after one round and on vectors after two", () => {
  const sides = [undefined, ...UNIVERSE];
  for (const left of sides) {
    for (const right of sides) {
      if (!consistent([left, right])) continue;
      const nextLeft = afterDecision(left, right, decide(left, right));
      const nextRight = afterDecision(right, left, decide(right, left));
      assert.equal(state(nextLeft), state(nextRight), `contents differ after one round for ${describe([left, right])}`);
      const finalLeft = afterDecision(nextLeft, nextRight, decide(nextLeft, nextRight));
      const finalRight = afterDecision(nextRight, nextLeft, decide(nextRight, nextLeft));
      if (finalLeft && finalRight) assert.equal(compareVectors(finalLeft.version, finalRight.version), "equal", `vectors differ after two rounds for ${describe([left, right])}`);
    }
  }
});

test("of two concurrent different versions exactly one side gives way", () => {
  for (const [left, right] of multisets(UNIVERSE, 2)) {
    if (compareVectors(left.version, right.version) !== "concurrent" || sameMeta(left, right)) continue;
    const applies = [decide(left, right), decide(right, left)].filter((decision) => decision.kind === "apply").length;
    assert.equal(applies, 1, `expected exactly one loser for ${describe([left, right])}`);
  }
});

test("decideGlobal converges three nodes in one round over every consistent triple", () => {
  const sides = [undefined, ...UNIVERSE];
  let triples = 0;
  for (const set of multisets(sides, 3)) {
    if (!consistent(set)) continue;
    // Each node sees the other two nodes' rows; which node is listed first does not matter.
    const others = (index: number) => set.filter((value, at): value is IndexEntry => at !== index && value !== undefined);
    const results = set.map((local, index) => {
      const { target, decision } = decideGlobal(local, others(index));
      return afterDecision(local, target, decision);
    });
    const states = new Set(results.map(state));
    assert.equal(states.size, 1, `nodes disagree after one round for ${describe(set)}: ${[...states].join(" | ")}`);
    triples += 1;
  }
  assert.ok(triples > 1000, `expected many consistent triples, checked ${triples}`);
});

test("decideGlobal agrees with decide when there is one peer", () => {
  const sides = [undefined, ...UNIVERSE];
  for (const local of sides) {
    for (const remote of UNIVERSE) {
      if (!consistent([local, remote])) continue;
      const { decision } = decideGlobal(local, [remote]);
      const expected = decide(local, remote);
      assert.equal(state(afterDecision(local, remote, decision)), state(afterDecision(local, remote, expected)), `outcome differs for ${describe([local, remote])}`);
      assert.equal(decision.kind === "apply" && decision.conflict, expected.kind === "apply" && expected.conflict, `conflict flag differs for ${describe([local, remote])}`);
    }
  }
});

test("pairwise decide can leave three nodes on three versions; decideGlobal picks one", () => {
  // L was edited into A by node b; c made B independently. mtimes rank L > B > A, dominance says A > L.
  const L = entry({ version: { a: 10 }, modifiedBy: "a", mtimeMs: 300, sha256: X });
  const A = entry({ version: { a: 10, b: 20 }, modifiedBy: "b", mtimeMs: 100, sha256: Y });
  const B = entry({ version: { c: 15 }, modifiedBy: "c", mtimeMs: 200, sha256: "c".repeat(64) });
  const nodes: Array<[IndexEntry, IndexEntry[]]> = [[L, [A, B]], [A, [L, B]], [B, [L, A]]];
  const pairwise = nodes.map(([local, remotes]) => decide(local, pickTarget(remotes)).kind);
  assert.deepEqual(pairwise, ["none", "none", "none"], "documents why decideGlobal exists: each node prefers its own version");
  const outcomes = nodes.map(([local, remotes]) => { const { target, decision } = decideGlobal(local, remotes); return state(afterDecision(local, target, decision)); });
  assert.equal(new Set(outcomes).size, 1, `decideGlobal must converge, got ${outcomes.join(" | ")}`);
  assert.equal(outcomes[0], state(B), "the undominated winner by mtime is B");
  assert.deepEqual(decideGlobal(A, [L, B]).decision, { kind: "apply", action: "fetch", conflict: true }, "A was nobody's history: it is kept as a conflict copy");
  assert.deepEqual(decideGlobal(L, [A, B]).decision, { kind: "apply", action: "fetch", conflict: false }, "L was already replaced by A: no conflict copy");
});

test("sameContent ignores mode and sameMeta does not", () => {
  assert.equal(sameContent(entry({ mode: 0o644 }), entry({ mode: 0o755 })), true);
  assert.equal(sameMeta(entry({ mode: 0o644 }), entry({ mode: 0o755 })), false);
});
