import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerTransport } from "../src/file-sync/core.js";
import { fileSyncDbPath } from "../src/file-sync/db.js";
import type { ConfigureArgs, FilesEndpoint, ServeAnswer } from "../src/file-sync/protocol.js";
import type { Clock } from "../src/file-sync/types.js";
import { decodeIndexPage, FILES_API, WireError, type IndexPage } from "../src/file-sync/wire.js";

const SHARE = "project:p1";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

class FakeClock implements Clock {
  private timers: Array<{ at: number; seq: number; run(): void; cancelled: boolean }> = [];
  private seq = 0;
  current = Date.now() + 3_600_000;
  now(): number { return this.current; }
  setTimeout(run: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.current + Math.max(0, ms), seq: this.seq++, run, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }
  fireNext(): boolean {
    this.timers = this.timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers.shift();
    if (!next) return false;
    this.current = Math.max(this.current, next.at);
    next.run();
    return true;
  }
}

interface Node { id: string; root: string; core: FileSyncCore; configure(peers?: string[], share?: Record<string, unknown>): Promise<unknown>; scan(): Promise<unknown> }

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-paging-"));
  const clock = new FakeClock();
  const cores = new Map<string, FileSyncCore>();
  const pages: Array<{ from: string; to: string; since: number; limit: number }> = [];
  const nodes: Node[] = [];
  t.after(async () => {
    for (const node of nodes) await node.core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const transport = (from: string): PeerTransport => ({
    async request(peer, request) {
      const core = cores.get(peer);
      if (!core) throw new Error(`connect ECONNREFUSED ${peer}`);
      const url = new URL(request.target, "http://peer");
      const endpoint = url.pathname.slice(FILES_API.length + 1) as FilesEndpoint;
      if (endpoint === "index") pages.push({ from, to: peer, since: Number(url.searchParams.get("since")), limit: Number(url.searchParams.get("limit")) });
      const answer = await core.service.serve(from, endpoint, Object.fromEntries(url.searchParams), request.json === undefined ? undefined : structuredClone(request.json));
      return { status: answer.status, headers: answer.headers, body: answer.json !== undefined ? once(Buffer.from(JSON.stringify(answer.json))) : answer.body ?? once(Buffer.alloc(0)) };
    },
  });
  const node = (id: string, peers: string[], options: Partial<CoreDeps> = {}): Node => {
    const root = path.join(dir, id, "root");
    mkdirSync(root, { recursive: true });
    let seed = [...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 11) % 2147483647;
    const core = createWorkerCore({
      nodeId: id, dataDir: path.join(dir, id, "data"), clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false,
      transport: transport(id), emit: () => {}, settleMs: 1000, pageLimit: 2, ...options,
    });
    cores.set(id, core);
    const result: Node = {
      id, root, core,
      configure: (sharePeers = peers, share = {}) => core.call("configure", {
        enabled: true, hostId: `host-${id}`, records: { engines: [], settings: [] },
        peers: sharePeers.map((nodeId) => ({ nodeId, publicKey: "unused", origins: [], present: true })),
        shares: [{ key: SHARE, projectId: "p1", kind: "project", root, phase: "syncthing", rules: {}, peers: sharePeers, ...share }],
      } satisfies ConfigureArgs),
      scan: () => core.call("scan", { share: SHARE, scope: "full", reason: "test" }),
    };
    nodes.push(result);
    return result;
  };
  const quiesce = async () => {
    for (let round = 0; round < 2000; round++) {
      await Promise.all(nodes.map((each) => each.core.sync?.idle()));
      await tick();
      if (!clock.fireNext()) { await Promise.all(nodes.map((each) => each.core.sync?.idle())); return; }
    }
    throw new Error("The cores did not settle");
  };
  return { dir, clock, node, nodes, quiesce, pages };
}

async function page(answer: ServeAnswer): Promise<IndexPage> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body ?? []) chunks.push(Buffer.from(chunk));
  return decodeIndexPage(Buffer.concat(chunks));
}

function index(node: Node, from: string, since: number, limit: number, indexId?: string): Promise<IndexPage> {
  return node.core.service.serve(from, "index", { projectId: "p1", kind: "project", since: String(since), limit: String(limit), ...(indexId ? { indexId } : {}) }, undefined).then(page);
}

/** The cursor a client keeps after a page (FILE-SYNC design §5.4). */
const cursorAfter = (result: IndexPage) => result.more ? result.entries.at(-1)!.seq : result.maxSeq;

function write(root: string, names: string[]): void {
  for (const name of names) writeFileSync(path.join(root, name), name);
}

