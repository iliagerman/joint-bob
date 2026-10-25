import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkerCore, type FileSyncCore } from "../src/file-sync/core.js";
import { FILE, type Clock, type IndexEntry, type Phase } from "../src/file-sync/types.js";
import { canonicalVector, compareVectors, mergeVectors } from "../src/file-sync/vectors.js";

/* §7.3: the switch to builtin decides every path once with one extra rule. Entries made while Syncthing
   copied files without telling the engine (every local one, a peer's up to its builtinSince) never delete
   a live file and never replace one with other content without keeping it. */

const SELF = "node-a";
const PEER = "node-b";
const OTHER = "node-c";

function sha(content: string): string { return createHash("sha256").update(content).digest("hex"); }

interface Node {
  root: string;
  key: string;
  core: FileSyncCore;
  pull(peer: string, entries: Array<Partial<IndexEntry> & { path: string }>): Promise<number>;
  local(relative: string): IndexEntry;
  bootstrap(builtinSinceByPeer: Record<string, number>): Promise<{ merged: number; need: number }>;
}

async function node(t: TestContext, files: Record<string, string>, phase: Phase = "builtin"): Promise<Node> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-boot-"));
  const root = path.join(dir, "root");
  mkdirSync(root);
  for (const [relative, content] of Object.entries(files)) {
    writeFileSync(path.join(root, relative), content);
    utimesSync(path.join(root, relative), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  }
  const key = "project:p1";
  let now = Date.now();
  const clock: Clock = { now: () => now++, setTimeout: () => ({ cancel() {} }) };
  let seed = 5;
  const core = createWorkerCore({ nodeId: SELF, dataDir: path.join(dir, "data"), clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false, emit: () => {} });
  t.after(async () => { await core.close(); rmSync(dir, { recursive: true, force: true }); });
  await core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key, projectId: "p1", kind: "project", root, phase, rules: {}, peers: [PEER, OTHER] }],
  });
  await core.call("scan", { share: key, scope: "full", reason: "test" });
  const seqs = new Map<string, number>();
  const result: Node = {
    root, key, core,
    async pull(peer, entries) {
      const since = core.db.cursor(key, peer)?.seq ?? 0;
      let seq = seqs.get(peer) ?? 0;
      const rows = entries.map((fields): IndexEntry => ({ type: FILE, size: 0, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: null, target: null, deleted: false, version: { [peer]: 1 }, modifiedBy: peer, ...fields, seq: ++seq }));
      seqs.set(peer, seq);
      await core.need.storeRemote(key, peer, since, { indexId: `${peer}-gen`, maxSeq: seq, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null, entries: rows, more: false });
      await core.need.idle();
      return seq;
    },
    local: (relative) => core.db.entry(key, relative)!,
    async bootstrap(builtinSinceByPeer) {
      const answer = await core.call("bootstrap", { share: key, builtinSinceByPeer });
      await core.need.idle();
      return answer;
    },
  };
  // The switch runs only once every peer's whole index is here: both start listed (empty), tests add pages.
  for (const peer of [PEER, OTHER]) await result.pull(peer, []);
  return result;
}

test("a weak tombstone of other content never deletes a live file: the live version is raised over it", async (t) => {
  const n = await node(t, { "live.txt": "live" });
  const before = n.local("live.txt");
  const since = await n.pull(PEER, [{ path: "live.txt", deleted: true, size: 3, sha256: sha("old"), version: mergeVectors(before.version, { [PEER]: 9 }) }]);
  assert.equal(n.core.db.needRow(n.key, "live.txt")?.action, "delete", "the ordinary rule would delete it");
  const result = await n.bootstrap({ [PEER]: since });
  const after = n.local("live.txt");
  assert.equal(compareVectors(after.version, n.core.db.remote(n.key, PEER, "live.txt")!.version), "greater");
  assert.deepEqual([after.deleted, after.sha256, after.modifiedBy], [false, sha("live"), SELF]);
  assert.equal(n.core.db.needRow(n.key, "live.txt"), undefined);
  assert.equal(readFileSync(path.join(n.root, "live.txt"), "utf8"), "live");
  assert.equal(result.need, 0);
  // builtin_since = this node's maxSeq after the bootstrap, served to peers.
  const builtinSince = n.core.db.share(n.key)!.builtinSince;
  assert.equal(builtinSince, n.core.db.share(n.key)!.maxSeq);
  const answer = await n.core.service.serve(PEER, "shares", {}, undefined);
  const served = (answer.json as { shares: Array<{ kind: string; builtinSince: number | null }> }).shares.find((share) => share.kind === "project");
  assert.equal(served?.builtinSince, builtinSince);
});

