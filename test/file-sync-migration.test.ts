import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pinClusterPublicKey } from "../src/cluster-identity.js";
import { ensurePeerEndpointSchema, recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { ensureResourceSharingSchema } from "../src/cluster-sharing.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { engineModeOf, engineRecordOf, ensureControlSchema, FolderOverBuiltinError, phaseOf, projectFilesOnSyncthing, projectHold, projectInsideBuiltin, readFileSyncConfig, saveEngineRecord, setPhase, whileFilesOnSyncthing, withProjectFilesLock, writeFileSyncConfig } from "../src/file-sync/control.js";
import { useFacadeEngineForTests, type EngineApi } from "../src/file-sync/facade.js";
import { FirstIndexQueue } from "../src/file-sync/first-index.js";
import { EngineSwitchRefused, HELD_REASON, Migration, removeSyncthingTemps, SYNCTHING_UNREACHABLE, SyncthingNotConfigured, syncthingFolderOverTarget, WRITES_WAIT_FOR_SYNCTHING, type MigrationDeps, type MigrationSyncthing } from "../src/file-sync/migration.js";
import { SyncthingEventStream, type StreamEvent } from "../src/file-sync/syncthing-events.js";
import type { PeerFileSync } from "../src/file-sync/peers.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, type OpArgs, type OpName, type ShareSpec, type ShareStatus } from "../src/file-sync/protocol.js";
import { acceptRecords } from "../src/file-sync/records.js";
import { EMPTY_RULE_SETTINGS, SHARE_KINDS, type Clock, type Phase, type ShareKind } from "../src/file-sync/types.js";
import type { SyncthingFolder } from "../src/syncthing.js";
import { projectTicketSyncFolderId } from "../src/task-workspaces.js";
import type { ProjectSyncStatus } from "../src/types.js";
import { projectWorktreeSyncFolderId } from "../src/worktree-filters.js";

/* The per-project switch between Syncthing and the built-in engine (migration.ts), against a fake
   Syncthing, a fake engine and fake peers: never a real daemon or worker. */

const LOCAL = "00000000-0000-4000-8000-000000000001";
const PEER = "00000000-0000-4000-8000-000000000002";
const THIRD = "00000000-0000-4000-8000-000000000003";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-10-25T00:00:00.000Z";
const HASH = "a".repeat(64);
const PROJECT = "alpha";

class FakeClock implements Clock {
  at = Date.parse(NOW);
  timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
  /** Every timer ever set: a loop would keep adding to it. */
  created = 0;
  now(): number { return this.at; }
  setTimeout(run: () => void, ms: number): { cancel(): void } {
    const timer = { at: this.at + ms, run, cancelled: false };
    this.timers.push(timer);
    this.created++;
    return { cancel: () => { timer.cancelled = true; } };
  }
  live(): number { return this.timers.filter((timer) => !timer.cancelled).length; }
  /** Moves time on and runs what came due. */
  advance(ms: number): void {
    this.at += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.at);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.run();
  }
}

class FakeSyncthing implements MigrationSyncthing {
  folders_: SyncthingFolder[] = [];
  answering = true;
  /** False: Joint Bob has no connection to a Syncthing on this node. */
  configured = true;
  /** With `configured` false: a Syncthing configuration is there all the same. */
  installed = false;
  paused: string[] = [];
  /** Folder ids a DELETE leaves in place (a daemon that does not let go). */
  stuck = new Set<string>();
  removed: string[] = [];
  states: Record<string, ProjectSyncStatus["state"]> = {};
  peerCaughtUpAnswer = true;
  calls: string[] = [];
  hook?: (call: string) => void;
  /** Bumped when this node is pointed at another Syncthing. */
  gen = 0;
  generation(): number { return this.gen; }

  add(id: string, folderPath: string, label = id): void { this.folders_.push({ id, label, path: folderPath, type: "sendreceive", devices: [] }); }
  ids(): string[] { return this.folders_.map((folder) => folder.id).sort(); }

  async folders(): Promise<SyncthingFolder[]> {
    this.calls.push("folders");
    this.hook?.("folders");
    if (!this.configured) throw new SyncthingNotConfigured(this.installed);
    if (!this.answering) throw new Error("fetch failed");
    return this.folders_.map((folder) => ({ ...folder }));
  }
  async pauseFolder(folderId: string): Promise<void> {
    this.calls.push(`pause ${folderId}`);
    if (!this.answering) throw new Error("fetch failed");
    this.paused.push(folderId);
    const folder = this.folders_.find((candidate) => candidate.id === folderId);
    if (folder) folder.paused = true;
  }
  async removeFolder(folderId: string): Promise<void> {
    this.calls.push(`remove ${folderId}`);
    this.hook?.(`remove ${folderId}`);
    if (!this.answering) throw new Error("fetch failed");
    this.removed.push(folderId);
    if (!this.stuck.has(folderId)) this.folders_ = this.folders_.filter((folder) => folder.id !== folderId);
  }
  async folderStatuses(folderIds: string[]): Promise<Record<string, ProjectSyncStatus>> {
    return Object.fromEntries(folderIds.map((id) => [id, { state: this.states[id] ?? "synced", remainingFiles: 0, remainingBytes: 0, message: "" }]));
  }
  async peerCaughtUp(): Promise<boolean> { return this.peerCaughtUpAnswer; }
}

interface Fixture {
  db: DatabaseSync;
  dir: string;
  roots: Record<ShareKind, string>;
  syncthing: FakeSyncthing;
  clock: FakeClock;
  engine: FakeEngine;
  capability: Map<string, PeerFileSync>;
  peer: FakePeer;
  activity: { reason?: string };
  logs: string[];
  /** auto-transition: server log lines, audit records and performance records. */
  infos: string[];
  audits: Array<Parameters<NonNullable<MigrationDeps["audit"]>>[0]>;
  metrics: Array<{ operation: string; durationMs: number }>;
  deps(overrides?: Partial<MigrationDeps>): MigrationDeps;
  machine(overrides?: Partial<MigrationDeps>): Migration;
  cleanup(): Promise<void>;
}

function status(kind: ShareKind, phase: Phase, overrides: Partial<ShareStatus> = {}, peer: Partial<ShareStatus["peers"][number]> = {}): ShareStatus {
  return {
    share: `${kind}:${PROJECT}`, projectId: PROJECT, kind, state: "idle", phase, maxSeq: 7, indexId: `idx-${kind}`, digest: HASH, rulesHash: HASH,
    liveFiles: 3, liveBytes: 30, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching", builtinSince: null,
    peers: [{ peer: PEER, cursor: 9, peerMaxSeq: 9, peerIndexId: "peer-idx", peerDigest: HASH, rulesMatch: true, caughtUp: true, differences: 0, cleanSince: "2026-10-24T23:59:00.000Z", route: "direct", builtinSince: null, ...peer }],
    ...overrides,
  };
}

/** The running engine as migration.ts sees it: shares derived from the phase, reports the test edits, op calls recorded. */
class FakeEngine {
  running_ = true;
  enabled_ = true;
  accept = true;
  calls: Array<{ op: OpName; args: unknown }> = [];
  /** The project's phase each accepted apply carried to the worker. */
  applied: Phase[] = [];
  tweak: Partial<Record<ShareKind, Partial<ShareStatus>>> = {};
  peerTweak: Partial<ShareStatus["peers"][number]> = {};
  /** Shares whose bootstrap answers "not-ready" this many more times. */
  notReady = new Map<string, number>();
  builtinSince = new Map<string, number>();
  nudged: string[] = [];
  /** Times a project came back to Syncthing here (fix: the engine may stop once it holds none). */
  left = 0;
  hook?: (op: OpName, args: unknown) => void;
  shadow = true;

  constructor(private readonly fixture: () => Fixture) {}

  private phase(): Phase { return phaseOf(this.fixture().db, PROJECT)?.phase ?? "syncthing"; }

  api(): MigrationDeps["engine"] {
    return {
      running: () => this.running_,
      enabled: () => this.enabled_,
      apply: async () => { if (this.accept) this.applied.push(this.phase()); return this.accept; },
      specs: (projectId) => this.specs(projectId),
      statuses: (projectId) => this.specs(projectId).map((spec) => this.report(spec.kind)),
      call: (async <K extends OpName>(op: K, args: OpArgs[K]) => {
        this.calls.push({ op, args });
        this.hook?.(op, args);
        const share = (args as { share?: string }).share ?? "";
        if (op === "scan") return { share, changed: 0, tombstones: 0, newGeneration: false, files: 3, hashedBytes: 0, durationMs: 1 };
        if (op === "status") return (args as OpArgs["status"]).shares!.map((key) => this.report(key.split(":")[0] as ShareKind));
        if (op === "bootstrap") {
          const left = this.notReady.get(share) ?? 0;
          if (left > 0) { this.notReady.set(share, left - 1); throw Object.assign(new Error(`File sync has not pulled the whole index of ${PEER} for ${share} yet`), { code: "not-ready" }); }
          this.builtinSince.set(share, 7);
          return { merged: 0, need: 0 };
        }
        throw new Error(`unexpected op ${op}`);
      }) as MigrationDeps["engine"]["call"],
      nudge: (peer) => { this.nudged.push(peer); },
      left: () => { this.left++; },
    };
  }

  specs(projectId: string): ShareSpec[] {
    if (projectId !== PROJECT || (this.phase() === "syncthing" && !this.shadow)) return [];
    const roots = this.fixture().roots;
    return SHARE_KINDS.map((kind) => ({ key: `${kind}:${PROJECT}`, projectId: PROJECT, kind, root: roots[kind], phase: this.phase(), rules: { ...EMPTY_RULE_SETTINGS }, peers: [PEER] }));
  }

  report(kind: ShareKind): ShareStatus {
    const since = this.builtinSince.get(`${kind}:${PROJECT}`);
    return status(kind, this.phase(), { ...this.tweak[kind], ...(since !== undefined ? { builtinSince: since } : {}) }, this.peerTweak);
  }

  ops(op: OpName): string[] { return this.calls.filter((call) => call.op === op).map((call) => (call.args as { share: string }).share); }
}

/** A peer's main server: /files/shares, /files/status and /files/changed answers the test edits. */
class FakePeer {
  requests: Array<{ peer: string; method: string; target: string; json?: unknown }> = [];
  silent = new Set<string>();
  shares: Record<string, unknown> = {};
  statusShares: Partial<Record<ShareKind, Record<string, unknown>>> = {};
  sharesStatus = 200;
  /** What its /files/switch answer adds: its phase and what would hold its release. */
  switchAnswer: Record<string, unknown> = {};
  switchStatus = 200;
  /** Record notices do not get through (the peer went away between the checks and the move). */
  failNotices = false;

  sharesAnswer(peer: string): unknown {
    return {
      fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: true }, nodeId: peer, hostId: "host-peer", origins: [],
      shares: SHARE_KINDS.map((kind) => ({ projectId: PROJECT, kind, indexId: "peer-idx", maxSeq: 9, digest: HASH, rulesHash: HASH, state: "idle", builtinSince: null, prunedBelow: 0, rootDev: null, rootIno: null })),
      engines: [], settings: [], ...this.shares,
    };
  }

  statusAnswer(): unknown {
    return { shares: SHARE_KINDS.map((kind) => ({ kind, state: "idle", cursor: 7, callerIndexId: `idx-${kind}`, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, digest: HASH, maxSeq: 9, ...this.statusShares[kind] })) };
  }

  request: MigrationDeps["peerRequest"] = async (peer, request) => {
    this.requests.push({ peer, ...request });
    if (this.silent.has(peer)) throw new Error("fetch failed");
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (request.target.endsWith("/shares")) return this.sharesStatus === 200 ? json(this.sharesAnswer(peer)) : json({ error: "no" }, this.sharesStatus);
    if (request.target.endsWith("/status")) return json(this.statusAnswer());
    if (request.target.endsWith("/changed")) { if (this.failNotices) throw new Error("fetch failed"); return json({}, 202); }
    if (request.target.endsWith("/switch")) {
      return this.switchStatus === 200 ? json({ projectId: (request.json as { projectId: string }).projectId, phase: "syncthing", error: null, blockers: [], ...this.switchAnswer }) : json({ error: "Not found" }, this.switchStatus);
    }
    return json({ error: "Not found" }, 404);
  };
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
    path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE cluster_v2_file_enrollments(peer_id TEXT NOT NULL,device_id TEXT NOT NULL,folder_id TEXT NOT NULL,project_id TEXT,PRIMARY KEY(peer_id,folder_id))`);
  ensureControlSchema(db);
  return db;
}

function addPeer(db: DatabaseSync, nodeId: string): void {
  if (!db.prepare("SELECT 1 FROM sharing_clusters WHERE id = ?").get(CLUSTER)) createSharingCluster(db, { id: CLUSTER, name: "home" }, LOCAL);
  addSharingMember(db, CLUSTER, LOCAL, nodeId, getSharingCluster(db, CLUSTER).managerEpoch);
  recordPeerEndpoint(db, { kind: "cluster", id: CLUSTER }, { nodeId, name: `node ${nodeId.slice(-1)}`, url: `https://${nodeId.slice(-4)}.example.com` });
  pinClusterPublicKey(db, nodeId, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
}