test("pages follow the cursor contract: more ? last seq : maxSeq", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  write(a.root, ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"]);
  await a.configure();
  await a.scan();
  const first = await index(a, "node-b", 0, 2);
  assert.deepEqual([first.entries.map((entry) => entry.seq), first.more, cursorAfter(first)], [[1, 2], true, 2]);
  const second = await index(a, "node-b", 2, 2);
  assert.deepEqual([second.entries.map((entry) => entry.seq), second.more, cursorAfter(second)], [[3, 4], true, 4]);
  const last = await index(a, "node-b", 4, 2);
  assert.deepEqual([last.entries.map((entry) => entry.seq), last.more, cursorAfter(last)], [[5], false, 5]);
  const empty = await index(a, "node-b", 5, 2);
  assert.deepEqual([empty.entries.length, empty.more, cursorAfter(empty)], [0, false, 5]);
  // The client walks the same pages.
  await b.configure();
  await b.scan();
  await s.quiesce();
  assert.deepEqual(s.pages.filter((entry) => entry.from === "node-b").map((entry) => entry.since), [0, 2, 4]);
  const cursor = b.core.db.cursor(SHARE, "node-a")!;
  assert.deepEqual([cursor.seq, cursor.listed], [5, true]);
  assert.equal(b.core.db.remoteCount(SHARE, "node-a"), 5);
});

test("a top-seq row dropped by a rule change ends the listing at maxSeq without another round trip", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  write(a.root, ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"]);
  await a.configure();
  await a.scan();
  const top = a.core.db.entries(SHARE).find((entry) => entry.seq === 5)!;
  await a.configure(["node-b"], { rules: { userRules: [top.path] } });
  await a.scan();
  const share = a.core.db.share(SHARE)!;
  // One seq without a row for the rules change itself, one for the drop: neither leaves a row or a tombstone.
  assert.equal(share.maxSeq, 7, "a newly ignored path leaves without a tombstone; the seqs it takes hold no row");
  assert.equal(share.prunedBelow, 7, "peers that held the row list the index again");
  assert.equal(a.core.db.entry(SHARE, top.path), undefined);
  const second = await index(a, "node-b", 2, 2);
  assert.deepEqual(second.entries.map((entry) => entry.seq), [3, 4]);
  assert.equal(second.more, false, "the look-ahead finds nothing above 4");
  assert.equal(cursorAfter(second), 7, "the cursor still reaches maxSeq");
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  await b.scan();
  await s.quiesce();
  const [status] = await b.core.call("status", {});
  assert.equal(status.peers[0].cursor, 7);
  assert.equal(status.peers[0].caughtUp, true);
  assert.deepEqual(s.pages.filter((entry) => entry.from === "node-b").map((entry) => entry.since), [0, 2]);
});

test("a cursor below prunedBelow resets the peer's rows and pulls from 0, so a pruned delete is not missed", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b", "node-c"], { scanner: { tombstoneRetentionMs: 0 } });
  const b = s.node("node-b", ["node-a"]);
  const c = s.node("node-c", ["node-a"]);
  write(a.root, ["1.txt", "2.txt", "3.txt"]);
  await a.configure();
  await a.scan();
  for (const node of [b, c]) { await node.configure(); await node.scan(); }
  await s.quiesce();
  assert.equal(c.core.db.cursor(SHARE, "node-a")?.seq, 3);
  assert.equal(c.core.db.remote(SHARE, "node-a", "2.txt")?.deleted, false);
  // C leaves the share for a while; meanwhile 2.txt is deleted, B acknowledges it and the tombstone is pruned.
  await a.configure(["node-b"]);
  write(a.root, ["4.txt", "5.txt"]);
  await a.scan();
  unlinkSync(path.join(a.root, "2.txt"));
  await a.scan();
  await s.quiesce();
  const tombstone = a.core.db.entry(SHARE, "2.txt")!;
  assert.equal(tombstone.deleted, true);
  write(a.root, ["6.txt"]);
  await a.scan();
  await s.quiesce();
  assert.ok(a.core.db.acks(SHARE).find((ack) => ack.peer === "node-b")!.seq >= tombstone.seq, "B pulled past the tombstone and said so");
  await a.scan();
  assert.equal(a.core.db.entry(SHARE, "2.txt"), undefined, "pruned");
  assert.equal(a.core.db.share(SHARE)!.prunedBelow, tombstone.seq);
  // C is back: its cursor (3) is below prunedBelow, so it may have missed that delete.
  const earlier = s.pages.length;
  await a.configure(["node-b", "node-c"]);
  await s.quiesce();
  const sinces = s.pages.slice(earlier).filter((entry) => entry.from === "node-c").map((entry) => entry.since);
  assert.deepEqual(sinces.slice(0, 2), [3, 0], "the stale page is dropped and the listing starts over");
  assert.equal(sinces.lastIndexOf(0), 1, "once: passing the old prunedBelow during the new listing is no reason to start again");
  assert.equal(c.core.db.remote(SHARE, "node-a", "2.txt"), undefined, "the row whose delete was pruned is gone");
  assert.deepEqual(c.core.db.remoteAfter(SHARE, "node-a", "", 100).map((row) => row.path), ["1.txt", "3.txt", "4.txt", "5.txt", "6.txt"]);
  assert.equal(c.core.db.cursor(SHARE, "node-a")?.seq, a.core.db.share(SHARE)!.maxSeq);
});

