import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createWorkerCore, type CoreDeps, type FileSyncCore, type PeerRequest, type PeerTransport } from "../src/file-sync/core.js";
import { digestOf } from "../src/file-sync/digest.js";
import { compileRules, effectiveRules } from "../src/file-sync/ignore.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type ConfigureArgs, type CoreEvent, type FilesEndpoint, type ServeAnswer } from "../src/file-sync/protocol.js";
import { PeerLimiter } from "../src/file-sync/sync.js";
import type { Clock, EngineRecord, SettingsRecord } from "../src/file-sync/types.js";
import { decodeIndexPage, FILES_API, INDEX_CONTENT_TYPE, NOT_SHARED_ERROR, sharesAnswerSchema, statusAnswerSchema } from "../src/file-sync/wire.js";

const SHARE = "project:p1";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }

/** Timers run only when a test fires them, so retries and coalescing are deterministic. */
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

type Responder = (from: string, request: PeerRequest) => Promise<ServeAnswer | undefined> | ServeAnswer | undefined;

/** Peers reach each other's FilesService directly; a responder can stand in for a peer or fail a request. */
class Net {
  readonly cores = new Map<string, FileSyncCore>();
  readonly log: Array<{ from: string; to: string; endpoint: string; status: number }> = [];
  readonly responders = new Map<string, Responder>();

  transport(from: string): PeerTransport {
    return {
      request: async (peer, request) => {
        const url = new URL(request.target, "http://peer");
        const endpoint = url.pathname.slice(FILES_API.length + 1) as FilesEndpoint;
        let answer = await this.responders.get(peer)?.(from, request);
        if (!answer) {
          const core = this.cores.get(peer);
          if (!core) throw new Error(`connect ECONNREFUSED ${peer}`);
          answer = await core.service.serve(from, endpoint, Object.fromEntries(url.searchParams), request.json === undefined ? undefined : structuredClone(request.json));
        }
        this.log.push({ from, to: peer, endpoint, status: answer.status });
        const body = answer.json !== undefined ? once(Buffer.from(JSON.stringify(answer.json))) : answer.body ?? once(Buffer.alloc(0));
        return { status: answer.status, headers: answer.headers, body };
      },
      route: () => "direct",
    };
  }

  requests(from: string, to: string, endpoint?: string): number {
    return this.log.filter((entry) => entry.from === from && entry.to === to && (!endpoint || entry.endpoint === endpoint)).length;
  }
}

interface Node {
  id: string;
  root: string;
  core: FileSyncCore;
  events: CoreEvent[];
  configure(overrides?: Partial<ConfigureArgs>, share?: Record<string, unknown>): Promise<unknown>;
  scan(): Promise<unknown>;
}

