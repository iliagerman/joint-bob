import assert from "node:assert/strict";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerTransport } from "../src/file-sync/core.js";
import type { LocalEntry } from "../src/file-sync/db.js";
import type { ConfigureArgs, FilesEndpoint, ShareStatus } from "../src/file-sync/protocol.js";
import type { Clock } from "../src/file-sync/types.js";
import { canonicalVector } from "../src/file-sync/vectors.js";
import { FILES_API } from "../src/file-sync/wire.js";

/* Shadow mode against a stand-in for Syncthing: random file operations on node A's tree are copied
   to the other trees after random delays, out of order, some dropped and repaired later. The engines
   only index and compare. Once everything is copied and quiet, they must agree completely: no
   differences, identical digests, and one version vector per path on every node (identical content
   merges). One copy left undone must show up as exactly that path. */

const SHARE = "project:p1";
const SEEDS = Number(process.env.FILE_SYNC_SEEDS ?? 200);
const ONLY = process.env.FILE_SYNC_SEED === undefined ? undefined : Number(process.env.FILE_SYNC_SEED);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

function prng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

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
  fireNext(limit = Number.POSITIVE_INFINITY): boolean {
    this.timers = this.timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = this.timers[0];
    if (!next || next.at > limit) return false;
    this.timers.shift();
    this.current = Math.max(this.current, next.at);
    next.run();
    return true;
  }
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (this.fireNext(target)) await tick();
    this.current = Math.max(this.current, target);
  }
}

interface Node { id: string; root: string; core: FileSyncCore }

class Cluster {
  readonly clock = new FakeClock();
  readonly nodes: Node[] = [];
  private readonly cores = new Map<string, FileSyncCore>();

  constructor(readonly dir: string, ids: string[], private readonly options: Partial<CoreDeps> = {}) {
    for (const id of ids) {
      const root = path.join(dir, id);
      mkdirSync(root, { recursive: true });
      this.nodes.push({ id, root, core: this.core(id, 13) });
    }
  }

  private core(id: string, salt: number): FileSyncCore {
    let seed = [...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), salt) % 2147483647;
    const core = createWorkerCore({
      nodeId: id, dataDir: path.join(this.dir, `${id}.data`), clock: this.clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
      watch: false, transport: this.transport(id), emit: () => {}, ...this.options,
    });
    this.cores.set(id, core);
    return core;
  }

  /** The node's engine stops; it starts again with file-sync.db deleted (a new index generation). */
  async wipe(node: Node): Promise<void> {
    await node.core.close();
    this.cores.delete(node.id);
    rmSync(path.join(this.dir, `${node.id}.data`), { recursive: true, force: true });
    node.core = this.core(node.id, 17);
  }

  private transport(from: string): PeerTransport {
    return {
      request: async (peer, request) => {
        const core = this.cores.get(peer);
        if (!core) throw new Error(`connect ECONNREFUSED ${peer}`);
        await tick();
        const url = new URL(request.target, "http://peer");
        const answer = await core.service.serve(from, url.pathname.slice(FILES_API.length + 1) as FilesEndpoint, Object.fromEntries(url.searchParams), request.json === undefined ? undefined : structuredClone(request.json));
        return { status: answer.status, headers: answer.headers, body: answer.json !== undefined ? once(Buffer.from(JSON.stringify(answer.json))) : answer.body ?? once(Buffer.alloc(0)) };
      },
      route: () => "direct",
    };
  }

  async start(share: Record<string, unknown> = {}, rules: (node: Node) => Record<string, unknown> = () => ({})): Promise<void> {
    for (const node of this.nodes) await this.configure(node, this.nodes.filter((other) => other !== node).map((other) => other.id), { rules: rules(node), ...share });
    for (const node of this.nodes) await this.scan(node, "full");
  }

  configure(node: Node, peers: string[], share: Record<string, unknown> = {}): Promise<unknown> {
    return node.core.call("configure", {
      enabled: true, hostId: `host-${node.id}`, records: { engines: [], settings: [] },
      peers: peers.map((nodeId) => ({ nodeId, publicKey: "unused", origins: [], present: true })),
      shares: [{ key: SHARE, projectId: "p1", kind: "project", root: node.root, phase: "syncthing", rules: {}, peers, ...share }],
    } satisfies ConfigureArgs);
  }

  async scan(node: Node, scope: "full" | string[]): Promise<void> {
    if (Array.isArray(scope) && !scope.length) return;
    const result = await node.core.call("scan", { share: SHARE, scope: scope === "full" ? "full" : { paths: scope }, reason: "test" });
    if (result.error) throw new Error(`Scan of ${node.id} failed: ${result.error}`);
  }

  async status(node: Node): Promise<ShareStatus> {
    const [status] = await node.core.call("status", { shares: [SHARE] });
    return status;
  }

  /** Until no request, pull, recompute, scan or timer is left (timers include the 2-minute settle window). */
  async quiesce(): Promise<void> {
    for (let round = 0; round < 20_000; round++) {
      await Promise.all(this.nodes.map((node) => node.core.sync!.idle()));
      await tick();
      // A node may not serve the share (yet): no status, nothing scanning.
      if ((await Promise.all(this.nodes.map((node) => this.status(node)))).some((status) => status?.scanning)) continue;
      if (!this.clock.fireNext()) {
        await Promise.all(this.nodes.map((node) => node.core.sync!.idle()));
        if (!this.clock.fireNext()) return;
      }
    }
    throw new Error("The cluster did not settle");
  }

  async close(): Promise<void> {
    for (const node of this.nodes) await node.core.close();
  }
}

