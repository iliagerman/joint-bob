import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fsPromises, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerRequest, type PeerTransport } from "../src/file-sync/core.js";
import type { CoreEvent, FilesEndpoint, ServeAnswer } from "../src/file-sync/protocol.js";
import { HANDOFF_PRIORITY_MS, transferTempName, type TransferApplier, type TransferApplyInput, type TransferApplyResult, type TransferItem, type TransferQueue } from "../src/file-sync/sync.js";
import { FILE, type Clock } from "../src/file-sync/types.js";
import { FILES_API } from "../src/file-sync/wire.js";

/* The transfer loop (FILE-SYNC design §6.2) between two in-thread cores over an in-memory transport
   that calls the peer's FilesService. Node "a" serves (shadow), node "b" downloads (builtin). The need
   queue and apply are stand-ins written to the contract sync.ts states (TransferQueue, TransferApplier),
   so this file proves the loop alone: batching, resume, the stall guard, the disk floor, moves without
   bytes, and stale targets. FILE_SYNC_TRANSFER_REAL=1 runs the same scenarios on the real need queue
   and apply instead (end to end; assertions about the stand-in's records are left out then). */

const SHARE = "project:p1";
const REAL = process.env.FILE_SYNC_TRANSFER_REAL === "1";
const STAND_IN_ONLY = REAL ? "records only the stand-in keeps" : false;
const MiB = 1024 * 1024;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Timers run only when the test fires them; it starts at the wall clock so temp files' mtimes read as fresh. */
class FakeClock implements Clock {
  private timers: Array<{ at: number; seq: number; run(): void; cancelled: boolean }> = [];
  private seq = 0;
  current = Date.now();
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
    while (this.fireNext(target)) { await tick(); await tick(); }
    this.current = Math.max(this.current, target);
  }
}

interface Logged { from: string; to: string; endpoint: string; status: number; range?: string; bytes: number }
type Responder = (from: string, request: PeerRequest, answer: ServeAnswer) => ServeAnswer | undefined;

/** Each request is served by the peer core's FilesService; the bytes its reader takes are counted. */
class Net {
  readonly cores = new Map<string, FileSyncCore>();
  readonly log: Logged[] = [];
  readonly routes = new Map<string, "direct" | "relay">();
  responder: Responder | undefined;

  transport(from: string): PeerTransport {
    return {
      request: async (peer, request) => {
        const url = new URL(request.target, "http://peer");
        const endpoint = url.pathname.slice(FILES_API.length + 1) as FilesEndpoint;
        const core = this.cores.get(peer);
        if (!core) throw new Error(`connect ECONNREFUSED ${peer}`);
        const range = request.headers?.range;
        let answer = await core.service.serve(from, endpoint, Object.fromEntries(url.searchParams), request.json === undefined ? undefined : structuredClone(request.json), range);
        answer = this.responder?.(from, request, answer) ?? answer;
        const entry: Logged = { from, to: peer, endpoint, status: answer.status, bytes: 0, ...(range ? { range } : {}) };
        this.log.push(entry);
        const source = answer.json !== undefined ? once(Buffer.from(JSON.stringify(answer.json))) : answer.body ?? once(Buffer.alloc(0));
        const counted = answer.json !== undefined ? source : count(source, entry);
        return { status: answer.status, headers: answer.headers, body: counted, route: this.routes.get(`${from}\n${peer}`) ?? "direct" };
      },
      route: (peer) => this.routes.get(`${from}\n${peer}`) ?? "direct",
    };
  }

  requests(endpoint: string): Logged[] { return this.log.filter((entry) => entry.endpoint === endpoint); }
  bytes(...endpoints: string[]): number { return this.log.filter((entry) => endpoints.includes(entry.endpoint)).reduce((sum, entry) => sum + entry.bytes, 0); }
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
async function* count(body: AsyncIterable<Uint8Array>, entry: Logged): AsyncIterable<Uint8Array> {
  for await (const chunk of body) { entry.bytes += chunk.byteLength; yield chunk; }
}

/**
 * The need queue and apply as the transfer loop's contract states them. Local state is the receiver's
 * index overlaid with what this apply wrote; the target of a path is the source's row. A fetch whose
 * content a pending delete holds becomes a move. Retries back off, blocks wait for their retry time.
 */
class StandIn implements TransferQueue, TransferApplier {
  core!: FileSyncCore;
  peers = ["a"];
  readonly written = new Map<string, string | null>();
  readonly state = new Map<string, { attempts: number; nextAt: number; reason: string; blocked: boolean }>();
  readonly retries: Array<{ path: string; reason: string }> = [];
  readonly blocks: Array<{ path: string; reason: string; retryAfterMs?: number }> = [];
  readonly prioritized: Array<{ share: string; prefix?: string; until: number }> = [];
  readonly inputs: TransferApplyInput[] = [];