function setup(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jb-fs-service-"));
  const clock = new FakeClock();
  const net = new Net();
  const nodes: Node[] = [];
  t.after(async () => {
    for (const node of nodes) await node.core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const node = (id: string, peers: string[], options: Partial<CoreDeps> & { root?: string; hostId?: string; present?: boolean } = {}): Node => {
    const root = options.root ?? path.join(dir, id, "root");
    mkdirSync(root, { recursive: true });
    let seed = [...id].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 2147483647;
    const events: CoreEvent[] = [];
    const core = createWorkerCore({
      nodeId: id, dataDir: path.join(dir, id, "data"), clock, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647, watch: false,
      transport: net.transport(id), emit: (event) => events.push(event), settleMs: 1000, ...options,
    });
    net.cores.set(id, core);
    const result: Node = {
      id, root, core, events,
      configure: (overrides = {}, share = {}) => core.call("configure", {
        enabled: true, hostId: options.hostId ?? `host-${id}`, records: { engines: [], settings: [] },
        peers: peers.map((nodeId) => ({ nodeId, publicKey: "unused", origins: [], present: options.present ?? true })),
        shares: [{ key: SHARE, projectId: "p1", kind: "project", root, phase: "syncthing", rules: {}, peers, ...share }],
        ...overrides,
      }),
      scan: () => core.call("scan", { share: SHARE, scope: "full", reason: "test" }),
    };
    nodes.push(result);
    return result;
  };
  const quiesce = async () => {
    for (let round = 0; round < 2000; round++) {
      await Promise.all(nodes.map((each) => each.core.sync?.idle()));
      await tick();
      if (!clock.fireNext()) {
        await Promise.all(nodes.map((each) => each.core.sync?.idle()));
        return;
      }
    }
    throw new Error("The cores did not settle");
  };
  return { dir, clock, net, node, nodes, quiesce };
}

const serve = (node: Node, from: string, endpoint: FilesEndpoint, query: Record<string, string> = {}, body?: unknown) => node.core.service.serve(from, endpoint, query, body);

async function json(answer: ServeAnswer): Promise<unknown> {
  if (answer.json !== undefined) return answer.json;
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body ?? []) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function bytes(answer: ServeAnswer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body ?? []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function files(root: string, names: Record<string, string>): void {
  for (const [name, content] of Object.entries(names)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
}

// ---- authorization ----

test("a peer outside the share is refused everywhere except the shares probe", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { present: false });
  await a.configure();
  files(a.root, { "a.txt": "a" });
  await a.scan();
  const probe = await serve(a, "node-x", "shares");
  assert.equal(probe.status, 200, "an old or unrelated peer still learns that this node runs the engine");
  assert.deepEqual(sharesAnswerSchema.parse(await json(probe)).shares, []);
  const query = { projectId: "p1", kind: "project" };
  for (const [endpoint, args, body] of [["index", query, undefined], ["changed", {}, { shares: [{ projectId: "p1", kind: "project", indexId: "abc", maxSeq: 1 }] }], ["status", {}, { projectId: "p1" }]] as const) {
    const answer = await serve(a, "node-x", endpoint, args, body);
    assert.equal(answer.status, 403, endpoint);
    assert.deepEqual(answer.json, { error: NOT_SHARED_ERROR }, endpoint);
  }
  const unknown = await serve(a, "node-b", "index", { projectId: "p2", kind: "project" });
  assert.equal(unknown.status, 403, "a share missing from configure is refused like an unshared one");
  assert.deepEqual(unknown.json, { error: NOT_SHARED_ERROR });
  // P3 serves bytes: an outsider is refused like everywhere else, a member's malformed body is a 400.
  const sha = "0".repeat(64);
  for (const [endpoint, body] of [["fetch", { projectId: "p1", kind: "project", items: [{ path: "a.txt", sha256: sha }] }], ["file", { projectId: "p1", kind: "project", path: "a.txt", sha256: sha }]] as const) {
    const outsider = await serve(a, "node-x", endpoint, {}, body);
    assert.equal(outsider.status, 403, endpoint);
    assert.deepEqual(outsider.json, { error: NOT_SHARED_ERROR }, endpoint);
  }
  assert.equal((await serve(a, "node-b", "fetch", {}, { projectId: "p1", kind: "project", items: [] })).status, 400, "a fetch asks for at least one file");
  assert.deepEqual((await serve(a, "node-b", "file", {}, {})).json, { error: "Invalid request" });
  const invalid = await serve(a, "node-b", "index", { projectId: "p1", kind: "bogus" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.json, { error: "Invalid request" });
});

test("before its first configure the service answers that it is starting", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const answer = await serve(a, "node-b", "shares");
  assert.equal(answer.status, 503);
});

// ---- shares ----

test("the shares answer describes each share and carries only records about the caller's projects", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { present: false });
  const p2 = path.join(s.dir, "p2");
  mkdirSync(p2);
  const at = "2026-10-25T10:00:00.000Z";
  const engines: EngineRecord[] = [
    { projectId: "p1", mode: "syncthing", generation: 1, updatedAt: at, origin: "node-a" },
    { projectId: "p2", mode: "syncthing", generation: 1, updatedAt: at, origin: "node-a" },
  ];
  const rules = { disabledBuiltins: [], userRules: ["*.log"], removedUserRules: [], gitignore: false, importedFrom: [] };
  const settings: SettingsRecord[] = [
    { key: "project:p1", value: rules, updatedAt: at, origin: "node-a" },
    { key: "project:p2", value: rules, updatedAt: at, origin: "node-a" },
    { key: "global:node-a", value: rules, updatedAt: at, origin: "node-a" },
    { key: "global:node-c", value: rules, updatedAt: at, origin: "node-c" },
  ];
  await a.configure({
    records: { engines, settings },
    peers: [{ nodeId: "node-b", publicKey: "x", origins: [], present: false }, { nodeId: "node-c", publicKey: "x", origins: [], present: false }],
    shares: [
      { key: SHARE, projectId: "p1", kind: "project", root: a.root, phase: "syncthing", rules: {}, peers: ["node-b"] },
      { key: "project:p2", projectId: "p2", kind: "project", root: p2, phase: "syncthing", rules: {}, peers: ["node-c"] },
    ],
  });
  files(a.root, { "one.txt": "1", "two.txt": "2" });
  await a.scan();
  const row = a.core.db.share(SHARE)!;
  const answer = sharesAnswerSchema.parse(await json(await serve(a, "node-b", "shares")));
  assert.deepEqual(answer.fileSync, { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: true });
  assert.equal(answer.nodeId, "node-a");
  assert.equal(answer.hostId, "host-node-a");
  assert.deepEqual(answer.shares, [{
    projectId: "p1", kind: "project", indexId: row.indexId, maxSeq: 2, digest: row.digest, rulesHash: compileRules(effectiveRules("project", {})).hash,
    state: "idle", builtinSince: null, prunedBelow: 0, rootDev: row.rootDev, rootIno: row.rootIno,
  }]);
  assert.deepEqual(answer.engines.map((record) => record.projectId), ["p1"]);
  assert.deepEqual(answer.settings.map((record) => record.key), ["project:p1", "global:node-a"], "another node's all-projects rules are never relayed");
  const toC = sharesAnswerSchema.parse(await json(await serve(a, "node-c", "shares")));
  assert.deepEqual(toC.shares.map((share) => share.projectId), ["p2"]);
  assert.deepEqual(toC.engines.map((record) => record.projectId), ["p2"]);
  assert.deepEqual(toC.settings.map((record) => record.key), ["project:p2", "global:node-a"]);
});