function addProject(db: DatabaseSync, id: string, root: string, syncFolderId: string | null = `joint-bob-${id}`): void {
  db.prepare("INSERT INTO projects (id, name, path, sync_folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, `Project ${id}`, root, syncFolderId, NOW, NOW);
  registerOwnedResource(db, { kind: "project", id, ownerNodeId: LOCAL }, LOCAL);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', ?, ?, 1, 0)").run(id, LOCAL);
  setResourceShares(db, LOCAL, "project", id, [{ clusterId: CLUSTER, projectId: null }]);
}

/** LOCAL owns "alpha", shared with PEER, on Syncthing with its three folders here; every check passes. */
async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-migration-"));
  const real = path.join(dir, "real-alpha");
  await mkdir(real, { recursive: true });
  // The project's root is a link: Syncthing's folder names the real path, and the release still finds it.
  await symlink(real, path.join(dir, "alpha"));
  const roots: Record<ShareKind, string> = { project: path.join(dir, "alpha"), tickets: path.join(dir, "tickets", PROJECT), worktrees: path.join(dir, "worktrees", PROJECT) };
  const db = database();
  addPeer(db, PEER);
  addProject(db, PROJECT, roots.project);
  const syncthing = new FakeSyncthing();
  syncthing.add(`joint-bob-${PROJECT}`, real, "Alpha");
  syncthing.add(projectTicketSyncFolderId(PROJECT), roots.tickets, "Alpha tickets");
  syncthing.add(projectWorktreeSyncFolderId(PROJECT), roots.worktrees, "Alpha worktrees");
  db.prepare("INSERT INTO cluster_v2_file_enrollments VALUES (?, 'DEVICE', ?, ?)").run(PEER, `joint-bob-${PROJECT}`, PROJECT);
  const clock = new FakeClock();
  const capability = new Map<string, PeerFileSync>();
  const peer = new FakePeer();
  const activity: { reason?: string } = {};
  const logs: string[] = [];
  const infos: string[] = [];
  const audits: Fixture["audits"] = [];
  const metrics: Fixture["metrics"] = [];
  let self: Fixture;
  const engine = new FakeEngine(() => self);
  const machines: Migration[] = [];
  self = {
    db, dir, roots, syncthing, clock, engine, capability, peer, activity, logs, infos, audits, metrics,
    deps: (overrides = {}) => ({
      db, nodeId: LOCAL, syncthing, engine: engine.api(), peerRequest: peer.request, capability: (id) => capability.get(id),
      activity: async () => activity.reason, roots: (id) => id === PROJECT ? roots : otherRoots(db, dir, id), log: (_key, message) => { logs.push(message); }, clock,
      retry: { minMs: 1_000, maxMs: 8_000 }, info: (message) => { infos.push(message); }, audit: (event) => { audits.push(event); },
      metric: (operation, durationMs) => { metrics.push({ operation, durationMs }); }, localName: () => "node 1", ...overrides,
    }),
    machine: (overrides = {}) => { const machine = new Migration(self.deps(overrides)); machines.push(machine); return machine; },
    cleanup: async () => { for (const machine of machines) machine.stop(); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
  return self;
}

/** Another project's roots in the fixture: its folder as the projects table has it, its tickets and worktrees beside alpha's. */
function otherRoots(db: DatabaseSync, dir: string, id: string): Record<ShareKind, string> | undefined {
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(id) as { path: string } | undefined;
  return row ? { project: row.path, tickets: path.join(dir, "tickets", id), worktrees: path.join(dir, "worktrees", id) } : undefined;
}

const failing = (answer: { checks: Array<{ key: string; ok: boolean }> }): string[] => answer.checks.filter((check) => !check.ok).map((check) => check.key);
const message = (answer: { checks: Array<{ key: string; message: string }> }, key: string): string => answer.checks.find((check) => check.key === key)?.message ?? "";

/** Requests the machine sends without waiting for them (a peer's report, the owner's asking) have had their answer. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));

async function settle(machine: Migration, clock?: FakeClock, rounds = 1): Promise<void> {
  await machine.idle();
  for (let round = 0; clock && round < rounds; round++) { clock.advance(10_000); await machine.idle(); }
}

/** The owner switched the project to builtin (generation 1). */
function switched(db: DatabaseSync, mode: "builtin" | "syncthing" = "builtin", generation = 1, origin = LOCAL): void {
  saveEngineRecord(db, { projectId: PROJECT, mode, generation, updatedAt: new Date(Date.parse(NOW) + generation).toISOString(), origin });
}

// ---- checks ----

test("with everything in order every check passes, and the clean-since time is information, not a check", async () => {
  const f = await fixture();
  try {
    const answer = await f.machine().checks(PROJECT);
    assert.equal(answer.engine, "builtin");
    assert.deepEqual(failing(answer), [], JSON.stringify(answer.checks));
    assert.deepEqual(answer.checks.map((check) => check.key), ["owner", "shared", "engine", "peers", "rules", "differences", "caughtUp", "folders", "syncthing", "activity"]);
    // Clean for one minute only: the plan's seven days are shown, never required (user decision).
    assert.equal(answer.cleanSince, "2026-10-24T23:59:00.000Z");
    assert.ok(!answer.checks.some((check) => /clean|days/i.test(check.key)));
    const asked = f.peer.requests.map((request) => `${request.method} ${request.target}`);
    assert.deepEqual(asked, ["GET /api/cluster/v2/files/shares", "POST /api/cluster/v2/files/status", "POST /api/cluster/v2/files/switch"]);
    assert.deepEqual(f.peer.requests[2].json, { projectId: PROJECT, blockers: true }, "the peer says what would hold its own release");
    assert.deepEqual((f.peer.requests[1].json as { shares: unknown[] }).shares, SHARE_KINDS.map((kind) => ({ kind, indexId: `idx-${kind}`, maxSeq: 7 })), "the peer pulls at once if it is behind");
  } finally { await f.cleanup(); }
});

test("each check fails alone with its own message", async () => {
  const cases: Array<{ key: string; expect: RegExp; set: (f: Fixture) => void | Promise<void> }> = [
    { key: "owner", expect: /^Only node 2, which owns this project, can move it$/, set: (f) => { f.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT); } },
    { key: "engine", expect: /^Turn on file sync on this machine first$/, set: (f) => { f.engine.enabled_ = false; } },
    { key: "engine", expect: /^File sync is still starting on this machine$/, set: (f) => { f.engine.running_ = false; } },
    { key: "peers", expect: /^node 2 has file sync turned off$/, set: (f) => { f.peer.shares = { fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, enabled: false } }; } },
    { key: "peers", expect: /^node 2 needs a newer Joint Bob$/, set: (f) => { f.peer.shares = { fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_PROTOCOL + 1, enabled: true } }; } },
    // fix (P4+P5): 2.157 and 2.158 run the engine (protocol 1) but never leave Syncthing for a switched project.
    { key: "peers", expect: /^node 2 needs a newer Joint Bob$/, set: (f) => { f.peer.shares = { fileSync: { protocol: 1, minProtocol: 1, enabled: true } }; } },
    // fix (P4+P5): what only the peer has: one of the user's own Syncthing folders inside the project there.
    { key: "folders", expect: /^On node 2: Syncthing folder “Photos” \(\/peer\/alpha\/photos\) is not Joint Bob's/, set: (f) => {
      f.peer.switchAnswer = { blockers: ["Syncthing folder “Photos” (/peer/alpha/photos) is not Joint Bob's and overlaps this project's files; Joint Bob leaves it alone, so remove it in Syncthing first"] };
    } },
    { key: "folders", expect: /^node 2 did not say what its Syncthing holds \(it needs a newer Joint Bob\)$/, set: (f) => { f.peer.switchStatus = 404; } },
    // fix (P4+P5): a shared project inside this one: both shares would write its files.
    { key: "folders", expect: /^Project “Project beta” \(.*nested\) lies inside this project's folders or around them; projects inside each other stay with Syncthing$/, set: async (f) => {
      await mkdir(path.join(f.dir, "real-alpha", "nested"));
      addProject(f.db, "beta", path.join(f.dir, "real-alpha", "nested"), null);
    } },
    { key: "rules", expect: /^node 2 skips different files in this project's worktrees \(its ignore rules differ\)$/, set: (f) => {
      f.peer.shares = { shares: SHARE_KINDS.map((kind) => ({ projectId: PROJECT, kind, indexId: "peer-idx", maxSeq: 9, digest: HASH, rulesHash: kind === "worktrees" ? "b".repeat(64) : HASH, state: "idle", builtinSince: null, prunedBelow: 0, rootDev: null, rootIno: null })) };
    } },
    { key: "differences", expect: /^3 files differ with node 2$/, set: (f) => { f.engine.tweak.tickets = { peers: [{ ...status("tickets", "syncthing").peers[0], differences: 3, cleanSince: null }] }; } },
    { key: "caughtUp", expect: /^node 2 has not seen this machine's latest changes yet$/, set: (f) => { f.peer.statusShares.project = { cursor: 6 }; } },
    { key: "caughtUp", expect: /^This machine has not seen node 2's latest changes yet$/, set: (f) => { f.peer.statusShares.tickets = { maxSeq: 12 }; } },
    { key: "syncthing", expect: /^Syncthing is still copying files in Alpha tickets$/, set: (f) => { f.syncthing.states[projectTicketSyncFolderId(PROJECT)] = "syncing"; } },
    { key: "syncthing", expect: /^Syncthing has not finished copying this project to node 2$/, set: (f) => { f.syncthing.peerCaughtUpAnswer = false; } },
    { key: "folders", expect: /^Syncthing folder “Videos” .* is not Joint Bob's and overlaps this project's files/, set: async (f) => {
      await mkdir(path.join(f.dir, "real-alpha", "videos"));
      f.syncthing.add("video-translator", path.join(f.dir, "real-alpha", "videos"), "Videos");
    } },
    { key: "activity", expect: /^A task is running in this project; wait for it to finish$/, set: (f) => { f.activity.reason = "A task is running in this project; wait for it to finish"; } },
  ];
  for (const entry of cases) {
    const f = await fixture();
    try {
      await entry.set(f);
      const answer = await f.machine().checks(PROJECT, "builtin");
      assert.deepEqual(failing(answer), [entry.key], `${entry.key}: ${JSON.stringify(answer.checks)}`);
      assert.match(message(answer, entry.key), entry.expect);
    } finally { await f.cleanup(); }
  }
});

test("a project shared with nobody, a silent peer and a silent Syncthing each fail the checks that need them", async () => {
  let f = await fixture();
  try {
    setResourceShares(f.db, LOCAL, "project", PROJECT, []);
    const answer = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(answer), ["shared"]);
    assert.equal(message(answer, "shared"), "This project is not shared with another machine");
  } finally { await f.cleanup(); }
  f = await fixture();
  try {
    f.peer.silent.add(PEER);
    const answer = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(answer), ["peers", "caughtUp"]);
    assert.match(message(answer, "peers"), /^node 2 did not answer \(fetch failed\)$/);
  } finally { await f.cleanup(); }
  f = await fixture();
  try {
    f.syncthing.answering = false;
    const answer = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(answer), ["syncthing"]);
    assert.match(message(answer, "syncthing"), /^Syncthing did not answer on this machine/);
  } finally { await f.cleanup(); }
});

test("moving back needs only the owner and a running engine, never matching files or machines that answer", async () => {
  const f = await fixture();
  try {
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin");
    f.engine.tweak.project = { peers: [{ ...status("project", "builtin").peers[0], differences: 40, cleanSince: null }] };
    f.syncthing.answering = false;
    f.activity.reason = "A task is running in this project; wait for it to finish";
    const machine = f.machine();
    const answer = await machine.checks(PROJECT);
    assert.equal(answer.engine, "syncthing", "the default target is the other engine");
    assert.deepEqual(answer.checks.map((check) => [check.key, check.ok]), [["owner", true], ["shared", true], ["engine", true], ["reachable", true]]);
    // fix: a machine away (Matan's closed laptop) does not hold the move back: it follows once it is in touch again.
    f.peer.silent.add(PEER);
    const silent = await machine.checks(PROJECT, "syncthing");
    assert.deepEqual(failing(silent), []);
    assert.equal(message(silent, "reachable"), "node 2 did not answer, so it moves back once in touch with this machine again");
    f.peer.failNotices = true;
    await machine.switchEngine(PROJECT, "syncthing", { by: "ilia" });
    assert.equal(engineModeOf(f.db, PROJECT), "syncthing");
    f.peer.silent.clear();
    f.peer.failNotices = false;
    const notices = noticesOf(f.peer).length;
    machine.peerContact(PEER);
    await delivered();
    assert.equal(noticesOf(f.peer).length, notices + 1, "told at its next contact");
  } finally { await f.cleanup(); }
});

// ---- the owner's switch and its records ----

test("only the owner switches; a refused switch writes nothing and says why", async () => {
  const f = await fixture();
  try {
    f.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    const machine = f.machine();
    await assert.rejects(machine.switchEngine(PROJECT, "builtin"), (error: unknown) => {
      assert.ok(error instanceof EngineSwitchRefused);
      assert.deepEqual(error.checks.filter((check) => !check.ok).map((check) => check.key), ["owner"]);
      assert.match(error.message, /Only node 2/);
      return true;
    });
    assert.equal(engineRecordOf(f.db, PROJECT), undefined);
    assert.ok(!f.peer.requests.some((request) => request.target.endsWith("/changed")), "nobody is told of a switch that did not happen");
  } finally { await f.cleanup(); }
});

test("the switch records generation + 1 and tells every peer; an older record never flips it back", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    const project = await machine.switchEngine(PROJECT, "builtin");
    assert.equal(project.engine, "builtin");
    assert.deepEqual({ ...engineRecordOf(f.db, PROJECT), updatedAt: undefined }, { projectId: PROJECT, mode: "builtin", generation: 1, updatedAt: undefined, origin: LOCAL });
    const notices = f.peer.requests.filter((request) => request.target.endsWith("/changed"));
    assert.deepEqual(notices.map((request) => [request.peer, request.method, request.json]), [[PEER, "POST", { shares: [], records: true }]]);
    f.clock.at += 1_000;
    f.peer.requests.length = 0;
    await machine.switchEngine(PROJECT, "syncthing");
    const back = engineRecordOf(f.db, PROJECT)!;
    assert.deepEqual([back.mode, back.generation], ["syncthing", 2]);
    assert.ok(back.updatedAt > NOW);
    // A record from before (a peer's stale copy, a replay) loses to the newer generation.
    assert.equal(saveEngineRecord(f.db, { projectId: PROJECT, mode: "builtin", generation: 1, updatedAt: "2026-10-26T00:00:00.000Z", origin: LOCAL }), false);
    assert.equal(engineModeOf(f.db, PROJECT), "syncthing");
    // And nobody else may speak for this node's project.
    const outcome = acceptRecords(f.db, LOCAL, { fromPeer: PEER, engines: [{ projectId: PROJECT, mode: "builtin", generation: 9, updatedAt: NOW, origin: PEER }], settings: [] }, { now: Date.parse(NOW) });
    assert.deepEqual(outcome.rejected, [{ record: `engine:${PROJECT}`, reason: "this node owns the project" }]);
    assert.equal(engineModeOf(f.db, PROJECT), "syncthing");
  } finally { await f.cleanup(); }
});

test("a non-owner takes the owner's records in generation order only", async () => {
  const db = database();
  try {
    addPeer(db, PEER);
    db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(PROJECT, "Alpha", "/x/alpha", NOW, NOW);
    registerOwnedResource(db, { kind: "project", id: PROJECT, ownerNodeId: PEER }, LOCAL);
    const record = (mode: "builtin" | "syncthing", generation: number) => ({ projectId: PROJECT, mode, generation, updatedAt: new Date(Date.parse(NOW) + generation).toISOString(), origin: PEER });
    const accept = (value: ReturnType<typeof record>, fromPeer = PEER) => acceptRecords(db, LOCAL, { fromPeer, engines: [value], settings: [] }, { now: Date.parse(NOW) });
    assert.equal(accept(record("builtin", 3)).engines, 1);
    assert.equal(accept(record("syncthing", 2)).engines, 0, "an older generation is ignored");
    assert.equal(engineModeOf(db, PROJECT), "builtin");
    assert.equal(accept(record("syncthing", 4), THIRD).engines, 0, "only from the owner");
    assert.equal(accept(record("syncthing", 4)).engines, 1);
    assert.equal(engineModeOf(db, PROJECT), "syncthing");
  } finally { db.close(); }
});

// ---- the phase machine ----