  constructor(private readonly clock: FakeClock, private readonly root: string, private readonly source = "a") {}

  private localFiles(): Map<string, string> {
    const files = new Map<string, string>();
    for (const entry of this.core.db.entries(SHARE)) if (!entry.deleted && entry.type === FILE && entry.sha256) files.set(entry.path, entry.sha256);
    for (const [relative, hash] of this.written) { if (hash === null) files.delete(relative); else files.set(relative, hash); }
    return files;
  }

  /** Every path's need right now, in transfer order (smaller first, deletes last). */
  current(): TransferItem[] {
    const local = this.localFiles();
    const holders = new Map<string, string[]>();
    for (const [relative, hash] of local) holders.set(hash, [...holders.get(hash) ?? [], relative]);
    const fetches: TransferItem[] = [];
    const deletes = new Map<string, TransferItem>();
    for (const row of this.core.db.remoteAfter(SHARE, this.source, "", 1_000_000)) {
      if (row.type !== FILE) continue;
      const mine = local.get(row.path);
      if (row.deleted) {
        if (mine !== undefined && mine === row.sha256) deletes.set(row.path, { share: SHARE, path: row.path, action: "delete", target: row, sources: [], localSources: [], size: 0 });
        continue;
      }
      if (mine === row.sha256) continue;
      const copies = (holders.get(row.sha256!) ?? []).filter((relative) => relative !== row.path);
      // Sources are the share's eligible peers holding the content.
      const sources = [this.source].filter((peer) => this.peers.includes(peer));
      fetches.push({ share: SHARE, path: row.path, action: "fetch", target: row, sources, localSources: copies.map((relative) => ({ share: SHARE, path: relative })), size: row.size });
    }
    for (const item of fetches) {
      const from = item.localSources.map((source) => (source as { path: string }).path).find((relative) => deletes.has(relative));
      if (from) { deletes.delete(from); item.action = "move"; item.fromPath = from; item.localSources = []; }
    }
    fetches.sort((a, b) => a.size - b.size || (a.path < b.path ? -1 : 1));
    return [...fetches, ...deletes.values()];
  }

  private id(relative: string, target: { sha256: string | null }): string { return `${relative}\n${target.sha256}`; }

  nextNeeds(options: { limit: number; availablePeers?: readonly string[]; inFlight?: Iterable<string> }): { items: TransferItem[]; nextRetryAt?: number } {
    const now = this.clock.now();
    const busy = new Set(options.inFlight ?? []);
    const items: TransferItem[] = [];
    let nextRetryAt: number | undefined;
    for (const item of this.current()) {
      const state = this.state.get(this.id(item.path, item.target));
      if (state && state.nextAt > now) { if (Number.isFinite(state.nextAt)) nextRetryAt = Math.min(nextRetryAt ?? Number.POSITIVE_INFINITY, state.nextAt); continue; }
      if (busy.has(`${SHARE}\n${item.path}`)) continue;
      if (item.action === "fetch" && !item.localSources.length && options.availablePeers && !item.sources.some((peer) => options.availablePeers!.includes(peer))) continue;
      items.push(item);
      if (items.length >= options.limit) break;
    }
    return { items, ...(nextRetryAt !== undefined ? { nextRetryAt } : {}) };
  }

  retryLater(_share: string, relative: string, reason: string, options: { delayMs?: number; target?: TransferItem["target"] } = {}): void {
    const id = this.id(relative, options.target ?? { sha256: null });
    const attempts = (this.state.get(id)?.attempts ?? 0) + 1;
    this.state.set(id, { attempts, nextAt: this.clock.now() + (options.delayMs ?? Math.min(300_000, 1000 * 2 ** (attempts - 1))), reason, blocked: false });
    this.retries.push({ path: relative, reason });
  }