test("a shares answer marks the peer capable and its records go to main with the authenticated sender", async (t) => {
  const s = setup(t);
  const at = "2026-10-25T10:00:00.000Z";
  const rules = { disabledBuiltins: [], userRules: [], removedUserRules: [], gitignore: true, importedFrom: [] };
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await a.configure({
    records: {
      engines: [{ projectId: "p1", mode: "syncthing", generation: 2, updatedAt: at, origin: "node-a" }],
      settings: [{ key: "project:p1", value: rules, updatedAt: at, origin: "node-a" }, { key: "global:node-c", value: rules, updatedAt: at, origin: "node-c" }],
    },
  });
  await b.configure();
  await s.quiesce();
  const records = b.events.filter((event) => event.event === "records");
  assert.deepEqual(records, [{
    event: "records", fromPeer: "node-a",
    engines: [{ projectId: "p1", mode: "syncthing", generation: 2, updatedAt: at, origin: "node-a" }],
    settings: [{ key: "project:p1", value: rules, updatedAt: at, origin: "node-a" }],
  }], "once, from the node that answered, without records about other nodes");
  assert.deepEqual(b.events.filter((event) => event.event === "capability"), [{ event: "capability", peer: "node-a", protocol: FILE_SYNC_PROTOCOL, enabled: true, origins: [], hostId: "host-node-a" }]);
  await b.core.call("announce", { slept: false });
  await s.quiesce();
  assert.equal(b.events.filter((event) => event.event === "records").length, 1, "the same records are not forwarded again");
});

// ---- index ----

test("an index page is gzip JSON with its own content type, and only a since of this generation is acknowledged", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { present: false });
  await a.configure();
  files(a.root, { "1.txt": "1", "2.txt": "2", "3.txt": "3", "4.txt": "4", "5.txt": "5" });
  await a.scan();
  const indexId = a.core.db.share(SHARE)!.indexId;
  const first = await serve(a, "node-b", "index", { projectId: "p1", kind: "project", since: "0", limit: "2" });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-type"], INDEX_CONTENT_TYPE);
  assert.equal(first.headers["content-encoding"], undefined, "compressed is the body's type, not a transfer encoding");
  const page = await decodeIndexPage(await bytes(first));
  assert.deepEqual(page.entries.map((entry) => entry.seq), [1, 2]);
  assert.equal(page.more, true);
  assert.equal(page.indexId, indexId);
  const ack = () => a.core.db.acks(SHARE).find((row) => row.peer === "node-b")?.seq;
  assert.equal(ack(), 0, "a pull from 0 is recorded (it holds nothing yet)");
  await bytes(await serve(a, "node-b", "index", { projectId: "p1", kind: "project", since: "2", limit: "2", indexId }));
  assert.equal(ack(), 2);
  await bytes(await serve(a, "node-b", "index", { projectId: "p1", kind: "project", since: "4", limit: "2", indexId: "another-generation" }));
  assert.equal(ack(), 2, "a cursor of another generation acknowledges nothing here");
  await bytes(await serve(a, "node-b", "index", { projectId: "p1", kind: "project", since: "4", limit: "2" }));
  assert.equal(ack(), 2, "nor does one that does not say which generation it belongs to");
});