test("a switched project walks releasing, bootstrapping and builtin: Syncthing lets go first, each folder is scanned and bootstrapped once", async () => {
  const f = await fixture();
  try {
    // Leftovers of a Syncthing download cut short go; files that only look alike stay; ignored folders are not walked.
    await writeFile(path.join(f.dir, "real-alpha", ".syncthing.notes.md.tmp"), "partial");
    await writeFile(path.join(f.dir, "real-alpha", "~syncthing~draft.txt.tmp"), "partial");
    await writeFile(path.join(f.dir, "real-alpha", "keep.tmp"), "mine");
    await writeFile(path.join(f.dir, "real-alpha", ".syncthing.notes.md"), "mine");
    await mkdir(path.join(f.dir, "real-alpha", "node_modules"));
    await writeFile(path.join(f.dir, "real-alpha", "node_modules", ".syncthing.x.tmp"), "ignored tree");
    // The old shared ticket folder (paused, as Joint Bob keeps it) covers the project's tickets: not the project's, so it stays.
    f.syncthing.add("joint-bob-ticket-workspaces", path.join(f.dir, "tickets"), "Joint Bob ticket workspaces");
    f.syncthing.folders_.at(-1)!.paused = true;
    f.syncthing.add("video-translator", path.join(f.dir, "videos"), "Videos");
    f.syncthing.add("dot-codex", path.join(f.dir, "real-alpha-other"), "Prefix sibling");
    const machine = f.machine();
    await machine.switchEngine(PROJECT, "builtin");
    await settle(machine);
    const held = phaseOf(f.db, PROJECT)!;
    assert.equal(held.phase, "builtin", JSON.stringify({ held, logs: f.logs, message: machine.project(PROJECT).phaseMessage }));
    assert.deepEqual(held.builtinSince, { project: 7, tickets: 7, worktrees: 7 });
    assert.deepEqual(f.syncthing.ids(), ["dot-codex", "joint-bob-ticket-workspaces", "video-translator"], "the user's folders, one that only shares a prefix, and the paused old ticket folder stay");
    assert.deepEqual(f.syncthing.removed.sort(), [`joint-bob-${PROJECT}`, projectTicketSyncFolderId(PROJECT), projectWorktreeSyncFolderId(PROJECT)].sort());
    assert.equal(f.db.prepare("SELECT count(*) count FROM cluster_v2_file_enrollments WHERE project_id = ?").get(PROJECT)!.count, 0);
    assert.deepEqual(f.engine.ops("scan"), SHARE_KINDS.map((kind) => `${kind}:${PROJECT}`));
    assert.ok(f.engine.calls.filter((call) => call.op === "scan").every((call) => (call.args as OpArgs["scan"]).scope === "full"));
    assert.deepEqual(f.engine.ops("bootstrap"), SHARE_KINDS.map((kind) => `${kind}:${PROJECT}`), "bootstrap once per folder");
    // The worker saw the shadow phases before builtin, and builtin only after every folder was decided.
    assert.deepEqual([...new Set(f.engine.applied)], ["syncthing", "releasing", "bootstrapping", "builtin"]);
    assert.deepEqual((await readdir(path.join(f.dir, "real-alpha"))).sort(), [".syncthing.notes.md", "keep.tmp", "node_modules"]);
    assert.equal(existsSync(path.join(f.dir, "real-alpha", "node_modules", ".syncthing.x.tmp")), true);
    assert.equal(machine.project(PROJECT).phaseMessage, null);
  } finally { await f.cleanup(); }
});

test("the bootstrap gets each peer's builtin_since and waits, without scanning again, until the peers' lists are whole", async () => {
  const f = await fixture();
  try {
    switched(f.db);
    f.engine.peerTweak = { builtinSince: 4 };
    f.engine.notReady.set(`tickets:${PROJECT}`, 1);
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "bootstrapping");
    assert.deepEqual(phaseOf(f.db, PROJECT)!.builtinSince, { project: 7 }, "the folder done before the wait is not done again");
    assert.deepEqual(f.engine.nudged, [PEER], "the pulls are asked for");
    assert.match(machine.project(PROJECT).phaseMessage ?? "", /^Checking both machines' files/);
    // The peer's list arrived: its report lets the switch go on at once.
    machine.shareChanged(f.engine.report("tickets"));
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.engine.ops("scan"), SHARE_KINDS.map((kind) => `${kind}:${PROJECT}`), "one full scan per folder");
    assert.deepEqual(f.engine.ops("bootstrap"), [`project:${PROJECT}`, `tickets:${PROJECT}`, `tickets:${PROJECT}`, `worktrees:${PROJECT}`]);
    for (const call of f.engine.calls.filter((entry) => entry.op === "bootstrap")) assert.deepEqual((call.args as OpArgs["bootstrap"]).builtinSinceByPeer, { [PEER]: 4 });
  } finally { await f.cleanup(); }
});

test("a node that stops at any step resumes there and finishes, bootstrapping each folder once", async () => {
  const crashes: Array<{ name: string; arm: (f: Fixture, crash: () => never) => void }> = [
    { name: "before Syncthing was asked", arm: (f, crash) => { f.syncthing.hook = (call) => { if (call === "folders") crash(); }; } },
    { name: "after one folder was removed", arm: (f, crash) => { f.syncthing.hook = (call) => { if (call.startsWith("remove ") && f.syncthing.removed.length === 1) crash(); }; } },
    { name: "before the fresh list", arm: (f, crash) => { let lists = 0; f.syncthing.hook = (call) => { if (call === "folders" && ++lists === 2) crash(); }; } },
    { name: "during the scan of the second folder", arm: (f, crash) => { f.engine.hook = (op, args) => { if (op === "scan" && (args as { share: string }).share.startsWith("tickets")) crash(); }; } },
    { name: "between two bootstraps", arm: (f, crash) => { f.engine.hook = (op, args) => { if (op === "bootstrap" && (args as { share: string }).share.startsWith("worktrees")) crash(); }; } },
  ];
  for (const { name, arm } of crashes) {
    const f = await fixture();
    try {
      switched(f.db);
      const first = f.machine();
      let crashed = false;
      arm(f, () => { if (!crashed) { crashed = true; first.stop(); } throw new Error("node stopped"); });
      first.kick();
      await first.idle();
      assert.ok(crashed, name);
      assert.notEqual(phaseOf(f.db, PROJECT)?.phase ?? "syncthing", "builtin", `${name}: not builtin after a crash`);
      f.syncthing.hook = undefined;
      f.engine.hook = undefined;
      const second = f.machine();
      second.kick();
      await settle(second);
      assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin", `${name}: ${f.logs.join(" | ")}`);
      assert.deepEqual(f.syncthing.ids(), [], name);
      const bootstraps = f.engine.ops("bootstrap");
      assert.deepEqual([...new Set(bootstraps)].sort(), SHARE_KINDS.map((kind) => `${kind}:${PROJECT}`).sort(), name);
      // A folder whose bootstrap finished before the crash is not decided again.
      assert.equal(bootstraps.filter((share) => share.startsWith("project")).length, 1, name);
    } finally { await f.cleanup(); }
  }
});

test("release waits while Syncthing does not answer or does not let go, and never touches a folder that is not Joint Bob's", async () => {
  const f = await fixture();
  try {
    switched(f.db);
    f.syncthing.answering = false;
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.match(machine.project(PROJECT).phaseMessage ?? "", /^Waiting for Syncthing to let go of this project's folders/);
    assert.deepEqual(f.syncthing.removed, []);
    // Answering again, but holding on to the worktree folder.
    f.syncthing.answering = true;
    f.syncthing.stuck.add(projectWorktreeSyncFolderId(PROJECT));
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing", "not verified gone: no bootstrap");
    assert.equal(machine.project(PROJECT).phaseMessage, "Waiting for Syncthing to let go of Alpha worktrees");
    assert.deepEqual(f.engine.ops("bootstrap"), []);
    // A folder of the user's own inside the project: left alone, and the switch says why.
    f.syncthing.stuck.clear();
    await mkdir(path.join(f.dir, "real-alpha", "photos"));
    f.syncthing.add("photos", path.join(f.dir, "real-alpha", "photos"), "Photos");
    f.clock.advance(2_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.match(phaseOf(f.db, PROJECT)!.error ?? "", /“Photos” .* is not Joint Bob's/);
    assert.ok(!f.syncthing.removed.includes("photos"));
    // Removed by the user in Syncthing: the switch goes on at its next try.
    f.syncthing.folders_ = f.syncthing.folders_.filter((folder) => folder.id !== "photos");
    f.clock.advance(4_000);
    await settle(machine, f.clock, 2);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(phaseOf(f.db, PROJECT)!.error, null);
  } finally { await f.cleanup(); }
});

test("another project's folder over the roots blocks the switch while that project is still on Syncthing", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.dir, "real-alpha", "nested"));
    addProject(f.db, "beta", path.join(f.dir, "real-alpha", "nested"), "joint-bob-beta");
    f.syncthing.add("joint-bob-beta", path.join(f.dir, "real-alpha", "nested"), "Beta");
    const checks = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), ["folders"]);
    assert.match(message(checks, "folders"), /Syncthing syncs “Project beta” in .*, which overlaps this project's files; projects inside each other stay with Syncthing/);
    assert.match(message(checks, "folders"), /Project “Project beta” .* lies inside this project's folders or around them/);
    switched(f.db);
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.ok(f.syncthing.ids().includes("joint-bob-beta"), "beta keeps its folder");
  } finally { await f.cleanup(); }
});

test("only the project's own folders leave Syncthing: an old shared Joint Bob folder over the roots stays, paused by the release itself", async () => {
  const f = await fixture();
  try {
    // Older releases synced every project's tickets through one folder; Joint Bob keeps it paused now.
    f.syncthing.add("joint-bob-ticket-workspaces", path.dirname(f.roots.tickets), "Joint Bob ticket workspaces");
    const legacy = f.syncthing.folders_.find((folder) => folder.id === "joint-bob-ticket-workspaces")!;
    legacy.paused = false;
    // auto-transition: resumed by someone, it holds nothing up: the release pauses it right then (it no longer waits for a sharing pass).
    let checks = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), [], JSON.stringify(checks.checks));
    assert.deepEqual(f.syncthing.paused, [], "asking pauses nothing");
    // Where nothing can pause it, it blocks and says what to do.
    const noPause: MigrationSyncthing = { folders: () => f.syncthing.folders(), removeFolder: (id) => f.syncthing.removeFolder(id), folderStatuses: (ids) => f.syncthing.folderStatuses(ids), peerCaughtUp: () => f.syncthing.peerCaughtUp() };
    checks = await f.machine({ syncthing: noPause }).checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), ["folders"]);
    assert.match(message(checks, "folders"), /old shared folder “Joint Bob ticket workspaces” .* is not paused in Syncthing and overlaps this project's files; pause it in Syncthing first/);
    legacy.paused = true;
    checks = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), []);
    // fix: the person's ~/.claude (or ~/.pi) folder is not one Joint Bob keeps paused: it blocks, named, and the release never pauses it.
    await mkdir(path.join(f.dir, "real-alpha", ".claude"));
    f.syncthing.add("dot-claude", path.join(f.dir, "real-alpha", ".claude"), "Claude settings");
    checks = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), ["folders"]);
    assert.match(message(checks, "folders"), /old shared folder “Claude settings” .* is not paused in Syncthing and overlaps this project's files; pause it in Syncthing first/);
    f.syncthing.folders_ = f.syncthing.folders_.filter((folder) => folder.id !== "dot-claude");
    // A nested project already on built-in sync here whose folder Syncthing holds again: not this switch's to remove.
    await mkdir(path.join(f.dir, "real-alpha", "nested"));
    addProject(f.db, "beta", path.join(f.dir, "real-alpha", "nested"), "joint-bob-beta");
    setPhase(f.db, "beta", "builtin");
    f.syncthing.add("joint-bob-beta", path.join(f.dir, "real-alpha", "nested"), "Beta");
    checks = await f.machine().checks(PROJECT, "builtin");
    assert.deepEqual(failing(checks), ["folders"]);
    assert.match(message(checks, "folders"), /syncs “Project beta” in .* again/);
    f.syncthing.folders_ = f.syncthing.folders_.filter((folder) => folder.id !== "joint-bob-beta");
    switched(f.db);
    // Its owner moved beta too (without a record the machine would take it back to Syncthing).
    saveEngineRecord(f.db, { projectId: "beta", mode: "builtin", generation: 1, updatedAt: NOW, origin: LOCAL });
    const machine = f.machine();
    machine.kick();
    await settle(machine, f.clock, 2);
    // beta stops writing too: alpha's Syncthing folder covers it until alpha lets go, which beta in turn holds up.
    assert.equal(phaseOf(f.db, "beta")!.phase, "releasing");
    // fix (P4+P5): beta, inside alpha, is on built-in sync here: alpha's share would write beta's files too.
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.match(phaseOf(f.db, PROJECT)!.error ?? "", /^Project “Project beta” .* lies inside this project's folders or around them, and built-in sync moves it on this machine/);
    assert.deepEqual(f.syncthing.removed, [], "nothing is released while it holds");
    for (const table of ["projects", "file_sync_phases", "file_sync_engines"]) f.db.prepare(`DELETE FROM ${table} WHERE ${table === "projects" ? "id" : "project_id"} = 'beta'`).run();
    f.clock.advance(1_000);
    await settle(machine, f.clock, 2);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.syncthing.removed.sort(), [`joint-bob-${PROJECT}`, projectTicketSyncFolderId(PROJECT), projectWorktreeSyncFolderId(PROJECT)].sort());
    assert.deepEqual(f.syncthing.ids(), ["joint-bob-ticket-workspaces"], "the paused old folder is left as it was");
  } finally { await f.cleanup(); }
});

test("a built-in project whose folder Syncthing holds again at start goes back to releasing", async () => {
  const f = await fixture();
  try {
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    // The fixture's folders are still configured: the engine stops writing, Syncthing is asked to let go, then the switch runs again.
    assert.ok(f.engine.applied.includes("releasing"));
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(f.syncthing.ids(), []);
    assert.equal(f.engine.ops("bootstrap").length, 3, "decided again: Syncthing may have written meanwhile");
    assert.match(f.logs.join("\n"), /Syncthing syncs Alpha again/);
  } finally { await f.cleanup(); }
});

