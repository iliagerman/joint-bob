import { z } from "zod";
import { peerAway } from "../peer-presence.js";
import { getProject } from "../store.js";
import { assertSyncthingFolderReady, listSyncthingFolders, rescanSyncthingFolder, syncthingFolderStatuses } from "../syncthing.js";
import { projectTicketSyncFolderId } from "../task-workspaces.js";
import type { ProjectRecord, ProjectSyncStatus } from "../types.js";
import { projectWorktreeSyncFolderId } from "../worktree-filters.js";
import { controlDatabase, listPhases } from "./control.js";
import type { FileSyncPeerFacts, FileSyncProjectView } from "./index.js";
import { FILE_SYNC_SWITCH_PROTOCOL, type ShareStatus } from "./protocol.js";
import { projectSyncStatus } from "./status.js";
import type { Phase, ShareKind } from "./types.js";
import type { StatusAnswer } from "./wire.js";

/* The one place callers ask about a project's files on other machines. The engine is chosen per
   project by its node-local phase (design §7): "syncthing" keeps Syncthing's answers exactly as they
   were, "builtin" answers from the built-in engine's in-memory reports, and the phases in between
   are a move that nothing should start work on. The engine's module loads only for a project that
   is not on Syncthing, so a node without one pays nothing. */

export type ProjectShareKind = "project" | "tickets";
/** Which engine moves a project's files on this node; "moving" while it changes engines. */
export type ProjectFilesEngine = "syncthing" | "builtin" | "moving";
/** What the UI is told besides the status: which engine, so it can tell Syncthing's waits from the built-in engine's. */
export type FacadeSyncStatus = ProjectSyncStatus & { engine?: "builtin" | "moving" };

export class ProjectNotSynchronizedError extends Error {
  constructor() { super("Project is not synchronized"); }
}

/** The built-in engine cannot act for the project on this node right now (off, restarting); `message` says why in plain words. */
export class ProjectFilesUnavailableError extends Error {}

/** A built-in project's files are not ready here; a "syncing" status is worth waiting for, anything else needs a person. */
export class ProjectFilesNotReadyError extends Error {
  constructor(readonly status: ProjectSyncStatus) { super(`Files are not synchronized on this node: ${status.message ?? status.state}`); }
  get retryable(): boolean { return this.status.state === "syncing"; }
}

export function unavailableProjectStatus(message = "No Syncthing folder is configured"): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

function shareFolderId(project: ProjectRecord, kind: ProjectShareKind): string | undefined {
  return kind === "tickets" ? projectTicketSyncFolderId(project.id) : project.syncFolderId;
}

/* ---- engine choice ---- */

/** The engine's main-thread answers the facade uses (index.ts); tests stand one in with useFacadeEngineForTests. */
export type EngineApi = Pick<typeof import("./index.js"),
  "fileSyncProjectViews" | "fileSyncPeerFacts" | "fileSyncFlushProject" | "fileSyncRescanProject" | "fileSyncScanPaths"
  | "fileSyncPrioritize" | "fileSyncHandoffStatus" | "fileSyncPulledSinceStart" | "fileSyncPendingFiles">;

let engineModule: Promise<EngineApi> | undefined;
let engineOverride: EngineApi | undefined;

function engineApi(): Promise<EngineApi> {
  return engineOverride ? Promise.resolve(engineOverride) : (engineModule ??= import("./index.js"));
}

/** Tests: the engine's main-thread answers from a stand-in; undefined restores the real one. */
export function useFacadeEngineForTests(engine: EngineApi | undefined): void {
  engineOverride = engine;
  partCache.clear();
  expectations.clear();
}

export function filesEngineOf(phase: Phase | undefined): ProjectFilesEngine {
  return !phase || phase === "syncthing" ? "syncthing" : phase === "builtin" ? "builtin" : "moving";
}

/** Node-local phases; a node.db that cannot be read counts as everything on Syncthing, as before the engine existed. */
async function phases(): Promise<Map<string, Phase>> {
  try { return new Map([...listPhases(await controlDatabase())].map(([projectId, record]) => [projectId, record.phase])); }
  catch { return new Map(); }
}

