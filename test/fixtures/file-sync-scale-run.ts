// Run by test/file-sync-scale.test.ts in a child process with a small heap: the need queue against a
// backlog shaped like the one that ended the Mac's worker on 2026-11-02 (a peer deleted ~25 worktrees,
// 296,000 deletes at priority 0; reading them at once took 470 MB of the worker's 512). Prints one JSON
// line with what each operation took; running out of heap ends the process instead.
import path from "node:path";
import { FileSyncDb, type NeedRow } from "../../src/file-sync/db.js";
import { NeedEngine, type NeedShare } from "../../src/file-sync/need.js";
import { DIRECTORY, FILE, type Clock } from "../../src/file-sync/types.js";

const [dir, rowsArg] = process.argv.slice(2);
const total = Number(rowsArg);
if (!dir || !Number.isInteger(total) || total <= 0) throw new Error("usage: file-sync-scale-run.ts <dir> <rows>");

let now = 1_000_000;
const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
const clock: Clock = {
  now: () => now,
  setTimeout(run, ms) {
    const timer = { at: now + ms, run, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  },
};
function advance(ms: number): void {
  now += ms;
  for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
    if (timer.cancelled) continue;
    if (timer.at <= now) timer.run(); else timers.push(timer);
  }
}

const key = "worktrees:p1";
const db = new FileSyncDb(path.join(dir, "file-sync.db"), "node-b");
db.writeTx(() => {
  db.insertShare({ share: key, projectId: "p1", kind: "worktrees", root: dir, indexId: "gen1" });
  db.updateShare(key, { fullScanAt: 1, rulesHash: "h" });
});
const share = (): NeedShare => ({ key, phase: "builtin", rulesHash: "h", kind: "worktrees", peers: () => ["p1"], available: () => true, ignored: () => false });
const need = new NeedEngine({
  db, nodeId: "node-b", clock, settleMs: 1000, share: (wanted) => wanted === key ? share() : undefined,
  localChanged: () => {}, comparisonChanged: () => {}, needChanged: () => {},
});
need.syncNeed(key);
await need.idle();

// The backlog: deleted worktrees of nested folders (most at priority 0, as a peer's status puts them),
// their baselines at 5, and creates no peer can send yet (they are read and passed over every time).
const version = { "aea53035-6e54-4ad6": 822_438, "3898bc65-575f-429f": 54_382, "cc57f9b1-64c7-456c": 191_407 };
function row(relative: string, action: NeedRow["action"], priority: number, type = FILE, deleted = true): NeedRow {
  return {
    path: relative, action, fromPath: null, conflict: false, priority, attempts: 0, nextAt: 0, lastError: null, blocked: false, blockedAt: null,
    target: { path: relative, type, size: deleted ? 0 : 2_000, mtimeMs: 1_000, mode: 0o644, sha256: deleted ? null : "c".repeat(64), target: null, deleted, version, modifiedBy: "aea53035-6e54-4ad6", seq: 0 },
  };
}
const creates = Math.floor(total / 10);
let seeded = 0;
db.writeTx(() => {
  for (let worktree = 0; seeded < total - creates; worktree++) {
    const root = `${worktree.toString(16).padStart(8, "0")}-1c0a-463e-aba9-8ec5aec21510`;
    db.putNeed(key, row(root, "delete", 0, DIRECTORY));
    for (let folder = 0; folder < 40 && seeded < total - creates; folder++) {
      const parent = `${root}/backend/src/module-${folder}`;
      db.putNeed(key, row(parent, "delete", 0, DIRECTORY));
      for (let file = 0; file < 100 && seeded < total - creates; file++, seeded++) {
        const baseline = file % 10 === 0;
        db.putNeed(key, baseline ? row(`${root}/.joint-bob-baseline/backend/src/module-${folder}/file-${file}.py`, "delete", 5) : row(`${parent}/file-${file}.py`, "delete", 0));
      }
    }
  }
  for (let file = 0; file < creates; file++) db.putNeed(key, row(`new-worktree/src/file-${file}.ts`, "fetch", 1, FILE, false));
});

const timings: Record<string, number> = {};
let heapPeakMb = 0;
function measure<T>(name: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  timings[name] = Math.round(performance.now() - started);
  heapPeakMb = Math.max(heapPeakMb, Math.round(process.memoryUsage().heapUsed / 1048576));
  return result;
}

// What the transfer loop asks for (sync.ts TRANSFER_SCAN_LIMIT).
const limit = (3 + 1) * 256 + 64;
const first = measure("nextNeeds", () => need.nextNeeds({ limit, availablePeers: ["p1"] }).items);
const second = measure("nextNeedsWithFirstInFlight", () => need.nextNeeds({ limit, availablePeers: ["p1"], inFlight: first.map((item) => `${item.share}\n${item.path}`) }).items);
measure("prioritizeShare", () => need.prioritize(key, undefined, now + 10_000));
// Every peer status asks again while the first is still on.
measure("prioritizeShareAgain", () => { for (let ask = 0; ask < 5; ask++) need.prioritize(key, undefined, now + 10_000 + ask); });
measure("prioritizeWorktree", () => need.prioritize(key, "00000003-1c0a-463e-aba9-8ec5aec21510", now + 10_000));
measure("expirePriorities", () => advance(10_100));
const pending = measure("pendingUnderWorktree", () => need.pendingUnder(key, "00000003-1c0a-463e-aba9-8ec5aec21510", ["p1"]));
const restored = db.needRow(key, `new-worktree/src/file-0.ts`)?.priority;

// Every item is a delete, and a folder never comes before a row inside it.
const order = [...first, ...second];
let foldersFirst = 0;
const seen = new Set<string>();
for (const item of order) {
  for (let at = item.path.lastIndexOf("/"); at > 0; at = item.path.lastIndexOf("/", at - 1)) if (seen.has(item.path.slice(0, at))) foldersFirst++;
  seen.add(item.path);
}
process.stdout.write(`${JSON.stringify({
  seeded: seeded + creates, timings, heapPeakMb, first: first.length, second: second.length, overlap: second.filter((item) => first.some((other) => other.path === item.path)).length,
  actions: [...new Set(order.map((item) => item.action))], foldersFirst, pendingFiles: pending.files, restored,
})}\n`);
need.close();
db.close();