// fix (P4+P5): the check is owed until a folder list was read, and is owed again when the roots move or Syncthing changes.
test("a built-in project is checked again when Syncthing answers late, when its roots move and when this node is pointed at another Syncthing", async () => {
  const f = await fixture();
  try {
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    // Syncthing comes up after the engine: its configuration still holds the three folders over the roots.
    f.syncthing.answering = false;
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(machine.project(PROJECT).phaseMessage, WRITES_WAIT_FOR_SYNCTHING);
    assert.equal(machine.writesAllowed(PROJECT), false, "the worker does not write until Syncthing answered");
    assert.equal(f.engine.ops("bootstrap").length, 0);
    f.syncthing.answering = true;
    f.clock.advance(1_000);
    await settle(machine, f.clock, 2);
    assert.match(f.logs.join("\n"), /Syncthing syncs Alpha again, over Project alpha/);
    assert.deepEqual(f.syncthing.ids(), [], "let go of once it answered");
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(f.engine.ops("bootstrap").length, 3, "decided again: Syncthing may have written meanwhile");
    // The project's folder moves under a folder of the user's own: built-in sync stops writing there and says why.
    const moved = path.join(f.dir, "sync", "alpha");
    await mkdir(moved, { recursive: true });
    f.syncthing.add("user-sync", path.join(f.dir, "sync"), "Sync");
    f.roots.project = moved;
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.match(phaseOf(f.db, PROJECT)!.error ?? "", /^Syncthing folder “Sync” .* is not Joint Bob's/);
    assert.ok(!f.syncthing.removed.includes("user-sync"));
    // Back where it was, and settled again.
    f.roots.project = path.join(f.dir, "alpha");
    f.clock.advance(10_000);
    await settle(machine, f.clock, 2);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    // A folder added while nothing changed here is not looked for on every step, but pointing this node at another Syncthing is.
    f.syncthing.add(`joint-bob-${PROJECT}`, path.join(f.dir, "real-alpha"), "Alpha");
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    const logged = f.logs.filter((line) => /Syncthing syncs Alpha again/.test(line)).length;
    f.syncthing.gen += 1;
    machine.kick();
    await settle(machine, f.clock, 2);
    assert.equal(f.logs.filter((line) => /Syncthing syncs Alpha again/.test(line)).length, logged + 1);
    assert.deepEqual(f.syncthing.ids(), ["user-sync"]);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
  } finally { await f.cleanup(); }
});

// fix (P4+P5): a peer's own Syncthing can hold its release; it says so before the switch, and where its move stands after it.
test("a peer says what would hold its release, and tells the owner where its own move stands", async () => {
  // The peer's side: PEER owns the project; this node holds one of the user's own folders inside it.
  const f = await fixture();
  try {
    f.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    f.db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    await mkdir(path.join(f.dir, "real-alpha", "photos"));
    f.syncthing.add("photos", path.join(f.dir, "real-alpha", "photos"), "Photos");
    const machine = f.machine();
    const answer = await machine.answerSwitch(PEER, { projectId: PROJECT, blockers: true });
    assert.equal(answer?.phase, "syncthing");
    assert.equal(answer?.blockers?.length, 1);
    assert.match(answer!.blockers![0], /^Syncthing folder “Photos” .* is not Joint Bob's and overlaps this project's files/);
    assert.deepEqual(f.syncthing.removed, [], "asking removes nothing");
    assert.equal(await machine.answerSwitch(THIRD, { projectId: PROJECT, blockers: true }), undefined, "only a machine the project is shared with is answered");
    f.syncthing.answering = false;
    assert.match((await machine.answerSwitch(PEER, { projectId: PROJECT, blockers: true }))!.blockers!.join(), /^Syncthing did not answer there/);
    f.syncthing.answering = true;
    // No address and key for the Syncthing that holds the project's folders here: worded for the owner's screen ("On <this machine>: …").
    f.syncthing.configured = false;
    assert.match((await machine.answerSwitch(PEER, { projectId: PROJECT, blockers: true }))!.blockers!.join(), /^Joint Bob cannot reach the Syncthing there .* set JOINT_BOB_SYNCTHING_URL and JOINT_BOB_SYNCTHING_API_KEY there/);
    f.syncthing.configured = true;
    // The owner moved it anyway (an older check, say): this node stays in releasing, and the owner hears why.
    switched(f.db, "builtin", 1, PEER);
    machine.kick();
    await machine.idle();
    await delivered();
    const reports = () => f.peer.requests.filter((request) => request.target.endsWith("/switch")).map((request) => request.json as { projectId: string; report: { phase: string; error: string | null } });
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.deepEqual(reports().map((report) => [report.projectId, report.report.phase]), [[PROJECT, "releasing"]]);
    assert.match(reports()[0].report.error ?? "", /“Photos”/);
    // The same state is not said twice; the user removes the folder and the end of the move is said once.
    machine.kick();
    await machine.idle();
    assert.equal(reports().length, 1);
    f.syncthing.folders_ = f.syncthing.folders_.filter((folder) => folder.id !== "photos");
    f.clock.advance(1_000);
    await settle(machine, f.clock, 2);
    await delivered();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(reports().at(-1)!.report, { phase: "builtin", error: null });
  } finally { await f.cleanup(); }

  // The owner's side: it keeps what each peer says and lists it; once per start it asks.
  const g = await fixture();
  try {
    g.syncthing.folders_ = [];
    switched(g.db);
    setPhase(g.db, PROJECT, "builtin");
    g.peer.switchAnswer = { phase: "releasing", error: "Syncthing folder “Photos” (/peer/alpha/photos) is not Joint Bob's" };
    const machine = g.machine();
    machine.kick();
    await machine.idle();
    await delivered();
    assert.deepEqual(g.peer.requests.filter((request) => request.target.endsWith("/switch")).map((request) => request.json), [{ projectId: PROJECT }]);
    assert.deepEqual(machine.project(PROJECT).peers, [{ peer: PEER, name: "node 2", phase: "releasing", error: "Syncthing folder “Photos” (/peer/alpha/photos) is not Joint Bob's" }]);
    assert.ok((await machine.answerSwitch(PEER, { projectId: PROJECT, report: { phase: "builtin", error: null } }))?.phase === "builtin");
    assert.deepEqual(machine.project(PROJECT).peers, [{ peer: PEER, name: "node 2", phase: "builtin", error: null }]);
    assert.equal(await machine.answerSwitch(THIRD, { projectId: PROJECT, report: { phase: "releasing", error: "x" } }), undefined);
    assert.deepEqual(machine.project(PROJECT).peers.map((peer) => peer.peer), [PEER], "a machine the project is not shared with is not listed");
    machine.kick();
    await machine.idle();
    assert.equal(g.peer.requests.filter((request) => request.target.endsWith("/switch")).length, 1, "asked once per start");
  } finally { await g.cleanup(); }
});

// fix (P4+P5): 2.157 and 2.158 run the engine but have no switch: a peer on one would stay on Syncthing and receive nothing.
test("a built-in project gaining a peer too old for the switch moves back on its own", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin");
    f.capability.set(PEER, { protocol: 1, minProtocol: 1, enabled: true, origins: [], via: "hello", at: 0 });
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.deepEqual([engineModeOf(f.db, PROJECT), phaseOf(f.db, PROJECT)!.phase], ["syncthing", "syncthing"]);
    assert.match(f.logs.join("\n"), /File sync moved Project alpha back to Syncthing: node 2 needs a newer Joint Bob to receive this project's files with built-in sync/);
    // Its answers say the same: the switch is refused until it runs a newer Joint Bob.
    f.peer.shares = { fileSync: { protocol: 1, minProtocol: 1, enabled: true } };
    await assert.rejects(machine.switchEngine(PROJECT, "builtin"), (error: unknown) => error instanceof EngineSwitchRefused && /node 2 needs a newer Joint Bob/.test(error.message));
  } finally { await f.cleanup(); }
});

test("a project that built-in sync moves here may not move under a Syncthing folder", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    await mkdir(path.join(f.dir, "sync"));
    f.syncthing.add("user-sync", path.join(f.dir, "sync"), "Sync");
    f.syncthing.add("joint-bob-ticket-workspaces", path.join(f.dir, "old-tickets"), "Joint Bob ticket workspaces");
    f.syncthing.folders_.at(-1)!.paused = true;
    assert.equal(await syncthingFolderOverTarget(f.db, PROJECT, path.join(f.dir, "sync", "alpha"), f.syncthing), undefined, "on Syncthing, Syncthing moves it there");
    setPhase(f.db, PROJECT, "builtin");
    assert.match(await syncthingFolderOverTarget(f.db, PROJECT, path.join(f.dir, "sync", "alpha"), f.syncthing) ?? "", /^Syncthing syncs “Sync” .* there, and built-in sync moves this project's files/);
    assert.equal(await syncthingFolderOverTarget(f.db, PROJECT, path.join(f.dir, "elsewhere", "alpha"), f.syncthing), undefined);
    assert.equal(await syncthingFolderOverTarget(f.db, PROJECT, path.join(f.dir, "old-tickets", "alpha"), f.syncthing), undefined, "a paused old Joint Bob folder never writes");
    f.syncthing.answering = false;
    assert.equal(await syncthingFolderOverTarget(f.db, PROJECT, path.join(f.dir, "sync", "alpha"), f.syncthing), undefined, "the switch checks the new roots itself once they moved");
  } finally { await f.cleanup(); }
});

// ---- moving back ----

test("moving back stops the worker writing before Syncthing may take the folders again", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(projectFilesOnSyncthing(f.db, PROJECT), false);
    assert.equal(await whileFilesOnSyncthing(PROJECT, async () => "enrolled", f.db), undefined, "no folder while on built-in sync");
    f.engine.applied.length = 0;
    // The worker has not taken the restoring state yet: Syncthing must wait.
    f.engine.accept = false;
    f.clock.at += 1_000;
    await machine.switchEngine(PROJECT, "syncthing");
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "restoring");
    assert.equal(machine.project(PROJECT).phaseMessage, "Moving back to Syncthing");
    assert.equal(projectFilesOnSyncthing(f.db, PROJECT), false);
    f.engine.accept = true;
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "syncthing");
    assert.deepEqual(phaseOf(f.db, PROJECT)!.builtinSince, {}, "a later switch bootstraps every folder again");
    assert.deepEqual(f.engine.applied.filter((phase, index, all) => phase !== all[index - 1]), ["restoring", "syncthing"], "the worker left builtin before the folders came back");
    assert.deepEqual(f.peer.requests.filter((request) => request.target.endsWith("/changed")).map((request) => request.peer), [PEER], "told once the worker serves the record");
    assert.equal(await whileFilesOnSyncthing(PROJECT, async () => "enrolled", f.db), "enrolled", "enrollment adds the folders again");
  } finally { await f.cleanup(); }
});

test("a node stopped while moving back resumes there and hands the folders back to Syncthing", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db, "syncthing", 2);
    setPhase(f.db, PROJECT, "restoring", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    // The worker never took the restoring state before the node stopped.
    f.engine.accept = false;
    const first = f.machine();
    first.kick();
    await first.idle();
    first.stop();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "restoring");
    assert.equal(projectFilesOnSyncthing(f.db, PROJECT), false);
    f.engine.accept = true;
    const second = f.machine();
    second.kick();
    await second.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "syncthing");
    assert.deepEqual(f.engine.applied, ["restoring", "syncthing"]);
  } finally { await f.cleanup(); }
});

test("a peer that cannot take files from the engine moves a built-in project back; a non-owner only reports it", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin");
    const machine = f.machine();
    // Not heard from yet (every peer at start): no move.
    machine.kick();
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
    f.capability.set(PEER, { protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, enabled: true, origins: [], via: "hello", at: 0 });
    machine.kick();
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
    // integrate: a hello that leaves the switch out (the peer could not read its own settings) is unknown, not off.
    f.capability.set(PEER, { protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, origins: [], via: "hello", at: 0 });
    machine.kick();
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "builtin", "an unknown switch moves nothing back");
    // A third machine joins with an old Joint Bob.
    addPeer(f.db, THIRD);
    f.capability.set(THIRD, { protocol: 0, origins: [], via: "answer", at: 0 });
    machine.kick();
    await machine.idle();
    const record = engineRecordOf(f.db, PROJECT)!;
    assert.deepEqual([record.mode, record.generation, record.origin], ["syncthing", 2, LOCAL]);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "syncthing");
    assert.match(f.logs.join("\n"), /File sync moved Project alpha back to Syncthing: node 3 runs a Joint Bob without built-in file sync/);
    assert.deepEqual(f.peer.requests.filter((request) => request.target.endsWith("/changed")).map((request) => request.peer).sort(), [PEER, THIRD]);
  } finally { await f.cleanup(); }

  const g = await fixture();
  try {
    g.syncthing.folders_ = [];
    addPeer(g.db, THIRD);
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    switched(g.db, "builtin", 1, PEER);
    setPhase(g.db, PROJECT, "builtin");
    g.capability.set(THIRD, { protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, enabled: false, origins: [], via: "hello", at: 0 });
    const machine = g.machine();
    machine.kick();
    await machine.idle();
    assert.equal(engineModeOf(g.db, PROJECT), "builtin", "only the owner moves it");
    assert.equal(phaseOf(g.db, PROJECT)!.phase, "builtin");
    assert.equal(phaseOf(g.db, PROJECT)!.error, "node 3 has file sync turned off, so it cannot receive this project's files");
    g.capability.set(THIRD, { protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, enabled: true, origins: [], via: "hello", at: 0 });
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(g.db, PROJECT)!.error, null, "cleared once the peer can take files");
  } finally { await g.cleanup(); }
});

test("the listing shows every shared project with its engine, phase and differences", async () => {
  const f = await fixture();
  try {
    db_addUnshared(f.db, path.join(f.dir, "solo"));
    f.engine.tweak.project = { peers: [{ ...status("project", "syncthing").peers[0], differences: 2, cleanSince: null }] };
    const listed = f.machine().projects();
    assert.deepEqual(listed, [{
      projectId: PROJECT, name: "Project alpha", owner: true, engine: "syncthing", phase: "syncthing", phaseMessage: null, phaseError: null,
      cleanSince: null, differences: 2, shares: ["project", "tickets", "worktrees"], waiting: false, peers: [],
      autoSwitch: { state: "blocked", reason: "2 files differ with node 2", cleanSince: null, cleanHours: 24, decidedBy: null },
    }], "the unshared project is not listed");
  } finally { await f.cleanup(); }
});

function db_addUnshared(db: DatabaseSync, root: string): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('solo', 'Solo', ?, ?, ?)").run(root, NOW, NOW);
}

// ---- auto-transition: the owner moves a project by itself, nobody coordinates the moment ----

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const pushesOf = (peer: FakePeer) => peer.requests.filter((request) => request.target.endsWith("/switch") && (request.json as { auto?: unknown }).auto).map((request) => request.json);
const noticesOf = (peer: FakePeer) => peer.requests.filter((request) => request.target.endsWith("/changed"));
const capable = (overrides: Partial<PeerFileSync> = {}): PeerFileSync => ({ protocol: FILE_SYNC_PROTOCOL, minProtocol: 1, enabled: true, origins: [], via: "hello", at: 0, ...overrides });

test("the owner moves a project by itself once its files matched for cleanHours and every check passes, on one timer", async () => {
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 1 } }, {});
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    // The fixture's files have matched for a minute.
    assert.deepEqual(machine.project(PROJECT).autoSwitch, { state: "matching", reason: "Files have matched on every machine for 1 min; it moves to built-in sync after 1 h", cleanSince: "2026-10-24T23:59:00.000Z", cleanHours: 1, decidedBy: null });
    assert.equal(engineRecordOf(f.db, PROJECT), undefined);
    assert.deepEqual(f.peer.requests, [], "no peer is asked before the time is up");
    assert.deepEqual(machine.pendingTimers(), [PROJECT], "one timer, for when the matching time is up");
    // Reports and derivations meanwhile set no timer of their own.
    const created = f.clock.created;
    for (let round = 0; round < 5; round++) { machine.shareChanged(f.engine.report("project")); machine.kick(); await machine.idle(); }
    assert.equal(f.clock.created, created, "the same timer stays armed");
    f.clock.advance(57 * MINUTE);
    await machine.idle();
    assert.equal(engineRecordOf(f.db, PROJECT), undefined, "not before the hour is up");
    assert.equal(f.clock.created, created, "nothing ran in between");
    assert.ok(f.clock.live() <= 1);
    // The hour is up (cleanSince + 1 h): the owner checks every machine and moves the project itself.
    f.clock.advance(2 * MINUTE);
    await settle(machine, f.clock, 2);
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.deepEqual(noticesOf(f.peer).map((request) => request.peer), [PEER], "the peer is told and follows the record");
    assert.deepEqual(f.audits, [{ eventType: "fileSync.engine.moved", actorType: "system", actorId: null, entityType: "project", entityId: PROJECT, details: { engine: "builtin", automatic: true } }]);
    assert.deepEqual(f.infos, ["File sync moved Project alpha to built-in sync by itself: every check passed and its files matched on every machine for 1 h"]);
    assert.deepEqual(f.metrics, [{ operation: "fileSync.autoSwitch", durationMs: HOUR }]);
    assert.equal(machine.project(PROJECT).autoSwitch, null, "nothing left to wait for");
    assert.deepEqual(machine.pendingTimers(), []);
  } finally { await f.cleanup(); }
});