test("a tombstone that deleted exactly the live content still wins; one written while the peer ran builtin is an ordinary delete", async (t) => {
  const n = await node(t, { "same.txt": "same", "late.txt": "late" });
  const same = n.local("same.txt");
  const late = n.local("late.txt");
  const since = await n.pull(PEER, [{ path: "same.txt", deleted: true, size: 4, sha256: sha("same"), version: mergeVectors(same.version, { [PEER]: 9 }) }]);
  await n.pull(PEER, [{ path: "late.txt", deleted: true, size: 3, sha256: sha("old"), version: mergeVectors(late.version, { [PEER]: 10 }) }]);
  const result = await n.bootstrap({ [PEER]: since });
  assert.equal(n.core.db.needRow(n.key, "same.txt")?.action, "delete");
  assert.equal(n.core.db.needRow(n.key, "late.txt")?.action, "delete", "seq above builtinSince: observed in builtin mode");
  assert.equal(result.need, 2);
});

test("a local tombstone of other content never deletes a peer's live file: it leaves the index and the file comes here", async (t) => {
  const n = await node(t, { "gone.txt": "mine", "exact.txt": "exact" });
  const gone = n.local("gone.txt");
  const exact = n.local("exact.txt");
  unlinkSync(path.join(n.root, "gone.txt"));
  unlinkSync(path.join(n.root, "exact.txt"));
  await n.core.call("scan", { share: n.key, scope: "full", reason: "test" });
  assert.deepEqual([n.local("gone.txt").deleted, n.local("exact.txt").deleted], [true, true]);
  // Syncthing gave the peer other bytes under the version this node had seen; this node's delete dominates them.
  await n.pull(PEER, [{ path: "gone.txt", size: 6, sha256: sha("theirs"), version: gone.version }, { path: "exact.txt", size: 5, sha256: sha("exact"), version: exact.version }]);
  assert.equal(n.core.db.needRow(n.key, "gone.txt"), undefined, "the ordinary rule keeps the tombstone (the peer would delete its file)");
  const prunedBefore = n.core.db.share(n.key)!.prunedBelow;
  await n.bootstrap({});
  assert.equal(n.core.db.entry(n.key, "gone.txt"), undefined);
  assert.ok(n.core.db.share(n.key)!.prunedBelow > prunedBefore, "peers forget the row as after a prune");
  assert.deepEqual([n.core.db.needRow(n.key, "gone.txt")?.action, n.core.db.needRow(n.key, "gone.txt")?.target.sha256], ["fetch", sha("theirs")]);
  assert.equal(n.local("exact.txt").deleted, true, "it deleted exactly that content: the delete stands");
  assert.equal(n.core.db.needRow(n.key, "exact.txt"), undefined);
});

test("weak other content keeps both: the local version becomes concurrent and the loser a conflict copy", async (t) => {
  const n = await node(t, { "both.txt": "mine", "strong.txt": "mine too", "merge.txt": "equal" });
  const both = n.local("both.txt");
  const strong = n.local("strong.txt");
  const merge = n.local("merge.txt");
  const later = both.mtimeMs + 60_000;
  const since = await n.pull(PEER, [
    { path: "both.txt", size: 6, sha256: sha("theirs"), version: mergeVectors(both.version, { [PEER]: 9 }), mtimeMs: later },
    { path: "merge.txt", size: 5, sha256: sha("equal"), version: { [OTHER]: 4 }, mtimeMs: merge.mtimeMs },
  ]);
  await n.pull(PEER, [{ path: "strong.txt", size: 6, sha256: sha("theirs"), version: mergeVectors(strong.version, { [PEER]: 10 }), mtimeMs: later }]);
  assert.equal(n.core.db.needRow(n.key, "both.txt")?.conflict, false, "dominance alone would overwrite it (trash only)");
  await n.bootstrap({ [PEER]: since });
  const row = n.core.db.needRow(n.key, "both.txt")!;
  assert.deepEqual([row.action, row.conflict, row.target.sha256], ["fetch", true, sha("theirs")], "the peer's newer version wins; this node keeps its own as a conflict copy");
  assert.equal(compareVectors(n.local("both.txt").version, row.target.version), "concurrent");
  assert.deepEqual([n.core.db.needRow(n.key, "strong.txt")?.conflict, n.core.db.needRow(n.key, "strong.txt")?.action], [false, "fetch"], "not weak: an ordinary update");
  assert.equal(n.core.db.needRow(n.key, "merge.txt"), undefined);
  assert.equal(canonicalVector(n.local("merge.txt").version), canonicalVector(mergeVectors(merge.version, { [OTHER]: 4 })), "identical content merges");
});

test("a peer missing from builtinSinceByPeer is not builtin yet: all its rows are weak; a shadow phase counts need without storing it", async (t) => {
  const n = await node(t, { "x.txt": "x", "y.txt": "y" }, "bootstrapping");
  const x = n.local("x.txt");
  await n.pull(OTHER, [{ path: "x.txt", deleted: true, size: 1, sha256: sha("other"), version: mergeVectors(x.version, { [OTHER]: 50 }) }, { path: "new.txt", size: 3, sha256: sha("new") }]);
  const result = await n.bootstrap({ [PEER]: 0 });
  assert.equal(compareVectors(n.local("x.txt").version, n.core.db.remote(n.key, OTHER, "x.txt")!.version), "greater");
  assert.equal(n.core.db.needCount(n.key), 0, "only a builtin share holds need rows");
  assert.equal(result.need, 1, "new.txt is what this node will fetch once builtin");
  assert.equal(n.core.db.share(n.key)!.builtinSince, n.core.db.share(n.key)!.maxSeq);
  // Builtin now: the stored rows decide, and the raised version keeps x.txt.
  await n.core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: n.key, projectId: "p1", kind: "project", root: n.root, phase: "builtin", rules: {}, peers: [PEER, OTHER] }],
  });
  await n.core.need.idle();
  assert.deepEqual([n.core.db.needRow(n.key, "x.txt"), n.core.db.needRow(n.key, "new.txt")?.action], [undefined, "fetch"]);
});