  block(_share: string, relative: string, reason: string, options: { retryAfterMs?: number; target?: TransferItem["target"] } = {}): void {
    const id = this.id(relative, options.target ?? { sha256: null });
    this.state.set(id, { attempts: this.state.get(id)?.attempts ?? 0, nextAt: options.retryAfterMs !== undefined ? this.clock.now() + options.retryAfterMs : Number.POSITIVE_INFINITY, reason, blocked: true });
    this.blocks.push({ path: relative, reason, ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}) });
  }

  prioritize(share: string, prefix: string | undefined, until: number): void { this.prioritized.push({ share, ...(prefix !== undefined ? { prefix } : {}), until }); }

  async applyBatch(args: { share: string; items: TransferApplyInput[] }): Promise<TransferApplyResult> {
    const now = new Map(this.current().map((item) => [item.path, item]));
    const items: TransferApplyResult["items"] = [];
    for (const input of args.items) {
      this.inputs.push(input);
      const item = now.get(input.path);
      const target = path.join(this.root, input.path);
      // Re-derived now (§5.5.1): a target that moved, or a source that left the share, makes the bytes stale.
      if (!item || (input.source !== undefined && !this.peers.includes(input.source)) || (input.tempPath && (item.action !== "fetch" || sha(readFileSync(input.tempPath)) !== item.target.sha256))) {
        if (input.tempPath) rmSync(input.tempPath, { force: true });
        items.push({ path: input.path, outcome: "stale" });
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      if (item.action === "delete") {
        if (existsSync(target)) this.core.trash.preserve(SHARE, input.path, target);
        rmSync(target, { force: true });
        this.written.set(input.path, null);
        items.push({ path: input.path, outcome: "applied" });
        continue;
      }
      if (input.tempPath) {
        if (existsSync(target)) this.core.trash.preserve(SHARE, input.path, target);
        renameSync(input.tempPath, target);
      } else if (input.move) {
        renameSync(path.join(this.root, item.fromPath!), target);
        this.written.set(item.fromPath!, null);
      } else if (input.localSource && "path" in input.localSource) {
        copyFileSync(path.join(this.root, input.localSource.path), target);
      } else {
        items.push({ path: input.path, outcome: "retry", reason: "Not modelled by the stand-in" });
        continue;
      }
      chmodSync(target, item.target.mode);
      this.written.set(input.path, item.target.sha256);
      items.push({ path: input.path, outcome: "applied" });
    }
    return { items };
  }
}