test("a failing check holds the automatic move and names the machine; a check that failed is not retried on a timer", async () => {
  const cases: Array<{ reason: string; set: (f: Fixture) => void; asked: boolean }> = [
    // What the peer said in its hello: known without asking anyone.
    { reason: "Waiting for node 2 to update Joint Bob", asked: false, set: (f) => { f.capability.set(PEER, capable({ protocol: 1 })); } },
    { reason: "Waiting for node 2 to turn on file sync", asked: false, set: (f) => { f.capability.set(PEER, capable({ enabled: false, autoSwitch: true })); } },
    // fix: a release without automatic moves (2.159) has file sync off by default: updating is what turns it on.
    { reason: "Waiting for node 2 to update Joint Bob", asked: false, set: (f) => { f.capability.set(PEER, capable({ enabled: false })); } },
    // Its later shares answers (which never say) keep what the hello said.
    { reason: "Waiting for node 2 to update Joint Bob", asked: false, set: (f) => { f.capability.set(PEER, capable({ enabled: false, autoSwitch: false, via: "shares" })); } },
    { reason: "Waiting for this machine to update Joint Bob", asked: false, set: (f) => { f.capability.set(PEER, capable({ minProtocol: FILE_SYNC_PROTOCOL + 1 })); } },
    { reason: "3 files differ with node 2", asked: false, set: (f) => { f.engine.tweak.tickets = { peers: [{ ...status("tickets", "syncthing").peers[0], differences: 3, cleanSince: null }] }; } },
    { reason: "Waiting for file sync to start on this machine", asked: false, set: (f) => { f.engine.running_ = false; } },
    // Its first index waits its turn, or the admin chose other projects to compare.
    { reason: "Waiting for this machine to read its files for the first time, one project at a time", asked: false, set: (f) => { f.engine.shadow = false; } },
    { reason: "Not compared on this machine, so it stays on Syncthing; tick Compare to let it move", asked: false, set: (f) => { f.engine.shadow = false; writeFileSyncConfig(f.db, { shadowProjects: ["other"] }, {}); } },
    // Only the full checks find these out.
    { reason: "Waiting for Syncthing to finish copying", asked: true, set: (f) => { f.syncthing.states[projectTicketSyncFolderId(PROJECT)] = "syncing"; } },
    // fix: a folder in error never finishes by itself: the reason names it rather than waiting for a copy.
    { reason: "Waiting for Syncthing's problem with Alpha tickets to be fixed on this machine", asked: true, set: (f) => { f.syncthing.states[projectTicketSyncFolderId(PROJECT)] = "error"; } },
    { reason: "Waiting for Syncthing to finish copying to node 2", asked: true, set: (f) => { f.syncthing.peerCaughtUpAnswer = false; } },
    { reason: "Waiting for node 2 to answer", asked: true, set: (f) => { f.peer.silent.add(PEER); } },
    { reason: "Waiting for node 2 to update Joint Bob", asked: true, set: (f) => { f.peer.shares = { fileSync: { protocol: 1, minProtocol: 1, enabled: true } }; } },
    // Turned off since its hello: a release without automatic moves is updated, a newer one has it turned on.
    { reason: "Waiting for node 2 to update Joint Bob", asked: true, set: (f) => { f.capability.set(PEER, capable()); f.peer.shares = { fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: false } }; } },
    { reason: "Waiting for node 2 to turn on file sync", asked: true, set: (f) => { f.capability.set(PEER, capable({ autoSwitch: true })); f.peer.shares = { fileSync: { protocol: FILE_SYNC_PROTOCOL, minProtocol: FILE_SYNC_MIN_PROTOCOL, enabled: false } }; } },
    { reason: "A task is running in this project; wait for it to finish", asked: true, set: (f) => { f.activity.reason = "A task is running in this project; wait for it to finish"; } },
  ];
  for (const entry of cases) {
    const f = await fixture();
    try {
      writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 0 } }, {});
      entry.set(f);
      const machine = f.machine();
      machine.kick();
      await machine.idle();
      const shown = machine.project(PROJECT).autoSwitch;
      assert.deepEqual([shown?.state, shown?.reason], ["blocked", entry.reason], entry.reason);
      assert.equal(engineRecordOf(f.db, PROJECT), undefined, entry.reason);
      const asked = f.peer.requests.filter((request) => request.target.endsWith("/shares")).length;
      assert.equal(asked > 0, entry.asked, `${entry.reason}: asked the peer`);
      // Nothing changes: no retry, whatever the time. fix: a difference with nothing to explain it has one timer, at the end of its grace.
      const graced = entry.reason.includes("differ");
      assert.deepEqual(machine.pendingTimers(), graced ? [PROJECT] : [], `${entry.reason}: ${graced ? "one timer" : "no timer"}`);
      f.clock.advance(6 * HOUR);
      await machine.idle();
      assert.deepEqual(machine.pendingTimers(), [], `${entry.reason}: none after it`);
      assert.equal(f.peer.requests.filter((request) => request.target.endsWith("/shares")).length, asked, `${entry.reason}: not asked again by itself`);
    } finally { await f.cleanup(); }
  }

  // Fixed, the next relevant change lets it go; a burst of changes right after a full check runs it once more after a minute, not per change.
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 0 } }, {});
    f.peer.silent.add(PEER);
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    const asked = () => f.peer.requests.filter((request) => request.target.endsWith("/shares")).length;
    const first = asked();
    f.peer.silent.clear();
    for (let round = 0; round < 3; round++) { machine.shareChanged(f.engine.report("project")); await machine.idle(); }
    assert.equal(asked(), first, "within a minute of a full check, changes wait for one more after it");
    assert.deepEqual(machine.pendingTimers(), [PROJECT]);
    f.clock.advance(MINUTE);
    await settle(machine, f.clock, 2);
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
  } finally { await f.cleanup(); }
});

test("a full check that keeps failing waits twice as long each time while changes keep coming", async () => {
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 0 } }, {});
    f.peer.silent.add(PEER);
    const machine = f.machine();
    const asked = () => f.peer.requests.filter((request) => request.target.endsWith("/shares")).length;
    const busy = async () => { for (let round = 0; round < 3; round++) { machine.shareChanged(f.engine.report("project")); await machine.idle(); } };
    machine.kick();
    await machine.idle();
    const counts = [asked()];
    // Changes keep coming: each full check fails, and the next one waits 1, 2, then 4 minutes.
    for (const gap of [1, 2, 4]) {
      await busy();
      f.clock.advance(gap * MINUTE - 1);
      await machine.idle();
      assert.equal(asked(), counts.at(-1), `not before ${gap} min`);
      f.clock.advance(1);
      await machine.idle();
      counts.push(asked());
      assert.ok(counts.at(-1)! > counts.at(-2)!, `checked again after ${gap} min`);
    }
    assert.equal(engineRecordOf(f.db, PROJECT), undefined);
    // Answering again, the next change lets it go after the current wait.
    f.peer.silent.clear();
    await busy();
    f.clock.advance(8 * MINUTE);
    await settle(machine, f.clock, 2);
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
  } finally { await f.cleanup(); }
});

test("turning file sync off sends built-in projects back to Syncthing first: the owner's at once, a peer's through its owner, then the engine may stop", async () => {
  // The owner: its own built-in project moves back for every machine, with the reason.
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin");
    f.capability.set(PEER, capable());
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
    f.engine.enabled_ = false;
    machine.kick();
    await machine.idle();
    assert.deepEqual([engineRecordOf(f.db, PROJECT)!.mode, engineRecordOf(f.db, PROJECT)!.generation], ["syncthing", 2]);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "syncthing");
    assert.match(f.logs.join("\n"), /File sync moved Project alpha back to Syncthing: file sync is being turned off on this machine/);
    assert.deepEqual(noticesOf(f.peer).map((request) => request.peer), [PEER]);
    assert.ok(f.engine.left > 0, "the engine hears it holds the project no more");
  } finally { await f.cleanup(); }

  // A peer: it never releases or rolls back by itself, keeps syncing, and tells its owner it is leaving.
  const g = await fixture();
  try {
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    switched(g.db, "builtin", 1, PEER);
    g.engine.enabled_ = false;
    const machine = g.machine();
    machine.kick();
    await machine.idle();
    await delivered();
    assert.equal(engineModeOf(g.db, PROJECT), "builtin", "only the owner moves it");
    assert.equal(phaseOf(g.db, PROJECT)?.phase ?? "syncthing", "syncthing", "it does not release Syncthing's folders on its way out");
    assert.deepEqual(g.syncthing.removed, []);
    const reports = g.peer.requests.filter((request) => request.target.endsWith("/switch")).map((request) => (request.json as { report?: { leaving?: boolean } }).report);
    assert.equal(reports.at(-1)?.leaving, true, "the owner hears it is leaving");
    assert.equal((await machine.answerSwitch(PEER, { projectId: PROJECT }))!.leaving, true, "and reads it when it asks");
    // Already built-in here: it holds where it is, and follows the owner's move back.
    setPhase(g.db, PROJECT, "builtin");
    machine.kick();
    await machine.idle();
    assert.match(phaseOf(g.db, PROJECT)!.error ?? "", /^Waiting for node 2 to move this project back to Syncthing, as file sync is being turned off here$/);
    const left = g.engine.left;
    switched(g.db, "syncthing", 2, PEER);
    machine.kick();
    await machine.idle();
    assert.equal(phaseOf(g.db, PROJECT)!.phase, "syncthing");
    assert.ok(g.engine.left > left);
  } finally { await g.cleanup(); }

  // The owner hears a peer is leaving: the project moves back now, though its hello still said on.
  const h = await fixture();
  try {
    h.syncthing.folders_ = [];
    switched(h.db);
    setPhase(h.db, PROJECT, "builtin");
    h.capability.set(PEER, capable());
    const machine = h.machine();
    machine.kick();
    await machine.idle();
    const answer = await machine.answerSwitch(PEER, { projectId: PROJECT, report: { phase: "builtin", error: null, leaving: true } });
    assert.equal(answer!.leaving, undefined, "this node is not leaving");
    await machine.idle();
    assert.equal(engineModeOf(h.db, PROJECT), "syncthing");
    assert.match(h.logs.join("\n"), /back to Syncthing: node 2 is turning file sync off, so it stops receiving this project's files/);
    // Back on: its next report says so, and nothing holds an automatic move later.
    await machine.answerSwitch(PEER, { projectId: PROJECT, report: { phase: "syncthing", error: null } });
    assert.notEqual(machine.project(PROJECT).autoSwitch?.reason, "node 2 is turning file sync off, so it stops receiving this project's files");
  } finally { await h.cleanup(); }
});

test("a move back by hand holds the project on Syncthing; the automatic move never overrides it, a move by hand lifts it", async () => {
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 0 } }, {});
    const machine = f.machine();
    await machine.switchEngine(PROJECT, "builtin", { by: "ilia", actorId: "user-1" });
    await settle(machine, f.clock, 2);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    f.clock.at += 1_000;
    await machine.switchEngine(PROJECT, "syncthing", { by: "ilia", actorId: "user-1" });
    await settle(machine, f.clock, 2);
    assert.deepEqual([engineModeOf(f.db, PROJECT), phaseOf(f.db, PROJECT)!.phase], ["syncthing", "syncthing"]);
    assert.equal(projectHold(f.db, PROJECT).stayOnSyncthing?.by, "ilia");
    // Every check passes and the files matched for days: it stays.
    f.clock.advance(3 * 24 * HOUR);
    machine.kick();
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "syncthing");
    assert.deepEqual(machine.project(PROJECT).autoSwitch, { state: "held", reason: HELD_REASON, cleanSince: null, cleanHours: 0, decidedBy: null });
    assert.deepEqual(machine.pendingTimers(), []);
    assert.deepEqual(f.audits.map((event) => [event.actorType, event.actorId, event.details.engine, event.details.automatic]), [["user", "user-1", "builtin", false], ["user", "user-1", "syncthing", false]]);
    // Moving it by hand to built-in sync again lifts the hold.
    await machine.switchEngine(PROJECT, "builtin", { by: "ilia", actorId: "user-1" });
    assert.deepEqual(projectHold(f.db, PROJECT), {});
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
  } finally { await f.cleanup(); }
});

test("an automatic move back starts the matching time over, so a project does not flap", async () => {
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 1 } }, {});
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin");
    // The peer turned file sync off: the owner moves the project back by itself.
    f.capability.set(PEER, capable({ enabled: false }));
    const machine = f.machine();
    machine.kick();
    await settle(machine, f.clock, 1);
    assert.deepEqual([engineModeOf(f.db, PROJECT), phaseOf(f.db, PROJECT)!.phase], ["syncthing", "syncthing"]);
    const rolledBackAt = projectHold(f.db, PROJECT).cleanAfter!;
    assert.ok(rolledBackAt >= NOW, rolledBackAt);
    assert.equal(projectHold(f.db, PROJECT).stayOnSyncthing, undefined, "an automatic move back holds nothing");
    assert.deepEqual(f.audits.map((event) => [event.actorType, event.details.engine, event.details.automatic]), [["system", "syncthing", true]]);
    // It is on again; the files matched since before the move back, but only the time since counts.
    f.capability.set(PEER, capable());
    machine.kick();
    await machine.idle();
    assert.deepEqual(machine.project(PROJECT).autoSwitch, { state: "matching", reason: "Files have matched on every machine for 0 min; it moves to built-in sync after 1 h", cleanSince: rolledBackAt, cleanHours: 1, decidedBy: null });
    f.clock.advance(Date.parse(rolledBackAt) + HOUR - 60_000 - f.clock.now());
    await machine.idle();
    assert.equal(engineModeOf(f.db, PROJECT), "syncthing", "the fixture's earlier matching time would have been up by now");
    f.clock.advance(60_000);
    await settle(machine, f.clock, 2);
    assert.equal(engineModeOf(f.db, PROJECT), "builtin");
  } finally { await f.cleanup(); }
});

