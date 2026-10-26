import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conflictCopyName } from "../src/file-sync/conflicts.js";
import { controlDatabase, setPhase } from "../src/file-sync/control.js";
import {
  assertProjectFilesReady, builtinProjectStatus, type EngineApi, noteHandoffFiles, peerFilesReady, ProjectFilesNotReadyError, projectFilesHandoffPart,
  projectSyncStatuses, rescanProjectFiles, taskShareStatuses, useFacadeEngineForTests, worktreeFilesChanged, worktreeHasPendingFiles, worktreeSweepRefusal,
} from "../src/file-sync/facade.js";
import type { FileSyncPeerFacts, FileSyncProjectView } from "../src/file-sync/index.js";
import { FILE_SYNC_PROTOCOL, type PeerShareStatus, type PendingFiles, type ShareStatus } from "../src/file-sync/protocol.js";
import type { ShareKind } from "../src/file-sync/types.js";
import type { StatusAnswer, StatusBody } from "../src/file-sync/wire.js";
import type { ProjectRecord, TaskRecord } from "../src/types.js";

/* app-integration (P4): the facade dispatches per project between Syncthing and the built-in engine.
   The engine's main-thread answers come from a stand-in (useFacadeEngineForTests), Syncthing from a
   fake REST server, phases from this process's node.db. */

const PEER = "00000000-0000-4000-8000-0000000000b2";
const OTHER = "00000000-0000-4000-8000-0000000000b3";

// Syncthing's connection is discovered once per process: the fake must be in place before anything asks.
const syncthingRequests: string[] = [];
const syncthingFolders: Array<{ id: string; path: string }> = [];
const fakeSyncthing = createServer((request, response) => {
  syncthingRequests.push(`${request.method} ${request.url}`);
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/rest/config/folders") { response.end(JSON.stringify(syncthingFolders.map((folder) => ({ ...folder, label: folder.id, type: "sendreceive", devices: [] })))); return; }
  if (request.url?.startsWith("/rest/db/status?")) { response.end(JSON.stringify({ state: "idle", needTotalItems: 0, needBytes: 0, errors: 0 })); return; }
  if (request.method === "POST" && request.url?.startsWith("/rest/db/scan?")) { response.end(); return; }
  response.statusCode = 404;
  response.end();
});
await new Promise<void>((resolve) => fakeSyncthing.listen(0, "127.0.0.1", resolve));
fakeSyncthing.unref();
for (const key of ["JOINT_BOB_SYNCTHING_URL", "JOINT_BOB_SYNCTHING_API_KEY", "PI_MOBILE_WEB_SYNCTHING_URL", "PI_MOBILE_WEB_SYNCTHING_API_KEY"]) delete process.env[key];
process.env.JOINT_BOB_SYNCTHING_URL = `http://127.0.0.1:${(fakeSyncthing.address() as { port: number }).port}`;
process.env.JOINT_BOB_SYNCTHING_API_KEY = "test-key";
test.after(() => new Promise<void>((resolve) => fakeSyncthing.close(() => resolve())));

function peerEntry(peer: string, overrides: Partial<PeerShareStatus> = {}): PeerShareStatus {
  return { peer, cursor: 5, peerMaxSeq: 5, peerIndexId: "theirs", peerDigest: null, rulesMatch: true, caughtUp: true, differences: 0, cleanSince: null, route: "direct", ...overrides };
}

function share(projectId: string, kind: ShareKind, overrides: Partial<ShareStatus> = {}): ShareStatus {
  return {
    share: `${kind}:${projectId}`, projectId, kind, state: "idle", phase: "builtin", maxSeq: 7, indexId: `ours-${kind}`, digest: "d", rulesHash: "r",
    liveFiles: 3, liveBytes: 30, need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, scanning: false, watch: "watching", peers: [peerEntry(PEER)], ...overrides,
  };
}

function view(projectId: string, overrides: Partial<FileSyncProjectView> = {}, shares?: ShareStatus[]): FileSyncProjectView {
  return {
    worker: "running", enabled: true,
    shares: shares ?? (["project", "tickets", "worktrees"] as const).map((kind) => share(projectId, kind)),
    peers: { project: [PEER], tickets: [PEER], worktrees: [PEER] }, ...overrides,
  };
}

interface Stand {
  views: Map<string, FileSyncProjectView>;
  facts: Record<string, FileSyncPeerFacts>;
  flush?: (projectId: string, kinds: readonly ShareKind[], timeoutMs: number) => Promise<void>;
  handoff?: (peer: string, body: StatusBody) => StatusAnswer | undefined;
  rescan?: Array<{ kind: ShareKind; error?: string }>;
  /** The worker's count of a share's need under a prefix; by default the share's whole need, all of it from present peers. */
  pending?: (projectId: string, kind: ShareKind, prefix: string, availablePeers: readonly string[]) => PendingFiles | undefined;
  pulled: Set<string>;
  calls: { flush: unknown[]; rescan: string[]; scan: unknown[]; prioritize: unknown[]; handoff: Array<{ peer: string; body: StatusBody }>; pending: unknown[] };
}