test("a commit between reading a page and reading maxSeq cannot make the cursor skip an entry", async (t) => {
  const s = setup(t);
  let commitInBetween = true;
  const dataDir = path.join(s.dir, "node-a", "data");
  const a = s.node("node-a", ["node-b"], {
    serviceHooks: {
      indexSnapshot() {
        if (!commitInBetween) return;
        commitInBetween = false;
        // Another writer commits seq 4 while the page is being built (a second connection: the worker's own cannot interleave).
        const other = new DatabaseSync(fileSyncDbPath(dataDir));
        other.exec("PRAGMA busy_timeout = 2000");
        other.prepare(`INSERT INTO entries(share, path, fs_name, parent, type, size, mtime_ms, mode, sha256, target, deleted, version, modified_by, seq, ino, ctime_ms, fs_mtime_ms, deleted_at)
          VALUES (?, 'late.txt', NULL, '', 0, 4, 1, 420, ?, NULL, 0, '{"node-a":1}', 'node-a', 4, 0, 0, 0, NULL)`).run(SHARE, "a".repeat(64));
        other.prepare("UPDATE shares SET max_seq = 4 WHERE share = ?").run(SHARE);
        other.close();
      },
    },
  });
  write(a.root, ["1.txt", "2.txt", "3.txt"]);
  await a.configure();
  await a.scan();
  const first = await index(a, "node-b", 0, 10);
  assert.deepEqual(first.entries.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(first.more, false);
  assert.equal(first.maxSeq, 3, "maxSeq comes from the page's own snapshot, not from after the commit");
  assert.equal(a.core.db.share(SHARE)!.maxSeq, 4, "the commit did happen");
  const next = await index(a, "node-b", cursorAfter(first), 10);
  assert.deepEqual(next.entries.map((entry) => entry.path), ["late.txt"], "the next page delivers it");
  assert.equal(next.maxSeq, 4);
});

test("a new index id from the peer resets its rows before the new generation is stored", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  write(a.root, ["old-1.txt", "old-2.txt", "old-3.txt"]);
  await a.configure();
  await a.scan();
  await b.configure();
  await b.scan();
  await s.quiesce();
  const before = b.core.db.cursor(SHARE, "node-a")!;
  assert.equal(before.seq, 3);
  // Another folder at A's root path: a new generation, nothing deleted.
  renameSync(a.root, `${a.root}-moved`);
  mkdirSync(a.root);
  write(a.root, ["new.txt"]);
  const result = await a.scan() as { newGeneration: boolean; tombstones: number };
  assert.equal(result.newGeneration, true);
  assert.equal(result.tombstones, 0);
  await s.quiesce();
  const after = b.core.db.cursor(SHARE, "node-a")!;
  assert.notEqual(after.indexId, before.indexId);
  assert.equal(after.indexId, a.core.db.share(SHARE)!.indexId);
  assert.deepEqual(b.core.db.remoteAfter(SHARE, "node-a", "", 100).map((row) => row.path), ["new.txt"], "rows of the old generation are not mistaken for current ones");
  const pulls = s.pages.filter((entry) => entry.from === "node-b").map((entry) => entry.since);
  assert.deepEqual(pulls.slice(-2), [3, 0], "the page asked with the old cursor is dropped and the new index is listed from 0");
});

test("storeRemote refuses a page that would not move the cursor forward", async (t) => {
  const s = setup(t);
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  const entry = { path: "x.txt", type: 0 as const, size: 1, mtimeMs: 1, mode: 0o644, sha256: "b".repeat(64), target: null, deleted: false, version: { "node-a": 5 }, modifiedBy: "node-a", seq: 3 };
  const base = { indexId: "abc", maxSeq: 9, digest: "0".repeat(64), prunedBelow: 0, builtinSince: null };
  await assert.rejects(b.core.need.storeRemote(SHARE, "node-a", 0, { ...base, entries: [entry, { ...entry, path: "y.txt", seq: 2 }], more: true }), WireError);
  await assert.rejects(b.core.need.storeRemote(SHARE, "node-a", 0, { ...base, entries: [], more: true }), WireError);
  await assert.rejects(b.core.need.storeRemote(SHARE, "node-a", 0, { ...base, entries: [{ ...entry, seq: 10 }], more: false }), WireError, "an entry above maxSeq");
  assert.equal(b.core.db.remoteCount(SHARE, "node-a"), 0);
});