test("a record notice a peer missed is sent again at its next contact, once", async () => {
  const f = await fixture();
  try {
    f.peer.failNotices = true;
    const machine = f.machine();
    await machine.switchEngine(PROJECT, "builtin");
    assert.equal(noticesOf(f.peer).length, 1);
    assert.match(f.logs.join("\n"), /could not tell node 2 about the move of Project alpha yet/);
    // It comes back (a hello, its return): the notice goes now, and only once.
    f.peer.failNotices = false;
    machine.peerContact(PEER);
    await delivered();
    assert.equal(noticesOf(f.peer).length, 2);
    machine.peerContact(PEER);
    await delivered();
    assert.equal(noticesOf(f.peer).length, 2, "delivered: not sent again");
    // A request of its own counts as contact too.
    f.peer.failNotices = true;
    await settle(machine, f.clock, 2);
    f.clock.at += 1_000;
    await machine.switchEngine(PROJECT, "syncthing");
    const missed = noticesOf(f.peer).length;
    f.peer.failNotices = false;
    await machine.answerSwitch(PEER, { projectId: PROJECT, report: { phase: "builtin", error: null } });
    await delivered();
    assert.equal(noticesOf(f.peer).length, missed + 1);
    assert.deepEqual(machine.pendingTimers().filter((id) => id !== PROJECT), [], "no timer retries a notice");
  } finally { await f.cleanup(); }
});

test("the owner tells the peers that asked what its automatic move waits for, and a non-owner shows it", async () => {
  const f = await fixture();
  try {
    f.capability.set(PEER, capable({ minProtocol: FILE_SYNC_PROTOCOL + 1 }));
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    await delivered();
    assert.deepEqual(pushesOf(f.peer), [], "nobody asked yet: nothing is sent");
    // The peer's Settings asks; "this machine" names the owner on the peer's screen.
    assert.deepEqual((await machine.answerSwitch(PEER, { projectId: PROJECT }))?.auto, { state: "blocked", reason: "Waiting for node 1 to update Joint Bob", cleanSince: null, cleanHours: 24 });
    machine.kick();
    await machine.idle();
    await delivered();
    assert.deepEqual(pushesOf(f.peer), [], "nothing changed since it asked");
    f.capability.set(PEER, capable());
    machine.kick();
    await machine.idle();
    await delivered();
    assert.deepEqual(pushesOf(f.peer), [{ projectId: PROJECT, auto: { state: "matching", reason: "", cleanSince: "2026-10-24T23:59:00.000Z", cleanHours: 24 } }], "told of the change");
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    await delivered();
    assert.equal(pushesOf(f.peer).length, 1, "told once per change");
  } finally { await f.cleanup(); }

  // A non-owner: before the owner said anything it asks once, then shows the owner's word with the owner's name.
  const g = await fixture();
  try {
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    g.db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    const cleanSince = new Date(Date.parse(NOW) - 6 * HOUR).toISOString();
    g.peer.switchAnswer = { auto: { state: "matching", reason: "", cleanSince, cleanHours: 24 } };
    const machine = g.machine();
    assert.deepEqual(machine.project(PROJECT).autoSwitch, { state: "blocked", reason: "node 2 moves this project when every machine is ready", cleanSince: null, cleanHours: 24, decidedBy: "node 2" });
    await delivered();
    assert.deepEqual(machine.project(PROJECT).autoSwitch, { state: "matching", reason: "Files have matched on every machine for 6 h; it moves to built-in sync after 24 h", cleanSince, cleanHours: 24, decidedBy: "node 2" });
    machine.project(PROJECT);
    await delivered();
    assert.equal(g.peer.requests.filter((request) => request.target.endsWith("/switch")).length, 1, "asked once in a few minutes, however often Settings loads");
    // Pushed by the owner when it changes.
    await machine.answerSwitch(PEER, { projectId: PROJECT, auto: { state: "blocked", reason: "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob", cleanSince: null, cleanHours: 24 } });
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob");
    // Only the owner speaks for its move.
    addPeer(g.db, THIRD);
    await machine.answerSwitch(THIRD, { projectId: PROJECT, auto: { state: "held", reason: HELD_REASON, cleanSince: null, cleanHours: 24 } });
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "Waiting for Matans-Sela-MacBook-Pro to update Joint Bob");
  } finally { await g.cleanup(); }
});

// ---- fix: the matching time counts while the machines could exchange files ----

/** The fixture's project share with one settled difference for PEER (the worker ended its streak), or matching again from `cleanSince`. */
function differs(f: Fixture, count: number, cleanSince: string | null = null): void {
  f.engine.tweak.project = { peers: [{ ...status("project", "syncthing").peers[0], differences: count, cleanSince: count ? null : cleanSince }] };
}

test("a change that waits for a machine that is away keeps the matching time; the project moves once it arrived", async () => {
  const f = await fixture();
  try {
    let away = false;
    const machine = f.machine({ peerAway: () => away });
    machine.kick();
    await machine.idle();
    assert.equal(machine.project(PROJECT).autoSwitch?.state, "matching");
    // 20 h later Ilia saves a file and closes the lid: B is away before Syncthing copies it, and the worker's streak ends.
    f.clock.advance(20 * HOUR);
    away = true;
    differs(f, 1);
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.deepEqual([machine.project(PROJECT).autoSwitch?.state, machine.project(PROJECT).autoSwitch?.reason], ["blocked", "Waiting for node 2 to come back: 1 changed file waits for it"]);
    assert.deepEqual(machine.pendingTimers(), [], "nothing runs while it is away");
    // 8 h later it is back; Syncthing copies the file.
    f.clock.advance(8 * HOUR);
    away = false;
    f.syncthing.peerCaughtUpAnswer = false;
    machine.peerContact(PEER);
    machine.kick();
    await machine.idle();
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "Waiting for Syncthing to copy 1 changed file between this machine and node 2");
    // Syncthing is done: B's engine lists the file a moment later and the worker starts a new streak; the time before still counts.
    f.syncthing.peerCaughtUpAnswer = true;
    machine.syncthingEvents([{ id: 9, type: "FolderCompletion", data: { folder: `joint-bob-${PROJECT}`, completion: 100 } }]);
    await machine.idle();
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "1 file differs with node 2");
    assert.deepEqual(machine.pendingTimers(), [PROJECT], "one timer, at the end of the grace");
    f.clock.advance(MINUTE);
    differs(f, 0, new Date(f.clock.now()).toISOString());
    machine.shareChanged(f.engine.report("project"));
    await settle(machine, f.clock, 2);
    assert.equal(engineModeOf(f.db, PROJECT), "builtin", JSON.stringify(machine.project(PROJECT).autoSwitch));
    assert.match(f.infos.join("\n"), /matched on every machine for 28 h/);
  } finally { await f.cleanup(); }
});

test("a difference that stands with every machine there and Syncthing done ends the matching time after the grace", async () => {
  const f = await fixture();
  try {
    const machine = f.machine({ peerAway: () => false, autoGraceMs: 15 * MINUTE });
    machine.kick();
    await machine.idle();
    f.clock.advance(10 * HOUR);
    differs(f, 2);
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.deepEqual(machine.pendingTimers(), [PROJECT]);
    assert.ok(projectHold(f.db, PROJECT).matching, "still carried within the grace");
    // Still there after the grace (an ignore rule only one side has, a file Syncthing cannot write): real, so the time starts over.
    f.clock.advance(15 * MINUTE);
    await machine.idle();
    assert.equal(projectHold(f.db, PROJECT).matching, undefined);
    assert.deepEqual(machine.pendingTimers(), []);
    const fixedAt = new Date(f.clock.now() + MINUTE).toISOString();
    f.clock.advance(MINUTE);
    differs(f, 0, fixedAt);
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.deepEqual([machine.project(PROJECT).autoSwitch?.state, machine.project(PROJECT).autoSwitch?.cleanSince], ["matching", fixedAt]);
  } finally { await f.cleanup(); }
});

// fix: nobody ticks a project on every machine: its owner asks each peer to compare it.
test("a peer that does not compare the project is asked to, says what it does, and an untick there is kept", async () => {
  const f = await fixture();
  try {
    writeFileSyncConfig(f.db, { autoSwitch: { cleanHours: 0 } }, {});
    // PEER serves no share for the project: nothing compared with it.
    for (const kind of SHARE_KINDS) f.engine.tweak[kind] = { peers: [{ ...status(kind, "syncthing").peers[0], cleanSince: null }] };
    const asks = () => f.peer.requests.filter((request) => request.target.endsWith("/switch") && (request.json as { compare?: boolean }).compare);
    const reasonOf = async (answer: Record<string, unknown>, setup?: (machine: Migration) => void): Promise<string | undefined> => {
      f.peer.switchAnswer = answer;
      const machine = f.machine();
      setup?.(machine);
      machine.kick();
      await machine.idle();
      await delivered();
      await machine.idle();
      const reason = machine.project(PROJECT).autoSwitch?.reason;
      machine.stop();
      return reason;
    };
    assert.equal(await reasonOf({ compares: "yes" }), "Waiting for node 2 to compare this project's files");
    assert.equal(asks().length, 1, "asked once");
    assert.equal(await reasonOf({ compares: "declined" }), "node 2 does not compare this project (unticked there), so it stays on Syncthing");
    assert.equal(await reasonOf({ compares: "off" }), "Waiting for node 2 to turn on file sync");
    // 2.159 answers without the field.
    assert.equal(await reasonOf({}), "Waiting for node 2 to update Joint Bob");
    // Away: asked again at its next contact, not on a timer.
    f.peer.silent.add(PEER);
    f.peer.switchAnswer = { compares: "yes" };
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    await delivered();
    const before = asks().length;
    assert.deepEqual(machine.pendingTimers(), []);
    f.peer.silent.clear();
    machine.peerContact(PEER);
    await machine.idle();
    await delivered();
    assert.equal(asks().length, before + 1);
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "Waiting for node 2 to compare this project's files");
  } finally { await f.cleanup(); }

  // The peer's side: a chosen list takes the project in, once; another machine cannot ask; an untick there is kept.
  const g = await fixture();
  try {
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    g.db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    writeFileSyncConfig(g.db, { shadowProjects: ["other"] }, {});
    const machine = g.machine();
    addPeer(g.db, THIRD);
    assert.equal((await machine.answerSwitch(THIRD, { projectId: PROJECT, compare: true }))?.compares, undefined, "only the owner asks");
    assert.equal((await machine.answerSwitch(PEER, { projectId: PROJECT, compare: true }))?.compares, "yes");
    assert.deepEqual(readFileSyncConfig(g.db, {}).requestedProjects, [PROJECT]);
    assert.equal((await machine.answerSwitch(PEER, { projectId: PROJECT, compare: true }))?.compares, "yes");
    assert.deepEqual(readFileSyncConfig(g.db, {}).requestedProjects, [PROJECT], "asked once is enough");
    writeFileSyncConfig(g.db, { shadowProjects: ["other"] }, {});
    assert.equal((await machine.answerSwitch(PEER, { projectId: PROJECT, compare: true }))?.compares, "declined");
    g.engine.enabled_ = false;
    writeFileSyncConfig(g.db, { shadowProjects: ["other", PROJECT] }, {});
    assert.equal((await machine.answerSwitch(PEER, { projectId: PROJECT, compare: true }))?.compares, "off");
  } finally { await g.cleanup(); }
});

test("a ticket folder missing here is made and looked at, so the project gets compared", async () => {
  const f = await fixture();
  try {
    f.engine.tweak.tickets = { state: "unavailable", message: "The folder is missing", peers: [{ ...status("tickets", "syncthing").peers[0], cleanSince: null }] };
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, "This machine has no folder for this project's tickets yet");
    machine.shareChanged(f.engine.report("tickets"));
    machine.shareChanged(f.engine.report("tickets"));
    await machine.idle();
    assert.ok(existsSync(f.roots.tickets));
    assert.deepEqual(f.engine.calls.filter((call) => call.op === "scan").map((call) => call.args), [{ share: `tickets:${PROJECT}`, scope: "full", reason: "folder" }], "once");
    // A missing project folder is not made: it may be on a disk that is not mounted.
    f.engine.tweak.project = { state: "unavailable" };
    machine.shareChanged(f.engine.report("project"));
    await machine.idle();
    assert.equal(f.engine.calls.filter((call) => call.op === "scan").length, 1);
    // The share left the worker before its look (a new list of projects to compare): the worker walks it in full when it comes
    // back, so nothing is logged.
    f.engine.tweak.worktrees = { state: "unavailable" };
    f.engine.hook = (op) => { if (op === "scan") throw new Error("File sync share not found: worktrees:alpha"); };
    machine.shareChanged(f.engine.report("worktrees"));
    await machine.idle();
    assert.ok(existsSync(f.roots.worktrees));
    assert.deepEqual(f.logs, []);
  } finally { await f.cleanup(); }
});

// fix: the hold travels with the project, and a person can lift it without moving the project now.
test("allowing the automatic move lifts a hold by hand; the hold reaches every peer, and a twin that takes the project over keeps it", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    await machine.switchEngine(PROJECT, "builtin", { by: "ilia", actorId: "user-1" });
    await settle(machine, f.clock, 2);
    f.clock.at += 1_000;
    await machine.switchEngine(PROJECT, "syncthing", { by: "ilia", actorId: "user-1" });
    await settle(machine, f.clock, 2);
    machine.kick();
    await machine.idle();
    await delivered();
    // Nobody asked, yet the peer hears of the hold, worded for its screen.
    assert.deepEqual(pushesOf(f.peer).map((push) => (push as { auto: { state: string; reason: string } }).auto).map((auto) => [auto.state, auto.reason]),
      [["held", "Moved back to Syncthing by hand on node 1, so it stays there"]]);
    assert.equal(machine.project(PROJECT).autoSwitch?.reason, HELD_REASON);
    assert.equal(machine.allowAuto(PROJECT).autoSwitch?.state, "matching");
    assert.deepEqual(projectHold(f.db, PROJECT).stayOnSyncthing, undefined);
    await machine.idle();
    await delivered();
    assert.deepEqual(pushesOf(f.peer).map((push) => (push as { auto: { state: string } }).auto.state), ["held", "matching"], "and of its end");
  } finally { await f.cleanup(); }

  const g = await fixture();
  try {
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    g.db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id = ? WHERE resource_id = ?").run(PEER, PROJECT);
    const machine = g.machine();
    assert.throws(() => machine.allowAuto(PROJECT), EngineSwitchRefused, "only the owner");
    const held = { state: "held" as const, reason: "Moved back to Syncthing by hand on node 2, so it stays there", cleanSince: null, cleanHours: 24 };
    await machine.answerSwitch(PEER, { projectId: PROJECT, auto: held });
    assert.equal(projectHold(g.db, PROJECT).stayOnSyncthing?.from, PEER);
    await machine.answerSwitch(PEER, { projectId: PROJECT, auto: { state: "matching", reason: "", cleanSince: NOW, cleanHours: 24 } });
    assert.equal(projectHold(g.db, PROJECT).stayOnSyncthing, undefined, "lifted on the owner, lifted here");
    await machine.answerSwitch(PEER, { projectId: PROJECT, auto: held });
    // PEER is lost; this node (its twin) takes the project over and holds it as the person asked.
    g.db.prepare("UPDATE sharing_resource_owners SET owner_node_id = ? WHERE resource_id = ?").run(LOCAL, PROJECT);
    g.db.prepare("UPDATE cluster_v2_resource_policy SET owner_node_id = ? WHERE resource_id = ?").run(LOCAL, PROJECT);
    writeFileSyncConfig(g.db, { autoSwitch: { cleanHours: 0 } }, {});
    machine.kick();
    await settle(machine, g.clock, 2);
    assert.equal(machine.project(PROJECT).autoSwitch?.state, "held");
    assert.equal(engineModeOf(g.db, PROJECT), "syncthing");
  } finally { await g.cleanup(); }
});