// ---- a tree on disk and the stand-in for Syncthing ----

function lstat(file: string): Stats | null {
  try { return lstatSync(file); } catch { return null; }
}

const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;

function walk(root: string): { files: string[]; dirs: string[]; links: string[] } {
  const found = { files: [] as string[], dirs: [""], links: [] as string[] };
  const visit = (relative: string) => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const child = join(relative, name);
      const st = lstatSync(path.join(root, child));
      if (st.isDirectory()) { found.dirs.push(child); visit(child); } else if (st.isSymbolicLink()) found.links.push(child); else found.files.push(child);
    }
  };
  visit("");
  return found;
}

/** Copies the current state at `relative` from one tree to another, as Syncthing would; returns the paths it changed. */
function mirror(source: string, target: string, relative: string, touched = new Set<string>()): Set<string> {
  if (relative) {
    const parts = relative.split("/");
    for (let index = 0; index < parts.length - 1; index++) {
      const prefix = parts.slice(0, index + 1).join("/");
      const from = lstat(path.join(source, prefix));
      // The path cannot exist below something that is not a folder: copy that ancestor instead.
      if (!from?.isDirectory()) return mirror(source, target, prefix, touched);
      const to = lstat(path.join(target, prefix));
      if (to && !to.isDirectory()) rmSync(path.join(target, prefix), { recursive: true, force: true });
      if (!to?.isDirectory()) {
        mkdirSync(path.join(target, prefix));
        chmodSync(path.join(target, prefix), from.mode & 0o777);
        touched.add(prefix);
      }
    }
  }
  const from = lstat(path.join(source, relative));
  const to = lstat(path.join(target, relative));
  const destination = path.join(target, relative);
  if (!from) {
    if (to) { rmSync(destination, { recursive: true, force: true }); touched.add(relative); }
    return touched;
  }
  if (from.isDirectory()) {
    if (to && !to.isDirectory()) rmSync(destination, { recursive: true, force: true });
    if (!to?.isDirectory()) { mkdirSync(destination); touched.add(relative); }
    if (relative && (!to?.isDirectory() || (to.mode & 0o777) !== (from.mode & 0o777))) { chmodSync(destination, from.mode & 0o777); touched.add(relative); }
    const names = new Set(readdirSync(path.join(source, relative)));
    for (const name of readdirSync(destination)) {
      if (!names.has(name)) { rmSync(path.join(destination, name), { recursive: true, force: true }); touched.add(join(relative, name)); }
    }
    for (const name of [...names].sort()) mirror(source, target, join(relative, name), touched);
    return touched;
  }
  if (from.isSymbolicLink()) {
    const link = readlinkSync(path.join(source, relative));
    if (to?.isSymbolicLink() && readlinkSync(destination) === link) return touched;
    if (to) rmSync(destination, { recursive: true, force: true });
    symlinkSync(link, destination);
    touched.add(relative);
    return touched;
  }
  const content = readFileSync(path.join(source, relative));
  if (to?.isFile() && (to.mode & 0o777) === (from.mode & 0o777) && readFileSync(destination).equals(content)) return touched;
  if (to && !to.isFile()) rmSync(destination, { recursive: true, force: true });
  writeFileSync(destination, content);
  chmodSync(destination, from.mode & 0o777);
  utimesSync(destination, from.atime, from.mtime);
  touched.add(relative);
  return touched;
}