function standIn(): Stand {
  const stand: Stand = { views: new Map(), facts: {}, pulled: new Set(), calls: { flush: [], rescan: [], scan: [], prioritize: [], handoff: [], pending: [] } };
  const engine: EngineApi = {
    fileSyncProjectViews: async (ids) => new Map(ids.map((id) => [id, stand.views.get(id) ?? view(id, { worker: "off", enabled: false }, [])])),
    fileSyncPeerFacts: async (peers) => ({ local: "laptop", peers: new Map([...peers].map((peer) => [peer, stand.facts[peer] ?? { name: peer === PEER ? "homeserver" : peer, present: true, protocol: FILE_SYNC_PROTOCOL, enabled: true }])) }),
    fileSyncFlushProject: async (projectId, kinds, timeoutMs) => { stand.calls.flush.push({ projectId, kinds: [...kinds], timeoutMs }); await stand.flush?.(projectId, kinds, timeoutMs); },
    fileSyncRescanProject: async (projectId) => { stand.calls.rescan.push(projectId); return stand.rescan ?? []; },
    fileSyncScanPaths: (projectId, kind, paths) => { stand.calls.scan.push({ projectId, kind, paths: [...paths] }); },
    fileSyncPrioritize: (projectId, kind, prefix) => { stand.calls.prioritize.push({ projectId, kind, prefix }); },
    fileSyncHandoffStatus: async (peer, body) => { stand.calls.handoff.push({ peer, body }); return stand.handoff?.(peer, body); },
    fileSyncPulledSinceStart: (key, peer) => stand.pulled.has(`${key}\n${peer}`),
    fileSyncPendingFiles: async (projectId, kind, prefix, availablePeers) => {
      stand.calls.pending.push({ projectId, kind, prefix, availablePeers: [...availablePeers] });
      if (stand.pending) return stand.pending(projectId, kind, prefix, availablePeers);
      const need = stand.views.get(projectId)?.shares.find((candidate) => candidate.kind === kind)?.need ?? { files: 0, bytes: 0 };
      return { files: need.files, bytes: need.bytes, waiting: { files: 0, bytes: 0, peers: [] } };
    },
  };
  useFacadeEngineForTests(engine);
  return stand;
}

function record(id: string, syncFolderId?: string): ProjectRecord {
  return { id, name: id, path: path.join(os.tmpdir(), id), ...(syncFolderId ? { syncFolderId } : {}), createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z" };
}

const facts = (peers: Record<string, Partial<FileSyncPeerFacts>> = {}) => ({
  local: "laptop",
  peers: new Map(Object.entries({ [PEER]: {}, ...peers }).map(([peer, known]) => [peer, { name: peer === PEER ? "homeserver" : peer, present: true, protocol: FILE_SYNC_PROTOCOL, enabled: true, ...known }])),
});

// Phases left behind would be switches for a started engine to resume (the last test starts one).
test.afterEach(async () => {
  useFacadeEngineForTests(undefined);
  (await controlDatabase()).prepare("DELETE FROM file_sync_phases").run();
});

test("a built-in project's status covers every state, in order, with plain texts", () => {
  const id = "status-project";
  const synced = builtinProjectStatus(view(id), facts());
  assert.deepEqual(synced, { state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Files are up to date", engine: "builtin" });

  const copying = builtinProjectStatus(view(id, {}, [share(id, "project", { need: { files: 312, bytes: Math.round(4.1 * 1024 * 1024) }, peers: [peerEntry(PEER, { caughtUp: false, cursor: 3 })] })]), facts());
  assert.deepEqual([copying.state, copying.remainingFiles, copying.message], ["syncing", 312, "Copying 312 files (4.1 MB) from homeserver"]);
  const one = builtinProjectStatus(view(id, {}, [share(id, "project", { need: { files: 1, bytes: 10 } })]), facts());
  assert.equal(one.message, "Copying 1 file (10 B) from homeserver", "every present peer stands in when none is ahead");
  assert.equal(builtinProjectStatus(view(id, { worker: "starting" }), facts()).message, "Starting file sync");
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { state: "starting" })]), facts()).message, "Starting file sync");
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { scanning: true, state: "scanning" })]), facts()).message, "Checking files");
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { peers: [peerEntry(PEER, { caughtUp: false })] })]), facts()).message, "Catching up with homeserver");
  // An away peer's newer files cannot come until it is back: that is not syncing.
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { peers: [peerEntry(PEER, { caughtUp: false })] })]), facts({ [PEER]: { present: false } })).state, "synced");

  assert.deepEqual(builtinProjectStatus(view(id, {}, [share(id, "project", { blocked: 2 })]), facts()).message, "2 files could not be synchronized");
  assert.deepEqual(builtinProjectStatus(view(id, {}, [share(id, "project", { errors: 1 })]), facts()).message, "1 file could not be read or written");
  assert.deepEqual(builtinProjectStatus(view(id, { worker: "failed" }), facts()), { state: "error", remainingFiles: 0, remainingBytes: 0, message: "File sync stopped on this node after repeated failures", engine: "builtin" });
  assert.equal(builtinProjectStatus(view(id), facts({ [PEER]: { enabled: false } })).message, "File sync is off on homeserver");
  assert.equal(builtinProjectStatus(view(id), facts({ [PEER]: { protocol: 0 } })).message, "homeserver runs a Joint Bob without the built-in file sync");
  // fix (P4+P5): 2.157 and 2.158 have the engine but never leave Syncthing for a switched project.
  assert.deepEqual(builtinProjectStatus(view(id), facts({ [PEER]: { protocol: 1 } })), { state: "error", remainingFiles: 0, remainingBytes: 0, message: "homeserver needs a newer Joint Bob to receive these files", engine: "builtin" });
  // fix (P4+P5): no machine that could send is around: the files wait for it, nothing is being copied.
  const away = builtinProjectStatus(view(id, {}, [share(id, "worktrees", { need: { files: 1, bytes: 10 } })]), facts({ [PEER]: { present: false } }));
  assert.deepEqual([away.state, away.message], ["syncing", "1 file (10 B) waiting for homeserver, which is away"]);

  assert.deepEqual(builtinProjectStatus(view(id, { worker: "off", enabled: false }, []), facts()), { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "File sync is off on this node", engine: "builtin" });
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { state: "unavailable", message: "The folder is missing" })]), facts()).message, "The folder is missing");
  assert.equal(builtinProjectStatus(view(id, { peers: {} }, []), facts()).message, "No other machine shares this project right now");
  // fix: writes held until Syncthing answers a first time are a problem to show, not syncing; a move in progress is syncing.
  assert.deepEqual(builtinProjectStatus(view(id, { writesHeld: "Waiting for Syncthing to answer before writing files" }), facts()),
    { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "Built-in sync is not writing files here yet: Waiting for Syncthing to answer before writing files", engine: "builtin" });
  assert.deepEqual([builtinProjectStatus(view(id, {}, [share(id, "project", { phase: "bootstrapping" })]), facts()).state, builtinProjectStatus(view(id, {}, [share(id, "project", { phase: "bootstrapping" })]), facts()).message], ["syncing", "Moving to built-in sync"]);
  // Error beats unavailable beats syncing.
  assert.equal(builtinProjectStatus(view(id, {}, [share(id, "project", { state: "unavailable" }), share(id, "tickets", { blocked: 1 }), share(id, "worktrees", { need: { files: 4, bytes: 4 } })]), facts()).state, "error");
});