// ---- auto-transition: two writers on one root, closed ----

test("a Syncthing folder added or resumed over a built-in project while it runs stops the engine's writes within the event", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    // The old shared ticket folder covers every project's tickets; paused, as Joint Bob keeps it, it is allowed.
    f.syncthing.add("joint-bob-ticket-workspaces", path.dirname(f.roots.tickets), "Joint Bob ticket workspaces");
    const legacy = f.syncthing.folders_[0];
    legacy.paused = true;
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    const machine = f.machine();
    machine.kick();
    await machine.idle();
    assert.equal(machine.writesAllowed(PROJECT), true);
    machine.syncthingEvents([{ id: 3, type: "ConfigSaved" }]);
    await machine.idle();
    assert.deepEqual([phaseOf(f.db, PROJECT)!.phase, machine.writesAllowed(PROJECT), f.engine.ops("bootstrap").length], ["builtin", true, 0], "a paused old folder changes nothing");
    // Someone adds a folder of their own over the project in Syncthing's GUI.
    await mkdir(path.join(f.dir, "real-alpha", "photos"));
    f.syncthing.add("photos", path.join(f.dir, "real-alpha", "photos"), "Photos");
    f.engine.applied.length = 0;
    machine.syncthingEvents([{ id: 4, type: "ConfigSaved" }]);
    await machine.idle();
    assert.equal(f.engine.applied[0], "releasing", "the worker stopped writing the project within the event");
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.equal(machine.writesAllowed(PROJECT), false);
    assert.match(phaseOf(f.db, PROJECT)!.error ?? "", /“Photos” .* is not Joint Bob's/);
    assert.ok(!f.syncthing.removed.includes("photos"), "the user's folder is never touched");
    // Removed in the GUI: that event lets the move finish at once.
    f.syncthing.folders_ = f.syncthing.folders_.filter((folder) => folder.id !== "photos");
    machine.syncthingEvents([{ id: 5, type: "ConfigSaved" }]);
    await machine.idle();
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(machine.writesAllowed(PROJECT), true);
    // The old folder resumed in the GUI is live: writes stop, and Joint Bob pauses it itself right then.
    legacy.paused = false;
    f.engine.applied.length = 0;
    const bootstraps = f.engine.ops("bootstrap").length;
    machine.syncthingEvents([{ id: 6, type: "FolderResumed", data: { id: "joint-bob-ticket-workspaces" } }]);
    await machine.idle();
    assert.equal(f.engine.applied[0], "releasing");
    assert.deepEqual(f.syncthing.paused, ["joint-bob-ticket-workspaces"]);
    assert.deepEqual(f.syncthing.ids(), ["joint-bob-ticket-workspaces"], "paused, never removed");
    assert.match(f.logs.join("\n"), /paused Joint Bob's old shared folder Joint Bob ticket workspaces/);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(f.engine.ops("bootstrap").length, bootstraps + 3, "decided again: Syncthing may have written meanwhile");
  } finally { await f.cleanup(); }
});

// fix: Syncthing is not needed to run built-in sync. Writes wait only for a first passed check of the roots.
test("a built-in project's writes wait only for a first folder check; once one passed, a Syncthing that does not answer stops nothing", async () => {
  const f = await fixture();
  try {
    f.syncthing.folders_ = [];
    switched(f.db);
    setPhase(f.db, PROJECT, "builtin", { builtinSince: { project: 7, tickets: 7, worktrees: 7 } });
    f.syncthing.answering = false;
    const machine = f.machine();
    assert.equal(machine.writesAllowed(PROJECT), false, "nothing is written before a first check");
    machine.kick();
    await machine.idle();
    assert.equal(machine.writesAllowed(PROJECT), false);
    assert.equal(machine.project(PROJECT).phaseMessage, WRITES_WAIT_FOR_SYNCTHING);
    assert.deepEqual(machine.pendingTimers(), [PROJECT], "asked again with backoff");
    f.syncthing.answering = true;
    f.engine.applied.length = 0;
    f.clock.advance(1_000);
    await machine.idle();
    assert.equal(machine.writesAllowed(PROJECT), true);
    assert.equal(machine.project(PROJECT).phaseMessage, null);
    assert.deepEqual(f.engine.applied, ["builtin"], "the worker was given its writes back");
    // Pointed at another Syncthing (a settings save, sync-check's reset): asked at once.
    f.syncthing.gen += 1;
    const lists = () => f.syncthing.calls.filter((call) => call === "folders").length;
    const before = lists();
    machine.kick();
    await machine.idle();
    assert.equal(lists(), before + 1, "the other Syncthing was asked");
    assert.equal(machine.writesAllowed(PROJECT), true);
    // Syncthing stops (Matan's Mac rebooted without it) and the connection is reset: writes go on, nothing is retried on a timer.
    f.syncthing.gen += 1;
    f.syncthing.answering = false;
    machine.kick();
    await machine.idle();
    assert.equal(machine.writesAllowed(PROJECT), true, "a Syncthing that does not answer stops nothing");
    assert.equal(machine.project(PROJECT).phaseMessage, null);
    assert.deepEqual(machine.pendingTimers(), []);
    const silent = lists();
    f.clock.advance(6 * HOUR);
    machine.kick();
    await machine.idle();
    assert.equal(machine.writesAllowed(PROJECT), true, "6 h later");
    assert.equal(lists(), silent, "not asked again until its event stream is back");
    // A restart while Syncthing is silent: the passed check is kept in node.db.
    machine.stop();
    const restarted = f.machine();
    assert.equal(restarted.writesAllowed(PROJECT), true);
    restarted.kick();
    await restarted.idle();
    assert.equal(restarted.writesAllowed(PROJECT), true);
    // Back with the project's folder added again (a restored configuration): its event stream looks at once and writes stop.
    f.syncthing.answering = true;
    f.syncthing.add(`joint-bob-${PROJECT}`, path.join(f.dir, "real-alpha"), "Alpha");
    f.engine.applied.length = 0;
    restarted.syncthingChanged();
    await settle(restarted, f.clock, 2);
    assert.equal(f.engine.applied[0], "releasing");
    assert.match(f.logs.join("\n"), /Syncthing syncs Alpha again/);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin");
    assert.equal(restarted.writesAllowed(PROJECT), true);
    // Roots moved while Syncthing is silent were never checked: their writes wait.
    f.syncthing.answering = false;
    const moved = path.join(f.dir, "moved-alpha");
    await mkdir(moved);
    f.roots.project = moved;
    restarted.kick();
    await restarted.idle();
    assert.equal(restarted.writesAllowed(PROJECT), false);
    assert.equal(restarted.project(PROJECT).phaseMessage, WRITES_WAIT_FOR_SYNCTHING);
  } finally { await f.cleanup(); }
});

// fix: "not configured" only means Joint Bob has no address and key for a Syncthing here, not that none runs.
test("with no connection to Syncthing a node has nothing to let go of only where Joint Bob never gave it the project's folders and no Syncthing is set up", async () => {
  const f = await fixture();
  try {
    // The homeserver after a deploy dropped JOINT_BOB_SYNCTHING_API_KEY: its Syncthing still holds the project's three folders.
    f.syncthing.configured = false;
    switched(f.db);
    const machine = f.machine();
    machine.kick();
    await settle(machine, f.clock, 2);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "releasing");
    assert.equal(machine.project(PROJECT).phaseMessage, SYNCTHING_UNREACHABLE);
    assert.deepEqual(f.syncthing.removed, []);
    assert.equal(machine.writesAllowed(PROJECT), false);
    // The owner's own checks say the same.
    switched(f.db, "syncthing", 2);
    await settle(machine, f.clock, 2);
    const refused = await machine.checks(PROJECT, "builtin");
    assert.deepEqual(failing(refused), ["syncthing"]);
    assert.equal(message(refused, "syncthing"), SYNCTHING_UNREACHABLE);
    // No folders ever enrolled, but a Syncthing configuration is there (its GUI off): still not proven empty.
    f.db.prepare("DELETE FROM cluster_v2_file_enrollments").run();
    f.syncthing.installed = true;
    assert.deepEqual(failing(await machine.checks(PROJECT, "builtin")), ["syncthing"]);
    // A machine that never had Syncthing: nothing to let go of, the move finishes.
    f.syncthing.installed = false;
    assert.deepEqual(failing(await machine.checks(PROJECT, "builtin")), []);
    switched(f.db, "builtin", 3);
    machine.kick();
    await settle(machine, f.clock, 3);
    assert.equal(phaseOf(f.db, PROJECT)!.phase, "builtin", JSON.stringify({ logs: f.logs, message: machine.project(PROJECT).phaseMessage }));
    assert.deepEqual(f.syncthing.removed, []);
    assert.equal(machine.writesAllowed(PROJECT), true);
  } finally { await f.cleanup(); }
});

// ---- auto-transition: the first index, one project at a time ----

test("the first index of every shared project runs one at a time, smallest first, and waits while main is busy", () => {
  const clock = new FakeClock();
  const indexed = new Set<string>(["known"]);
  let changed = 0;
  let busy = true;
  const queue = new FirstIndexQueue({
    indexed: () => indexed, markIndexed: (id) => { indexed.add(id); }, changed: () => { changed++; },
    name: (id) => `Project ${id}`, clock, calmWindowMs: 2_000, loopUtilization: () => () => busy ? 0.95 : 0.1,
  });
  const spec = (projectId: string, kind: ShareKind): ShareSpec => ({ key: `${kind}:${projectId}`, projectId, kind, root: `/r/${projectId}/${kind}`, phase: "syncthing", rules: { ...EMPTY_RULE_SETTINGS }, peers: [PEER] });
  const all = ["alpha", "beta", "gamma", "known", "moved"].flatMap((id) => SHARE_KINDS.map((kind) => spec(id, kind)));
  const always = (id: string) => id === "moved";
  // Syncthing knows how many files beta and gamma have; alpha's count is unknown, so it goes last.
  queue.setCounts(new Map([["beta", 900], ["gamma", 12]]));
  const projectsOf = (shares: ShareSpec[]) => [...new Set(shares.map((share) => share.projectId))].sort();
  let admitted = queue.admit(all, always);
  assert.deepEqual(projectsOf(admitted), ["gamma", "known", "moved"], "indexed and moved projects at once, one new project");
  assert.deepEqual(queue.status(), { projectId: "gamma", name: "Project gamma", position: 2, total: 5 });
  const reports = new Map<string, ShareStatus>();
  const report = (projectId: string, kind: ShareKind, overrides: Partial<ShareStatus>) => {
    const value = { ...status(kind, "syncthing"), share: `${kind}:${projectId}`, projectId, ...overrides };
    reports.set(value.share, value);
    queue.reported(value, (key) => reports.get(key));
  };
  report("gamma", "project", { indexed: true });
  report("gamma", "tickets", { indexed: false, state: "scanning", scanning: true });
  report("gamma", "worktrees", { state: "unavailable" });
  assert.equal(indexed.has("gamma"), false, "one folder still scanning");
  report("gamma", "tickets", { indexed: true });
  assert.equal(indexed.has("gamma"), true);
  assert.equal(changed, 0, "the next waits for main to be calm");
  clock.advance(2_000);
  assert.equal(changed, 0, "a busy window waits for another");
  busy = false;
  clock.advance(2_000);
  assert.equal(changed, 1);
  admitted = queue.admit(all, always);
  assert.deepEqual(projectsOf(admitted), ["beta", "gamma", "known", "moved"]);
  assert.deepEqual(queue.status(), { projectId: "beta", name: "Project beta", position: 3, total: 5 });
  // A project that is no longer shared leaves the queue; the next goes in.
  admitted = queue.admit(all.filter((share) => share.projectId !== "beta"), always);
  assert.deepEqual(projectsOf(admitted), ["alpha", "gamma", "known", "moved"]);
  assert.ok(clock.live() === 0, "no timer while a project indexes");
  // fix: a file rewritten every second keeps a folder scanning: its first index is done all the same, and a main thread
  // that stays busy lets the next project go after a few windows instead of holding the queue for good.
  busy = true;
  report("alpha", "project", { indexed: true, state: "scanning", scanning: true });
  report("alpha", "tickets", { indexed: true, state: "scanning", scanning: true });
  report("alpha", "worktrees", { indexed: true });
  assert.equal(indexed.has("alpha"), true, "indexed while still scanning");
  const before = changed;
  for (let window = 0; window < 4; window++) clock.advance(2_000);
  assert.equal(changed, before, "four busy windows wait");
  clock.advance(2_000);
  assert.equal(changed, before + 1, "the fifth goes on anyway");
  assert.equal(clock.live(), 0);
  queue.stop();
});