interface Node { id: string; root: string; core: FileSyncCore; events: CoreEvent[]; scan(): Promise<unknown> }

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-transfer-"));
  const clock = new FakeClock();
  const net = new Net();
  const nodes: Node[] = [];
  t.after(async () => {
    for (const node of nodes) await node.core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const node = async (id: "a" | "b", options: Partial<CoreDeps> = {}): Promise<Node> => {
    const root = path.join(dir, id, "root");
    mkdirSync(root, { recursive: true });
    const peer = id === "a" ? "b" : "a";
    let seed = id === "a" ? 11 : 13;
    const events: CoreEvent[] = [];
    const core = createWorkerCore({
      nodeId: id, dataDir: path.join(dir, id, "data"), clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false,
      transport: net.transport(id), emit: (event) => events.push(event), noticeDelayMs: 10, settleMs: 1000,
      // Big files are hashed at once, so a source indexes its 50 MiB file in one scan.
      scanner: { smallFileBytes: 64 * MiB }, ...options,
    });
    net.cores.set(id, core);
    await core.call("configure", {
      enabled: true, hostId: `host-${id}`, records: { engines: [], settings: [] },
      peers: [{ nodeId: peer, publicKey: "unused", origins: [], present: true }],
      shares: [{ key: SHARE, projectId: "p1", kind: "project", root, phase: id === "b" ? "builtin" : "syncthing", rules: {}, peers: [peer] }],
    });
    const result: Node = { id, root, core, events, scan: () => core.call("scan", { share: SHARE, scope: "full", reason: "test" }) };
    nodes.push(result);
    return result;
  };
  /** Runs every core to rest: work in flight, then timers up to `horizonMs` from now (all of them without one). */
  const quiesce = async (horizonMs = Number.POSITIVE_INFINITY) => {
    const limit = clock.now() + horizonMs;
    for (let round = 0; round < 20_000; round++) {
      await Promise.all(nodes.map((each) => each.core.sync?.idle()));
      await tick();
      if (!clock.fireNext(limit)) {
        await Promise.all(nodes.map((each) => each.core.sync?.idle()));
        await tick();
        if (!clock.fireNext(limit)) return;
      }
    }
    throw new Error("The cores did not settle");
  };
  /** Ticks (firing timers due within `horizonMs`) until `condition` holds, without waiting on work in flight. */
  const until = async (condition: () => boolean, horizonMs = 1000) => {
    for (let round = 0; round < 20_000 && !condition(); round++) {
      await tick();
      clock.fireNext(clock.now() + horizonMs);
    }
    assert.ok(condition(), "the condition never held");
  };
  return { dir, clock, net, node, nodes, quiesce, until };
}

async function pair(t: TestContext, options: { a?: Partial<CoreDeps>; b?: Partial<CoreDeps>; transfers?: Partial<NonNullable<CoreDeps["transfers"]>> } = {}) {
  const s = setup(t);
  const a = await s.node("a", options.a);
  const standIn = new StandIn(s.clock, path.join(s.dir, "b", "root"));
  const b = await s.node("b", { ...options.b, transfers: { ...(REAL ? {} : { queue: standIn, apply: standIn }), ...options.transfers } });
  standIn.core = b.core;
  // The real queue keeps need rows once the local index is complete.
  if (REAL) await b.scan();
  return { ...s, a, b, standIn };
}

function tree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else files.set(relative, sha(readFileSync(path.join(directory, entry.name))));
    }
  };
  walk(root, "");
  return files;
}

test("2,000 small files arrive in about one fetch request per 256, counted per peer and route", async (t) => {
  const s = await pair(t);
  let total = 0;
  for (let index = 0; index < 2000; index++) {
    const directory = path.join(s.a.root, `d${index % 20}`);
    mkdirSync(directory, { recursive: true });
    const content = `file ${index}\n${"x".repeat(index % 1500)}`;
    total += Buffer.byteLength(content);
    writeFileSync(path.join(directory, `f${index}.txt`), content);
  }
  await s.a.scan();
  await s.quiesce();

  assert.deepEqual(tree(s.b.root), tree(s.a.root));
  const fetches = s.net.requests("fetch").filter((entry) => entry.from === "b");
  t.diagnostic(`${fetches.length} fetch requests for 2,000 files (${total} bytes)`);
  assert.ok(fetches.length >= Math.ceil(2000 / 256) && fetches.length <= Math.ceil(2000 / 256) + 2, `${fetches.length} fetch requests`);
  assert.equal(s.net.requests("file").length, 0);
  assert.equal(s.net.bytes("fetch") > total, true, "frames carry headers besides the bytes");
  const metrics = s.b.events.filter((event): event is Extract<CoreEvent, { event: "metric" }> => event.event === "metric" && event.operation === "fileSync.transfer");
  assert.equal(metrics.reduce((sum, metric) => sum + Number(metric.fields?.bytes), 0), total);
  assert.equal(metrics.reduce((sum, metric) => sum + Number(metric.fields?.files), 0), 2000);
  assert.ok(metrics.every((metric) => metric.fields?.endpoint === "fetch" && metric.fields?.route === "direct" && typeof metric.durationMs === "number"));
  const [status] = await s.b.core.call("status", { shares: [SHARE] });
  assert.deepEqual(status.peers[0].transfer, { directBytes: total, relayBytes: 0, files: 2000 });
  assert.equal(s.b.core.sync!.transfersInFlight, 0);
  // Temps beside the targets are gone: every one was renamed into place.
  assert.ok([...tree(s.b.root).keys()].every((relative) => !relative.includes(".joint-bob-sync.")));
});