test("bootstrap refuses an index that is not complete yet", async (t) => {
  const n = await node(t, { "a.txt": "a" });
  n.core.db.writeTx(() => n.core.db.updateShare(n.key, { fullScanAt: null }));
  await assert.rejects(n.core.call("bootstrap", { share: n.key, builtinSinceByPeer: {} }), /not finished indexing/);
});

test("bootstrap waits for every peer's whole index: a Syncthing-era tombstone still being paged in never deletes a live file", async (t) => {
  const n = await node(t, { "x.txt": "live here", "a.txt": "a" }, "bootstrapping");
  const x = n.local("x.txt");
  // OTHER is not builtin (absent from builtinSinceByPeer): every row of its index is weak. Its new listing comes in two pages.
  const row = (seq: number, fields: Partial<IndexEntry> & { path: string }): IndexEntry => ({ type: FILE, size: 0, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: null, target: null, deleted: false, version: { [OTHER]: seq }, modifiedBy: OTHER, ...fields, seq });
  const page = (since: number, entries: IndexEntry[], more: boolean) => n.core.need.storeRemote(n.key, OTHER, since, { indexId: "other-gen-2", maxSeq: 2, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null, entries, more });
  await page(0, [row(1, { path: "a.txt", size: 1, sha256: sha("a"), version: n.local("a.txt").version })], true);
  await assert.rejects(n.bootstrap({ [PEER]: 0 }), (error: Error & { code?: string }) => error.code === "not-ready" && /whole index of node-c/.test(error.message));
  assert.equal(n.core.db.share(n.key)!.builtinSince, null, "not switched");
  // The rest of the listing: a tombstone Syncthing made there over other content, dominating this node's version.
  await page(1, [row(2, { path: "x.txt", deleted: true, size: 3, sha256: sha("old"), version: mergeVectors(x.version, { [OTHER]: 50 }) })], false);
  await n.core.need.idle();
  await n.bootstrap({ [PEER]: 0 });
  await n.core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: n.key, projectId: "p1", kind: "project", root: n.root, phase: "builtin", rules: {}, peers: [PEER, OTHER] }],
  });
  await n.core.need.idle();
  assert.equal(n.core.db.needRow(n.key, "x.txt"), undefined, "the weak tombstone lost to the live file");
  assert.equal(compareVectors(n.local("x.txt").version, n.core.db.remote(n.key, OTHER, "x.txt")!.version), "greater");
  assert.equal(readFileSync(path.join(n.root, "x.txt"), "utf8"), "live here");
});

test("rows a pull stores while the switch runs are decided under its rule too: the pass runs again", async (t) => {
  const n = await node(t, { "x.txt": "live here", "a.txt": "a" }, "bootstrapping");
  const x = n.local("x.txt");
  const db = n.core.db;
  // The first time the pass lists OTHER's rows, a page of OTHER (not builtin: weak) lands: a tombstone of other content.
  const remoteAfter = db.remoteAfter.bind(db);
  let landed = false;
  t.mock.method(db, "remoteAfter", (share: string, peer: string, after: string, limit: number) => {
    if (!landed && peer === OTHER) {
      landed = true;
      const cursor = db.cursor(share, OTHER)!;
      const row: IndexEntry = { path: "x.txt", type: FILE, size: 3, mtimeMs: 1_700_000_000_000, mode: 0o644, sha256: sha("old"), target: null, deleted: true, version: mergeVectors(x.version, { [OTHER]: 50 }), modifiedBy: OTHER, seq: cursor.seq + 1 };
      db.writeTx(() => {
        db.putRemote(share, OTHER, row);
        db.updateCursor(share, OTHER, { seq: row.seq, peerMaxSeq: row.seq }, Date.now());
      });
    }
    return remoteAfter(share, peer, after, limit);
  });
  await n.bootstrap({ [PEER]: 0 });
  assert.equal(landed, true);
  await n.core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key: n.key, projectId: "p1", kind: "project", root: n.root, phase: "builtin", rules: {}, peers: [PEER, OTHER] }],
  });
  await n.core.need.idle();
  assert.equal(n.core.db.needRow(n.key, "x.txt"), undefined, "the tombstone that arrived mid-switch never deletes the live file");
  assert.equal(compareVectors(n.local("x.txt").version, n.core.db.remote(n.key, OTHER, "x.txt")!.version), "greater");
});