async function phaseOfProject(projectId: string): Promise<Phase | undefined> {
  return (await phases()).get(projectId);
}

/** Which engine moves the project's files on this node (design §6.5). */
export async function projectFilesEngine(projectId: string): Promise<ProjectFilesEngine> {
  return filesEngineOf(await phaseOfProject(projectId));
}

/** The same for many projects with one read. */
export async function projectFilesEngines(projectIds: readonly string[]): Promise<Map<string, ProjectFilesEngine>> {
  const held = projectIds.length ? await phases() : new Map<string, Phase>();
  return new Map(projectIds.map((id) => [id, filesEngineOf(held.get(id))]));
}

function movingStatus(phase: Phase | undefined): FacadeSyncStatus {
  return { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: phase === "restoring" ? "Moving back to Syncthing" : "Moving to the built-in file sync", engine: "moving" };
}

/* ---- built-in status texts (pure; exported for tests) ---- */

export interface PeerFacts { local: string; peers: ReadonlyMap<string, FileSyncPeerFacts> }

function plural(count: number, one: string, many = `${one}s`): string { return `${count} ${count === 1 ? one : many}`; }

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function nameOf(facts: PeerFacts, peer: string): string { return facts.peers.get(peer)?.name ?? peer; }
function presentPeer(facts: PeerFacts, peer: string): boolean { return facts.peers.get(peer)?.present ?? !peerAway(peer); }