test("a 50 MiB file resumes after a mid-stream abort without sending received bytes again", async (t) => {
  let cutAt = 0;
  const s = await pair(t, {
    transfers: { faults: { midStream: (_relative, bytes) => { if (!cutAt && bytes >= 20 * MiB) { cutAt = bytes; throw new Error("connection reset"); } } } },
  });
  const content = randomBytes(50 * MiB);
  writeFileSync(path.join(s.a.root, "big.bin"), content);
  await s.a.scan();
  await s.quiesce();

  assert.equal(sha(readFileSync(path.join(s.b.root, "big.bin"))), sha(content));
  const files = s.net.requests("file");
  assert.equal(files.length, 2);
  assert.ok(cutAt >= 20 * MiB && cutAt < 50 * MiB);
  assert.equal(files[0].range, undefined);
  assert.equal(files[1].range, `bytes=${cutAt}-`);
  assert.equal(files[1].status, 206);
  assert.equal(s.net.bytes("file"), 50 * MiB, "every byte crossed once");
  if (!REAL) assert.ok(s.standIn.retries.some((retry) => /connection reset/.test(retry.reason)));
  assert.equal(existsSync(path.join(s.b.root, transferTempName(SHARE, "big.bin", sha(content)))), false);
});

test("stopping while a resumed download re-hashes its temp ends between chunks, and the temp stays", async (t) => {
  let cutAt = 0;
  const s = await pair(t, {
    transfers: { faults: { midStream: (_relative, bytes) => { if (!cutAt && bytes >= 20 * MiB) { cutAt = bytes; throw new Error("connection reset"); } } } },
  });
  const content = randomBytes(50 * MiB);
  writeFileSync(path.join(s.a.root, "big.bin"), content);
  const temp = path.join(s.b.root, transferTempName(SHARE, "big.bin", sha(content)));
  // Reads of the temp are slow from the cut on (a multi-GiB temp on a slow disk): 20 chunks take about two seconds.
  let reads = 0;
  const open = fsPromises.open;
  fsPromises.open = (async (file: Parameters<typeof open>[0], ...rest: unknown[]) => {
    const handle: FileHandle = await (open as (...args: unknown[]) => Promise<FileHandle>)(file, ...rest);
    if (!cutAt || String(file) !== temp || rest[0] !== (fsPromises.constants.O_RDONLY | fsPromises.constants.O_NOFOLLOW)) return handle;
    const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
    (handle as unknown as { read: (...args: unknown[]) => Promise<unknown> }).read = async (...args: unknown[]) => { reads++; await new Promise((resolve) => setTimeout(resolve, 100)); return read(...args); };
    return handle;
  }) as typeof open;
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = open; syncBuiltinESMExports(); });
  // Real time passes here (50 MiB is written and read), so this waits on the clock of the wall, firing due timers.
  const waitFor = async (condition: () => boolean) => {
    for (let round = 0; round < 3000 && !condition(); round++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      s.clock.fireNext(s.clock.now() + 60_000);
    }
    assert.ok(condition(), `cut at ${cutAt}, ${reads} slow reads`);
  };
  await s.a.scan();
  await waitFor(() => reads > 0);
  const started = performance.now();
  await s.b.core.close();
  const took = performance.now() - started;
  assert.ok(took < 1000, `stop took ${Math.round(took)} ms with the temp half re-hashed (${reads} of 20 chunks)`);
  assert.ok(reads < 20, "the re-hash stopped early");
  assert.ok(existsSync(temp), "the bytes stay to be resumed after the next start");
});