const CONTENTS = ["", "x", "same", "hello world", "same\n"];

/** One random operation on the tree; returns the paths it touched, or null when it found nothing to do. */
function operate(root: string, random: () => number): string[] | null {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const tree = walk(root);
  const content = () => random() < 0.6 ? pick(CONTENTS) : `content-${Math.floor(random() * 1e9)}`;
  const at = (relative: string) => path.join(root, relative);
  const roll = random() * 100;
  if (roll < 30) {
    const file = join(pick(tree.dirs), `f${Math.floor(random() * 8)}.txt`);
    const st = lstat(at(file));
    if (st && !st.isFile()) return null;
    writeFileSync(at(file), content());
    return [file];
  }
  if (roll < 48) {
    if (!tree.files.length) return null;
    const file = pick(tree.files);
    writeFileSync(at(file), content());
    return [file];
  }
  if (roll < 58) {
    const gone = [...tree.files, ...tree.links];
    if (!gone.length) return null;
    const file = pick(gone);
    unlinkSync(at(file));
    return [file];
  }
  if (roll < 68) {
    const dir = join(pick(tree.dirs), `d${Math.floor(random() * 4)}`);
    if (lstat(at(dir))) return null;
    mkdirSync(at(dir));
    return [dir];
  }
  if (roll < 72) {
    const dirs = tree.dirs.filter(Boolean);
    if (!dirs.length) return null;
    const dir = pick(dirs);
    rmSync(at(dir), { recursive: true, force: true });
    return [dir];
  }
  if (roll < 80) {
    const movable = [...tree.files, ...tree.dirs.filter(Boolean), ...tree.links];
    if (!movable.length) return null;
    const from = pick(movable);
    const parent = pick(tree.dirs);
    const to = join(parent, `${from.split("/").pop()!.replace(/^m?/, "m")}`);
    if (lstat(at(to)) || to === from || to.startsWith(`${from}/`) || parent === from || parent.startsWith(`${from}/`)) return null;
    renameSync(at(from), at(to));
    return [from, to];
  }
  if (roll < 90) {
    const targets = [...tree.files, ...tree.dirs.filter(Boolean)];
    if (!targets.length) return null;
    const target = pick(targets);
    const isDirectory = lstatSync(at(target)).isDirectory();
    chmodSync(at(target), isDirectory ? pick([0o755, 0o700, 0o750]) : pick([0o644, 0o600, 0o755]));
    return [target];
  }
  if (roll < 95) {
    const link = join(pick(tree.dirs), `l${Math.floor(random() * 3)}`);
    if (lstat(at(link))) return null;
    symlinkSync(pick(["f1.txt", "../outside", "d0/f2.txt", "/absolute/target"]), at(link));
    return [link];
  }
  // A file becomes a folder with a file in it.
  if (!tree.files.length) return null;
  const file = pick(tree.files);
  unlinkSync(at(file));
  mkdirSync(at(file));
  writeFileSync(at(join(file, "inner.txt")), content());
  return [file, join(file, "inner.txt")];
}

interface Job { due: number; replica: Node; paths: string[] }

// ---- checks ----

function rows(node: Node): Map<string, LocalEntry> {
  return new Map(node.core.db.entries(SHARE).map((entry) => [entry.path, entry]));
}