// ---- changed ----

test("changed answers 202 at once; the pull runs afterwards", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { present: false });
  const b = s.node("node-b", ["node-a"], { present: false });
  await a.configure();
  await b.configure();
  files(a.root, { "a.txt": "a", "b.txt": "b" });
  await a.scan();
  await b.scan();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.net.responders.set("node-a", async (_from, request) => { if (request.purpose === "index") await gate; return undefined; });
  const row = a.core.db.share(SHARE)!;
  const answer = await Promise.race([
    serve(b, "node-a", "changed", {}, { shares: [{ projectId: "p1", kind: "project", indexId: row.indexId, maxSeq: row.maxSeq }] }),
    new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 2000)),
  ]);
  assert.notEqual(answer, "waited", "the notice is not held until the pull ends");
  assert.equal((answer as ServeAnswer).status, 202);
  assert.equal(b.core.sync!.pulling(SHARE, "node-a"), true, "the pull is scheduled and waiting on the peer");
  release();
  await s.quiesce();
  const cursor = b.core.db.cursor(SHARE, "node-a")!;
  assert.equal(cursor.indexId, row.indexId);
  assert.equal(cursor.seq, row.maxSeq);
  assert.equal(b.core.db.remoteCount(SHARE, "node-a"), 2);
});

// ---- status ----

test("status reports the caller's cursor and pulls at once when the caller is ahead", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { present: false });
  const b = s.node("node-b", ["node-a"], { present: false });
  await a.configure();
  await b.configure();
  files(a.root, { "a.txt": "a", "b.txt": "b", "c.txt": "c" });
  await a.scan();
  await b.scan();
  const row = a.core.db.share(SHARE)!;
  const answer = await serve(b, "node-a", "status", {}, { projectId: "p1", shares: [{ kind: "project", indexId: row.indexId, maxSeq: row.maxSeq }] });
  assert.equal(answer.status, 200);
  const local = b.core.db.share(SHARE)!;
  assert.deepEqual(statusAnswerSchema.parse(answer.json), {
    shares: [{ kind: "project", state: "idle", cursor: 0, callerIndexId: null, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, digest: local.digest, maxSeq: local.maxSeq }],
  });
  await s.quiesce();
  assert.equal(s.net.requests("node-b", "node-a", "index"), 1, "one pull, started by the status request");
  assert.equal(b.core.db.cursor(SHARE, "node-a")?.seq, row.maxSeq);
  const again = statusAnswerSchema.parse((await serve(b, "node-a", "status", {}, { projectId: "p1" })).json);
  assert.equal(again.shares[0].cursor, row.maxSeq);
  assert.equal(again.shares[0].callerIndexId, row.indexId);
});

// ---- sync layer ----

test("a 404 from the shares probe marks the peer as not capable; notices stop until it returns", async (t) => {
  const s = setup(t);
  s.net.responders.set("node-old", () => ({ status: 404, headers: {}, json: { error: "Not found" } }));
  const a = s.node("node-a", ["node-old"]);
  await a.configure();
  await s.quiesce();
  assert.equal(s.net.requests("node-a", "node-old"), 1, "the probe only");
  assert.deepEqual(a.events.filter((event) => event.event === "capability"), [{ event: "capability", peer: "node-old", protocol: 0, enabled: false, origins: [] }]);
  files(a.root, { "a.txt": "a" });
  await a.scan();
  await s.quiesce();
  assert.equal(s.net.requests("node-a", "node-old"), 1, "no notice goes to a node that cannot use it");
  await a.core.call("peerPresence", { peer: "node-old", present: true });
  await s.quiesce();
  assert.equal(s.net.requests("node-a", "node-old", "shares"), 2, "a returning peer is probed again (it may have been updated)");
});