test("a stalled stream is abandoned after 30 s without bytes and resumed", async (t) => {
  const s = await pair(t);
  const content = randomBytes(4 * MiB);
  writeFileSync(path.join(s.a.root, "slow.bin"), content);
  let stalled = false;
  let first = true;
  s.net.responder = (_from, request, answer) => {
    if (!request.target.endsWith("/file") || !first || !answer.body) return undefined;
    first = false;
    const body = answer.body;
    return {
      ...answer,
      body: (async function* () {
        let sent = 0;
        for await (const chunk of body) {
          yield chunk;
          sent += chunk.byteLength;
          if (sent >= MiB) break;
        }
        // Then nothing: the connection is open and silent until the reader gives up.
        stalled = true;
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw request.signal?.reason ?? new Error("aborted");
      })(),
    };
  };
  await s.a.scan();
  await s.until(() => stalled);
  await s.clock.advance(29_000);
  assert.equal(s.net.requests("file").length, 1, "29 s of silence is not a stall yet");
  await s.clock.advance(1_000);
  await s.quiesce();

  assert.equal(sha(readFileSync(path.join(s.b.root, "slow.bin"))), sha(content));
  const files = s.net.requests("file");
  assert.equal(files.length, 2);
  assert.equal(files[1].range, `bytes=${MiB}-`);
  if (!REAL) assert.ok(s.standIn.retries.some((retry) => /stalled/.test(retry.reason)), JSON.stringify(s.standIn.retries));
});

test("below the disk floor nothing is requested; the items are blocked and offered again later", async (t) => {
  let free = 1024 ** 3;
  const s = await pair(t, { b: { diskFree: () => free } });
  writeFileSync(path.join(s.a.root, "small.txt"), "small");
  writeFileSync(path.join(s.a.root, "large.bin"), randomBytes(2 * MiB));
  await s.a.scan();
  await s.quiesce(30_000);

  assert.equal(s.net.requests("fetch").length + s.net.requests("file").length, 0);
  if (REAL) assert.equal((await s.b.core.call("status", { shares: [SHARE] }))[0].blocked, 2);
  else {
    assert.deepEqual(s.standIn.blocks.map((block) => [block.path, block.reason, block.retryAfterMs]).sort(), [
      ["large.bin", "Not enough free disk space", 60_000], ["small.txt", "Not enough free disk space", 60_000],
    ]);
  }
  assert.deepEqual(readdirSync(s.b.root), []);

  free = 1024 ** 5;
  await s.quiesce();
  assert.deepEqual(tree(s.b.root), tree(s.a.root));
});

test("a version that changes during a large download ends as the newest version, with no conflict copy or temp left", async (t) => {
  const v1 = randomBytes(8 * MiB);
  const v2 = randomBytes(8 * MiB);
  let changed = false;
  let a: Node | undefined;
  const s = await pair(t, {
    transfers: { faults: { midStream: (_relative, bytes) => {
      if (changed || bytes < 2 * MiB) return;
      changed = true;
      // Rewritten in place on the source while its bytes are on their way, then indexed there.
      writeFileSync(path.join(a!.root, "v.bin"), v2);
      void a!.scan();
    } } },
  });
  a = s.a;
  writeFileSync(path.join(s.a.root, "v.bin"), v1);
  await s.a.scan();
  await s.quiesce();

  assert.ok(changed);
  assert.equal(sha(readFileSync(path.join(s.b.root, "v.bin"))), sha(v2));
  assert.deepEqual([...tree(s.b.root).keys()], ["v.bin"], "no conflict copy, no temp of either version");
  if (!REAL) assert.equal(s.standIn.inputs.filter((input) => input.tempPath).at(-1)?.tempPath, path.join(s.b.root, transferTempName(SHARE, "v.bin", sha(v2))));
});

test("renaming a 1,000-file directory moves no bytes", async (t) => {
  const s = await pair(t, { a: { scanner: { smallFileBytes: 64 * MiB } } });
  mkdirSync(path.join(s.a.root, "old"));
  for (let index = 0; index < 1000; index++) writeFileSync(path.join(s.a.root, "old", `f${index}.txt`), `content ${index}`);
  await s.a.scan();
  await s.quiesce();
  assert.deepEqual(tree(s.b.root), tree(s.a.root));
  // b indexes what arrived, so its own rows hold the content a rename can reuse.
  await s.b.scan();
  await s.quiesce();
  const before = { requests: s.net.requests("fetch").length + s.net.requests("file").length, bytes: s.net.bytes("fetch", "file") };

  renameSync(path.join(s.a.root, "old"), path.join(s.a.root, "new"));
  await s.a.scan();
  await s.quiesce();

  const after = tree(s.b.root);
  assert.equal(after.size, 1000);
  assert.ok([...after.keys()].every((relative) => relative.startsWith("new/")));
  assert.deepEqual(after, tree(s.a.root));
  assert.equal(s.net.requests("fetch").length + s.net.requests("file").length, before.requests, "no transfer request");
  assert.equal(s.net.bytes("fetch", "file"), before.bytes, "0 bytes over the transport");
  if (!REAL) assert.equal(s.standIn.inputs.filter((input) => input.move).length, 1000);
});

