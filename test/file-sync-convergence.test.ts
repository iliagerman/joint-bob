import assert from "node:assert/strict";
import test from "node:test";
import type { Phase } from "../src/file-sync/types.js";
import { detectEngine, runSeed, seedList, type SeedResult } from "./file-sync-harness.js";

/* The randomized convergence proof of the built-in engine (FILE-SYNC design §9 P3a): per seed, 2 or 3
   in-thread cores, a parked network that drops, reorders and truncates, people editing all trees at
   once, crashes between temp and rename, lost indexes, dropped shares and replaced roots; then quiet,
   and every invariant checked (see file-sync-harness.ts). FILE_SYNC_SEEDS (default 300), FILE_SYNC_SEED
   to replay one, FILE_SYNC_SEED_START to run another range, FILE_SYNC_NODES=2|3 for one size only,
   FILE_SYNC_ENGINE=stub|ops|core to choose who applies, FILE_SYNC_RACES=<p> for writers racing the
   apply's renames, FILE_SYNC_RACES_INNER=<p> for writers inside its section, FILE_SYNC_PERTURB=<p> for
   edits while it prepares (each 0 turns its default off), FILE_SYNC_VERBOSE=1 to print the operations,
   FILE_SYNC_TRACE=<path regexp> and FILE_SYNC_TRACE_HASH=<sha256 prefix> to follow one path's rows or
   one content through a replay. Every fourth 3-node seed runs its third node on Syncthing (shadow): its
   tree is never written, and the builtin nodes still agree. */

const SEEDS = seedList(300);
const NODES = process.env.FILE_SYNC_NODES ? [Number(process.env.FILE_SYNC_NODES)] : [2, 3];
const VERBOSE = process.env.FILE_SYNC_VERBOSE === "1";

/** Without FILE_SYNC_NODES the 3-node run (random pull order, relaying) takes every fifth seed. */
function seedsFor(nodes: number): number[] {
  if (process.env.FILE_SYNC_NODES || process.env.FILE_SYNC_SEED !== undefined || nodes === 2) return SEEDS;
  return SEEDS.filter((_, index) => index % 5 === 0);
}

function summary(results: SeedResult[]): string {
  const blocked = new Map<string, number>();
  for (const result of results) for (const item of result.blocked) blocked.set(item.model ?? "unexplained", (blocked.get(item.model ?? "unexplained") ?? 0) + 1);
  const total = (key: string) => results.reduce((sum, result) => sum + (Number(result.stats[key]) || 0), 0);
  const ms = results.map((result) => result.ms).sort((a, b) => a - b);
  return [
    `${results.length} seeds, engine ${detectEngine()}, median ${ms[Math.floor(ms.length / 2)] ?? 0} ms, slowest ${ms.at(-1) ?? 0} ms`,
    `crashes ${total("crashes")}, index wipes ${total("wipes")}, share drops ${total("drops")}, root replacements ${total("replaced")}, raced tombstones ${total("raced")}`,
    `kept in the trash ${total("kept")}, conflict copies ${total("copies")}, writes inside apply ${total("innerRaced")}, edits while it prepared ${total("perturbed")}, rule changes ${total("ruleChanges")}, phase changes ${total("phaseChanges")}, revocations ${total("revocations")}`,
    `network: ${total("net.requests")} requests, ${total("net.dropped")} dropped, ${total("net.refused")} refused, ${total("net.held")} held, ${total("net.truncated")} cut short, ${total("net.lost")} answers lost`,
    `blocked at the end: ${blocked.size ? [...blocked].map(([model, count]) => `${model} ${count}`).join(", ") : "none"}`,
  ].join("\n");
}

for (const nodes of NODES) {
  const seeds = seedsFor(nodes);
  test(`${nodes} nodes converge with every version kept (${seeds.length} seeds from ${seeds[0]})`, async () => {
    const results: SeedResult[] = [];
    const failures: SeedResult[] = [];
    for (const seed of seeds) {
      const phases: Phase[] | undefined = nodes === 3 && seed % 4 === 0 ? ["builtin", "builtin", "syncthing"] : undefined;
      const result = await runSeed({ seed, nodes, largeFiles: true, verbose: VERBOSE, ...(phases ? { phases } : {}) });
      results.push(result);
      if (result.problems.length) {
        failures.push(result);
        console.log(result.report);
      }
    }
    console.log(summary(results));
    assert.deepEqual(failures.map((failure) => failure.seed), [], `failing seeds (replay one with FILE_SYNC_SEED=<seed> FILE_SYNC_NODES=${nodes}):\n${failures.slice(0, 3).map((failure) => failure.report).join("\n\n")}`);
  });
}