test("an undelivered notice is retried with backoff while the peer is present, and flushed when it returns", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await a.configure();
  await b.configure();
  await a.scan();
  await b.scan();
  await s.quiesce();
  let down = true;
  let attempts = 0;
  s.net.responders.set("node-b", (_from, request) => { if (down) { if (request.purpose === "notice") attempts++; throw new Error("connect ECONNREFUSED"); } return undefined; });
  files(a.root, { "new.txt": "new" });
  await a.scan();
  await s.clock.advance(250);
  await a.core.sync!.idle();
  assert.equal(attempts, 1, "the coalesced notice went out once");
  await s.clock.advance(1000);
  await a.core.sync!.idle();
  assert.equal(attempts, 2, "retried after 1 s");
  await s.clock.advance(2000);
  await a.core.sync!.idle();
  assert.equal(attempts, 3, "then after 2 s");
  await a.core.call("peerPresence", { peer: "node-b", present: false });
  await s.clock.advance(3_600_000);
  await a.core.sync!.idle();
  assert.equal(attempts, 3, "nothing is retried while the peer is away");
  down = false;
  await a.core.call("peerPresence", { peer: "node-b", present: true });
  await s.quiesce();
  assert.equal(b.core.db.cursor(SHARE, "node-a")?.seq, a.core.db.share(SHARE)!.maxSeq, "the peer pulled what the notice announced");
  assert.ok(b.core.db.remote(SHARE, "node-a", "new.txt"));
});

test("the live check repairs once, then reports a digest mismatch as a share error until it matches again", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await a.configure();
  await b.configure();
  files(a.root, { "same.txt": "same" });
  files(b.root, { "same.txt": "same" });
  await a.scan();
  await b.scan();
  await s.quiesce();
  const [before] = await b.core.call("status", {});
  assert.equal(before.peers[0].differences, 0);
  assert.equal(before.errors, 0);
  // A wrong digest on A: its rows still say the same as B's files, so B's copy of A's index looks right but cannot be.
  a.core.db.writeTx(() => a.core.db.updateShare(SHARE, { digest: "f".repeat(64) }));
  await b.core.call("repair", { share: SHARE, peer: "node-a" });
  await s.quiesce();
  const metrics = b.events.filter((event) => event.event === "metric" && event.operation === "fileSync.digestMismatch");
  assert.deepEqual(metrics.map((event) => event.event === "metric" && event.fields?.repaired), [false, true], "one automatic repair, then the mismatch persisted");
  const [broken] = await b.core.call("status", {});
  assert.equal(broken.state, "error");
  assert.equal(broken.errors, 1);
  assert.match(broken.message ?? "", /node-a/);
  const correct = digestOf(a.core.db.entries(SHARE));
  a.core.db.writeTx(() => a.core.db.updateShare(SHARE, { digest: correct }));
  await b.core.call("repair", { share: SHARE, peer: "node-a" });
  await s.quiesce();
  const [fixed] = await b.core.call("status", {});
  assert.equal(fixed.errors, 0);
  assert.equal(fixed.state, "idle");
});

test("the same-folder guard leaves out a peer on this machine whose share is the same folder", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"], { hostId: "same-host" });
  const b = s.node("node-b", ["node-a"], { hostId: "same-host", root: a.root });
  files(a.root, { "a.txt": "a" });
  await a.configure();
  await b.configure();
  await a.scan();
  await b.scan();
  // Announced after both scans: the guard needs both root identities.
  await a.core.call("announce", { slept: false });
  await b.core.call("announce", { slept: false });
  await s.quiesce();
  assert.equal(a.core.sync!.isExcluded(SHARE, "node-b"), true);
  assert.equal(b.core.sync!.isExcluded(SHARE, "node-a"), true);
  const [status] = await a.core.call("status", {});
  assert.deepEqual(status.peers, [], "an excluded peer has no place in the share's status");
  const pulls = s.net.requests("node-a", "node-b", "index");
  files(b.root, { "b.txt": "b" });
  await b.scan();
  await s.quiesce();
  assert.equal(s.net.requests("node-a", "node-b", "index"), pulls, "nothing is pulled from or noticed to it");
});

