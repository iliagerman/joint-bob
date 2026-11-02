import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* Scale guard for the need queue. On 2026-11-02 a peer deleted ~25 worktrees, and the Mac's file-sync
   worker ran out of its 512 MB heap reading the 296,000 deletes at once: five times in ten minutes, then
   it gave up ("File sync stopped on this node after repeated failures"). The other file-sync tests seed a
   handful of rows, where reading a whole share costs nothing, so none of them noticed.

   Here the queue runs over 150,000 rows in a child process with a 96 MB heap. The old code peaked at
   415 MB on this backlog and dies of "heap out of memory"; the current code peaks near 35 MB. Any
   operation that decodes the whole backlog at once ends the child. The time budgets are generous multiples
   of the current figures on an M-series Mac (40 ms, 150 ms); the old code took 720 ms and 3,300 ms. */
const RUNNER = fileURLToPath(new URL("./fixtures/file-sync-scale-run.ts", import.meta.url));
const ROWS = 150_000;
const HEAP_MB = 96;

test(`the need queue works through a ${ROWS.toLocaleString("en")}-row delete backlog within a ${HEAP_MB} MB heap`, { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-scale-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", `--max-old-space-size=${HEAP_MB}`, RUNNER, dir, String(ROWS)], { encoding: "utf8", timeout: 110_000 });
  assert.equal(run.status, 0, `the queue did not get through the backlog (status ${run.status}, signal ${run.signal}):\n${run.stderr.slice(-2000)}`);
  const result = JSON.parse(run.stdout.trim().split("\n").pop()!) as {
    seeded: number; timings: Record<string, number>; heapPeakMb: number; first: number; second: number; overlap: number;
    actions: string[]; foldersFirst: number; pendingFiles: number; restored: number;
  };
  t.diagnostic(JSON.stringify({ timings: result.timings, heapPeakMb: result.heapPeakMb }));
  assert.equal(result.seeded, ROWS);
  // Two full batches of deletes, the second past the first one in flight, and never a folder before what is in it.
  assert.deepEqual([result.first, result.second, result.overlap, result.actions, result.foldersFirst], [1088, 1088, 0, ["delete"], 0]);
  // One worktree's rows (its folder, 40 subfolders, 4,000 files), and a priority put back once it expired.
  assert.deepEqual([result.pendingFiles, result.restored], [4041, 1]);
  assert.ok(result.timings.nextNeeds! < 400, `nextNeeds took ${result.timings.nextNeeds} ms`);
  assert.ok(result.timings.nextNeedsWithFirstInFlight! < 400, `nextNeeds with a batch in flight took ${result.timings.nextNeedsWithFirstInFlight} ms`);
  assert.ok(result.timings.prioritizeShareAgain! < 1500, `five more whole-share prioritizes took ${result.timings.prioritizeShareAgain} ms`);
});