test("relay-fallback transfers wait while main's event loop is busy; direct ones never touch main", async (t) => {
  const s = await pair(t);
  s.net.routes.set("b\na", "relay");
  await s.b.core.call("pace", { relayPaused: true });
  writeFileSync(path.join(s.a.root, "one.txt"), "one");
  await s.a.scan();
  await s.quiesce();
  assert.equal(s.net.requests("fetch").length, 0);
  assert.equal(existsSync(path.join(s.b.root, "one.txt")), false);

  await s.b.core.call("pace", { relayPaused: false });
  await s.quiesce();
  assert.equal(readFileSync(path.join(s.b.root, "one.txt"), "utf8"), "one");
  const [status] = await s.b.core.call("status", { shares: [SHARE] });
  assert.deepEqual(status.peers[0].transfer, { directBytes: 0, relayBytes: 3, files: 1 });
});

test("a handoff's status request and the prioritize op move the share's rows first", { skip: STAND_IN_ONLY }, async (t) => {
  const s = await pair(t);
  await s.quiesce();
  const before = s.clock.now();
  const answer = await s.b.core.service.serve("a", "status", {}, { projectId: "p1", shares: [{ kind: "project", indexId: "abcdef", maxSeq: 1 }] });
  assert.equal(answer.status, 200);
  await s.b.core.call("prioritize", { share: SHARE, prefix: "docs", untilMs: before + 5000 });
  assert.deepEqual(s.standIn.prioritized, [{ share: SHARE, until: before + HANDOFF_PRIORITY_MS }, { share: SHARE, prefix: "docs", until: before + 5000 }]);
  // A plain status question (no shares named) is no handoff.
  await s.b.core.service.serve("a", "status", {}, { projectId: "p1" });
  assert.equal(s.standIn.prioritized.length, 2);
  await s.quiesce();
});

test("revocation wins: bytes from a peer that left the share are neither written nor applied", async (t) => {
  const s = await pair(t);
  writeFileSync(path.join(s.a.root, "one.txt"), "one");
  writeFileSync(path.join(s.a.root, "two.txt"), "two");
  s.net.responder = (_from, request, answer) => {
    if (!request.target.endsWith("/fetch") || !answer.body) return undefined;
    const body = answer.body;
    return {
      ...answer,
      body: (async function* () {
        // The share's peer set changes while the answer is on its way.
        await s.b.core.call("configure", {
          enabled: true, hostId: "host-b", records: { engines: [], settings: [] }, peers: [{ nodeId: "a", publicKey: "unused", origins: [], present: true }],
          shares: [{ key: SHARE, projectId: "p1", kind: "project", root: s.b.root, phase: "builtin", rules: {}, peers: [] }],
        });
        yield* body;
      })(),
    };
  };
  await s.a.scan();
  await s.quiesce(5_000);
  assert.equal(s.net.requests("fetch").length, 1);
  assert.deepEqual(readdirSync(s.b.root), [], "no file and no temp");
  if (!REAL) assert.deepEqual(s.standIn.inputs, []);
});

test("downloads tell apply where their bytes came from, so apply can re-check the share's peers", { skip: STAND_IN_ONLY }, async (t) => {
  const s = await pair(t);
  writeFileSync(path.join(s.a.root, "one.txt"), "one");
  s.net.responder = (_from, request) => {
    // The share loses the peer after the bytes left it and before apply runs.
    if (request.target.endsWith("/fetch")) s.standIn.peers = [];
    return undefined;
  };
  await s.a.scan();
  await s.quiesce(5_000);
  assert.equal(existsSync(path.join(s.b.root, "one.txt")), false);
  assert.deepEqual(s.standIn.inputs.map((input) => [input.path, input.source, Boolean(input.tempPath)]), [["one.txt", "a", true]]);
  assert.deepEqual(readdirSync(s.b.root), [], "the stale temp is gone");
});