test("the per-peer limiter allows four requests, two of them pulls; notices bypass; urgent ones go first", async () => {
  const limiter = new PeerLimiter();
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const take = (name: string, purpose: PeerRequest["purpose"], urgent = false) => void limiter.acquire(purpose, urgent).then((release) => { started.push(name); releases.set(name, release); });
  take("i1", "index");
  take("i2", "index");
  take("i3", "index");
  take("s1", "status");
  take("s2", "shares");
  take("s3", "status");
  take("u1", "status", true);
  await tick();
  assert.deepEqual(started, ["i1", "i2", "s1", "s2"], "the third pull waits for a pull slot without holding up the others");
  assert.deepEqual(limiter.active, { inFlight: 4, pulls: 2, queued: 3 });
  const notice = await limiter.acquire("notice");
  notice();
  assert.deepEqual(limiter.active, { inFlight: 4, pulls: 2, queued: 3 }, "notices take no slot");
  releases.get("s1")!();
  await tick();
  assert.equal(started.at(-1), "u1", "a person's request goes ahead of queued background work");
  releases.get("i1")!();
  await tick();
  assert.equal(started.at(-1), "i3");
  releases.get("i2")!();
  await tick();
  assert.equal(started.at(-1), "s3");
});

test("a peer whose engine is off gets no notices and nothing is retried", async (t) => {
  const s = setup(t);
  const off = { fileSync: { protocol: 1, minProtocol: 1, enabled: false }, nodeId: "node-off", hostId: "host-off", origins: [], shares: [], engines: [], settings: [] };
  // Main's routes on a node with file sync off: the probe learns it, anything else is 503.
  s.net.responders.set("node-off", (_from, request) => request.purpose === "shares"
    ? { status: 200, headers: {}, json: off }
    : { status: 503, headers: {}, json: { error: "File sync is off on this node" } });
  const a = s.node("node-a", ["node-off"]);
  await a.configure();
  await a.scan();
  for (let edit = 0; edit < 10; edit++) {
    files(a.root, { [`f${edit}.txt`]: String(edit) });
    await a.scan();
    await s.clock.advance(60_000);
  }
  await s.clock.advance(3_600_000);
  await s.quiesce();
  assert.deepEqual(s.net.log.filter((entry) => entry.to === "node-off").map((entry) => entry.endpoint), ["shares"], "the probe only");
  assert.deepEqual(a.events.filter((event) => event.event === "capability").map((event) => event.event === "capability" && event.enabled), [false]);
});

test("a notice answered 503 (an engine still starting) is not retried; the peer's own notice brings it back", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  await a.configure();
  await a.scan();
  await b.scan();
  await s.quiesce();
  let starting = true;
  let refused = 0;
  s.net.responders.set("node-b", (_from, request) => {
    if (!starting || request.purpose !== "notice") return undefined;
    refused++;
    return { status: 503, headers: {}, json: { error: "File sync is starting" } };
  });
  files(a.root, { "new.txt": "new" });
  await a.scan();
  await s.clock.advance(3_600_000);
  await s.quiesce();
  files(a.root, { "more.txt": "more" });
  await a.scan();
  await s.quiesce();
  assert.equal(refused, 1, "neither retried nor sent again while it is not running");
  starting = false;
  files(b.root, { "b.txt": "b" });
  await b.scan();
  await s.quiesce();
  assert.equal(b.core.db.cursor(SHARE, "node-a")?.seq, a.core.db.share(SHARE)!.maxSeq, "probed again on its notice, told everything, and pulled");
});

test("a peer whose engine answered that it is starting gets its direct addresses tried again once it runs", async (t) => {
  const s = setup(t);
  const reached: string[] = [];
  const a = s.node("node-a", ["node-b"], { transport: { ...s.net.transport("node-a"), reachable: (peer: string) => { reached.push(peer); } } });
  const b = s.node("node-b", ["node-a"]);
  let starting = true;
  s.net.responders.set("node-b", (_from, request) => starting && request.purpose === "shares" ? { status: 503, headers: {}, json: { error: "File sync is starting" } } : undefined);
  await a.configure();
  await a.scan();
  await s.quiesce();
  assert.deepEqual(reached, [], "not running yet");
  starting = false;
  await b.configure();
  await b.scan();
  files(b.root, { "b.txt": "b" });
  await b.scan();
  await s.quiesce();
  assert.deepEqual(reached, ["node-b"], "its notice showed the engine running: the skipped addresses are cleared once");
  files(b.root, { "c.txt": "c" });
  await b.scan();
  await s.quiesce();
  assert.deepEqual(reached, ["node-b"], "later notices from a running engine change nothing");
});