test("Syncthing's event stream: subscribed from the newest event, each event once, a backoff retry when Syncthing does not answer, nothing without Syncthing", async () => {
  const clock = new FakeClock();
  const delivered: number[] = [];
  let subscribed = 0;
  const calls: Array<{ since: number; limit?: number }> = [];
  const queue: Array<StreamEvent[] | Error> = [];
  let waiting: (() => void) | undefined;
  const source = {
    events: async (options: { since: number; limit?: number; signal: AbortSignal }): Promise<StreamEvent[]> => {
      calls.push({ since: options.since, ...(options.limit ? { limit: options.limit } : {}) });
      while (!queue.length) {
        await new Promise<void>((resolve, reject) => { waiting = resolve; options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
      }
      const next = queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    },
    notConfigured: (error: unknown) => (error as Error).message === "Syncthing is not configured on this node",
  };
  const push = (value: StreamEvent[] | Error) => { queue.push(value); waiting?.(); };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const stream = new SyncthingEventStream({ source, types: ["ConfigSaved"], clock, retry: { minMs: 1_000, maxMs: 4_000 }, onEvents: (events) => delivered.push(...events.map((event) => event.id)), onSubscribed: () => { subscribed++; } });
  stream.start();
  push([{ id: 41, type: "ConfigSaved" }]);
  await tick();
  assert.deepEqual(calls[0], { since: 0, limit: 1 });
  assert.equal(subscribed, 1);
  assert.deepEqual(delivered, [], "the newest event before subscribing is covered by the check onSubscribed runs");
  push([{ id: 42, type: "ConfigSaved" }, { id: 43, type: "ConfigSaved" }]);
  await tick();
  push([{ id: 43, type: "ConfigSaved" }, { id: 44, type: "ConfigSaved" }]);
  await tick();
  assert.deepEqual(delivered, [42, 43, 44]);
  assert.equal(calls.at(-1)!.since, 44);
  // Syncthing stops answering: one retry after the backoff, then subscribed again.
  push(new Error("fetch failed"));
  await tick();
  assert.equal(clock.live(), 1);
  const before = calls.length;
  clock.advance(999);
  assert.equal(calls.length, before);
  clock.advance(1);
  push([]);
  await tick();
  assert.equal(subscribed, 2);
  // Not set up here: it stops, and a new connection starts it again.
  push(new Error("Syncthing is not configured on this node"));
  await tick();
  assert.equal(clock.live(), 0, "nothing retries without Syncthing");
  stream.restart();
  push([]);
  await tick();
  assert.equal(subscribed, 3);
  stream.stop();
  await stream.running?.catch(() => undefined);
});

// ---- the guard every Syncthing folder path goes through ----

test("the folder guard runs work only on Syncthing, and a switch waits for a running enrollment", async () => {
  const db = database();
  try {
    const order: string[] = [];
    let release!: () => void;
    const slow = whileFilesOnSyncthing(PROJECT, async () => { order.push("enroll start"); await new Promise<void>((resolve) => { release = resolve; }); order.push("enroll end"); return "done"; }, db);
    const phase = withProjectFilesLock(PROJECT, async () => { order.push("switch"); setPhase(db, PROJECT, "releasing"); });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["enroll start"]);
    release();
    assert.equal(await slow, "done");
    await phase;
    assert.deepEqual(order, ["enroll start", "enroll end", "switch"]);
    assert.equal(await whileFilesOnSyncthing(PROJECT, async () => "late", db), undefined);
    for (const held of ["bootstrapping", "builtin", "restoring"] as const) {
      setPhase(db, PROJECT, held);
      assert.equal(await whileFilesOnSyncthing(PROJECT, async () => "ran", db), undefined, held);
    }
    setPhase(db, PROJECT, "syncthing");
    assert.equal(await whileFilesOnSyncthing(PROJECT, async () => "ran", db), "ran");
  } finally { db.close(); }
});

// fix (P4+P5): the guard checks paths too: no Syncthing folder over a project that built-in sync moves here.
test("the folder guard refuses a folder at, inside or around a project that built-in sync moves here", async () => {
  const db = database();
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-guard-"));
  try {
    for (const [id, root] of [["mono", path.join(dir, "mono")], ["web", path.join(dir, "mono", "web")], ["sibling", path.join(dir, "monorepo")], ["outer", dir]]) {
      db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, `Project ${id}`, root, NOW, NOW);
    }
    assert.equal(await whileFilesOnSyncthing("web", async () => "made", db), "made", "nothing is on built-in sync yet");
    setPhase(db, "mono", "builtin");
    await assert.rejects(whileFilesOnSyncthing("web", async () => "made", db), (error: unknown) => error instanceof FolderOverBuiltinError
      && /^This project's folder overlaps “Project mono” \(.*mono\), which built-in sync moves on this machine, so Syncthing does not sync it here$/.test(error.message));
    await assert.rejects(whileFilesOnSyncthing("outer", async () => "made", db), FolderOverBuiltinError, "a folder around it covers it too");
    assert.equal(await whileFilesOnSyncthing("sibling", async () => "made", db), "made", "a sibling that only shares a prefix");
    assert.equal(await whileFilesOnSyncthing("web", async () => "moved", db, [path.join(dir, "elsewhere")]), "moved", "a move to elsewhere is checked at its new place");
    await assert.rejects(whileFilesOnSyncthing("sibling", async () => "moved", db, [path.join(dir, "mono", "lib")]), FolderOverBuiltinError);
    assert.equal(await whileFilesOnSyncthing("mono", async () => "made", db), undefined, "the built-in project itself gets none");
    assert.equal(await projectInsideBuiltin(db, "web"), true);
    assert.equal(await projectInsideBuiltin(db, "sibling"), false);
    // A project moving to built-in sync (or back) counts as well.
    setPhase(db, "mono", "restoring");
    await assert.rejects(whileFilesOnSyncthing("web", async () => "made", db), FolderOverBuiltinError);
    setPhase(db, "mono", "syncthing");
    assert.equal(await whileFilesOnSyncthing("web", async () => "made", db), "made");
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("every call that creates or resumes a project's Syncthing folder goes through the guard", async () => {
  const root = path.resolve("src");
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  await walk(root);
  const creators = /\b(ensureSharedProjectFolder|ensureSyncthingFolder|resumeSharedProjectFolder)\(/;
  const unguarded: string[] = [];
  let calls = 0;
  for (const file of files) {
    if (file === path.join(root, "syncthing.ts")) continue;
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (!creators.test(line) || /^\s*import\b/.test(line)) return;
      calls++;
      // The call itself, or the block it sits in, is inside whileFilesOnSyncthing(...).
      if (!lines.slice(Math.max(0, index - 20), index + 1).some((candidate) => candidate.includes("whileFilesOnSyncthing("))) unguarded.push(`${path.relative(root, file)}:${index + 1}`);
    });
  }
  assert.ok(calls >= 6, `found ${calls} calls`);
  assert.deepEqual(unguarded, []);
});

/** A Syncthing REST stand-in: folder writes are recorded. */
async function fakeSyncthingRest(): Promise<{ url: string; writes: string[]; folders: SyncthingFolder[]; close: () => Promise<void> }> {
  const writes: string[] = [];
  const folders: SyncthingFolder[] = [];
  const body = (request: IncomingMessage): Promise<unknown> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined));
  });
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://syncthing");
    const send = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(value === undefined ? "" : JSON.stringify(value)); };
    const payload = await body(request);
    if (url.pathname === "/rest/system/status") return send({ myID: "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA" });
    if (url.pathname === "/rest/config/devices") return send(request.method === "GET" ? [] : undefined);
    if (url.pathname === "/rest/db/ignores") return send(request.method === "GET" ? { ignore: [] } : undefined);
    if (url.pathname === "/rest/config/folders" && request.method === "GET") return send(folders);
    if (url.pathname.startsWith("/rest/config/folders")) {
      const folder = payload as SyncthingFolder | undefined;
      writes.push(`${request.method} ${folder?.id ?? decodeURIComponent(url.pathname.split("/").pop() ?? "")}`);
      if (folder && request.method !== "DELETE") {
        const index = folders.findIndex((candidate) => candidate.id === folder.id);
        if (index >= 0) folders[index] = folder; else folders.push(folder);
      }
      return send(undefined);
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, writes, folders, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("enrollment adds folders only for projects still on Syncthing here, and still exchanges every project's location", async () => {
  const syncthingKeys = ["JOINT_BOB_SYNCTHING_URL", "JOINT_BOB_SYNCTHING_API_KEY", "PI_MOBILE_WEB_SYNCTHING_URL", "PI_MOBILE_WEB_SYNCTHING_API_KEY"];
  const previous = Object.fromEntries(syncthingKeys.map((key) => [key, process.env[key]]));
  const rest = await fakeSyncthingRest();
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-enrollment-"));
  for (const key of syncthingKeys) delete process.env[key];
  process.env.JOINT_BOB_SYNCTHING_URL = rest.url;
  process.env.JOINT_BOB_SYNCTHING_API_KEY = "test-key";
  try {
    const [{ clusterV2Database }, { getClusterNode }, store, { registerLocalSharingResource }, sharing] = await Promise.all([
      import("../src/cluster-v2-store.js"), import("../src/cluster.js"), import("../src/store.js"), import("../src/cluster-sharing.js"), import("../src/server/sharing-files.js")]);
    const db = await clusterV2Database();
    const local = (await getClusterNode()).id;
    ensureResourceSharingSchema(db);
    ensurePeerEndpointSchema(db);
    createSharingCluster(db, { id: CLUSTER, name: "home" }, local);
    addSharingMember(db, CLUSTER, local, PEER, getSharingCluster(db, CLUSTER).managerEpoch);
    recordPeerEndpoint(db, { kind: "cluster", id: CLUSTER }, { nodeId: PEER, name: "node 2", url: "https://peer.example.com" });
    const projects = [];
    // fix (P4+P5): the third lies inside the first, which built-in sync moves here.
    for (const [name, root] of [["Builtin here", path.join(dir, "Builtin here")], ["On Syncthing", path.join(dir, "On Syncthing")], ["Inside it", path.join(dir, "Builtin here", "web")]]) {
      const project = await store.addProject(name, root, { synced: true });
      registerLocalSharingResource(db, local, { kind: "project", id: project.id });
      setResourceShares(db, local, "project", project.id, [{ clusterId: CLUSTER, projectId: null }]);
      projects.push(project);
    }
    const [builtin, syncthing, inside] = projects;
    setPhase(db, builtin.id, "builtin");
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    let answer;
    try {
      answer = await sharing.receiveFileEnrollment(PEER, {
        deviceId: "BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB",
        projects: [builtin.id, syncthing.id, inside.id], locations: [],
      });
    } finally { console.warn = warn; }
    assert.deepEqual(answer.projects, [syncthing.id], "only the project on Syncthing is enrolled, and not the one inside a built-in project");
    assert.deepEqual(answer.locations.map((location) => location.projectId).sort(), [builtin.id, syncthing.id, inside.id].sort(), "locations of all");
    const written = rest.writes.map((write) => write.split(" ")[1]);
    assert.ok(written.includes(syncthing.syncFolderId!), JSON.stringify(rest.writes));
    for (const id of [builtin.syncFolderId!, projectTicketSyncFolderId(builtin.id), projectWorktreeSyncFolderId(builtin.id)]) assert.ok(!written.includes(id), `${id} untouched: ${JSON.stringify(rest.writes)}`);
    for (const id of [inside.syncFolderId!, projectTicketSyncFolderId(inside.id), projectWorktreeSyncFolderId(inside.id)]) assert.ok(!written.includes(id), `${id} not made over a built-in tree: ${JSON.stringify(rest.writes)}`);
    assert.match(warned.join("\n"), /File enrollment skipped 1 project\(s\).*Inside it: This project's folder overlaps “Builtin here” .*, which built-in sync moves on this machine, so Syncthing does not sync it here/);
    // The twin's resume leaves it paused too, and resumes the rest.
    const twin = await import("../src/file-sync/control.js");
    await assert.rejects(twin.whileFilesOnSyncthing(inside.id, async () => "resumed", db), twin.FolderOverBuiltinError);
    assert.deepEqual((db.prepare("SELECT DISTINCT project_id FROM cluster_v2_file_enrollments WHERE peer_id = ?").all(PEER) as Array<{ project_id: string }>).map((row) => row.project_id), [syncthing.id]);
    // Twin and cluster status wait on Syncthing only for projects still on it; built-in ones are ready once the engine
    // holds what the peer sent (its cursors caught up, nothing left to receive), read from memory.
    setPhase(db, syncthing.id, "builtin");
    let caughtUp = true;
    const shares = (projectId: string): ShareStatus[] => SHARE_KINDS.map((kind) => ({
      share: `${kind}:${projectId}`, projectId, kind, state: "idle", phase: "builtin", maxSeq: 7, indexId: `idx-${kind}`, digest: HASH, rulesHash: HASH, liveFiles: 1, liveBytes: 1,
      need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching",
      peers: [{ peer: PEER, cursor: caughtUp ? 9 : 4, peerMaxSeq: 9, peerIndexId: "peer-idx", peerDigest: HASH, rulesMatch: true, caughtUp, differences: 0, cleanSince: null, route: "direct" }],
    }));
    useFacadeEngineForTests({
      fileSyncProjectViews: async (ids) => new Map(ids.map((id) => [id, { worker: "running", enabled: true, shares: shares(id), peers: { project: [PEER], tickets: [PEER], worktrees: [PEER] } }])),
      fileSyncPeerFacts: async (peers) => ({ local: "laptop", peers: new Map([...peers].map((peer) => [peer, { name: "node 2", present: true, protocol: FILE_SYNC_PROTOCOL, enabled: true }])) }),
    } as unknown as EngineApi);
    try {
      assert.deepEqual(await sharing.sharingFilesStatus(db, local, PEER), { ready: true });
      caughtUp = false;
      assert.deepEqual(await sharing.sharingFilesStatus(db, local, PEER), { ready: false }, "files still on their way from the peer hold readiness back");
    } finally { useFacadeEngineForTests(undefined); }
  } finally {
    for (const key of syncthingKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rest.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Syncthing temps go by name only, without following links", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-temps-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "file-sync-temps-outside-"));
  try {
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, "a", "b", ".syncthing.x.tmp"), "");
    await writeFile(path.join(dir, "a", "~syncthing~y.tmp"), "");
    await writeFile(path.join(dir, "a", "syncthing.z.tmp"), "");
    await writeFile(path.join(outside, ".syncthing.elsewhere.tmp"), "");
    await symlink(outside, path.join(dir, "link"));
    assert.equal(await removeSyncthingTemps(dir), 2);
    assert.deepEqual((await readdir(path.join(dir, "a"), { recursive: true })).sort(), ["b", "syncthing.z.tmp"]);
    assert.equal(existsSync(path.join(outside, ".syncthing.elsewhere.tmp")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the worker reports builtin_since for the switch, and forgets its own once the project is back on Syncthing", async (t) => {
  const { createWorkerCore } = await import("../src/file-sync/core.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-sync-migration-core-"));
  const root = path.join(dir, "root");
  await mkdir(root);
  await writeFile(path.join(root, "a.txt"), "a");
  let now = Date.now();
  let seed = 7;
  const core = createWorkerCore({
    nodeId: "node-a", dataDir: path.join(dir, "data"), watch: false, emit: () => {},
    clock: { now: () => now++, setTimeout: () => ({ cancel() {} }) }, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
  });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const key = "project:p1";
  const configure = (phase: Phase) => core.call("configure", {
    enabled: true, hostId: "host", peers: [], records: { engines: [], settings: [] },
    shares: [{ key, projectId: "p1", kind: "project", root, phase, rules: {}, peers: ["node-b"] }],
  });
  await configure("bootstrapping");
  await core.call("scan", { share: key, scope: "full", reason: "switch" });
  // The peer is on built-in sync since its seq 4: its pages say so, and the status hands it to the bootstrap.
  await core.need.storeRemote(key, "node-b", 0, { indexId: "b-gen", maxSeq: 6, digest: "0".repeat(64), prunedBelow: 0, builtinSince: 4, entries: [], more: false });
  await core.need.idle();
  const [before] = await core.call("status", { shares: [key] });
  assert.equal(before.builtinSince, null);
  assert.equal(before.peers[0].builtinSince, 4);
  await core.call("bootstrap", { share: key, builtinSinceByPeer: { "node-b": 4 } });
  const [after] = await core.call("status", { shares: [key] });
  assert.equal(after.builtinSince, after.maxSeq);
  await configure("builtin");
  assert.equal((await core.call("status", { shares: [key] }))[0].builtinSince, after.maxSeq, "kept while on built-in sync");
  await configure("restoring");
  assert.equal((await core.call("status", { shares: [key] }))[0].builtinSince, null, "a later switch decides the Syncthing-era rows as such again");
});

test("the switch's routes are the node admin's only", async () => {
  const { isAdminRoute } = await import("../src/server/admin.js");
  for (const [method, route] of [["GET", "/file-sync/projects"], ["GET", "/file-sync/engine/checks"], ["POST", "/file-sync/engine"], ["POST", "/File-Sync/Engine/"]]) {
    assert.equal(isAdminRoute(method, route), true, `${method} ${route}`);
  }
});