/** "homeserver", "homeserver and laptop", or "3 other machines". */
function machines(facts: PeerFacts, peers: readonly string[]): string {
  const names = [...new Set(peers)].map((peer) => nameOf(facts, peer));
  if (!names.length) return "other machines";
  return names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.length} other machines`;
}

/** An eligible peer that cannot receive files (design §7 continuous check), named for the person reading it. */
function peerProblem(view: FileSyncProjectView, facts: PeerFacts): string | undefined {
  for (const peer of [...new Set(Object.values(view.peers).flat())].sort()) {
    const known = facts.peers.get(peer);
    if (known?.protocol === 0) return `${nameOf(facts, peer)} runs a Joint Bob without the built-in file sync`;
    // fix (P4+P5): an engine without the switch (2.157, 2.158) stays on Syncthing for the project and receives nothing.
    if (known?.protocol !== undefined && known.protocol < FILE_SYNC_SWITCH_PROTOCOL) return `${nameOf(facts, peer)} needs a newer Joint Bob to receive these files`;
    if (known?.enabled === false) return `File sync is off on ${nameOf(facts, peer)}`;
  }
  return undefined;
}

/** A built-in project's status from its shares (design §6.5); `kinds` narrows it to some of them (a ticket's folder). */
export function builtinProjectStatus(view: FileSyncProjectView, facts: PeerFacts, kinds?: readonly ShareKind[]): FacadeSyncStatus {
  const shares = kinds ? view.shares.filter((share) => kinds.includes(share.kind)) : view.shares;
  const done = (status: ProjectSyncStatus): FacadeSyncStatus => ({ ...status, engine: "builtin" });
  if (view.worker === "failed") return done({ state: "error", remainingFiles: 0, remainingBytes: 0, message: "File sync stopped on this node after repeated failures" });
  if (view.enabled && view.worker === "running" && !view.shares.length) {
    return done({ state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: "No other machine shares this project right now" });
  }
  // fix: nothing is written here until Syncthing answers once: a problem to show, not syncing.
  if (view.writesHeld) return done({ state: "unavailable", remainingFiles: 0, remainingBytes: 0, message: `Built-in sync is not writing files here yet: ${view.writesHeld}` });
  const status = projectSyncStatus(shares, { enabled: view.enabled, running: view.worker === "running", present: (peer) => presentPeer(facts, peer) }, peerProblem(view, facts));
  if (status.state !== "syncing") return done(status);
  const behind = shares.flatMap((share) => share.peers.filter((peer) => !peer.caughtUp && presentPeer(facts, peer.peer)).map((peer) => peer.peer));
  if (status.remainingFiles > 0) {
    // Need rows do not say which peer has the content: the ones still ahead, else every present peer.
    const sources = behind.length ? behind : shares.flatMap((share) => share.peers.filter((peer) => presentPeer(facts, peer.peer)).map((peer) => peer.peer));
    const amount = `${plural(status.remainingFiles, "file")} (${formatBytes(status.remainingBytes)})`;
    // fix (P4+P5): with every machine that could send away, nothing is being copied: the files wait for them.
    if (!sources.length) {
      const away = shares.flatMap((share) => share.peers.map((peer) => peer.peer));
      return done({ ...status, message: `${amount} waiting for ${machines(facts, away)}, which ${new Set(away).size === 1 ? "is" : "are"} away` });
    }
    return done({ ...status, message: `Copying ${amount} from ${machines(facts, sources)}` });
  }
  if (status.message === "Catching up with other machines") return done({ ...status, message: `Catching up with ${machines(facts, behind)}` });
  return done(status);
}

/** Where a peer reads it as the plain status (handoff eligibility answers). */
function withoutEngine(status: FacadeSyncStatus): ProjectSyncStatus {
  const { engine: _engine, ...plain } = status;
  return plain;
}

const STATE_RANK: Record<ProjectSyncStatus["state"], number> = { error: 4, unavailable: 3, paused: 2, syncing: 1, synced: 0 };

function worst<T extends ProjectSyncStatus>(statuses: readonly T[]): T | undefined {
  return statuses.reduce<T | undefined>((held, status) => !held || STATE_RANK[status.state] > STATE_RANK[held.state] ? status : held, undefined);
}

/* ---- handoff (design §6.5): the source says how far its index reached, the destination waits until it holds that ---- */

const handoffShareSchema = z.object({ kind: z.enum(["project", "tickets", "worktrees"]), indexId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), maxSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
/** Non-strict like every handoff body: a newer source may add fields, an older destination drops the whole part. */
const handoffFilesSchema = z.object({ projectId: z.string().min(1).max(240), shares: z.array(handoffShareSchema).min(1).max(3) });
export type HandoffFiles = z.infer<typeof handoffFilesSchema>;
type HandoffShare = HandoffFiles["shares"][number];
type AnswerShare = StatusAnswer["shares"][number];

/** A handoff stops counting this long after the source last said it (the dialog repeats it every second; commit follows prepare within seconds). */
const EXPECTATION_TTL_MS = 2 * 60_000;
/** Polls from several dialogs share one worker answer this fresh. */
const ANSWER_REUSE_MS = 500;
/** How long a readiness check waits for the worker's answer before it reports "Checking files". */
const ANSWER_WAIT_MS = 2_000;
/** The source's own flush while a dialog polls (the peer's eligibility request times out after 3 s). */
export const HANDOFF_POLL_FLUSH_MS = 1_500;
/** A handoff check waits this long for this node's own changes to be picked up (design §6.5). */
export const READY_FLUSH_MS = 10_000;
const PART_REUSE_MS = 1_000;

interface Expectation { peer: string; part: HandoffFiles; at: number; asked?: { at: number; answer: Promise<StatusAnswer | undefined> } }
/** projectId → source peer → what it handed over last. In memory: a restart drops it, and the source says it again with its next request. */
const expectations = new Map<string, Map<string, Expectation>>();
const partCache = new Map<string, { at: number; part: Promise<HandoffFiles | undefined> }>();

/** One share of a destination's answer as a status; `names.source` is the machine handing over. */
export function handoffShareStatus(expected: HandoffShare, answer: AnswerShare | undefined, names: { local: string; source: string }): ProjectSyncStatus {
  const status = (state: ProjectSyncStatus["state"], message: string, files = 0, bytes = 0): ProjectSyncStatus => ({ state, remainingFiles: files, remainingBytes: bytes, message });
  if (!answer) return status("syncing", "Starting file sync");
  if (answer.state === "error" || answer.blocked > 0 || answer.errors > 0) {
    return status("error", answer.blocked ? `${plural(answer.blocked, "file")} could not be synchronized` : answer.errors ? `${plural(answer.errors, "file")} could not be read or written` : "File sync stopped on an error", answer.need.files, answer.need.bytes);
  }
  if (answer.state === "unavailable") return status("unavailable", "The folder is missing on this node");
  // Another generation of the source's index, or not as far as it said: its newest files are not even listed here yet.
  if (answer.callerIndexId !== expected.indexId || answer.cursor < expected.maxSeq) return status("syncing", `Checking what changed on ${names.source}`, answer.need.files, answer.need.bytes);
  if (answer.need.files > 0) return status("syncing", `Copying files to ${names.local}`, answer.need.files, answer.need.bytes);
  if (answer.state === "starting") return status("syncing", "Starting file sync");
  if (answer.state === "scanning") return status("syncing", "Checking files");
  return status("synced", "Files are up to date");
}

/**
 * A handoff or takeover source sent `fileSync` in its eligibility or prepare body. Kept for a while
 * and, for a project on built-in sync here, handed to the worker at once: it pulls what the source
 * has and this node lacks and puts those folders first. Never throws: an unreadable part is dropped,
 * as an older node drops it.
 */
export function noteHandoffFiles(peer: string, projectId: unknown, part: unknown): void {
  const parsed = handoffFilesSchema.safeParse(part);
  if (!parsed.success || parsed.data.projectId !== projectId) return;
  const byPeer = expectations.get(parsed.data.projectId) ?? new Map<string, Expectation>();
  const expectation: Expectation = { peer, part: parsed.data, at: Date.now() };
  byPeer.set(peer, expectation);
  expectations.set(parsed.data.projectId, byPeer);
  void phaseOfProject(parsed.data.projectId).then((phase) => { if (filesEngineOf(phase) === "builtin") void ask(expectation); }).catch(() => undefined);
}

/** Fresh handoffs into this project; a source that is away cannot send anything more, so it is not waited for. */
function currentExpectations(projectId: string, kind?: ShareKind): Expectation[] {
  const byPeer = expectations.get(projectId);
  if (!byPeer) return [];
  const now = Date.now();
  for (const [peer, expectation] of byPeer) if (now - expectation.at > EXPECTATION_TTL_MS) byPeer.delete(peer);
  if (!byPeer.size) expectations.delete(projectId);
  return [...byPeer.values()].filter((expectation) => !peerAway(expectation.peer) && (!kind || expectation.part.shares.some((share) => share.kind === kind)));
}

function ask(expectation: Expectation): Promise<StatusAnswer | undefined> {
  if (expectation.asked && Date.now() - expectation.asked.at < ANSWER_REUSE_MS) return expectation.asked.answer;
  const answer = engineApi().then((engine) => engine.fileSyncHandoffStatus(expectation.peer, expectation.part)).catch(() => undefined);
  expectation.asked = { at: Date.now(), answer };
  return answer;
}

async function answerWithin(expectation: Expectation, ms: number): Promise<StatusAnswer | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<undefined>((resolve) => { const wait = setTimeout(() => resolve(undefined), ms); wait.unref(); timer = wait; });
  try { return await Promise.race([ask(expectation), waited]); } finally { clearTimeout(timer); }
}

/** What the handoffs into the project say about one folder kind here; undefined when none is pending for it. */
async function handoffStatusFor(projectId: string, kind: ShareKind, facts: PeerFacts): Promise<ProjectSyncStatus | undefined> {
  const pending = currentExpectations(projectId, kind);
  if (!pending.length) return undefined;
  const statuses = await Promise.all(pending.map(async (expectation) => {
    const answer = await answerWithin(expectation, ANSWER_WAIT_MS);
    const expected = expectation.part.shares.find((share) => share.kind === kind)!;
    if (!answer) return { state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking files" } satisfies ProjectSyncStatus;
    return handoffShareStatus(expected, answer.shares.find((share) => share.kind === kind), { local: facts.local, source: nameOf(facts, expectation.peer) });
  }));
  return worst(statuses);
}

/**
 * The source's part of an eligibility or prepare body: how far its own index of each folder kind
 * reached, after picking up its latest changes (bounded by `flushTimeoutMs`). Undefined for a project
 * not on built-in sync here, so Syncthing projects send exactly what they always did.
 */
export async function projectFilesHandoffPart(project: ProjectRecord, kinds: readonly ShareKind[], flushTimeoutMs: number): Promise<HandoffFiles | undefined> {
  const key = `${project.id}\n${[...kinds].sort().join(",")}\n${flushTimeoutMs}`;
  const cached = partCache.get(key);
  if (cached && Date.now() - cached.at < PART_REUSE_MS) return cached.part;
  const part = (async (): Promise<HandoffFiles | undefined> => {
    if (filesEngineOf(await phaseOfProject(project.id)) !== "builtin") return undefined;
    const engine = await engineApi();
    // Whatever was picked up in time counts; the destination's later checks see the rest.
    await engine.fileSyncFlushProject(project.id, kinds, flushTimeoutMs).catch(() => undefined);
    const view = (await engine.fileSyncProjectViews([project.id])).get(project.id);
    const shares = (view?.shares ?? []).filter((share) => kinds.includes(share.kind) && share.indexId).map((share) => ({ kind: share.kind, indexId: share.indexId, maxSeq: share.maxSeq }));
    return shares.length ? { projectId: project.id, shares } : undefined;
  })().catch(() => undefined);
  partCache.set(key, { at: Date.now(), part });
  for (const [held, entry] of partCache) if (Date.now() - entry.at > PART_REUSE_MS) partCache.delete(held);
  return part;
}

/* ---- the facade ---- */

/** Keyed by project id. Projects on Syncthing get Syncthing's answer, exactly as before; built-in ones are computed in memory. */
export async function projectSyncStatuses(projects: ProjectRecord[]): Promise<Record<string, FacadeSyncStatus>> {
  const held = projects.length ? await phases() : new Map<string, Phase>();
  const onSyncthing = projects.filter((project) => filesEngineOf(held.get(project.id)) === "syncthing");
  const statuses = await syncthingFolderStatuses(onSyncthing.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []));
  const result: Record<string, FacadeSyncStatus> = Object.fromEntries(onSyncthing.map((project) => [project.id, project.syncFolderId
    ? statuses[project.syncFolderId] ?? unavailableProjectStatus("Loading sync status")
    : unavailableProjectStatus()]));
  const elsewhere = projects.filter((project) => filesEngineOf(held.get(project.id)) !== "syncthing");
  if (!elsewhere.length) return result;
  const builtin = elsewhere.filter((project) => held.get(project.id) === "builtin");
  for (const project of elsewhere) if (held.get(project.id) !== "builtin") result[project.id] = movingStatus(held.get(project.id));
  if (!builtin.length) return result;
  const engine = await engineApi();
  const views = await engine.fileSyncProjectViews(builtin.map((project) => project.id));
  const facts = await engine.fileSyncPeerFacts([...views.values()].flatMap((view) => view.shares.flatMap((share) => share.peers.map((peer) => peer.peer)).concat(Object.values(view.peers).flat())));
  for (const project of builtin) result[project.id] = builtinProjectStatus(views.get(project.id)!, facts);
  return result;
}

/** Asks for an immediate scan of the project and of its ticket and worktree folders. */
export async function rescanProjectFiles(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const engine = await projectFilesEngine(project.id);
  if (engine !== "syncthing") {
    const api = await engineApi();
    let finished: Array<{ kind: ShareKind; error?: string }>;
    try { finished = await api.fileSyncRescanProject(project.id); }
    catch (error) { throw new ProjectFilesUnavailableError(error instanceof Error ? error.message : "File sync is not running on this node"); }
    // A ticket or worktree folder this node never had is not the project's problem; the project folder's is.
    const failed = finished.find((scan) => scan.kind === "project" && scan.error);
    if (failed) throw new ProjectFilesUnavailableError(failed.error!);
    return;
  }
  if (!project.syncFolderId) throw new ProjectNotSynchronizedError();
  const configured = new Set((await listSyncthingFolders()).map((folder) => folder.id));
  // The project folder is always asked, so a missing folder or daemon still reports its error.
  const optional = [projectTicketSyncFolderId(project.id), projectWorktreeSyncFolderId(project.id)].filter((id) => configured.has(id));
  await Promise.all([project.syncFolderId, ...optional].map(rescanSyncthingFolder));
}

/**
 * Read-only for Syncthing: a handoff check must not rewrite ignore rules (the sync check keeps
 * project, ticket and worktree rules current). Built-in: this node's changes are picked up (10 s at
 * most), then no need, blocked item or error may remain, and a handoff into the project must have
 * arrived; anything still under way is a retryable "syncing".
 */
export async function assertProjectFilesReady(project: ProjectRecord, kind: ProjectShareKind): Promise<void> {
  const phase = await phaseOfProject(project.id);
  const engine = filesEngineOf(phase);
  if (engine === "moving") throw new ProjectFilesNotReadyError(movingStatus(phase));
  if (engine === "syncthing") {
    const folderId = shareFolderId(project, kind);
    if (folderId) await assertSyncthingFolderReady(folderId, false);
    return;
  }
  const api = await engineApi();
  let view = (await api.fileSyncProjectViews([project.id])).get(project.id)!;
  const facts = await api.fileSyncPeerFacts(Object.values(view.peers).flat());
  if (view.worker !== "running") throw new ProjectFilesNotReadyError(builtinProjectStatus(view, facts, [kind]));
  // No peer shares the project now: like a project without a folder, there is nothing to wait for.
  if (!view.shares.length) return;
  try { await api.fileSyncFlushProject(project.id, [kind], READY_FLUSH_MS); }
  catch { throw new ProjectFilesNotReadyError({ state: "syncing", remainingFiles: 0, remainingBytes: 0, message: "Checking files" }); }
  view = (await api.fileSyncProjectViews([project.id])).get(project.id)!;
  const share = view.shares.find((candidate) => candidate.kind === kind);
  if (share) {
    const local = localShareProblem(share);
    if (local) throw new ProjectFilesNotReadyError(local);
  }
  const handoff = await handoffStatusFor(project.id, kind, facts);
  if (handoff && handoff.state !== "synced") throw new ProjectFilesNotReadyError(handoff);
}

/** Need, blocked items, errors or an unfinished scan in this node's copy of one share. */
function localShareProblem(share: ShareStatus): ProjectSyncStatus | undefined {
  const status = (state: ProjectSyncStatus["state"], message: string): ProjectSyncStatus => ({ state, remainingFiles: share.need.files, remainingBytes: share.need.bytes, message });
  if (share.state === "error" || share.blocked > 0 || share.errors > 0) {
    return status("error", share.blocked ? `${plural(share.blocked, "file")} could not be synchronized` : share.errors ? `${plural(share.errors, "file")} could not be read or written` : share.message ?? "File sync stopped on an error");
  }
  if (share.state === "unavailable") return status("unavailable", share.message ?? "The folder is missing on this node");
  if (share.state === "starting") return status("syncing", "Starting file sync");
  if (share.scanning || share.state === "scanning") return status("syncing", "Checking files");
  if (share.need.files > 0) return status("syncing", `${plural(share.need.files, "file")} still arriving`);
  return undefined;
}

/** This node's view of each share a ticket needs; a project without a folder has nothing to wait for. */
export async function taskShareStatuses(project: ProjectRecord, targets: Array<{ kind: ProjectShareKind; label: string }>): Promise<Array<ProjectSyncStatus & { label: string }>> {
  const phase = await phaseOfProject(project.id);
  const engine = filesEngineOf(phase);
  if (engine !== "syncthing") {
    const unique = targets.filter((target, index) => targets.findIndex(({ kind }) => kind === target.kind) === index);
    if (engine === "moving") return unique.map((target) => ({ label: target.label, ...withoutEngine(movingStatus(phase)) }));
    const api = await engineApi();
    const view = (await api.fileSyncProjectViews([project.id])).get(project.id)!;
    const facts = await api.fileSyncPeerFacts([...Object.values(view.peers).flat(), ...currentExpectations(project.id).map((expectation) => expectation.peer)]);
    return Promise.all(unique.map(async (target) => {
      const own = builtinProjectStatus(view, facts, [target.kind]);
      const handoff = view.worker === "running" ? await handoffStatusFor(project.id, target.kind, facts) : undefined;
      return { label: target.label, ...withoutEngine(handoff ? worst<FacadeSyncStatus>([own, handoff])! : own) };
    }));
  }
  const resolved = targets.flatMap((target) => {
    const folderId = shareFolderId(project, target.kind);
    return folderId ? [{ folderId, label: target.label }] : [];
  });
  const unique = resolved.filter((target, index) => resolved.findIndex(({ folderId }) => folderId === target.folderId) === index);
  const statuses = await syncthingFolderStatuses(unique.map((target) => target.folderId));
  return unique.map((target) => ({ label: target.label, ...statuses[target.folderId] }));
}

/**
 * The app wrote under the project's worktree folder (`changed`: the absolute path it wrote or
 * removed). Syncthing's watcher waits before it notices, so the folder is rescanned at once; the
 * built-in engine scans that path now and tells peers after the commit.
 */
export function worktreeFilesChanged(projectId: string, changed?: string): void {
  void projectFilesEngine(projectId).then(async (engine) => {
    if (engine !== "syncthing") {
      (await engineApi()).fileSyncScanPaths(projectId, "worktrees", changed ? [changed] : []);
      return;
    }
    const folderId = projectWorktreeSyncFolderId(projectId);
    const folders = await listSyncthingFolders();
    if (folders.some((folder) => folder.id === folderId)) await rescanSyncthingFolder(folderId);
  }).catch((error) => console.warn("Worktree folder rescan failed", error));
}

/** How long a worktree whose files are still arriving goes first in the engine's queue. */
const WORKTREE_PRIORITY_MS = 10 * 60_000;

/**
 * Whether files of the worktree are still on their way to this node, so merging or sweeping it now
 * would act on an old copy. Syncthing has no per-path answer and keeps today's behaviour (false).
 * The built-in engine holds only while something can still arrive: a present peer whose index of
 * the worktree folder is ahead of this node's copy (known per folder, and over in moments), or need
 * rows under this worktree that a present peer or a local copy can supply (fix P4+P5: another
 * worktree's files, or files only a machine that is away has, do not hold it). Pending files of the
 * worktree are moved up the queue.
 */
export async function worktreeHasPendingFiles(projectId: string, worktreeId: string): Promise<boolean> {
  const engine = await projectFilesEngine(projectId);
  if (engine === "syncthing") return false;
  if (engine === "moving") return true;
  const api = await engineApi();
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  // Off or given up: nothing will arrive, and waiting would block the worktree for good.
  if (view.worker === "off" || view.worker === "failed" || view.worker === "stopped" || view.worker === "stopping") return false;
  if (view.worker !== "running") return true;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  if (!share) return false;
  const prioritize = () => api.fileSyncPrioritize(projectId, "worktrees", worktreeId, Date.now() + WORKTREE_PRIORITY_MS);
  if (share.state === "starting") { prioritize(); return true; }
  const eligible = [...new Set([...view.peers.worktrees ?? [], ...share.peers.map((peer) => peer.peer)])];
  const facts = await api.fileSyncPeerFacts(eligible);
  const sending = (peer: string) => presentPeer(facts, peer) && facts.peers.get(peer)?.protocol !== 0 && facts.peers.get(peer)?.enabled !== false;
  const present = eligible.filter(sending);
  // No machine that could send is around: nothing arrives until one is back, and the merge need not wait for that.
  if (!present.length) return false;
  let pending = share.peers.some((peer) => !peer.caughtUp && sending(peer.peer));
  if (!pending && share.need.files > 0) {
    // A worker that does not answer in time holds the merge only while a present machine could still send.
    const counted = await api.fileSyncPendingFiles(projectId, "worktrees", worktreeId, present).catch(() => undefined);
    pending = counted ? counted.files > 0 : true;
  }
  if (pending) prioritize();
  return pending;
}

/**
 * Why housekeeping (the sweep, the done-cleanup) must keep a worktree for now, or undefined when it
 * may delete it (design §6.5). On built-in sync a deletion here reaches every machine, so it acts on
 * a worktree another machine created only after a completed pull from every eligible peer since this
 * node last started or woke, with none of them ahead: until then its conversation markers may simply
 * not have arrived. Projects on Syncthing keep today's behaviour.
 */
export async function worktreeSweepRefusal(projectId: string, worktree: { id: string; createdByNodeId: string }): Promise<string | undefined> {
  const engine = await projectFilesEngine(projectId);
  if (engine === "syncthing") return undefined;
  if (engine === "moving") return "Worktree kept: file sync is moving this project";
  if (await worktreeHasPendingFiles(projectId, worktree.id)) return "Worktree kept: its files are still arriving from another machine";
  const api = await engineApi();
  const { getClusterNode } = await import("../cluster.js");
  if (worktree.createdByNodeId === (await getClusterNode()).id) return undefined;
  const view = (await api.fileSyncProjectViews([projectId])).get(projectId)!;
  const share = view.shares.find((candidate) => candidate.kind === "worktrees");
  const eligible = view.peers.worktrees ?? [];
  if (!share || view.worker !== "running" || !eligible.length) return "Worktree kept: another machine created it and this node cannot check that machine's copy now";
  const peerFacts = await api.fileSyncPeerFacts(eligible);
  for (const peer of eligible) {
    const known = peerFacts.peers.get(peer);
    const entry = share.peers.find((candidate) => candidate.peer === peer);
    if (!known?.protocol || known.enabled === false || !known.present || !entry?.caughtUp || !api.fileSyncPulledSinceStart(share.share, peer)) {
      return `Worktree kept: another machine created it and this node has not caught up with ${known?.name ?? peer} since it started`;
    }
  }
  return undefined;
}

/**
 * Whether this node holds what `peer` has of these projects (a takeover from it, a twin's
 * readiness): Syncthing's own folder state for projects still on Syncthing, and for built-in ones
 * this node's cursor of the peer's index caught up with nothing left to receive. No network request:
 * built-in answers come from the reports main already holds. An away peer cannot send more, so it
 * holds nothing back.
 */
export async function peerFilesReady(peer: string, projectIds: readonly string[]): Promise<{ ready: boolean; statuses: Record<string, ProjectSyncStatus> }> {
  const held = await phases();
  const statuses: Record<string, ProjectSyncStatus> = {};
  const projects = (await Promise.all(projectIds.map((id) => getProject(id)))).filter((project): project is ProjectRecord => Boolean(project));
  const onSyncthing = projects.filter((project) => filesEngineOf(held.get(project.id)) === "syncthing" && project.syncFolderId);
  const folders = await syncthingFolderStatuses(onSyncthing.map((project) => project.syncFolderId!));
  for (const project of onSyncthing) statuses[project.id] = folders[project.syncFolderId!] ?? unavailableProjectStatus("Loading sync status");
  for (const project of projects) if (filesEngineOf(held.get(project.id)) === "moving") statuses[project.id] = movingStatus(held.get(project.id));
  const builtin = projects.filter((project) => held.get(project.id) === "builtin");
  if (builtin.length) {
    const api = await engineApi();
    const views = await api.fileSyncProjectViews(builtin.map((project) => project.id));
    const facts = await api.fileSyncPeerFacts([peer]);
    for (const project of builtin) {
      const view = views.get(project.id)!;
      // Only this peer: another machine being behind or off does not hold back what this one sent.
      const narrowed: FileSyncProjectView = {
        ...view,
        shares: view.shares.map((share) => ({ ...share, peers: share.peers.filter((entry) => entry.peer === peer) })),
        peers: Object.fromEntries(Object.entries(view.peers).map(([kind, peers]) => [kind, peers.filter((candidate) => candidate === peer)])),
      };
      statuses[project.id] = withoutEngine(builtinProjectStatus(narrowed, facts));
    }
  }
  return { ready: Object.values(statuses).every((status) => status.state === "synced"), statuses };
}