test("a share the peer does not serve is not noticed until the peer names it", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  // B runs the engine without this project (not in its shadow list): it refuses notices about it with 403.
  await b.configure({ shares: [] });
  await a.configure();
  await a.scan();
  await s.quiesce();
  for (let edit = 0; edit < 3; edit++) {
    files(a.root, { [`f${edit}.txt`]: "x" });
    await a.scan();
    await s.quiesce();
  }
  assert.equal(s.net.requests("node-a", "node-b", "changed"), 0, "its shares answer left the share out");
  await b.configure();
  await b.scan();
  await s.quiesce();
  files(a.root, { "late.txt": "late" });
  await a.scan();
  await s.quiesce();
  assert.ok(s.net.requests("node-a", "node-b", "changed") >= 1, "named in its notice, the share is noticed again");
  assert.equal(b.core.db.cursor(SHARE, "node-a")?.seq, a.core.db.share(SHARE)!.maxSeq);
});

test("a peer main reports away is left alone: nothing is retried until it is back", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  await a.configure();
  await a.scan();
  await b.scan();
  await s.quiesce();
  let away = true;
  let attempts = 0;
  // The relay leg as main answers it for a peer that peer presence has as away.
  s.net.responders.set("node-b", () => {
    if (!away) return undefined;
    attempts++;
    throw Object.assign(new Error("Cluster peer is unreachable"), { code: "unreachable", away: true });
  });
  files(a.root, { "new.txt": "new" });
  await a.scan();
  await s.clock.advance(4 * 3_600_000);
  await s.quiesce();
  assert.equal(attempts, 1, "one notice, then nothing for four hours");
  away = false;
  await a.core.call("peerPresence", { peer: "node-b", present: true });
  await s.quiesce();
  assert.equal(b.core.db.cursor(SHARE, "node-a")?.seq, a.core.db.share(SHARE)!.maxSeq, "flushed and pulled once main reports it back");
});

test("records in a direct answer count only as the same answer fetched again through main", async (t) => {
  const s = setup(t);
  const at = "2026-10-25T10:00:00.000Z";
  const rules = { disabledBuiltins: [], userRules: [], removedUserRules: [], gitignore: false, importedFrom: [] };
  const genuine: EngineRecord = { projectId: "p1", mode: "syncthing", generation: 1, updatedAt: at, origin: "node-a" };
  const a = s.node("node-a", ["node-b"]);
  await a.configure({ records: { engines: [genuine], settings: [] } });
  const net = s.net.transport("node-b");
  const relayed: string[] = [];
  const b = s.node("node-b", ["node-a"], {
    transport: {
      route: () => "direct",
      request: async (peer, request) => {
        const response = await net.request(peer, request);
        if (request.via === "relay") { relayed.push(request.target); return { ...response, route: "relay" }; }
        if (request.purpose !== "shares") return { ...response, route: "direct" };
        // Something else holds A's direct address and answers as A: same node id, forged records.
        const answer = JSON.parse((await bytes(response as unknown as ServeAnswer)).toString("utf8"));
        answer.engines = [{ ...genuine, mode: "builtin", generation: 99 }];
        answer.settings = [{ key: "project:p1", value: { ...rules, userRules: ["*"] }, updatedAt: at, origin: "node-a" }];
        return { status: 200, headers: {}, body: once(Buffer.from(JSON.stringify(answer))), route: "direct" };
      },
    },
  });
  await b.configure();
  await s.quiesce();
  assert.deepEqual(relayed, ["/api/cluster/v2/files/shares"]);
  assert.deepEqual(b.events.filter((event) => event.event === "records"), [{ event: "records", fromPeer: "node-a", engines: [genuine], settings: [] }]);
});