async function assertConverged(cluster: Cluster, context: string): Promise<void> {
  const [first] = cluster.nodes;
  for (const node of cluster.nodes) {
    const status = await cluster.status(node);
    assert.equal(status.peers.length, cluster.nodes.length - 1, `${context}: ${node.id} lists every peer`);
    for (const peer of status.peers) {
      const where = `${context}: ${node.id} vs ${peer.peer}`;
      assert.equal(peer.rulesMatch, true, `${where}: rules match`);
      assert.equal(peer.caughtUp, true, `${where}: caught up`);
      assert.equal(peer.differences, 0, `${where}: settled differences`);
      assert.equal(node.core.need.pendingDifferences(SHARE, peer.peer), 0, `${where}: no difference at all`);
      assert.notEqual(node.core.need.comparison(SHARE, peer.peer), undefined, `${where}: compared`);
      assert.notEqual(peer.cleanSince, null, `${where}: clean`);
    }
    assert.notEqual(status.state, "error", `${context}: ${node.id} reports no error: ${status.message}`);
    assert.equal(status.digest, (await cluster.status(first)).digest, `${context}: ${node.id} has A's digest`);
  }
  const all = cluster.nodes.map(rows);
  const paths = new Set(all.flatMap((map) => [...map.keys()]));
  for (const relative of paths) {
    const held = all.map((map) => map.get(relative));
    const present = held.filter((entry): entry is LocalEntry => entry !== undefined);
    const live = present.filter((entry) => !entry.deleted);
    if (live.length) assert.equal(live.length, cluster.nodes.length, `${context}: ${relative} is live on every node or none`);
    const vectors = new Set(present.map((entry) => canonicalVector(entry.version)));
    assert.equal(vectors.size, 1, `${context}: one version of ${relative} everywhere it is indexed: ${[...vectors].join(" | ")}`);
    // Conflict copies are named after the losing version's mtime and producer: every node must name it alike.
    const producers = new Set(present.map((entry) => `${entry.mtimeMs} ${entry.modifiedBy}`));
    assert.equal(producers.size, 1, `${context}: one producer of ${relative}'s version everywhere: ${[...producers].join(" | ")}`);
  }
}

async function runSeed(seed: number, dir: string): Promise<void> {
  const random = prng(seed);
  const ids = seed % 3 === 0 ? ["node-a", "node-b", "node-c"] : ["node-a", "node-b"];
  const cluster = new Cluster(dir, ids);
  const context = `seed ${seed}`;
  try {
    await cluster.start();
    const [source, ...replicas] = cluster.nodes;
    const queue: Job[] = [];
    const dropped: Job[] = [];
    const steps = 15 + Math.floor(random() * 30);
    for (let step = 0; step < steps; step++) {
      const touched = operate(source.root, random);
      if (touched) {
        await cluster.scan(source, random() < 0.15 ? "full" : touched);
        for (const replica of replicas) {
          const job = { due: step + Math.floor(random() * 4), replica, paths: touched };
          if (random() < 0.1) dropped.push(job); else queue.push(job);
        }
      }
      const due = queue.filter((job) => job.due <= step);
      for (const job of due) queue.splice(queue.indexOf(job), 1);
      // Out of order, as Syncthing pulls by its own priorities.
      due.sort(() => random() - 0.5);
      for (const job of due) {
        const changed = new Set<string>();
        for (const relative of job.paths) mirror(source.root, job.replica.root, relative, changed);
        await cluster.scan(job.replica, random() < 0.15 ? "full" : [...changed]);
      }
      if (dropped.length && random() < 0.25) queue.push({ ...dropped.shift()!, due: step });
      await cluster.clock.advance(Math.floor(random() * 600));
      if (random() < 0.3) await Promise.all(cluster.nodes.map((node) => node.core.sync!.idle()));
    }
    // Syncthing catches up on everything, the dropped copies included.
    for (const replica of replicas) {
      const changed = mirror(source.root, replica.root, "");
      await cluster.scan(replica, random() < 0.5 ? "full" : [...changed]);
    }
    await cluster.quiesce();
    await assertConverged(cluster, context);

    if (seed % 4 === 1) {
      // One copy never made: the first replica lacks it, every other tree has it.
      const relative = `dropped-${seed}.txt`;
      writeFileSync(path.join(source.root, relative), `only on some nodes ${seed}`);
      await cluster.scan(source, [relative]);
      const [missing, ...others] = replicas;
      for (const replica of others) {
        mirror(source.root, replica.root, relative);
        await cluster.scan(replica, [relative]);
      }
      await cluster.quiesce();
      for (const node of cluster.nodes) {
        const status = await cluster.status(node);
        for (const peer of status.peers) {
          const differs = (node === missing) !== (peer.peer === missing.id);
          assert.equal(peer.differences, differs ? 1 : 0, `${context}: dropped copy, ${node.id} vs ${peer.peer}`);
          if (!differs) continue;
          const page = await node.core.call("differences", { share: SHARE, peer: peer.peer, offset: 0, limit: 10 });
          assert.deepEqual(page.items.map((item) => [item.path, item.kind]), [[relative, node === missing ? "only-there" : "only-here"]], `${context}: the difference is that path`);
          assert.equal(peer.cleanSince, null, `${context}: not clean while it lasts`);
        }
      }
    }
  } finally {
    await cluster.close();
  }
}