test("a mixed node asks Syncthing only about projects still on it", async () => {
  const stand = standIn();
  const db = await controlDatabase();
  const onSyncthing = record("mixed-syncthing", "folder-mixed"), builtin = record("mixed-builtin", "folder-builtin"), moving = record("mixed-moving", "folder-moving"), backward = record("mixed-restoring", "folder-restoring");
  setPhase(db, builtin.id, "builtin");
  setPhase(db, moving.id, "releasing");
  setPhase(db, backward.id, "restoring");
  stand.views.set(builtin.id, view(builtin.id, {}, [share(builtin.id, "project", { need: { files: 2, bytes: 2048 } })]));
  syncthingFolders.push({ id: "folder-mixed", path: onSyncthing.path });
  syncthingRequests.length = 0;
  const statuses = await projectSyncStatuses([onSyncthing, builtin, moving, backward]);
  assert.deepEqual(statuses[onSyncthing.id], { state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Safe to start work" });
  assert.deepEqual(statuses[builtin.id], { state: "syncing", remainingFiles: 2, remainingBytes: 2048, message: "Copying 2 files (2.0 KB) from homeserver", engine: "builtin" });
  assert.deepEqual(statuses[moving.id], { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Moving to the built-in file sync", engine: "moving" });
  assert.equal(statuses[backward.id].message, "Moving back to Syncthing");
  assert.deepEqual(syncthingRequests, ["GET /rest/config/folders", "GET /rest/db/status?folder=folder-mixed"], "Syncthing is never asked about a project it no longer holds");
});

test("Rescan files walks the engine's folders for a built-in project and asks Syncthing for the rest", async () => {
  const stand = standIn();
  const { addProject } = await import("../src/store.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-facade-rescan-"));
  try {
    const project = await addProject("Rescan builtin", path.join(root, "project"), { writeInstructions: false });
    setPhase(await controlDatabase(), project.id, "builtin");
    syncthingRequests.length = 0;
    await rescanProjectFiles(project.id);
    assert.deepEqual(stand.calls.rescan, [project.id]);
    assert.deepEqual(syncthingRequests, []);
    stand.rescan = [{ kind: "tickets", error: "The folder is missing" }];
    await rescanProjectFiles(project.id);
    stand.rescan = [{ kind: "project", error: "The folder is a symbolic link" }];
    await assert.rejects(rescanProjectFiles(project.id), { message: "The folder is a symbolic link" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a handoff check on a built-in project flushes for 10 s at most, then wants no need, block or error", async () => {
  const stand = standIn();
  const project = record("ready-project");
  setPhase(await controlDatabase(), project.id, "builtin");
  stand.views.set(project.id, view(project.id));
  await assertProjectFilesReady(project, "project");
  assert.deepEqual(stand.calls.flush, [{ projectId: project.id, kinds: ["project"], timeoutMs: 10_000 }]);

  // The bridge gives up on a flush that outlasts its time limit: still checking, worth waiting for.
  stand.flush = async () => { throw new Error("File sync worker did not answer flush within 10 s"); };
  const timedOut = await assertProjectFilesReady(project, "project").then(() => undefined, (error: unknown) => error);
  assert.ok(timedOut instanceof ProjectFilesNotReadyError);
  assert.deepEqual([timedOut.retryable, timedOut.status.state, timedOut.status.message], [true, "syncing", "Checking files"]);
  stand.flush = undefined;

  stand.views.set(project.id, view(project.id, {}, [share(project.id, "project", { need: { files: 3, bytes: 300 } })]));
  await assert.rejects(assertProjectFilesReady(project, "project"), (error: ProjectFilesNotReadyError) => error.retryable && error.status.remainingFiles === 3 && /3 files still arriving/.test(error.message));
  stand.views.set(project.id, view(project.id, {}, [share(project.id, "project", { blocked: 1 })]));
  await assert.rejects(assertProjectFilesReady(project, "project"), (error: ProjectFilesNotReadyError) => !error.retryable && error.status.state === "error");
  stand.views.set(project.id, view(project.id, { worker: "restarting" }));
  await assert.rejects(assertProjectFilesReady(project, "project"), (error: ProjectFilesNotReadyError) => error.retryable && error.status.message === "Starting file sync");
  // Only the asked folder counts: a ticket folder still copying does not hold the project's.
  stand.views.set(project.id, view(project.id, {}, [share(project.id, "project"), share(project.id, "tickets", { need: { files: 9, bytes: 9 } })]));
  await assertProjectFilesReady(project, "project");
  setPhase(await controlDatabase(), project.id, "bootstrapping");
  await assert.rejects(assertProjectFilesReady(project, "project"), (error: ProjectFilesNotReadyError) => error.retryable && error.status.message === "Moving to the built-in file sync");
});

test("the source's part travels in eligibility and prepare bodies; an old destination drops it and a new one waits for it", async () => {
  const stand = standIn();
  const db = await controlDatabase();
  const project = record("handoff-project");
  setPhase(db, project.id, "builtin");
  stand.views.set(project.id, view(project.id));
  const task = { id: "t1", projectId: project.id, title: "Ticket", currentNodeId: OTHER, worktreePath: "/tmp/ws/t1", worktreeBranch: null } as unknown as TaskRecord;

  const { taskHandoffFiles } = await import("../src/server/cluster-helpers.js");
  const files = await taskHandoffFiles(project, task, 1_500);
  assert.deepEqual(files, { fileSync: { projectId: project.id, shares: [{ kind: "tickets", indexId: "ours-tickets", maxSeq: 7 }] } }, "a synchronized ticket workspace hands over its ticket folder");
  assert.deepEqual(stand.calls.flush.at(-1), { projectId: project.id, kinds: ["tickets"], timeoutMs: 1_500 });
  const onSyncthing = record("handoff-syncthing");
  assert.deepEqual(await taskHandoffFiles(onSyncthing, task, 1_500), {}, "a Syncthing project sends exactly what it always did");

  // An older destination parses with today's schemas: the part goes, nothing else changes.
  const { preparedTaskSchema, taskEligibilitySchema } = await import("../src/server/schemas.js");
  const eligibilityBody = { projectId: project.id, task, source: false, ...files };
  assert.deepEqual(taskEligibilitySchema.parse(JSON.parse(JSON.stringify(eligibilityBody))), { projectId: project.id, task: JSON.parse(JSON.stringify(task)), source: false });
  const prepareBody = { projectId: project.id, task, handoffId: randomUUID(), handoffContext: "", handoffVersion: new Date().toISOString(), bundle: null, ...files };
  assert.equal("fileSync" in preparedTaskSchema.parse(JSON.parse(JSON.stringify(prepareBody))), false);

  // A new destination takes it from the signed runtime request, before the handler's schema drops it.
  const { dispatchSignedRuntime } = await import("../src/server/runtime-peers.js");
  const request = { path: "/api/cluster/v2/runtime/tasks/eligibility", method: "POST", url: "/api/cluster/v2/runtime/tasks/eligibility", body: { projectId: project.id, task, fileSync: files.fileSync } };
  let forwarded = false;
  dispatchSignedRuntime(request as never, { locals: { machineNodeId: PEER } } as never, () => { forwarded = true; });
  assert.deepEqual([forwarded, request.url], [true, "/api/cluster/tasks/eligibility"]);

  // Behind the source: the worker was asked at once (pull, priority) and the destination says so.
  let answer: StatusAnswer = { shares: [{ kind: "tickets", state: "idle", cursor: 4, callerIndexId: "ours-tickets", need: { files: 0, bytes: 0 }, blocked: 0, errors: 0, digest: "a".repeat(64), maxSeq: 2 }] };
  stand.handoff = () => answer;
  const target = [{ kind: "tickets" as const, label: "Ticket workspace" }];
  const behind = await taskShareStatuses(project, target);
  assert.deepEqual(behind, [{ label: "Ticket workspace", state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking what changed on homeserver" }]);
  assert.deepEqual(stand.calls.handoff[0], { peer: PEER, body: files.fileSync });
  answer = { shares: [{ ...answer.shares[0], cursor: 7, need: { files: 312, bytes: 4_299_162 } }] };
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(await taskShareStatuses(project, target), [{ label: "Ticket workspace", state: "syncing", remainingFiles: 312, remainingBytes: 4_299_162, message: "Copying files to laptop" }]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await assert.rejects(assertProjectFilesReady(project, "tickets"), (error: ProjectFilesNotReadyError) => error.retryable && error.status.message === "Copying files to laptop");
  answer = { shares: [{ ...answer.shares[0], need: { files: 0, bytes: 0 } }] };
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(await taskShareStatuses(project, target), [{ label: "Ticket workspace", state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Files are up to date" }]);
  await assertProjectFilesReady(project, "tickets");
  // Another generation of the source's index is not "caught up", whatever the number says.
  answer = { shares: [{ ...answer.shares[0], callerIndexId: "older", cursor: 99 }] };
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await taskShareStatuses(project, target))[0].state, "syncing");
  // A worker that cannot answer reads as still checking, never as ready.
  stand.handoff = () => undefined;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual((await taskShareStatuses(project, target)).map((status) => [status.state, status.message]), [["syncing", "Checking files"]]);

  // A part for another project, or an unreadable one, is dropped like an old node drops it.
  const before = stand.calls.handoff.length;
  noteHandoffFiles(OTHER, "someone-else", files.fileSync);
  noteHandoffFiles(OTHER, project.id, { projectId: project.id, shares: [{ kind: "tickets", indexId: "bad id!", maxSeq: 1 }] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stand.calls.handoff.length, before);
  assert.deepEqual(await projectFilesHandoffPart(record("handoff-off"), ["project"], 1_500), undefined);
});

test("worktree files still arriving hold merges and are moved up the queue", async () => {
  const stand = standIn();
  const db = await controlDatabase();
  const id = "pending-project";
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false, "Syncthing projects keep today's answer");
  setPhase(db, id, "builtin");
  stand.views.set(id, view(id));
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false);
  stand.views.set(id, view(id, {}, [share(id, "worktrees", { need: { files: 2, bytes: 20 } })]));
  assert.equal(await worktreeHasPendingFiles(id, "w1"), true);
  assert.deepEqual(stand.calls.prioritize, [{ projectId: id, kind: "worktrees", prefix: "w1" }]);
  stand.views.set(id, view(id, {}, [share(id, "worktrees", { peers: [peerEntry(PEER, { caughtUp: false, cursor: 3, peerMaxSeq: 9 })] })]));
  assert.equal(await worktreeHasPendingFiles(id, "w1"), true, "a present peer announcing more than this node holds");
  stand.facts[PEER] = { name: "homeserver", present: false, protocol: FILE_SYNC_PROTOCOL, enabled: true };
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false, "an away peer cannot send it now");
  stand.views.set(id, view(id, {}, [share(id, "worktrees", { state: "starting" })]));
  assert.equal(await worktreeHasPendingFiles(id, "w1"), true, "not reported yet");
  stand.views.set(id, view(id, { worker: "off" }));
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false, "an engine that is off sends nothing, and must not hold the worktree for good");
  setPhase(db, id, "restoring");
  assert.equal(await worktreeHasPendingFiles(id, "w1"), true, "moving between engines");
  worktreeFilesChanged(id, "/somewhere/w1/.joint-bob-worktree/worktree.json");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(stand.calls.scan, [{ projectId: id, kind: "worktrees", paths: ["/somewhere/w1/.joint-bob-worktree/worktree.json"] }], "the engine scans the written path now");
});

// fix (P4+P5): need is counted under the worktree being merged, from machines that can send it now.
test("a merge waits only for its own worktree's files, and only while a machine that has them can send", async () => {
  const stand = standIn();
  const db = await controlDatabase();
  const id = "pending-narrow";
  setPhase(db, id, "builtin");
  stand.views.set(id, view(id, {}, [share(id, "worktrees", { need: { files: 1, bytes: 10 } })]));
  const nothing = { files: 0, bytes: 0, waiting: { files: 0, bytes: 0, peers: [] } };
  // The one file on its way belongs to w2: w1 merges now, w2 waits for it.
  stand.pending = (_project, _kind, prefix) => prefix === "w2" ? { ...nothing, files: 1, bytes: 10 } : nothing;
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false, "another worktree's file does not hold this one");
  assert.deepEqual(stand.calls.prioritize, [], "nothing of w1 goes up the queue");
  assert.equal(await worktreeHasPendingFiles(id, "w2"), true);
  assert.deepEqual(stand.calls.pending.at(-1), { projectId: id, kind: "worktrees", prefix: "w2", availablePeers: [PEER] });
  assert.deepEqual(stand.calls.prioritize, [{ projectId: id, kind: "worktrees", prefix: "w2" }]);
  // Only a machine that is asleep has it: nothing can come now, so the merge does not wait for days.
  stand.pending = () => ({ ...nothing, waiting: { files: 1, bytes: 10, peers: [OTHER] } });
  assert.equal(await worktreeHasPendingFiles(id, "w2"), false);
  // The worker does not answer in time: held while a machine that could send is around.
  stand.pending = () => { throw new Error("File sync took too long to answer"); };
  assert.equal(await worktreeHasPendingFiles(id, "w1"), true);
  // Every machine away: nothing is asked, nothing is held, and the status names who the files wait for.
  stand.facts[PEER] = { name: "homeserver", present: false, protocol: FILE_SYNC_PROTOCOL, enabled: true };
  const asked = stand.calls.pending.length;
  assert.equal(await worktreeHasPendingFiles(id, "w1"), false);
  assert.equal(stand.calls.pending.length, asked);
  const project = record(id);
  assert.equal((await projectSyncStatuses([project]))[id].message, "1 file (10 B) waiting for homeserver, which is away");
});

test("peer readiness reads Syncthing for its projects and this node's cursors for built-in ones", async () => {
  const stand = standIn();
  const { addProject } = await import("../src/store.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-facade-peer-"));
  try {
    const builtin = await addProject("Peer builtin", path.join(root, "b"), { writeInstructions: false });
    setPhase(await controlDatabase(), builtin.id, "builtin");
    stand.views.set(builtin.id, view(builtin.id, { peers: { project: [PEER, OTHER] } }, [share(builtin.id, "project", { peers: [peerEntry(PEER), peerEntry(OTHER, { caughtUp: false })] })]));
    syncthingRequests.length = 0;
    assert.deepEqual(await peerFilesReady(PEER, [builtin.id]), { ready: true, statuses: { [builtin.id]: { state: "synced", remainingFiles: 0, remainingBytes: 0, message: "Files are up to date" } } }, "another machine being behind does not hold back this one");
    assert.equal((await peerFilesReady(OTHER, [builtin.id])).ready, false);
    assert.deepEqual(syncthingRequests, [], "no network request for built-in projects");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the sweep and done-cleanup keep a built-in project's worktree while its files arrive or another machine made it", async (t) => {
  const stand = standIn();
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-facade-sweep-"));
  process.env.JOINT_BOB_WORKTREE_ROOT = path.join(root, "worktrees");
  t.after(async () => { delete process.env.JOINT_BOB_WORKTREE_ROOT; await rm(root, { recursive: true, force: true }); });
  const [{ addProject }, worktrees, { cleanupDoneWorktrees }, { setSessionDone }, { getClusterNode }] = await Promise.all([
    import("../src/store.js"), import("../src/project-worktrees.js"), import("../src/server/worktree-cleanup.js"), import("../src/names.js"), import("../src/cluster.js"),
  ]);
  const source = path.join(root, "project");
  await mkdir(source);
  await writeFile(path.join(source, "index.ts"), "export const value = 1;\n");
  const project = await addProject("Sweep fixture", source, { writeInstructions: false });
  setPhase(await controlDatabase(), project.id, "builtin");
  stand.views.set(project.id, view(project.id, {}, [share(project.id, "worktrees", { need: { files: 1, bytes: 1 } })]));
  const own = await worktrees.createProjectWorktree(project, { name: "own" });
  const sessionId = randomUUID();
  await worktrees.markWorktreeConversation(project.id, own.id, "pi", sessionId);
  await setSessionDone(sessionId, true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(stand.calls.scan.some((call) => (call as { paths: string[] }).paths.includes(own.path)), "a new worktree is scanned at once");

  let result = await cleanupDoneWorktrees(project);
  assert.deepEqual(result.deletedWorktreeIds, []);
  assert.equal(result.retainedWorktrees[own.id], "Worktree kept: its files are still arriving from another machine");
  await access(own.path);
  await assert.rejects(worktrees.mergeProjectWorktree(project, own.id), { status: 409, message: "Files of this worktree are still arriving from another machine; merge again in a moment" });

  // Another machine's worktree whose markers may not be here yet: only after a pull from every peer since this node started.
  stand.views.set(project.id, view(project.id));
  const foreign = await worktrees.createProjectWorktree(project, { name: "foreign" });
  const metadataPath = path.join(foreign.path, worktrees.WORKTREE_META_DIR, "worktree.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { createdByNodeId: string; createdAt: string };
  assert.equal(metadata.createdByNodeId, (await getClusterNode()).id);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, createdByNodeId: OTHER, createdAt: new Date(Date.now() - 3_600_000).toISOString() }));
  assert.match(await worktreeSweepRefusal(project.id, { id: foreign.id, createdByNodeId: OTHER }) ?? "", /another machine created it and this node has not caught up with homeserver since it started/);
  stand.pulled.add(`worktrees:${project.id}\n${PEER}`);
  assert.equal(await worktreeSweepRefusal(project.id, { id: foreign.id, createdByNodeId: OTHER }), undefined);
  assert.equal(await worktreeSweepRefusal(project.id, { id: own.id, createdByNodeId: (await getClusterNode()).id }), undefined, "its own worktree needs no pull");

  result = await cleanupDoneWorktrees(project);
  assert.ok(result.deletedWorktreeIds.includes(own.id), JSON.stringify(result));
  await assert.rejects(access(own.path), { code: "ENOENT" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(stand.calls.scan.some((call) => (call as { paths: string[] }).paths.includes(own.path)), "the deletion is scanned at once");
});

test("the sync check recognises the built-in engine's conflict copies and times them by when they appeared", async () => {
  const { conflictOriginalPath, findSyncConflicts, resolveTrivialConflict, syncResolverPrompt, SYNC_FIXER_OPENING } = await import("../src/server/sync-check.js");
  const { isInternalSession } = await import("../src/internal-sessions.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-facade-conflicts-"));
  try {
    const twoDaysAgo = Date.now() - 2 * 24 * 3_600_000;
    const copy = conflictCopyName("notes/plan.md", { mtimeMs: twoDaysAgo, modifiedBy: PEER });
    assert.equal(conflictOriginalPath(path.join(root, copy)), path.join(root, "notes/plan.md"));
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes/plan.md"), "ours\n");
    await writeFile(path.join(root, copy), "theirs\n");
    // The engine gives the copy the losing version's mtime; it appeared just now.
    await utimes(path.join(root, copy), new Date(twoDaysAgo), new Date(twoDaysAgo));
    const [builtin] = await findSyncConflicts("p", root, { builtin: true });
    assert.deepEqual([builtin.builtin, builtin.relativePath], [true, path.join("notes", "plan.md")]);
    assert.equal(await resolveTrivialConflict(builtin), "settling", "a copy that just appeared is left alone for a while");
    assert.equal(await resolveTrivialConflict(builtin, Date.now() + 5 * 60_000), "needs-agent", "and is not stale for its losing version's age");
    const [syncthing] = await findSyncConflicts("p", root);
    assert.equal(await resolveTrivialConflict(syncthing, Date.now() + 5 * 60_000), "stale", "Syncthing's copies keep their stamp's meaning");
    assert.ok(syncResolverPrompt([]).startsWith(SYNC_FIXER_OPENING));
    assert.equal(/Syncthing/.test(syncResolverPrompt([])), false);
    assert.ok(isInternalSession(randomUUID(), syncResolverPrompt([])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* The engine's own half of it (index.ts): calls reach a stand-in worker, pulls are counted from its reports. */

test("the engine's calls for the facade reach the worker, bounded, and pulls count only after this node started", { timeout: 60_000 }, async (t) => {
  const [{ getClusterNode }, { clusterV2Database }, { getOrCreateClusterIdentity, pinClusterPublicKey }, { ensurePeerEndpointSchema, recordPeerEndpoint }, { ensureResourceSharingSchema }, policy, { workerLaunch }, index] = await Promise.all([
    import("../src/cluster.js"), import("../src/cluster-v2-store.js"), import("../src/cluster-identity.js"), import("../src/cluster-peer-endpoints.js"), import("../src/cluster-sharing.js"),
    import("../src/cluster-sharing-policy.js"), import("../src/file-sync/bridge.js"), import("../src/file-sync/index.js"),
  ]);
  const saved = Object.fromEntries(["JOINT_BOB_FILE_SYNC", "JOINT_BOB_FILE_SYNC_PROJECTS", "JOINT_BOB_FILE_SYNC_LISTEN", "JOINT_BOB_FILE_SYNC_PORT"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, { JOINT_BOB_FILE_SYNC: "1", JOINT_BOB_FILE_SYNC_PROJECTS: "engine-alpha", JOINT_BOB_FILE_SYNC_LISTEN: "127.0.0.1", JOINT_BOB_FILE_SYNC_PORT: "22756" });
  const work = await mkdtemp(path.join(os.tmpdir(), "jb-facade-engine-"));
  const log = path.join(work, "ops.jsonl");
  const cluster = "10000000-0000-4000-8000-0000000000c1";
  const now = new Date().toISOString();
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  getOrCreateClusterIdentity(db, local);
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT 'personal', color TEXT,
    path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  policy.createSharingCluster(db, { id: cluster, name: "facade" }, local);
  policy.addSharingMember(db, cluster, local, PEER, policy.getSharingCluster(db, cluster).managerEpoch);
  recordPeerEndpoint(db, { kind: "cluster", id: cluster }, { nodeId: PEER, name: "homeserver", url: "https://peer.example.com" });
  pinClusterPublicKey(db, PEER, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
  const projectRoot = path.join(work, "alpha");
  db.prepare("INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('engine-alpha', 'alpha', ?, ?, ?)").run(projectRoot, now, now);
  policy.registerOwnedResource(db, { kind: "project", id: "engine-alpha", ownerNodeId: local }, local);
  db.prepare("INSERT INTO cluster_v2_resource_policy VALUES ('project', 'engine-alpha', ?, 1, 0)").run(local);
  policy.setResourceShares(db, local, "project", "engine-alpha", [{ clusterId: cluster, projectId: null }]);

  const report = (kind: ShareKind, peer: Partial<PeerShareStatus>) => ({ event: "shareState", status: { ...share("engine-alpha", kind, { phase: "syncthing", maxSeq: 9, indexId: `idx-${kind}` }), peers: [peerEntry(PEER, peer)] } });
  const statusAnswer = { shares: [{ kind: "project", state: "idle", cursor: 4, callerIndexId: "theirs", need: { files: 1, bytes: 5 }, blocked: 0, errors: 0, digest: "b".repeat(64), maxSeq: 9 }] };
  index.useFileSyncWorkerForTests({
    launch: workerLaunch(new URL("./fixtures/file-sync-control-worker.js", import.meta.url)),
    workerData: {
      log, origins: [],
      emit: {
        // What the worker knew at its start: caught up from stored cursors, which prove nothing about now.
        configure: [report("project", { cursor: 5, caughtUp: true }), report("worktrees", { cursor: 2, caughtUp: false }), report("tickets", { cursor: 1 })],
        // A pull of the worktree folder completed; the project folder's report did not move.
        announce: [report("worktrees", { cursor: 6, caughtUp: true }), report("project", { cursor: 5, caughtUp: true })],
      },
      answers: { serve: { status: 200, headers: { "content-type": "application/json" }, json: statusAnswer, stream: false }, scan: { share: "project:engine-alpha", changed: 0, tombstones: 0, newGeneration: false, files: 1, hashedBytes: 0, durationMs: 1 } },
    },
  });
  t.after(async () => {
    await index.stopFileSync();
    index.useFileSyncWorkerForTests(undefined);
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(work, { recursive: true, force: true });
  });
  const ops = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { op: string; args: Record<string, unknown> });
  const until = async (done: () => Promise<boolean> | boolean, what: string) => {
    for (const deadline = Date.now() + 20_000; !(await done());) {
      if (Date.now() > deadline) assert.fail(`${what} did not happen: ${JSON.stringify(await ops()).slice(0, 2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  await index.startFileSync();
  await until(async () => (await ops()).some((entry) => entry.op === "announce"), "the announce after the first configure");
  await until(() => index.fileSyncPulledSinceStart("worktrees:engine-alpha", PEER), "the completed worktree pull");
  assert.equal(index.fileSyncPulledSinceStart("project:engine-alpha", PEER), false, "a report that only repeats stored cursors is no pull");
  assert.equal(index.fileSyncPulledSinceStart("tickets:engine-alpha", PEER), false);

  const views = await index.fileSyncProjectViews(["engine-alpha", "nothing"]);
  assert.deepEqual(views.get("engine-alpha")?.shares.map((entry) => [entry.kind, entry.maxSeq, entry.indexId]), [["project", 9, "idx-project"], ["tickets", 9, "idx-tickets"], ["worktrees", 9, "idx-worktrees"]]);
  assert.deepEqual(views.get("engine-alpha")?.peers, { project: [PEER], tickets: [PEER], worktrees: [PEER] });
  assert.deepEqual([views.get("engine-alpha")?.worker, views.get("nothing")?.shares], ["running", []]);
  const peerFacts = await index.fileSyncPeerFacts([PEER]);
  assert.deepEqual(peerFacts.peers.get(PEER)?.name, "homeserver");

  await index.fileSyncFlushProject("engine-alpha", ["project"], 10_000);
  const rescans = await index.fileSyncRescanProject("engine-alpha");
  assert.deepEqual(rescans.map((scan) => scan.kind), ["project", "tickets", "worktrees"]);
  index.fileSyncScanPaths("engine-alpha", "project", [path.join(projectRoot, "src", "a.ts"), path.join(work, "outside.txt")]);
  index.fileSyncPrioritize("engine-alpha", "worktrees", "w1", Date.now() + 1_000);
  const answer = await index.fileSyncHandoffStatus(PEER, { projectId: "engine-alpha", shares: [{ kind: "project", indexId: "theirs", maxSeq: 9 }] });
  assert.deepEqual(answer, statusAnswer);
  await until(async () => (await ops()).some((entry) => entry.op === "prioritize"), "the prioritize op");
  const asked = (await ops()).filter((entry) => ["flush", "scan", "prioritize", "serve"].includes(entry.op));
  assert.deepEqual(asked.map((entry) => entry.op === "prioritize" ? { op: entry.op, args: { ...entry.args, untilMs: typeof entry.args.untilMs } } : entry), [
    { op: "flush", args: { share: "project:engine-alpha" } },
    { op: "scan", args: { share: "project:engine-alpha", scope: "full", reason: "manual" } },
    { op: "scan", args: { share: "tickets:engine-alpha", scope: "full", reason: "manual" } },
    { op: "scan", args: { share: "worktrees:engine-alpha", scope: "full", reason: "manual" } },
    { op: "scan", args: { share: "project:engine-alpha", scope: { paths: ["src/a.ts"] }, reason: "app" } },
    { op: "prioritize", args: { share: "worktrees:engine-alpha", prefix: "w1", untilMs: "number" } },
    { op: "serve", args: { peer: PEER, endpoint: "status", query: {}, body: { projectId: "engine-alpha", shares: [{ kind: "project", indexId: "theirs", maxSeq: 9 }] } } },
  ]);

  // A wake forgets every pull: what peers did while this node slept is unknown until it pulls again.
  index.fileSyncAnnounce(true);
  assert.equal(index.fileSyncPulledSinceStart("worktrees:engine-alpha", PEER), false);
});