test("triggers while a contact is in flight fold into it: one shares request and one notice", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  await b.scan();
  await s.quiesce();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  s.net.responders.set("node-b", async (from, request) => { if (from === "node-a" && request.purpose === "shares") await gate; return undefined; });
  await a.configure();
  // A worker's start: its first configure, the announce index.ts sends after it, and a hello from the peer.
  await a.core.call("announce", { slept: false });
  await a.core.call("peerPresence", { peer: "node-b", present: true });
  release();
  await s.quiesce();
  assert.equal(s.net.requests("node-a", "node-b", "shares"), 1, "the answer in flight serves every trigger that came before it");
  assert.equal(s.net.requests("node-a", "node-b", "changed"), 1, "one notice for all of them");
});

test("a real difference found while the comparison is still being computed is no digest mismatch", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  for (const node of [a, b]) files(node.root, { "f1.txt": "same 1", "f2.txt": "same 2", "f3.txt": "same 3" });
  files(a.root, { "zzz-only-a.txt": "not copied yet" });
  // Each node indexes first, then they find each other: the pull makes the pair comparable and the comparison runs in slices.
  for (const node of [a, b]) { await node.configure({}, { peers: [] }); await node.scan(); }
  for (const node of [a, b]) await node.configure();
  await s.quiesce();
  for (const node of [a, b]) {
    const [status] = await node.core.call("status", {});
    assert.notEqual(status.state, "error", `${node.id}: ${status.message}`);
    assert.equal(status.errors, 0);
    assert.equal(status.peers[0].differences, 1, node.id);
    assert.deepEqual(node.events.filter((event) => event.event === "metric" && event.operation === "fileSync.digestMismatch"), [], `${node.id}: no repair for a real difference`);
  }
});

test("a digest mismatch error left from before a restart is cleared by the next contact that finds the digests equal", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  for (const node of [a, b]) files(node.root, { "same.txt": "same" });
  await a.configure();
  await b.configure();
  await a.scan();
  await b.scan();
  await s.quiesce();
  b.core.db.writeTx(() => b.core.db.setError(SHARE, "", "error", "Index does not match its digest after a repair (node-a)", s.clock.now()));
  assert.equal((await b.core.call("status", {}))[0].errors, 1);
  // Nothing changed: no pull follows the contact, yet the check runs on what is stored.
  await b.core.call("announce", { slept: false });
  await s.quiesce();
  const [status] = await b.core.call("status", {});
  assert.equal(status.errors, 0);
  assert.equal(status.state, "idle");
});

test("an index page built before the peer's rules changed never overrides the rules a later notice announced", async (t) => {
  const s = setup(t);
  const a = s.node("node-a", ["node-b"]);
  const b = s.node("node-b", ["node-a"]);
  await b.configure();
  await a.configure();
  files(a.root, { "one.txt": "1" });
  files(b.root, { "one.txt": "1" });
  await a.scan();
  await b.scan();
  await s.quiesce();
  // B's next pull of A is answered now, but the answer arrives late.
  let release!: () => void;
  const late = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  s.net.responders.set("node-a", async (from, request) => {
    if (from !== "node-b" || request.purpose !== "index" || held) return undefined;
    held = true;
    const url = new URL(request.target, "http://peer");
    const answer = await a.core.service.serve(from, "index", Object.fromEntries(url.searchParams), undefined);
    await late;
    return answer;
  });
  // Only A has it (no merge writes a later row that would make B pull again).
  files(a.root, { "two.txt": "2" });
  await a.scan();
  await s.clock.advance(1000);
  assert.equal(held, true, "B's pull is on its way");
  // The project's rules change on both nodes (a settings record); A's notice tells B, then the old page lands.
  const rules = { userRules: ["*.tmp"] };
  await b.configure({}, { rules });
  await a.configure({}, { rules });
  // Under new rules each index is complete again only after a full scan (the watcher queues one; this test has none).
  await b.scan();
  await a.scan();
  await s.clock.advance(1000);
  release();
  await s.quiesce();
  for (const node of [a, b]) {
    const [status] = await node.core.call("status", {});
    assert.equal(status.peers[0].rulesMatch, true, `${node.id}: ${JSON.stringify(status.peers[0])}`);
    assert.notEqual(node.core.need.comparison(SHARE, status.peers[0].peer), undefined, `${node.id} compares again`);
  }
});