test(`shadow mode converges with a Syncthing stand-in (${ONLY === undefined ? `${SEEDS} seeds` : `seed ${ONLY}`})`, async () => {
  const seeds = ONLY === undefined ? Array.from({ length: SEEDS }, (_, index) => index + 1) : [ONLY];
  for (const seed of seeds) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
    try {
      await runSeed(seed, dir);
    } catch (error) {
      (error as Error).message = `[FILE_SYNC_SEED=${seed}] ${(error as Error).message}`;
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("shadow mode writes nothing into the share trees", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b"]);
  try {
    const [a, b] = cluster.nodes;
    writeFileSync(path.join(a.root, "only-a.txt"), "a");
    mkdirSync(path.join(b.root, "only-b"));
    writeFileSync(path.join(b.root, "only-b", "b.txt"), "b");
    writeFileSync(path.join(a.root, "both.txt"), "one");
    writeFileSync(path.join(b.root, "both.txt"), "two");
    const listing = (root: string) => {
      const found: string[] = [];
      const visit = (relative: string) => {
        for (const name of readdirSync(path.join(root, relative)).sort()) {
          const child = join(relative, name);
          const st = lstatSync(path.join(root, child));
          found.push(`${child} ${st.mode} ${st.mtimeMs} ${st.isFile() ? readFileSync(path.join(root, child), "utf8") : ""}`);
          if (st.isDirectory()) visit(child);
        }
      };
      visit("");
      return found;
    };
    const before = [listing(a.root), listing(b.root)];
    await cluster.start();
    await cluster.quiesce();
    assert.deepEqual([listing(a.root), listing(b.root)], before, "the engine only indexed and compared");
    const status = await cluster.status(a);
    assert.equal(status.peers[0].differences, 4, "only-a.txt, only-b, only-b/b.txt and both.txt differ");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("differences are not compared while the peers' rules differ", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b"]);
  try {
    const [a, b] = cluster.nodes;
    writeFileSync(path.join(a.root, "a.txt"), "a");
    writeFileSync(path.join(b.root, "b.txt"), "b");
    await cluster.start({}, (node) => node === a ? { userRules: ["*.log"] } : {});
    await cluster.quiesce();
    for (const node of [a, b]) {
      const [peer] = (await cluster.status(node)).peers;
      assert.equal(peer.rulesMatch, false, node.id);
      assert.equal(peer.differences, 0, `${node.id}: no comparison under different rules`);
      assert.equal(node.core.need.comparison(SHARE, peer.peer), undefined);
      assert.equal(peer.caughtUp, true, `${node.id}: the index is still pulled`);
    }
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder the peer starts serving later, and a rules change, reach the other side with the next notice", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b"]);
  try {
    const [a, b] = cluster.nodes;
    for (const node of cluster.nodes) writeFileSync(path.join(node.root, "same.txt"), "same");
    // B runs the engine but does not serve the folder yet: A's shares request finds nothing to compare with.
    await b.core.call("configure", {
      enabled: true, hostId: "host-node-b", records: { engines: [], settings: [] }, peers: [{ nodeId: a.id, publicKey: "unused", origins: [], present: true }], shares: [],
    });
    await cluster.configure(a, [b.id]);
    await cluster.scan(a, "full");
    await cluster.quiesce();
    assert.equal((await cluster.status(a)).peers[0].rulesMatch, false, "nothing known of B's rules yet");
    // B starts serving it. A asks for no shares answer again; B's notice is all it hears.
    await cluster.configure(b, [a.id]);
    await cluster.scan(b, "full");
    await cluster.quiesce();
    for (const node of [a, b]) {
      const [peer] = (await cluster.status(node)).peers;
      assert.deepEqual([peer.rulesMatch, peer.caughtUp, peer.differences], [true, true, 0], `${node.id}: ${JSON.stringify(peer)}`);
      assert.notEqual(peer.cleanSince, null, `${node.id} compares`);
    }
    // A's rules change and no row moves (it ignores nothing it indexed): its notice still tells B, which stops comparing.
    await cluster.configure(a, [b.id], { rules: { userRules: ["*.log"] } });
    await cluster.quiesce();
    assert.equal((await cluster.status(b)).peers[0].rulesMatch, false);
    assert.equal(b.core.need.comparison(SHARE, a.id), undefined, "B does not compare under different rules");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a peer out of the share for a while keeps its clean streak; what changed meanwhile is compared when it is back", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b", "node-c"]);
  try {
    const [a, b, c] = cluster.nodes;
    for (const node of cluster.nodes) writeFileSync(path.join(node.root, "same.txt"), "same");
    await cluster.start();
    await cluster.quiesce();
    const peerB = async () => (await cluster.status(a)).peers.find((peer) => peer.peer === b.id)!;
    const peerC = async () => (await cluster.status(a)).peers.find((peer) => peer.peer === c.id)!;
    const streak = (await peerB()).cleanSince;
    // Each comparison starts when its own pull completes, which need not be the same instant.
    const streakC = (await peerC()).cleanSince;
    assert.notEqual(streak, null);
    assert.notEqual(streakC, null);
    // A relay lease lapses: B leaves A's share for a while, nothing changes meanwhile.
    await cluster.configure(a, [c.id]);
    await cluster.quiesce();
    await cluster.configure(a, [b.id, c.id]);
    await cluster.quiesce();
    assert.equal((await peerB()).cleanSince, streak, "compared again from the stored rows, the streak goes on");
    // Again, and this time A changes a file that only C receives.
    await cluster.configure(a, [c.id]);
    writeFileSync(path.join(a.root, "same.txt"), "changed");
    await cluster.scan(a, ["same.txt"]);
    mirror(a.root, c.root, "same.txt");
    await cluster.scan(c, ["same.txt"]);
    await cluster.quiesce();
    await cluster.configure(a, [b.id, c.id]);
    await cluster.quiesce();
    const back = await peerB();
    assert.equal(back.differences, 1, "the change made while B was out is found once B is back");
    assert.equal(back.cleanSince, null);
    assert.equal((await peerC()).cleanSince, streakC, "C never left");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows dropped by a new rule leave peers' copies too, so lifting the rule leaves no stale difference", async () => {
  for (const goneOn of ["both", "a"] as const) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
    const cluster = new Cluster(dir, ["node-a", "node-b"]);
    try {
      const [a, b] = cluster.nodes;
      const other = (node: Node) => node === a ? b.id : a.id;
      for (const node of cluster.nodes) { writeFileSync(path.join(node.root, "keep.txt"), "k"); writeFileSync(path.join(node.root, "gone.skip"), "g"); }
      await cluster.start();
      await cluster.quiesce();
      assert.equal(b.core.db.remote(SHARE, a.id, "gone.skip")?.deleted, false);
      // The project's rules gain *.skip everywhere: each node drops its row without a tombstone, and the peer's copy goes with it.
      for (const node of cluster.nodes) { await cluster.configure(node, [other(node)], { rules: { userRules: ["*.skip"] } }); await cluster.scan(node, "full"); }
      await cluster.quiesce();
      for (const node of cluster.nodes) assert.equal(node.core.db.remote(SHARE, other(node), "gone.skip"), undefined, `${goneOn}: ${node.id} holds no row the peer dropped`);
      // The file goes while ignored (Syncthing does not copy that either), then the rule is lifted.
      for (const node of goneOn === "both" ? cluster.nodes : [a]) unlinkSync(path.join(node.root, "gone.skip"));
      for (const node of cluster.nodes) { await cluster.configure(node, [other(node)], { rules: {} }); await cluster.scan(node, "full"); }
      await cluster.quiesce();
      const [onA] = (await cluster.status(a)).peers;
      const [onB] = (await cluster.status(b)).peers;
      const expected = goneOn === "both" ? 0 : 1;
      assert.deepEqual([onA.differences, onB.differences], [expected, expected], `${goneOn}: ${JSON.stringify([onA, onB])}`);
      if (goneOn === "a") {
        const page = await b.core.call("differences", { share: SHARE, peer: a.id, offset: 0, limit: 10 });
        assert.deepEqual(page.items.map((item) => [item.path, item.kind]), [["gone.skip", "only-here"]], "B sees that A lacks the file");
      }
    } finally {
      await cluster.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("identical deletions merge even while a third, winning version exists, so they stay merged once it is gone", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b", "node-c"]);
  try {
    const [a, b, c] = cluster.nodes;
    const peersOf = (node: Node) => cluster.nodes.filter((other) => other !== node).map((other) => other.id);
    for (const node of cluster.nodes) { writeFileSync(path.join(node.root, "f.txt"), "x"); writeFileSync(path.join(node.root, "keep.txt"), "k"); }
    await cluster.start();
    await cluster.quiesce();
    // C edits f before Syncthing copies anything; B deletes it, and Syncthing removes it on A.
    writeFileSync(path.join(c.root, "f.txt"), "y"); await cluster.scan(c, ["f.txt"]);
    await cluster.quiesce();
    unlinkSync(path.join(b.root, "f.txt")); await cluster.scan(b, ["f.txt"]);
    await cluster.quiesce();
    unlinkSync(path.join(a.root, "f.txt")); await cluster.scan(a, ["f.txt"]);
    await cluster.quiesce();
    // The deletion reaches C too; then C loses file-sync.db and indexes again: its row for f is gone, not replaced.
    unlinkSync(path.join(c.root, "f.txt"));
    await cluster.wipe(c);
    await cluster.configure(c, peersOf(c));
    await cluster.scan(c, "full");
    await cluster.quiesce();
    const fa = a.core.db.entry(SHARE, "f.txt")!;
    const fb = b.core.db.entry(SHARE, "f.txt")!;
    assert.equal(fa.deleted && fb.deleted, true);
    assert.equal(canonicalVector(fa.version), canonicalVector(fb.version), "one version of the same deletion (§0.3)");
    assert.deepEqual([fa.mtimeMs, fa.modifiedBy], [fb.mtimeMs, fb.modifiedBy], "and one producer");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identical content stored while the local rules ignored it merges once they no longer do", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b"]);
  try {
    const [a, b] = cluster.nodes;
    for (const node of cluster.nodes) {
      writeFileSync(path.join(node.root, "keep.txt"), "k");
      mkdirSync(path.join(node.root, "d"));
      writeFileSync(path.join(node.root, "d", "f.skip"), "x");
    }
    await cluster.start();
    await cluster.quiesce();
    // The folder goes on both nodes before either hears of the other's deletion: two tombstones of the same content.
    for (const node of cluster.nodes) { rmSync(path.join(node.root, "d"), { recursive: true }); await cluster.scan(node, ["d"]); }
    // A ignores *.skip for a while (its row stays: nothing below a deleted folder is walked), and stores B's tombstone meanwhile.
    await cluster.configure(a, [b.id], { rules: { userRules: ["*.skip"] } });
    await cluster.scan(a, "full");
    await cluster.quiesce();
    await cluster.configure(a, [b.id], { rules: {} });
    await cluster.scan(a, "full");
    await cluster.quiesce();
    const fa = a.core.db.entry(SHARE, "d/f.skip")!;
    const fb = b.core.db.entry(SHARE, "d/f.skip")!;
    assert.equal(fa.deleted && fb.deleted, true);
    assert.equal(canonicalVector(fa.version), canonicalVector(fb.version), "one version of the same deletion");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a peer whose index is not rescanned under new rules yet is no digest mismatch", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-shadow-"));
  const cluster = new Cluster(dir, ["node-a", "node-b"]);
  try {
    const [a, b] = cluster.nodes;
    for (const node of cluster.nodes) { writeFileSync(path.join(node.root, "keep.txt"), "k"); writeFileSync(path.join(node.root, "x.skip"), "x"); }
    await cluster.start();
    await cluster.quiesce();
    // Both get the new rules; B's rescan is done, A's (a large share, say) is still to come. A's index and digest still hold x.skip.
    const rules = { userRules: ["*.skip"] };
    await cluster.configure(a, [b.id], { rules });
    await cluster.configure(b, [a.id], { rules });
    await cluster.scan(b, "full");
    await cluster.quiesce();
    const waiting = await cluster.status(b);
    assert.notEqual(waiting.state, "error", `B waits for A's rescan instead of calling A's index broken: ${waiting.message}`);
    assert.equal(waiting.errors, 0);
    assert.equal(waiting.peers[0].differences, 0, "a row the rules ignore is no difference");
    await cluster.scan(a, "full");
    await cluster.quiesce();
    await assertConverged(cluster, "after A's rescan");
  } finally {
    await cluster.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
