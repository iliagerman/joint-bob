import { createHash } from "node:crypto";
import { mkdir, opendir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { projectWorktreeRoot } from "../project-worktrees.js";
import { notifyRelayPeersChanged } from "../relay/events.js";
import { replicationPeers } from "../server/replication-v2.js";
import { syncthingFoldersCovering, type SyncthingFolder } from "../syncthing.js";
import { projectTicketSyncFolderId, TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "../task-workspaces.js";
import type { ProjectSyncStatus } from "../types.js";
import { projectWorktreeSyncFolderId } from "../worktree-filters.js";
import { comparedProjects, engineModeOf, engineRecordOf, listEngineRecords, listPhases, phaseOf, projectFilesOnSyncthing, projectHold, projectOwnerNode, readFileSyncConfig, requestCompare, saveEngineRecord, setPhase, setVerifiedRoots, updateProjectHold, verifiedRoots, withProjectFilesLock, type AutoSwitchConfig, type ProjectHold } from "./control.js";
import { compileRules, effectiveRules } from "./ignore.js";
import { predatesAutoSwitch, type PeerFileSync } from "./peers.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, FILE_SYNC_SWITCH_PROTOCOL, type OpArgs, type OpName, type OpResults, type ShareSpec, type ShareStatus } from "./protocol.js";
import type { StreamEvent } from "./syncthing-events.js";
import { SHARE_KINDS, systemClock, type Clock, type EngineMode, type EngineRecord, type Phase, type ShareKind } from "./types.js";
import { FILES_API, projectIdSchema, sharesAnswerSchema, statusAnswerSchema, type SharesAnswer, type StatusAnswer } from "./wire.js";

/* The per-project switch between Syncthing and the built-in engine (design §7, FILE-SYNC-PLAN.md
   §7.3). The owner records which engine a project uses; every node, the owner included, then walks
   its own phase for the project: syncthing → releasing (Syncthing lets go of every Joint Bob folder
   over the project's roots, checked with a fresh folder list) → bootstrapping (Syncthing's temps go,
   a full scan, the bootstrap decision per folder) → builtin (the worker may write). A move back goes
   builtin → restoring (the worker stops writing) → syncthing, and enrollment adds the folders again.
   Every step is persisted before the next starts and is safe to run twice, so a node that stops at
   any point resumes where it was. Nothing here polls: steps run on derivations (sharing, records,
   capability), share reports and one-shot retries after a failure.

   auto-transition: nobody has to pick the moment. The owner moves a project on Syncthing to built-in
   sync by itself once every check passes and all three folders have matched on every machine for
   cleanHours; it looks again when something that could change the answer happens (a share report, a
   peer's capability, a peer's return, a record, Syncthing going idle) and at one one-shot timer when
   the matching time is up. A move back by hand holds the project on Syncthing until someone allows
   the automatic move again; an automatic move back starts the matching time over. Every other node
   follows the record through the phases above; a notice a peer missed is sent again at its next
   contact.

   fix: the matching time counts while the machines could exchange files. A difference that is only
   files on their way (a machine away, Syncthing still copying, a list of files not fetched yet) does
   not end it; one that stands for IN_FLIGHT_GRACE_MS with every machine there and Syncthing done
   does. A peer with a chosen list of projects to compare is asked to compare the project, so nobody
   ticks it on every machine. Once a built-in project's folder check passed, writes go on through a
   Syncthing outage; a node only counts as having no Syncthing when Joint Bob never gave it the
   project's folders and no Syncthing configuration is there. */

/** `waiting`: what the automatic move waits for in plain language, naming the machine (failing checks only). */
export interface Check { key: string; ok: boolean; message: string; waiting?: string }
export interface ChecksAnswer { engine: EngineMode; checks: Check[]; cleanSince: string | null }

/** auto-transition: what a project on Syncthing waits for before its owner moves it to built-in sync by itself. */
export type AutoState = "matching" | "blocked" | "held" | "off" | "due";
export interface AutoSwitchView {
  /** matching: the files match and the time is not up yet; blocked: something must change first; held: moved back by hand; off: automatic moves are off on the owner; due: being checked now. */
  state: AutoState;
  reason: string;
  /** Since when every folder has matched on every machine (the owner's view), and how long it must. */
  cleanSince: string | null;
  cleanHours: number;
  /** The owner's name when another machine decides; null when this machine does. */
  decidedBy: string | null;
}

export const HELD_REASON = "Moved back to Syncthing by hand; click Allow automatic move to let it move again";
export const WRITES_WAIT_FOR_SYNCTHING = "Waiting for Syncthing to answer before writing files";
/** fix: a Syncthing Joint Bob cannot talk to may still sync the project's folders, so the move waits for it. */
export const SYNCTHING_UNREACHABLE = "Joint Bob cannot reach this machine's Syncthing (it has no local address and API key for it); set JOINT_BOB_SYNCTHING_URL and JOINT_BOB_SYNCTHING_API_KEY so Syncthing can let go of this project's folders";

/**
 * Joint Bob has no address and API key for Syncthing on this node. `installed`: a Syncthing
 * configuration was found here all the same (the GUI off or not on loopback): its daemon may run.
 */
export class SyncthingNotConfigured extends Error {
  constructor(readonly installed = false) { super("Syncthing is not configured on this node"); }
}

function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 72 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** "Files have matched on every machine for 6 h; it moves to built-in sync after 24 h". */
export function matchingReason(cleanSince: string, cleanHours: number, now: number): string {
  return `Files have matched on every machine for ${span(now - Date.parse(cleanSince))}; it moves to built-in sync after ${span(cleanHours * 3_600_000)}`;
}

export interface FileSyncProject {
  projectId: string;
  name: string;
  /** This node owns the project: only it may switch the engine. */
  owner: boolean;
  engine: EngineMode;
  phase: Phase;
  phaseMessage: string | null;
  phaseError: string | null;
  /** Since when every peer's files matched this node's (all three folders); null while any differs or was never compared. */
  cleanSince: string | null;
  differences: number;
  shares: ShareKind[];
  /** fix (P4+P5): the move waits for something outside it (a person, sharing): nothing changes until then, so Settings need not refresh for it. */
  waiting: boolean;
  /** fix (P4+P5), the owner only: where each peer's own move of the project stands, as the peer last said. */
  peers: PeerPhase[];
  /** auto-transition: on Syncthing, what the automatic move waits for; null once it moves or moved. */
  autoSwitch: AutoSwitchView | null;
}

export interface PeerPhase { peer: string; name: string; phase: Phase; error: string | null }

/* fix (P4+P5): POST /api/cluster/v2/files/switch, answered by main (routes.ts). The owner asks each
   peer, before a move, what would hold its own release (folders only it has); a peer tells the owner
   where its own move stands whenever that changes, so a peer that cannot finish shows on the owner. */
const phaseSchema = z.enum(["syncthing", "releasing", "bootstrapping", "builtin", "restoring"]);
const reason = z.string().max(4000);
/** auto-transition: what the owner's automatic move waits for, as its peers show it (a "matching" reason is worded by the reader, who knows the time). */
const autoWireSchema = z.object({
  state: z.enum(["matching", "blocked", "held", "off", "due"]),
  reason,
  cleanSince: z.string().max(40).nullable(),
  cleanHours: z.number().finite().min(0).max(24 * 60),
});
type AutoWire = z.infer<typeof autoWireSchema>;
export const switchBodySchema = z.object({
  projectId: projectIdSchema,
  /** The owner asks for what would hold this node's release of the project. */
  blockers: z.boolean().optional(),
  /** The sender's own phase of the project (a peer telling the owner). */
  report: z.object({ phase: phaseSchema, error: reason.nullable(), leaving: z.boolean().optional() }).optional(),
  /** auto-transition: the owner tells a peer what its automatic move waits for. */
  auto: autoWireSchema.optional(),
  /** fix: the owner means to move the project and asks this node to compare its files. */
  compare: z.boolean().optional(),
});
const comparesSchema = z.enum(["yes", "off", "declined"]);
/**
 * `auto`: the answering owner's automatic move of the project (older owners leave it out).
 * `compares`, to a `compare` request: "yes" (now, or after its first look at the files), "off" (file
 * sync is off there), "declined" (an admin there unticked it); older nodes leave it out.
 */
export const switchAnswerSchema = z.object({ projectId: projectIdSchema, phase: phaseSchema, error: reason.nullable(), blockers: z.array(reason).max(200).optional(), auto: autoWireSchema.optional(), compares: comparesSchema.optional(), leaving: z.boolean().optional() });
export type SwitchBody = z.infer<typeof switchBodySchema>;
export type SwitchAnswer = z.infer<typeof switchAnswerSchema>;

/** The switch was refused; `checks` says why (every check, failing ones with ok false). */
export class EngineSwitchRefused extends Error {
  constructor(readonly checks: Check[]) { super(checks.filter((check) => !check.ok).map((check) => check.message).join("; ") || "The switch was refused"); }
}

/** This node's Syncthing as the switch needs it. Tests pass a fake; production wraps src/syncthing.ts. */
export interface MigrationSyncthing {
  /** A fresh folder list from a daemon that answered; throws when Syncthing does not answer, SyncthingNotConfigured when Joint Bob has no connection to one here. */
  folders(): Promise<SyncthingFolder[]>;
  /** Takes a folder out of Syncthing's configuration; Syncthing leaves its files on disk. */
  removeFolder(folderId: string): Promise<void>;
  /** auto-transition: pauses one of Joint Bob's old shared folders (never a project's, never the user's). */
  pauseFolder?(folderId: string): Promise<void>;
  folderStatuses(folderIds: string[]): Promise<Record<string, ProjectSyncStatus>>;
  peerCaughtUp(deviceId: string, folderIds: string[]): Promise<boolean>;
  /** Changes when this node is pointed at another Syncthing: built-in projects are checked against its folders again. */
  generation?(): number;
}

/** The running engine (index.ts), or a stand-in that is not running. */
export interface MigrationEngine {
  /** The worker runs and took its first configure. */
  running(): boolean;
  /** The node's switch (Settings or the environment). */
  enabled(): boolean;
  /** Derives again and pushes configure; true once the worker took the desired state, or no worker runs to hold an older one. */
  apply(): Promise<boolean>;
  /** The project's derived shares (only those with an eligible peer now). */
  specs(projectId: string): ShareSpec[];
  /** What the worker last reported for them. */
  statuses(projectId: string): ShareStatus[];
  call<K extends OpName>(op: K, args: OpArgs[K], options?: { timeoutMs?: number }): Promise<OpResults[K]>;
  /** Asks the worker to catch up with a peer now (its index pull). */
  nudge(peer: string): void;
  /** A project is back on Syncthing here: with file sync turned off meanwhile, the engine may stop once it holds none. */
  left?(): void;
}

/** A signed request to a peer's /api/cluster/v2/files/* through its main server. */
export type PeerRequest = (peer: string, request: { method: "GET" | "POST"; target: string; json?: unknown }, signal: AbortSignal) => Promise<Response>;

export interface MigrationDeps {
  db: DatabaseSync;
  nodeId: string;
  syncthing: MigrationSyncthing;
  engine: MigrationEngine;
  peerRequest: PeerRequest;
  /** What a peer said about its engine (hello, shares answers); undefined: not heard from. */
  capability: (peer: string) => PeerFileSync | undefined;
  /** Why the project is busy (a running task, a merge), or undefined. */
  activity?: (projectId: string) => Promise<string | undefined>;
  roots?: (projectId: string) => Record<ShareKind, string> | undefined;
  log?: (key: string, message: string) => void;
  settle?: (key: string) => void;
  clock?: Clock;
  peerTimeoutMs?: number;
  /** Delays of the retries after a step could not finish (Syncthing not answering, peers not caught up). */
  retry?: { minMs: number; maxMs: number };
  /** auto-transition: the owner's automatic move (file_sync_config by default). */
  autoSwitch?: () => AutoSwitchConfig;
  /** Least time between two full checks of one project's automatic move (they ask every peer). */
  autoCheckGapMs?: number;
  /** A line for the server log (a move the owner made by itself). */
  info?: (message: string) => void;
  /** One audit record per move (audit.ts in production). */
  audit?: (event: { eventType: string; actorType: "user" | "system"; actorId: string | null; entityType: "project"; entityId: string; details: Record<string, string | number | boolean | null> }) => void;
  /** One performance record per automatic move (performance-diagnostics' record). */
  metric?: (operation: string, durationMs: number, fields: Record<string, number | boolean>) => void;
  /** This machine's name, for reasons its peers show ("this machine" would name theirs). */
  localName?: () => string;
  /** fix: main leaves the peer alone for now (peer-presence.ts): its files cannot arrive meanwhile. */
  peerAway?: (peer: string) => boolean;
  /** How long a settled difference may stand, with every machine there and Syncthing done, before it ends the matching time. */
  autoGraceMs?: number;
  /** fix: a project its owner asked this node to compare is about to be: its Syncthing ignore lines are read first (index.ts). */
  beforeCompare?: (projectId: string) => Promise<void>;
}

const PEER_TIMEOUT_MS = 10_000;
/** A difference this much past the last sign of files on their way (Syncthing copying, a machine away) is real: the other machine's scan and list reach this one within it. */
const IN_FLIGHT_GRACE_MS = 15 * 60_000;
/** Why differences stand is asked of Syncthing at most this often while nothing on its side changed (busy projects report every second). */
const EXPLAIN_CACHE_MS = 30_000;
/** fix: Joint Bob's old shared folders that its sharing passes keep paused (sharing-files.ts, skill-sharing.ts): the release may pause one itself. dot-pi and dot-claude are not among them. */
const AGENT_RESOURCES_FOLDER_ID = "joint-bob-agent-resources";
const CONVERSATION_FOLDER_PREFIX = "joint-bob-conversations-";
function pausedByJointBob(id: string): boolean { return id === TICKET_WORKSPACE_FOLDER_ID || id === AGENT_RESOURCES_FOLDER_ID || id.startsWith(CONVERSATION_FOLDER_PREFIX); }
const SCAN_TIMEOUT_MS = 2 * 60 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 60 * 60_000;
const RETRY = { minMs: 5_000, maxMs: 5 * 60_000 };
/** Steps one pass may take in a row (syncthing → releasing → bootstrapping → builtin is three). */
const STEPS_PER_PASS = 12;
/** A trigger soon after a full check that failed waits this long: the checks ask every peer, and a busy project reports often. */
const AUTO_CHECK_GAP_MS = 60_000;
const AUTO_CHECK_GAP_MAX_MS = 30 * 60_000;
/** setTimeout's ceiling; a later deadline is looked at again when this fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Only these names, the temps Syncthing leaves when it stops mid-download. */
const SYNCTHING_TEMP = /^(?:\.syncthing\..*\.tmp|~syncthing~.*\.tmp)$/s;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** A project's folder IDs, worked out once (fix: Syncthing's event batches look every project up). */
const folderIdCache = new Map<string, string[]>();

/** The folder IDs Joint Bob gives a project's three folders (sharing-files.ts enrollment). */
function projectFolderIds(projectId: string, syncFolderId: string | null | undefined): string[] {
  const key = `${projectId}\n${syncFolderId ?? ""}`;
  let ids = folderIdCache.get(key);
  if (!ids) {
    if (folderIdCache.size > 10_000) folderIdCache.clear();
    ids = [syncFolderId ?? `joint-bob-project-${hash(projectId)}`, `joint-bob-project-${hash(projectId)}`, projectTicketSyncFolderId(projectId), projectWorktreeSyncFolderId(projectId)];
    folderIdCache.set(key, ids);
  }
  return ids;
}

/** Joint Bob's own folders: every project's, and the legacy global ones (ticket workspaces, agent resources, conversations, dot-pi, dot-claude). */
function jointBobFolderId(id: string): boolean { return id.startsWith("joint-bob-") || id === "dot-pi" || id === "dot-claude"; }

function folderLabel(folder: SyncthingFolder): string { return folder.label?.trim() || folder.id; }

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** A grant that lapses only with a relay's lease (relay resource groups): still a peer that holds the files. */
function relayGrant(db: DatabaseSync, node: string, projectId: string, owner: string): boolean {
  if (!tableExists(db, "relay_sharing_groups")) return false;
  try {
    const rows = db.prepare(`SELECT s.node_ids FROM sharing_resource_shares s JOIN relay_sharing_groups g ON g.cluster_id = s.cluster_id
      JOIN sharing_clusters c ON c.id = s.cluster_id AND c.closed = 0
      JOIN sharing_memberships om ON om.cluster_id = s.cluster_id AND om.node_id = ?
      JOIN sharing_memberships rm ON rm.cluster_id = s.cluster_id AND rm.node_id = ?
      WHERE s.kind = 'project' AND s.resource_id = ?`).all(owner, node, projectId) as Array<{ node_ids: string | null }>;
    return rows.some((row) => row.node_ids === null || (JSON.parse(row.node_ids) as string[]).includes(node));
  } catch { return false; }
}

function receivesIgnoringLease(db: DatabaseSync, node: string, projectId: string, owner: string | undefined): boolean {
  try { if (mayReceiveResource(db, node, "project", projectId)) return true; } catch { return false; }
  return owner !== undefined && (node === owner || relayGrant(db, node, projectId, owner));
}

/**
 * Peers that may hold the project with this node from the sharing tables, relay leases ignored: a
 * relay-only peer whose lease lapsed still has the files, so a switch must account for it.
 */
export function projectPeers(db: DatabaseSync, local: string, projectId: string, candidates?: readonly string[]): string[] {
  try {
    const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind = 'project' AND resource_id = ?").get(projectId) as { deleted: number } | undefined;
    if (!policy || policy.deleted) return [];
  } catch { return []; }
  const owner = projectOwnerNode(db, projectId);
  if (!receivesIgnoringLease(db, local, projectId, owner)) return [];
  let known: string[];
  try { known = [...candidates ?? replicationPeers(db, local).map((peer) => peer.nodeId)]; } catch { known = []; }
  if (owner && owner !== local) known.push(owner);
  return [...new Set(known)].filter((peer) => peer !== local && receivesIgnoringLease(db, peer, projectId, owner)).sort();
}

function defaultRoots(db: DatabaseSync, projectId: string): Record<ShareKind, string> | undefined {
  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
  if (!row) return undefined;
  try { return { project: row.path, tickets: path.join(ticketWorkspaceRoot(), projectId), worktrees: projectWorktreeRoot(projectId) }; } catch { return undefined; }
}

/** The latest time every comparison became clean; null while any differs or was never compared. */
export function projectCleanSince(statuses: readonly ShareStatus[]): string | null {
  let latest: string | null = null;
  let any = false;
  for (const status of statuses) for (const peer of status.peers) {
    any = true;
    if (peer.differences > 0 || !peer.cleanSince) return null;
    if (latest === null || peer.cleanSince > latest) latest = peer.cleanSince;
  }
  return any ? latest : null;
}

export function projectDifferences(statuses: readonly ShareStatus[]): number {
  return statuses.reduce((sum, status) => sum + status.peers.reduce((count, peer) => count + peer.differences, 0), 0);
}

/** Deletes Syncthing's leftover download temps under `root`, never following links and skipping folders the engine ignores. */
export async function removeSyncthingTemps(root: string, ignoredDirectory: (relative: string) => boolean = () => false): Promise<number> {
  let removed = 0;
  let visited = 0;
  const walk = async (relative: string): Promise<void> => {
    let directory;
    try { directory = await opendir(path.join(root, relative)); } catch { return; }
    for await (const entry of directory) {
      // A large tree is walked a slice at a time: requests keep their turn on the main thread.
      if (++visited % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!ignoredDirectory(child)) await walk(child); continue; }
      if (!entry.isFile() || !SYNCTHING_TEMP.test(entry.name)) continue;
      try { await rm(path.join(root, child)); removed++; } catch { /* gone already, or not ours to remove */ }
    }
  };
  await walk("");
  return removed;
}

type StepOutcome = "done" | "wait" | "again";

/** What a peer answered to the checks: its shares, its status of the project and, asked for, what would hold its own release. */
/** What a peer said of its move; fix: `leaving`, file sync is being turned off there. */
interface PeerReport { phase: Phase; error: string | null; leaving?: boolean }
interface PeerAnswer { peer: string; shares?: SharesAnswer; status?: StatusAnswer; error?: string; release?: SwitchAnswer; releaseError?: string }

function peerFailure(status: number): string {
  return status === 404 ? "it runs a Joint Bob without built-in file sync"
    : status === 503 ? "file sync is not running there" : status === 403 ? "it does not share this project with this machine" : `HTTP ${status}`;
}

/** `pause`: Joint Bob's old shared folders that are not paused; the release pauses them itself. */
interface Classified { remove: SyncthingFolder[]; pause: SyncthingFolder[]; blocked: Array<{ folder: SyncthingFolder; reason: string }> }

/**
 * auto-transition: what an owner's automatic move waits for; `at` is when the matching time is up.
 * fix: `peerReason`, the same for its peers' screens where the owner's wording names an action only
 * the owner can take; `differing`, settled differences per peer, still to be explained; `compare`, a
 * peer that does not compare the project yet; `matching`, the matching time to keep.
 */
interface AutoDecision {
  state: AutoState; reason: string; cleanSince: string | null; cleanHours: number; at?: number;
  peerReason?: string; differing?: Array<{ peer: string; count: number }>; compare?: string; matching?: NonNullable<ProjectHold["matching"]>;
}
type CompareAnswer = z.infer<typeof comparesSchema> | "update";
/**
 * A non-owner: what the owner said about its automatic move, and when it was last asked. Per
 * node.db: Settings' stand-in machines (file sync off here) share it with the running one.
 */
interface OwnerKnowledge { states: Map<string, AutoWire & { owner: string }>; asked: Map<string, number> }
const ownerSaid = new WeakMap<DatabaseSync, OwnerKnowledge>();
function ownerKnowledge(db: DatabaseSync): OwnerKnowledge {
  let held = ownerSaid.get(db);
  if (!held) { held = { states: new Map(), asked: new Map() }; ownerSaid.set(db, held); }
  return held;
}
/** Settings asks the owner again at most this often; the owner tells a peer that asked of each change meanwhile. */
const OWNER_ASK_MS = 5 * 60_000;

function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

export class Migration {
  private readonly db: DatabaseSync;
  private readonly local: string;
  private readonly clock: Clock;
  private readonly retry: { minMs: number; maxMs: number };
  private readonly steps = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly waits = new Map<string, { attempts: number; until: number; timer?: { cancel(): void } }>();
  private readonly messages = new Map<string, string>();
  /** Shares scanned in full for the switch since this node started: a retry after peers caught up does not scan again. */
  private readonly scanned = new Set<string>();
  /**
   * Built-in projects looked at against this Syncthing since this start: the Syncthing and the roots
   * that look was for. Another Syncthing or other roots are looked at again at once. Whether writes
   * may go is the persisted pass (verifiedRoots): a Syncthing that does not answer holds them only
   * where no check of these roots ever passed (fix: Syncthing is not needed to run built-in sync).
   */
  private readonly verified = new Map<string, { generation: number; roots: string }>();
  private readonly switching = new Map<string, Promise<unknown>>();
  /** Records written here that peers have not been told about: the worker must serve them first (its configure carries them). */
  private readonly unnotified = new Set<string>();
  /** The owner: each peer's phase of a project, as the peer said (its report, or its answer to the checks). In memory: asked again at start. */
  private readonly peerReports = new Map<string, Map<string, PeerReport>>();
  /** Owned projects whose peers were asked for their phase since this node started. */
  private readonly asked = new Set<string>();
  /** A peer: the report the owner last took for each project, and the one on its way. */
  private readonly delivered = new Map<string, string>();
  private readonly delivering = new Set<string>();
  /** auto-transition: built-in projects whose folders Syncthing's events say to check again. */
  private readonly recheck = new Set<string>();
  /** auto-transition, the owner: one timer per project (the matching time is up, or the gap after a full check), and the evaluations. */
  private readonly autoTimers = new Map<string, { at: number; timer: { cancel(): void } }>();
  private readonly autoRuns = new Map<string, Promise<void>>();
  private readonly autoAgain = new Set<string>();
  /** The last full check that failed, per project: its time and reason. */
  private readonly autoChecked = new Map<string, { at: number; reason: string; failures: number }>();
  /** What each project's automatic move waits for now, and what its peers were last told. */
  private readonly autoStates = new Map<string, AutoDecision>();
  private readonly autoSent = new Map<string, string>();
  /** Peers that asked about a project's automatic move since this start: only they are told of its changes. */
  private readonly subscribers = new Map<string, Set<string>>();
  /** Peers that missed a record notice, and projects whose state a peer missed: sent again at the peer's next contact. */
  private readonly missedNotices = new Set<string>();
  private readonly missedStates = new Map<string, Set<string>>();
  private readonly noticing = new Set<string>();
  private readonly pushing = new Set<string>();
  private readonly pushAgain = new Set<string>();
  /** fix, the owner: since when each project's settled differences stood with nothing to explain them (a restart starts the grace again), and the last explanation. */
  private readonly unexplained = new Map<string, number>();
  /** `asked`: Syncthing was asked for it (cached for a while); otherwise known without asking. */
  private readonly explained = new Map<string, { at: number; tick: number; reason: string | undefined; asked: boolean }>();
  /** Bumped by Syncthing events that can change why differences stand (a folder idle, a device caught up). */
  private syncthingTick = 0;
  /** fix, the owner: peers asked to compare a project (`peer\nproject`), their answers, and the requests that did not get through. */
  private readonly compareAsked = new Set<string>();
  private readonly compareAnswers = new Map<string, CompareAnswer>();
  private readonly compareMissed = new Set<string>();
  /** Shares whose missing ticket or worktree folder this start created, and those being made. */
  private readonly madeRoots = new Set<string>();
  private readonly chores = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: MigrationDeps) {
    this.db = deps.db;
    this.local = deps.nodeId;
    this.clock = deps.clock ?? systemClock;
    this.retry = deps.retry ?? RETRY;
  }

  // ---- the machine ----

  /** Projects the machine looks after: every switched one and any not settled on Syncthing. */
  private tracked(): string[] {
    return [...new Set([...listEngineRecords(this.db).map((record) => record.projectId), ...listPhases(this.db).keys()])].sort();
  }

  /** A derivation, a record or a capability changed: every tracked project takes a step if it has one, and the owner's automatic moves look again. */
  kick(projectId?: string): void {
    if (this.stopped) return;
    for (const id of projectId ? [projectId] : this.tracked()) this.run(id);
    if (projectId) this.autoEvaluate(projectId); else this.autoAll();
  }

  /** A share report came in: a project waiting for its peers to catch up tries again at once when they have; one on Syncthing may have become clean. */
  shareChanged(status: ShareStatus): void {
    if (this.stopped) return;
    if (phaseOf(this.db, status.projectId)?.phase !== "bootstrapping") {
      if (status.state === "unavailable" && status.kind !== "project" && projectFilesOnSyncthing(this.db, status.projectId)) {
        const made = this.makeRoot(status).finally(() => this.chores.delete(made));
        this.chores.add(made);
      }
      this.autoEvaluate(status.projectId);
      return;
    }
    if (status.state !== "idle" || status.scanning || !status.peers.every((peer) => peer.caughtUp)) return;
    const wait = this.waits.get(status.projectId);
    if (wait) wait.until = 0;
    this.run(status.projectId);
  }

  /**
   * auto-transition: Syncthing's event stream. A configuration change, a pause or a resume may put a
   * folder over a project that built-in sync moves here (the GUI, the CLI, a restored configuration):
   * those projects check their folders again now. A folder that went idle, or a device that caught up,
   * may let a waiting automatic move go on.
   */
  syncthingEvents(events: readonly StreamEvent[]): void {
    if (this.stopped) return;
    let configuration = false;
    const settled = new Set<string>();
    for (const event of events) {
      if (event.type === "ConfigSaved" || event.type === "FolderPaused" || event.type === "FolderResumed") configuration = true;
      const data = (event.data ?? {}) as { folder?: unknown; to?: unknown; completion?: unknown };
      if (typeof data.folder !== "string") continue;
      if ((event.type === "StateChanged" && data.to === "idle") || (event.type === "FolderCompletion" && data.completion === 100)) settled.add(data.folder);
    }
    if (configuration) this.syncthingChanged();
    if (!settled.size) return;
    this.syncthingTick++;
    const owners = this.folderOwners("");
    for (const project of new Set([...settled].flatMap((folder) => owners.get(folder)?.id ?? []))) this.autoEvaluate(project);
  }

  /**
   * fix: a shared project's ticket or worktree folder that does not exist here (a node that never had
   * it from Syncthing, a moved ticket root) is made empty, as the switch's bootstrap would, and looked
   * at: otherwise it is never compared and the project never moves. A missing project folder is not
   * made: it may be on a disk that is not mounted.
   */
  private async makeRoot(status: ShareStatus): Promise<void> {
    if (this.madeRoots.has(status.share)) return;
    const spec = this.deps.engine.specs(status.projectId).find((candidate) => candidate.key === status.share);
    if (!spec || spec.kind === "project") return;
    this.madeRoots.add(status.share);
    try { await mkdir(spec.root, { recursive: true }); } catch (error) {
      this.log(`fileSync:root:${spec.key}`, `File sync could not make the ${kindLabel(spec.kind)} folder of ${this.name(spec.projectId)} at ${spec.root}: ${messageOf(error)}`);
      return;
    }
    try { await this.deps.engine.call("scan", { share: spec.key, scope: "full", reason: "folder" }); } catch (error) {
      // The share left the worker meanwhile (a new list of projects to compare, file sync stopping) or the worker restarts:
      // the worker walks a share it is given in full, so the folder made here is found then.
      if (this.stopped || /share not found|worker stopped/i.test(messageOf(error)) || (error as { code?: unknown })?.code === "not-running") return;
      this.log(`fileSync:root:${spec.key}`, `File sync could not look at the new ${kindLabel(spec.kind)} folder of ${this.name(spec.projectId)} at ${spec.root}: ${messageOf(error)}`);
    }
  }

  /** Syncthing's folders may have changed outside Joint Bob (or went unwatched): every project past Syncthing here looks at them again now. */
  syncthingChanged(): void {
    if (this.stopped) return;
    for (const record of listPhases(this.db).values()) {
      if (record.phase === "syncthing") continue;
      if (record.phase === "builtin") this.recheck.add(record.projectId);
      // A release waiting for a folder the user just removed goes on at once.
      const wait = this.waits.get(record.projectId);
      if (wait) wait.until = 0;
      this.run(record.projectId);
    }
  }

  /** Whether the worker may write the built-in project's files now: a folder check of these roots passed since it moved here, and none found a folder over them since. */
  writesAllowed(projectId: string): boolean {
    return this.passedRoots(projectId) === this.rootsKey(projectId);
  }

  /** What this node's move of the project is doing or waits for now, if anything. */
  message(projectId: string): string | undefined { return this.messages.get(projectId); }

  /** Read from node.db each time: a stand-in machine (Settings while file sync starts) may have written it. */
  private passedRoots(projectId: string): string | null {
    try { return verifiedRoots(this.db, projectId) ?? null; } catch { return null; }
  }

  private setPassed(projectId: string, roots: string | null): void {
    if (this.passedRoots(projectId) !== roots) setVerifiedRoots(this.db, projectId, roots);
  }

  stop(): void {
    this.stopped = true;
    for (const wait of this.waits.values()) wait.timer?.cancel();
    this.waits.clear();
    for (const held of this.autoTimers.values()) held.timer.cancel();
    this.autoTimers.clear();
  }

  /** Tests: resolves once no step or automatic evaluation runs. */
  async idle(): Promise<void> {
    while (this.steps.size || this.autoRuns.size || this.chores.size) await Promise.allSettled([...this.steps.values(), ...this.autoRuns.values(), ...this.chores]);
  }

  /** Tests: the timers this machine holds, by project. */
  pendingTimers(): string[] {
    return [...[...this.waits].filter(([, wait]) => wait.timer).map(([projectId]) => projectId), ...this.autoTimers.keys()].sort();
  }

  private run(projectId: string): void {
    if (this.steps.has(projectId)) { this.again.add(projectId); return; }
    const done = this.step(projectId).catch((error) => {
      this.log(`fileSync:switch:${projectId}`, `File sync could not move ${this.name(projectId)} on: ${messageOf(error)}`);
      this.wait(projectId);
    }).finally(() => {
      this.steps.delete(projectId);
      if (!this.stopped) this.reportToOwner(projectId);
      if (this.again.delete(projectId) && !this.stopped) this.run(projectId);
    });
    this.steps.set(projectId, done);
  }

  private async step(projectId: string): Promise<void> {
    await this.announce(projectId);
    // The owner's view of each peer's move lives in memory: once per start it asks, then the peers tell it of changes.
    if (!this.asked.has(projectId) && engineRecordOf(this.db, projectId) && this.ownerOf(projectId) === this.local) {
      this.asked.add(projectId);
      void this.askPhases(projectId);
    }
    for (let count = 0; !this.stopped; count++) {
      // A folder that keeps coming back sends the project round in circles: it tries again later, not at once.
      if (count === STEPS_PER_PASS) { this.wait(projectId); return; }
      const mode = engineModeOf(this.db, projectId);
      const phase = phaseOf(this.db, projectId)?.phase ?? "syncthing";
      if (mode === "builtin") {
        // fix: file sync is being turned off here. Its built-in projects go back to Syncthing first, the engine syncing them
        // meanwhile: the owner moves them for every machine (this node's own at once), and this node never releases one.
        if (!this.deps.engine.enabled()) {
          if (this.ownerOf(projectId) === this.local) { await this.autoRollback(projectId, "file sync is being turned off on this machine"); continue; }
          this.updatePhase(projectId, phase, { error: `Waiting for ${this.peerName(this.ownerOf(projectId))} to move this project back to Syncthing, as file sync is being turned off here` });
          this.messages.set(projectId, "File sync is being turned off: this project goes back to Syncthing first");
          return;
        }
        const problem = this.peerProblem(projectId);
        if (problem) {
          if (this.ownerOf(projectId) === this.local) { await this.autoRollback(projectId, problem); continue; }
          // Only the owner may move it back; until it does, this node holds where it is and says why.
          this.updatePhase(projectId, phase, { error: problem });
          return;
        }
        if (phase === "syncthing") {
          if (!this.roots(projectId) || !projectPeers(this.db, this.local, projectId).length) {
            this.messages.set(projectId, "Waiting for this project to be shared with another machine");
            return;
          }
          // Under the lock: an enrollment that checked the phase finishes first, and none starts after.
          await withProjectFilesLock(projectId, async () => {
            if (engineModeOf(this.db, projectId) === "builtin" && projectFilesOnSyncthing(this.db, projectId)) this.toReleasing(projectId);
          });
          this.messages.set(projectId, "Asking Syncthing to let go of this project's folders");
          await this.deps.engine.apply();
          continue;
        }
        // Moved back and forth before restoring finished: Syncthing may hold the folders again.
        if (phase === "restoring") { this.toReleasing(projectId); continue; }
        if (phase === "builtin") {
          this.messages.delete(projectId);
          // auto-transition: Syncthing's events say its folders changed: looked at again, writes go on meanwhile.
          const recheck = this.recheck.delete(projectId);
          if (recheck || this.checkOwed(projectId)) {
            const verified = await this.verifyBuiltin(projectId);
            if (verified === "moved") continue;
            // Not known yet (Syncthing did not answer): writes wait, and it is asked again with backoff until it does.
            if (verified === "unknown") { this.wait(projectId); return; }
            this.clearWait(projectId);
          }
          this.clearError(projectId, "builtin");
          return;
        }
        if (this.waiting(projectId)) return;
        const outcome = phase === "releasing" ? await this.release(projectId) : await this.bootstrap(projectId);
        if (outcome === "wait") { this.wait(projectId); return; }
        this.clearWait(projectId);
        continue;
      }
      if (phase === "syncthing") { this.messages.delete(projectId); this.clearWait(projectId); this.clearError(projectId, phase); this.deps.engine.left?.(); return; }
      if (phase !== "restoring") {
        this.updatePhase(projectId, "restoring");
        this.messages.set(projectId, "Moving back to Syncthing");
        continue;
      }
      // The worker leaves the project first (stops writing, its queue goes), then Syncthing may take it back.
      if (!(await this.deps.engine.apply())) { this.wait(projectId); return; }
      if (engineModeOf(this.db, projectId) !== "syncthing") continue;
      this.updatePhase(projectId, "syncthing", { builtinSince: {} });
      for (const kind of SHARE_KINDS) this.scanned.delete(`${kind}:${projectId}`);
      this.verified.delete(projectId);
      this.setPassed(projectId, null);
      this.clearWait(projectId);
      this.messages.delete(projectId);
      await this.deps.engine.apply();
      this.deps.engine.left?.();
      return;
    }
  }

  /** syncthing → releasing → bootstrapping: every Joint Bob folder over the roots leaves Syncthing, checked by a fresh list. */
  private async release(projectId: string): Promise<StepOutcome> {
    const roots = this.roots(projectId);
    if (!roots) { this.messages.set(projectId, "This project's folder is not known on this machine"); return "wait"; }
    // fix (P4+P5): a project inside this one (or around it) that built-in sync moves here: two shares would write its files.
    const [nested] = await this.nestedProjects(projectId, roots, true);
    if (nested) {
      this.updatePhase(projectId, "releasing", { error: nested });
      this.messages.set(projectId, "Waiting for a project inside this one to move back to Syncthing");
      return "wait";
    }
    let folders: SyncthingFolder[];
    try { folders = await this.folderList(projectId); } catch (error) {
      this.messages.set(projectId, messageOf(error) === SYNCTHING_UNREACHABLE ? SYNCTHING_UNREACHABLE : `Waiting for Syncthing to let go of this project's folders (Syncthing did not answer: ${messageOf(error)})`);
      return "wait";
    }
    const { remove, pause, blocked } = await this.classify(projectId, folders, roots);
    if (blocked.length) {
      this.updatePhase(projectId, "releasing", { error: blocked[0].reason });
      this.messages.set(projectId, `Waiting for Syncthing to let go of ${folderLabel(blocked[0].folder)}`);
      return "wait";
    }
    for (const folder of remove) {
      try { await this.deps.syncthing.removeFolder(folder.id); } catch { /* the fresh list below decides */ }
    }
    // auto-transition: an old shared folder someone resumed is paused right now, not at the next sharing pass.
    for (const folder of pause) {
      try {
        await this.deps.syncthing.pauseFolder!(folder.id);
        this.log(`fileSync:switch:pause:${folder.id}`, `File sync paused Joint Bob's old shared folder ${folderLabel(folder)} in Syncthing: it covers ${this.name(projectId)}, whose files built-in sync moves`);
      } catch { /* the fresh list below decides */ }
    }
    let fresh: SyncthingFolder[];
    try { fresh = await this.folderList(projectId); } catch {
      this.messages.set(projectId, `Waiting for Syncthing to let go of ${remove.length ? folderLabel(remove[0]) : "this project's folders"}`);
      return "wait";
    }
    const left = await this.holding(projectId, fresh, roots);
    if (left.length) { this.messages.set(projectId, `Waiting for Syncthing to let go of ${folderLabel(left[0])}`); return "wait"; }
    if (tableExists(this.db, "cluster_v2_file_enrollments")) {
      const removed = this.db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE project_id = ?").run(projectId).changes;
      // Relay-reached peers get their Syncthing tunnels planned again without these folders.
      if (removed) notifyRelayPeersChanged();
    }
    if (engineModeOf(this.db, projectId) !== "builtin" || phaseOf(this.db, projectId)?.phase !== "releasing") return "again";
    this.updatePhase(projectId, "bootstrapping");
    this.messages.set(projectId, "Checking both machines' files");
    return "done";
  }

  /** bootstrapping → builtin: Syncthing's temps go, then per folder a full scan and the bootstrap decision (need.ts). */
  private async bootstrap(projectId: string): Promise<StepOutcome> {
    const engine = this.deps.engine;
    if (!engine.running()) { this.messages.set(projectId, "Waiting for file sync to start on this machine"); return "wait"; }
    const roots = this.roots(projectId);
    if (!roots) return "wait";
    // The engine writes only once Syncthing holds none of the roots: a folder added back since sends the project back.
    let folders: SyncthingFolder[];
    try { folders = await this.folderList(projectId); } catch {
      this.messages.set(projectId, "Waiting for Syncthing to answer before taking over this project's files");
      return "wait";
    }
    if ((await this.holding(projectId, folders, roots)).length) {
      this.toReleasing(projectId);
      return "again";
    }
    if (!(await engine.apply())) return "wait";
    const specs = engine.specs(projectId).sort((a, b) => SHARE_KINDS.indexOf(a.kind) - SHARE_KINDS.indexOf(b.kind));
    if (!specs.length) { this.messages.set(projectId, "Waiting for the other machines to be reachable"); return "wait"; }
    this.messages.set(projectId, "Checking both machines' files");
    const since: Record<string, number> = { ...phaseOf(this.db, projectId)?.builtinSince };
    for (const spec of specs) {
      if (Object.hasOwn(since, spec.kind)) continue;
      if (engineModeOf(this.db, projectId) !== "builtin" || phaseOf(this.db, projectId)?.phase !== "bootstrapping") return "again";
      if (!this.scanned.has(spec.key)) {
        // Enrollment made these for Syncthing; a node that never held a ticket or worktree gets the empty folder now. A
        // missing project folder is not made: it may be on a disk that is not mounted.
        if (spec.kind !== "project") await mkdir(spec.root, { recursive: true }).catch(() => undefined);
        // Syncthing has let go: what it left half-downloaded goes, then the index is brought up to date with the disk.
        const matcher = compileRules(effectiveRules(spec.kind, spec.rules));
        await removeSyncthingTemps(spec.root, (relative) => matcher.classify(relative, true) !== null);
        const scanned = await engine.call("scan", { share: spec.key, scope: "full", reason: "switch" }, { timeoutMs: SCAN_TIMEOUT_MS });
        if (scanned.error) { this.messages.set(projectId, `Checking both machines' files: this machine could not read its ${kindLabel(spec.kind)} (${scanned.error})`); return "wait"; }
        this.scanned.add(spec.key);
      }
      const [status] = await engine.call("status", { shares: [spec.key] });
      if (!status) return "wait";
      const byPeer = Object.fromEntries(status.peers.flatMap((peer) => typeof peer.builtinSince === "number" ? [[peer.peer, peer.builtinSince]] : []));
      try {
        await engine.call("bootstrap", { share: spec.key, builtinSinceByPeer: byPeer }, { timeoutMs: BOOTSTRAP_TIMEOUT_MS });
      } catch (error) {
        if ((error as { code?: unknown })?.code !== "not-ready") throw error;
        // Its index or a peer's is not whole yet: the pulls are asked for now, and the share's next report tries again.
        for (const peer of spec.peers) engine.nudge(peer);
        this.messages.set(projectId, "Checking both machines' files: waiting for the other machines' lists of files");
        return "wait";
      }
      const [after] = await engine.call("status", { shares: [spec.key] });
      since[spec.kind] = typeof after?.builtinSince === "number" ? after.builtinSince : after?.maxSeq ?? status.maxSeq;
      this.updatePhase(projectId, "bootstrapping", { builtinSince: since });
    }
    if (engineModeOf(this.db, projectId) !== "builtin" || phaseOf(this.db, projectId)?.phase !== "bootstrapping") return "again";
    // Scans and decisions can take minutes: Syncthing is asked once more right before the engine may write.
    try { folders = await this.folderList(projectId); } catch {
      this.messages.set(projectId, "Waiting for Syncthing to answer before taking over this project's files");
      return "wait";
    }
    if ((await this.holding(projectId, folders, roots)).length) {
      this.toReleasing(projectId);
      return "again";
    }
    this.updatePhase(projectId, "builtin", { builtinSince: since });
    this.messages.delete(projectId);
    this.verified.set(projectId, this.checkedNow(projectId));
    this.setPassed(projectId, this.rootsKey(projectId));
    await engine.apply();
    return "done";
  }

  private rootsKey(projectId: string): string { return JSON.stringify(this.roots(projectId) ?? null); }

  /** What a check now is for: this node's Syncthing and the project's roots. */
  private checkedNow(projectId: string): { generation: number; roots: string } {
    return { generation: this.deps.syncthing.generation?.() ?? 0, roots: this.rootsKey(projectId) };
  }

  /** Not checked since this start, or for other roots or another Syncthing. */
  private checkOwed(projectId: string): boolean {
    const held = this.verified.get(projectId), now = this.checkedNow(projectId);
    return !held || held.roots !== now.roots || held.generation !== now.generation;
  }

  /**
   * At each start, when the project's roots move, when this node is pointed at another Syncthing and
   * when Syncthing's events say its folders changed: a live folder over a built-in project's roots
   * (added or resumed in the GUI, a restored configuration, a path that missed the guard) sends the
   * project back to releasing, which stops the engine writing there at once. Writes need one passed
   * check of these roots since the project moved here (index.ts derives the share as not builtin
   * until then); after that a Syncthing that does not answer stops nothing: its event stream looks
   * again once it is back (syncthingChanged). Never passed, writes wait for an answer ("unknown").
   */
  private async verifyBuiltin(projectId: string): Promise<"clear" | "moved" | "unknown"> {
    const key = this.checkedNow(projectId);
    const allowed = this.writesAllowed(projectId);
    const roots = this.roots(projectId);
    if (!roots) {
      this.verified.set(projectId, key);
      return "clear";
    }
    let folders: SyncthingFolder[];
    try { folders = await this.folderList(projectId); } catch (error) {
      if (allowed) { this.verified.set(projectId, key); return "clear"; }
      this.messages.set(projectId, messageOf(error) === SYNCTHING_UNREACHABLE ? SYNCTHING_UNREACHABLE : WRITES_WAIT_FOR_SYNCTHING);
      return "unknown";
    }
    const left = await this.holding(projectId, folders, roots);
    if (!left.length) {
      this.verified.set(projectId, key);
      this.setPassed(projectId, key.roots);
      this.messages.delete(projectId);
      if (!allowed) await this.deps.engine.apply();
      return "clear";
    }
    this.verified.delete(projectId);
    const [folder] = left;
    this.log(`fileSync:switch:${projectId}`, `Syncthing syncs ${folderLabel(folder)} again, over ${this.name(projectId)}: built-in sync stops writing there until Syncthing lets go of it`);
    this.toReleasing(projectId, `Syncthing syncs “${folderLabel(folder)}” (${folder.path}) over this project's files again, so built-in sync stopped writing them here until Syncthing lets go of it`);
    await this.deps.engine.apply();
    return "moved";
  }

  /**
   * A fresh folder list. With no connection to a Syncthing here, there is nothing to let go of only
   * where Joint Bob never gave Syncthing the project's folders (no enrollment rows: the release
   * deletes them once a fresh list proved the folders gone) and no Syncthing configuration was found:
   * otherwise a daemon Joint Bob cannot reach may still sync them (SYNCTHING_UNREACHABLE).
   */
  private async folderList(projectId: string): Promise<SyncthingFolder[]> {
    try { return await this.deps.syncthing.folders(); } catch (error) {
      if (!(error instanceof SyncthingNotConfigured)) throw error;
      if (!error.installed && !this.enrolled(projectId)) return [];
      throw new Error(SYNCTHING_UNREACHABLE);
    }
  }

  private enrolled(projectId: string): boolean {
    if (!tableExists(this.db, "cluster_v2_file_enrollments")) return false;
    return this.db.prepare("SELECT 1 FROM cluster_v2_file_enrollments WHERE project_id = ? LIMIT 1").get(projectId) !== undefined;
  }

  /** Folder id → the project whose folder it is (sharing-files.ts enrollment names them); `projectId` wins a shared id. */
  private folderOwners(projectId: string): Map<string, { id: string; name: string }> {
    const rows = this.db.prepare("SELECT id, name, sync_folder_id FROM projects").all() as Array<{ id: string; name: string; sync_folder_id: string | null }>;
    const owners = new Map<string, { id: string; name: string }>();
    for (const row of rows) for (const id of projectFolderIds(row.id, row.sync_folder_id)) if (!owners.has(id) || row.id === projectId) owners.set(id, row);
    return owners;
  }

  /**
   * The folders over the roots that Syncthing may write in. Joint Bob's old shared folders (ticket
   * workspaces, agent resources, conversations), which no project owns, are left out while paused:
   * Joint Bob pauses them on every sharing pass and takes peers' devices off them, so Syncthing never
   * writes there, and the switch must not touch a folder that is not the project's (user decision).
   */
  private async holding(projectId: string, folders: readonly SyncthingFolder[], roots: Record<ShareKind, string>, owners = this.folderOwners(projectId)): Promise<SyncthingFolder[]> {
    return (await syncthingFoldersCovering(folders, Object.values(roots))).filter((folder) => !(folder.paused === true && !owners.has(folder.id) && jointBobFolderId(folder.id)));
  }

  /**
   * Only the project's own folders are ever removed, and Joint Bob's old shared folders paused (as
   * every sharing pass keeps them); any other folder that may write over its roots blocks the switch, named.
   */
  private async classify(projectId: string, folders: readonly SyncthingFolder[], roots: Record<ShareKind, string>): Promise<Classified> {
    const owners = this.folderOwners(projectId);
    const result: Classified = { remove: [], pause: [], blocked: [] };
    for (const folder of await this.holding(projectId, folders, roots, owners)) {
      const owner = owners.get(folder.id);
      if (owner?.id === projectId) result.remove.push(folder);
      // Another project's folder (nested projects): removing it would only see enrollment add it back, and a project on
      // built-in sync here lets go of it itself (verifyBuiltin). Two projects inside each other stay with Syncthing: on
      // built-in sync both would write the inner one's files (fix P4+P5).
      else if (owner) result.blocked.push({ folder, reason: projectFilesOnSyncthing(this.db, owner.id)
        ? `Syncthing syncs “${owner.name}” in ${folder.path}, which overlaps this project's files; projects inside each other stay with Syncthing`
        : `Syncthing syncs “${owner.name}” in ${folder.path} again, which overlaps this project's files; restarting Joint Bob on this machine makes it let go` });
      // auto-transition: resumed by someone (Joint Bob's sharing passes keep these paused): the release pauses it itself,
      // so it holds nothing up. fix: only those; dot-pi, dot-claude and any other are the person's to pause.
      else if (pausedByJointBob(folder.id) && this.deps.syncthing.pauseFolder) result.pause.push(folder);
      else if (jointBobFolderId(folder.id)) result.blocked.push({ folder, reason: `Joint Bob's old shared folder “${folderLabel(folder)}” (${folder.path}) is not paused in Syncthing and overlaps this project's files; pause it in Syncthing first` });
      // Not Joint Bob's (the user's own folders in a shared daemon): never touched.
      else result.blocked.push({ folder, reason: `Syncthing folder “${folderLabel(folder)}” (${folder.path}) is not Joint Bob's and overlaps this project's files; Joint Bob leaves it alone, so remove it in Syncthing first` });
    }
    return result;
  }

  /**
   * fix (P4+P5): other projects synced from this node whose folders lie inside this one's, or around
   * it. Moved to built-in sync, both projects' shares would write the inner files (§0.12), so neither
   * moves. An unshared project inside is only this project's files. `builtinOnly`: only those that
   * built-in sync moves here already (or is moving), which keep a switched project from writing.
   */
  private async nestedProjects(projectId: string, roots: Record<ShareKind, string>, builtinOnly = false): Promise<string[]> {
    const rows = this.db.prepare("SELECT id, name FROM projects WHERE id <> ? ORDER BY name, id").all(projectId) as Array<{ id: string; name: string }>;
    let candidates: string[] | undefined;
    const reasons: string[] = [];
    for (const row of rows) {
      const onSyncthing = projectFilesOnSyncthing(this.db, row.id);
      if (builtinOnly && onSyncthing) continue;
      if (onSyncthing && !engineRecordOf(this.db, row.id)) {
        try { candidates ??= replicationPeers(this.db, this.local).map((peer) => peer.nodeId); } catch { candidates = []; }
        if (!projectPeers(this.db, this.local, row.id, candidates).length) continue;
      }
      const theirs = this.roots(row.id);
      if (!theirs) continue;
      const [hit] = await syncthingFoldersCovering(Object.values(theirs).map((root) => ({ path: root })), Object.values(roots));
      if (hit) reasons.push(`Project “${row.name}” (${hit.path}) lies inside this project's folders or around them${onSyncthing ? "" : ", and built-in sync moves it on this machine"}; projects inside each other stay with Syncthing`);
    }
    return reasons;
  }

  /** What would hold this node's release of the project: nested projects, folders Syncthing may write in that are not the project's own, and its own elsewhere. */
  private async releaseBlockers(projectId: string): Promise<{ blockers: string[]; remove: SyncthingFolder[]; syncthing?: string }> {
    const roots = this.roots(projectId);
    if (!roots) return { blockers: ["This project's folder is not known on this machine"], remove: [] };
    const blockers = await this.nestedProjects(projectId, roots);
    let folders: SyncthingFolder[];
    try { folders = await this.folderList(projectId); } catch (error) { return { blockers, remove: [], syncthing: messageOf(error) }; }
    const { remove, blocked } = await this.classify(projectId, folders, roots);
    // fix: the project's own folder syncing somewhere else here (a received project given another folder): built-in sync
    // would sync its folder, and the files Syncthing keeps there would stay behind with nobody to sync with.
    const owners = this.folderOwners(projectId);
    const kindOf = (id: string): ShareKind => id === projectTicketSyncFolderId(projectId) ? "tickets" : id === projectWorktreeSyncFolderId(projectId) ? "worktrees" : "project";
    const elsewhere = folders.filter((folder) => owners.get(folder.id)?.id === projectId && folder.paused !== true && !remove.some((held) => held.id === folder.id))
      .map((folder) => `Syncthing syncs ${folderLabel(folder)} in ${folder.path} on this machine, but the project's folder here is ${roots[kindOf(folder.id)]}; moving it would leave the files in ${folder.path} behind`);
    return { blockers: [...blockers, ...blocked.map((entry) => entry.reason), ...elsewhere], remove };
  }

  // ---- continuous check: every eligible peer must be able to take files from the engine ----

  /**
   * A peer known to lack the engine, to run one too old to leave Syncthing for a switched project
   * (2.157, 2.158: it would stay on Syncthing while this node stops sending there), or to have it
   * off; an unheard peer is not a problem yet (every peer is unheard at start).
   */
  private peerProblem(projectId: string): string | undefined {
    for (const peer of projectPeers(this.db, this.local, projectId)) {
      if (this.peerReports.get(projectId)?.get(peer)?.leaving) return `${this.peerName(peer)} is turning file sync off, so it stops receiving this project's files`;
      const known = this.deps.capability(peer);
      if (!known) continue;
      if (known.protocol < FILE_SYNC_MIN_PROTOCOL) return `${this.peerName(peer)} runs a Joint Bob without built-in file sync, so it cannot receive this project's files`;
      if (known.protocol < FILE_SYNC_SWITCH_PROTOCOL || (known.minProtocol ?? FILE_SYNC_MIN_PROTOCOL) > FILE_SYNC_PROTOCOL) return `${this.peerName(peer)} needs a newer Joint Bob to receive this project's files with built-in sync`;
      if (known.enabled === false) return `${this.peerName(peer)} has file sync turned off, so it cannot receive this project's files`;
    }
    return undefined;
  }

  private async autoRollback(projectId: string, problem: string): Promise<void> {
    this.record(projectId, "syncthing");
    // auto-transition: no flapping: the automatic move needs a fresh matching time once the peer can take files again.
    updateProjectHold(this.db, projectId, { cleanAfter: new Date(this.clock.now()).toISOString() });
    this.log(`fileSync:switch:${projectId}`, `File sync moved ${this.name(projectId)} back to Syncthing: ${problem}`);
    this.auditMove(projectId, "syncthing", { automatic: true, reason: problem });
    await this.announce(projectId);
  }

  // ---- the owner's switch ----

  ownerOf(projectId: string): string { return projectOwnerNode(this.db, projectId) ?? this.local; }

  /** Live checks for moving the project to `target` (default: the other engine). */
  async checks(projectId: string, target?: EngineMode): Promise<ChecksAnswer> {
    const engine = target ?? (engineModeOf(this.db, projectId) === "builtin" ? "syncthing" : "builtin");
    const statuses = this.deps.engine.statuses(projectId);
    const cleanSince = projectCleanSince(statuses);
    const checks: Check[] = [];
    const owner = this.ownerOf(projectId);
    checks.push(owner === this.local
      ? { key: "owner", ok: true, message: "This machine owns the project" }
      : { key: "owner", ok: false, message: `Only ${this.peerName(owner)}, which owns this project, can move it` });
    const peers = projectPeers(this.db, this.local, projectId);
    checks.push(peers.length
      ? { key: "shared", ok: true, message: `Shared with ${peers.map((peer) => this.peerName(peer)).join(", ")}` }
      : { key: "shared", ok: false, message: "This project is not shared with another machine", waiting: "Waiting for this project to be shared with another machine" });
    // Peers learn of the switch from this node's engine (its answers carry the record), so it must run here either way.
    checks.push(!this.deps.engine.enabled() ? { key: "engine", ok: false, message: "Turn on file sync on this machine first", waiting: "Waiting for file sync to be turned on on this machine" }
      : !this.deps.engine.running() ? { key: "engine", ok: false, message: "File sync is still starting on this machine", waiting: "Waiting for file sync to start on this machine" }
      : { key: "engine", ok: true, message: "File sync runs on this machine" });
    const answers = await Promise.all(peers.map((peer) => this.askPeer(peer, projectId, statuses, engine === "builtin")));
    if (engine === "syncthing") {
      // fix: a machine away does not hold the move back: it hears of it at its next contact (the notice goes again then,
      // and every shares answer carries the record), as an automatic move back does.
      const silent = answers.filter((answer) => !answer.shares);
      checks.push(silent.length
        ? { key: "reachable", ok: true, message: `${silent.map((answer) => this.peerName(answer.peer)).join(", ")} did not answer, so ${silent.length === 1 ? "it moves" : "they move"} back once in touch with this machine again` }
        : { key: "reachable", ok: true, message: "Every machine answered" });
      return { engine, checks, cleanSince };
    }
    checks.push(this.capableCheck(answers));
    checks.push(this.rulesCheck(answers, statuses));
    checks.push(this.differencesCheck(peers, statuses));
    checks.push(this.caughtUpCheck(answers, statuses));
    checks.push(...await this.syncthingChecks(projectId, peers, answers));
    const busy = await (this.deps.activity ?? defaultActivity)(projectId).catch((error) => `Could not check for running tasks: ${messageOf(error)}`);
    checks.push(busy ? { key: "activity", ok: false, message: busy } : { key: "activity", ok: true, message: "No task or merge is running in this project" });
    return { engine, checks, cleanSince };
  }

  /**
   * Records the engine and tells every peer; refused with every check when one fails (a move back
   * needs only the owner and a running engine). A person's move back holds the project on Syncthing,
   * a person's move to built-in sync lifts that; `auto` is the owner's own move, which goes only
   * while nothing holds it back.
   */
  async switchEngine(projectId: string, target: EngineMode, options: { by?: string; actorId?: string; auto?: boolean } = {}): Promise<FileSyncProject> {
    const previous = this.switching.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      // A person's move just before (the chain runs it first) wins over the automatic one.
      const due = options.auto ? this.autoLocal(projectId) : undefined;
      if (options.auto && due?.state !== "due") return this.project(projectId);
      const answer = await this.checks(projectId, target);
      if (answer.checks.some((check) => !check.ok)) throw new EngineSwitchRefused(answer.checks);
      // Moving back again re-announces (a peer that missed the first word still on built-in sync hears it now).
      if (engineModeOf(this.db, projectId) !== target || (target === "syncthing" && engineRecordOf(this.db, projectId))) {
        this.record(projectId, target);
        if (options.auto) {
          const cleanSince = due?.cleanSince ?? answer.cleanSince;
          const matched = cleanSince ? this.clock.now() - Date.parse(cleanSince) : 0;
          (this.deps.info ?? console.log)(`File sync moved ${this.name(projectId)} to built-in sync by itself: every check passed and its files matched on every machine for ${span(matched)}`);
          this.deps.metric?.("fileSync.autoSwitch", matched, { peers: projectPeers(this.db, this.local, projectId).length });
        } else this.log(`fileSync:switch:${projectId}`, `File sync moves ${this.name(projectId)} to ${target === "builtin" ? "built-in sync" : "Syncthing"}`);
        this.auditMove(projectId, target, { automatic: Boolean(options.auto), ...(options.auto ? {} : { actorId: options.actorId ?? null }) });
      }
      if (!options.auto) {
        updateProjectHold(this.db, projectId, target === "syncthing"
          ? { stayOnSyncthing: { by: options.by ?? "an admin", at: new Date(this.clock.now()).toISOString() } }
          : { stayOnSyncthing: null, cleanAfter: null });
      }
      // Moving to the engine already in use tells the peers again.
      this.unnotified.add(projectId);
      await this.announce(projectId);
      this.kick(projectId);
      return this.project(projectId);
    });
    const held = run.catch(() => undefined);
    this.switching.set(projectId, held);
    try { return await run; } finally { if (this.switching.get(projectId) === held) this.switching.delete(projectId); }
  }

  /**
   * fix: lifts a move back by hand without moving the project now: the owner moves it by itself
   * again once every check passes and the files matched long enough (a fresh matching time after
   * an automatic move back is waived too). Only the owner may.
   */
  allowAuto(projectId: string): FileSyncProject {
    if (this.ownerOf(projectId) !== this.local) throw new EngineSwitchRefused([{ key: "owner", ok: false, message: `Only ${this.peerName(this.ownerOf(projectId))}, which owns this project, can allow its automatic move` }]);
    updateProjectHold(this.db, projectId, { stayOnSyncthing: null, cleanAfter: null });
    this.autoEvaluate(projectId);
    return this.project(projectId);
  }

  /** generation + 1, never an older timestamp than the record it replaces (another node's clock may run ahead). */
  private record(projectId: string, mode: EngineMode): EngineRecord {
    const held = engineRecordOf(this.db, projectId);
    const at = Math.max(this.clock.now(), held ? Date.parse(held.updatedAt) + 1 : 0);
    const record: EngineRecord = { projectId, mode, generation: (held?.generation ?? 0) + 1, updatedAt: new Date(at).toISOString(), origin: this.local };
    saveEngineRecord(this.db, record);
    this.unnotified.add(projectId);
    // A matching time counted before a move says nothing about the files after it.
    if (projectHold(this.db, projectId).matching) updateProjectHold(this.db, projectId, { matching: null });
    return record;
  }

  /** Once the worker serves the new record, every peer is asked to fetch it; a configure that did not go through is retried with the next step. */
  private async announce(projectId: string): Promise<void> {
    if (!this.unnotified.has(projectId) || !(await this.deps.engine.apply())) return;
    this.unnotified.delete(projectId);
    await this.notify(projectId);
  }

  /** Each peer fetches this node's shares answer, which carries the record (records.ts accepts it from the owner only). */
  private async notify(projectId: string): Promise<void> {
    await Promise.allSettled(projectPeers(this.db, this.local, projectId).map(async (peer) => {
      try {
        await this.sendNotice(peer);
      } catch (error) {
        // auto-transition: told again at its next contact with this node (a hello, its return, a request of its own).
        this.missedNotices.add(peer);
        this.log(`fileSync:switch:notify:${peer}`, `File sync could not tell ${this.peerName(peer)} about the move of ${this.name(projectId)} yet: ${messageOf(error)}`);
      }
    }));
  }

  /** One notice carries every record: the peer fetches this node's whole shares answer. */
  private async sendNotice(peer: string): Promise<void> {
    const response = await this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/changed`, json: { shares: [], records: true } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    this.missedNotices.delete(peer);
    this.deps.settle?.(`fileSync:switch:notify:${peer}`);
  }

  /**
   * auto-transition: the peer is in touch again (a hello or its answer, its return, a request of its
   * own): a record notice it missed goes again, and so does what an automatic move waits for. Nothing
   * is retried on a timer: a peer that stays away hears it when it comes back.
   */
  peerContact(peer: string): void {
    if (this.stopped || peer === this.local) return;
    if (this.missedNotices.has(peer) && !this.noticing.has(peer)) {
      this.noticing.add(peer);
      void this.sendNotice(peer).catch((error) => {
        this.log(`fileSync:switch:notify:${peer}`, `File sync could not tell ${this.peerName(peer)} about a move yet: ${messageOf(error)}`);
      }).finally(() => this.noticing.delete(peer));
    }
    for (const projectId of [...this.missedStates.get(peer) ?? []]) this.pushState(projectId, peer);
    // fix: a request to compare a project that did not get through is asked again now.
    for (const key of [...this.compareMissed]) {
      if (!key.startsWith(`${peer}\n`)) continue;
      this.compareMissed.delete(key);
      this.compareAsked.delete(key);
      this.autoEvaluate(key.slice(peer.length + 1));
    }
  }

  // ---- auto-transition: the owner's automatic move to built-in sync ----

  private autoConfig(): AutoSwitchConfig {
    try { return (this.deps.autoSwitch ?? (() => readFileSyncConfig(this.db).autoSwitch))(); } catch { return { enabled: false, cleanHours: 24 }; }
  }

  /** Every project this node owns that is on Syncthing looks again; the others drop their timer. */
  private autoAll(): void {
    let rows: Array<{ id: string }>;
    try { rows = this.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>; } catch { return; }
    for (const { id } of rows) this.autoEvaluate(id);
  }

  /** One evaluation per project at a time; a trigger meanwhile runs one more after it. */
  private autoEvaluate(projectId: string): void {
    if (this.stopped) return;
    if (this.autoRuns.has(projectId)) { this.autoAgain.add(projectId); return; }
    const run = this.autoStep(projectId).catch((error) => {
      this.log(`fileSync:auto:${projectId}`, `File sync could not decide whether to move ${this.name(projectId)} to built-in sync: ${messageOf(error)}`);
    }).finally(() => {
      this.autoRuns.delete(projectId);
      if (this.autoAgain.delete(projectId) && !this.stopped) this.autoEvaluate(projectId);
    });
    this.autoRuns.set(projectId, run);
  }

  private async autoStep(projectId: string): Promise<void> {
    const local = this.autoLocal(projectId);
    if (!local) {
      this.clearAutoTimer(projectId);
      this.autoStates.delete(projectId);
      this.autoChecked.delete(projectId);
      this.unexplained.delete(projectId);
      this.explained.delete(projectId);
      return;
    }
    if (local.compare) this.askCompare(projectId, local.compare);
    if (local.differing) { await this.autoDiffering(projectId, local); return; }
    this.unexplained.delete(projectId);
    this.explained.delete(projectId);
    if (local.matching) this.keepMatching(projectId, local.matching);
    if (local.state !== "due") {
      this.autoChecked.delete(projectId);
      this.setAutoState(projectId, local);
      if (local.at !== undefined) this.armAuto(projectId, local.at); else this.clearAutoTimer(projectId);
      return;
    }
    // A full check asks every peer: one that failed a moment ago is not repeated on every report, but once after the gap.
    const checked = this.autoChecked.get(projectId);
    // fix: a check that keeps failing for a lasting reason waits twice as long each time (up to AUTO_CHECK_GAP_MAX_MS).
    const gap = Math.min((this.deps.autoCheckGapMs ?? AUTO_CHECK_GAP_MS) * 2 ** Math.max(0, (checked?.failures ?? 1) - 1), AUTO_CHECK_GAP_MAX_MS);
    if (checked && this.clock.now() < checked.at + gap) { this.armAuto(projectId, checked.at + gap); return; }
    this.clearAutoTimer(projectId);
    try {
      await this.switchEngine(projectId, "builtin", { auto: true });
      this.autoChecked.delete(projectId);
    } catch (error) {
      if (!(error instanceof EngineSwitchRefused)) throw error;
      const failed = error.checks.find((check) => !check.ok);
      const reason = failed?.waiting ?? failed?.message ?? "Waiting for a check to pass";
      // Looked at again on the next change that could alter it; no retry on a timer.
      this.autoChecked.set(projectId, { at: this.clock.now(), reason, failures: (checked?.failures ?? 0) + 1 });
      this.setAutoState(projectId, { ...local, state: "blocked", reason, at: undefined });
    }
  }

  /**
   * fix: settled differences. Files still on their way (a machine away, Syncthing copying, a list of
   * files not fetched yet) leave the matching time running; differences that stand for the grace
   * with every machine there and Syncthing done end it. One timer, at the end of the grace; the rest
   * is looked at again on the reports, Syncthing events and contacts that end the wait.
   */
  private async autoDiffering(projectId: string, local: AutoDecision): Promise<void> {
    this.autoChecked.delete(projectId);
    const why = await this.inFlightReason(projectId, local.differing!);
    if (why) {
      this.unexplained.delete(projectId);
      this.carryMatching(projectId);
      this.clearAutoTimer(projectId);
      this.setAutoState(projectId, { ...local, reason: why });
      return;
    }
    local = { ...local, reason: this.differText(local.differing!) };
    const now = this.clock.now();
    const since = this.unexplained.get(projectId) ?? now;
    this.unexplained.set(projectId, since);
    const end = since + (this.deps.autoGraceMs ?? IN_FLIGHT_GRACE_MS);
    if (now < end) {
      this.carryMatching(projectId);
      this.armAuto(projectId, end);
    } else {
      // They differ with every machine there and Syncthing done: the matching time starts over once they match.
      if (projectHold(this.db, projectId).matching) updateProjectHold(this.db, projectId, { matching: null });
      this.clearAutoTimer(projectId);
    }
    this.setAutoState(projectId, local);
  }

  /**
   * Why settled differences with these peers may be files still on their way, or undefined: the peer
   * is away, this machine has not fetched its latest list of files, or this machine's Syncthing has
   * not finished copying the project with it (not connected, still copying). Syncthing is asked at
   * most every EXPLAIN_CACHE_MS unless one of its events came in since.
   */
  private async inFlightReason(projectId: string, differing: ReadonlyArray<{ peer: string; count: number }>): Promise<string | undefined> {
    const now = this.clock.now();
    const note = (reason: string | undefined, asked = false): string | undefined => {
      this.explained.set(projectId, { at: now, tick: this.syncthingTick, reason, asked });
      return reason;
    };
    for (const { peer, count } of differing) {
      if (this.deps.peerAway?.(peer)) return note(`Waiting for ${this.peerName(peer)} to come back: ${changedFiles(count)} ${count === 1 ? "waits" : "wait"} for it`);
    }
    const statuses = this.deps.engine.statuses(projectId);
    for (const { peer, count } of differing) {
      if (statuses.some((status) => status.peers.some((entry) => entry.peer === peer && !entry.caughtUp))) return note(`Waiting for this machine to fetch ${this.peerName(peer)}'s latest list of files (${changedFiles(count)})`);
    }
    const cached = this.explained.get(projectId);
    if (cached?.asked && cached.tick === this.syncthingTick && now - cached.at < EXPLAIN_CACHE_MS) return cached.reason;
    const enrolled = tableExists(this.db, "cluster_v2_file_enrollments")
      ? this.db.prepare("SELECT peer_id, device_id, folder_id FROM cluster_v2_file_enrollments WHERE project_id = ?").all(projectId) as Array<{ peer_id: string; device_id: string; folder_id: string }>
      : [];
    for (const { peer, count } of differing) {
      const rows = enrolled.filter((row) => row.peer_id === peer);
      // This machine's Syncthing does not copy the project with it: nothing here to wait for.
      if (!rows.length) continue;
      const done = await this.deps.syncthing.peerCaughtUp(rows[0].device_id, [...new Set(rows.map((row) => row.folder_id))]).catch(() => false);
      if (!done) return note(`Waiting for Syncthing to copy ${changedFiles(count)} between this machine and ${this.peerName(peer)}`, true);
    }
    return note(undefined, true);
  }

  /** The matching time as counted now, kept for the next start. */
  private keepMatching(projectId: string, matching: NonNullable<ProjectHold["matching"]>): void {
    const held = projectHold(this.db, projectId).matching;
    if (held && held.since === matching.since && held.worker === matching.worker && held.rules === matching.rules) return;
    updateProjectHold(this.db, projectId, { matching });
  }

  /** Differences that may be files on their way stand: the matching time is carried over the worker's new clean-since once they go. */
  private carryMatching(projectId: string): void {
    const held = projectHold(this.db, projectId).matching;
    if (held && held.worker !== null) updateProjectHold(this.db, projectId, { matching: { ...held, worker: null } });
  }

  /**
   * What the automatic move of a project this node owns waits for, from what this node knows without
   * asking anyone, in the order a person would fix it. Undefined when there is nothing to decide: not
   * this node's, not shared, or not settled on Syncthing.
   */
  private autoLocal(projectId: string): AutoDecision | undefined {
    if (this.ownerOf(projectId) !== this.local || engineModeOf(this.db, projectId) !== "syncthing" || !projectFilesOnSyncthing(this.db, projectId)) return undefined;
    const peers = projectPeers(this.db, this.local, projectId);
    if (!peers.length || !this.roots(projectId)) return undefined;
    const config = this.autoConfig();
    const hold = projectHold(this.db, projectId);
    const owner = this.ownerName();
    const decide = (state: AutoState, reason: string, extra: Partial<AutoDecision> = {}): AutoDecision => ({ state, reason, cleanSince: null, cleanHours: config.cleanHours, ...extra });
    if (hold.stayOnSyncthing) return decide("held", HELD_REASON, { peerReason: `Moved back to Syncthing by hand on ${owner}, so it stays there` });
    if (!config.enabled) return decide("off", "Automatic moves are off on this machine; click Move to built-in sync to move it", { peerReason: `Automatic moves are off on ${owner}` });
    if (!this.deps.engine.enabled()) return decide("blocked", "Waiting for file sync to be turned on on this machine");
    if (!this.deps.engine.running()) return decide("blocked", "Waiting for file sync to start on this machine");
    for (const peer of peers) {
      const problem = this.capabilityWait(peer);
      if (problem) return decide("blocked", problem);
    }
    const statuses = this.deps.engine.statuses(projectId);
    if (statuses.length < SHARE_KINDS.length || statuses.some((status) => status.state === "starting")) {
      return this.compared(projectId)
        ? decide("blocked", "Waiting for this machine to read its files for the first time, one project at a time", { peerReason: `Waiting for ${owner} to read its files for the first time` })
        : decide("blocked", "Not compared on this machine, so it stays on Syncthing; tick Compare to let it move", { peerReason: `${owner} does not compare this project, so it stays on Syncthing` });
    }
    // fix: a folder missing here is never compared (makeRoot makes the ticket and worktree folders).
    const missing = statuses.find((status) => status.state === "unavailable");
    if (missing) return decide("blocked", missing.kind === "project" ? "This project's folder is missing on this machine" : `This machine has no folder for this project's ${missing.kind} yet`);
    const differing: Array<{ peer: string; count: number }> = [];
    for (const peer of peers) {
      const entries = statuses.map((status) => status.peers.find((entry) => entry.peer === peer));
      const name = this.peerName(peer);
      // Listed under other ignore rules: its comparison never starts, however long it waits.
      if (entries.some((entry) => entry?.peerIndexId && !entry.rulesMatch)) return decide("blocked", `${name} skips other files in this project (its ignore rules differ)`);
      const count = entries.reduce((sum, entry) => sum + (entry?.differences ?? 0), 0);
      if (count) { differing.push({ peer, count }); continue; }
      // fix: not compared with it yet: it is asked to compare the project (autoStep), and says what it does.
      if (entries.some((entry) => !entry?.cleanSince)) return decide("blocked", this.compareWait(projectId, peer), { compare: peer });
    }
    if (differing.length) return decide("blocked", this.explained.get(projectId)?.reason ?? this.differText(differing), { differing });
    const worker = projectCleanSince(statuses);
    if (!worker) return decide("blocked", "Waiting for the files to match on every machine");
    // fix: carried over differences that were only files on their way, while the worker's streak is the one it was carried to.
    const rules = hash(statuses.map((status) => `${status.kind}:${status.rulesHash}`).sort().join("\n"));
    const held = hold.matching;
    const since = held && held.rules === rules && (held.worker === null || held.worker === worker) && held.since < worker ? held.since : worker;
    const matching = { since, worker, rules };
    const cleanSince = laterOf(since, hold.cleanAfter)!;
    const at = Date.parse(cleanSince) + config.cleanHours * 3_600_000;
    if (this.clock.now() < at) return decide("matching", matchingReason(cleanSince, config.cleanHours, this.clock.now()), { cleanSince, at, matching });
    return decide("due", "Checking every machine before the move", { cleanSince, matching });
  }

  /** The admin's choice of projects to compare here includes it (every project unless a list was chosen; projects their owner asked for). */
  private compared(projectId: string): boolean {
    try { const chosen = comparedProjects(readFileSyncConfig(this.db)); return chosen === "all" || chosen.includes(projectId); } catch { return true; }
  }

  /** This machine's name in its peers' texts. */
  private ownerName(): string { return this.deps.localName?.() || "its owner"; }

  /** "3 files differ with homeserver", for the first machine that differs. */
  private differText(differing: ReadonlyArray<{ peer: string; count: number }>): string {
    const [first] = differing;
    return `${first.count} ${first.count === 1 ? "file differs" : "files differ"} with ${this.peerName(first.peer)}`;
  }

  /** What a peer said about its engine that rules the move out, as what the move waits for. A peer not heard from yet is asked by the full checks. */
  private capabilityWait(peer: string): string | undefined {
    const known = this.deps.capability(peer);
    if (!known) return undefined;
    if ((known.minProtocol ?? FILE_SYNC_MIN_PROTOCOL) > FILE_SYNC_PROTOCOL) return "Waiting for this machine to update Joint Bob";
    if (known.protocol < FILE_SYNC_SWITCH_PROTOCOL) return `Waiting for ${this.peerName(peer)} to update Joint Bob`;
    // fix: a release without automatic moves has file sync off by default; updating turns it on.
    if (known.enabled === false) return `Waiting for ${this.peerName(peer)} to ${predatesAutoSwitch(known) ? "update Joint Bob" : "turn on file sync"}`;
    return undefined;
  }

  /** fix: a peer that does not compare the project yet, as its answer to this node's request says. */
  private compareWait(projectId: string, peer: string): string {
    const name = this.peerName(peer);
    switch (this.compareAnswers.get(`${peer}\n${projectId}`)) {
      case "off": return `Waiting for ${name} to turn on file sync`;
      case "declined": return `${name} does not compare this project (unticked there), so it stays on Syncthing`;
      case "update": return `Waiting for ${name} to update Joint Bob`;
      default: return `Waiting for ${name} to compare this project's files`;
    }
  }

  /**
   * fix: asks a peer that does not compare the project to compare it (this node means to move it), so
   * nobody ticks it on every machine; once per start, again at its next contact if it could not be
   * reached, and again once it turned file sync on.
   */
  private askCompare(projectId: string, peer: string): void {
    const key = `${peer}\n${projectId}`;
    if (this.compareAnswers.get(key) === "off" && this.deps.capability(peer)?.enabled === true) { this.compareAnswers.delete(key); this.compareAsked.delete(key); }
    if (this.stopped || this.compareAsked.has(key)) return;
    this.compareAsked.add(key);
    void (async () => {
      try {
        const response = await this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/switch`, json: { projectId, compare: true } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          // A release without the switch has no route for it (404); one that does not share the project needs nothing (403).
          if (response.status === 404) this.compareAnswers.set(key, "update");
          else if (response.status !== 403) this.compareMissed.add(key);
          return;
        }
        const answer = switchAnswerSchema.safeParse(await response.json().catch(() => undefined));
        this.compareAnswers.set(key, answer.success && answer.data.projectId === projectId && answer.data.compares ? answer.data.compares : "update");
      } catch { this.compareMissed.add(key); }
      finally { this.autoEvaluate(projectId); }
    })();
  }

  /** One timer per project: re-armed for a new deadline, never repeating. */
  private armAuto(projectId: string, at: number): void {
    const held = this.autoTimers.get(projectId);
    if (held?.at === at) return;
    held?.timer.cancel();
    const timer = this.clock.setTimeout(() => {
      if (this.autoTimers.get(projectId)?.timer === timer) this.autoTimers.delete(projectId);
      this.autoEvaluate(projectId);
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - this.clock.now())));
    this.autoTimers.set(projectId, { at, timer });
  }

  private clearAutoTimer(projectId: string): void {
    this.autoTimers.get(projectId)?.timer.cancel();
    this.autoTimers.delete(projectId);
  }

  /** "this machine" in a reason means the owner; its peers read the owner's name instead. */
  private forPeers(text: string): string {
    const name = this.deps.localName?.();
    return name ? text.replace(/\bthis machine\b/g, name).replace(/\bThis machine\b/g, name) : text;
  }

  /** fix: a reason naming an action only the owner can take has its own wording for the peers. */
  private wireOf(decision: AutoDecision): AutoWire {
    return { state: decision.state, reason: decision.state === "matching" ? "" : decision.peerReason ?? this.forPeers(decision.reason), cleanSince: decision.cleanSince, cleanHours: decision.cleanHours };
  }

  /**
   * Remembers what the move waits for; peers that asked hear when that changes (not while it is only
   * being checked). fix: a hold by hand, and its end, reach every peer, which keeps it: a twin that
   * takes the project over then holds it too.
   */
  private setAutoState(projectId: string, decision: AutoDecision): void {
    this.autoStates.set(projectId, decision);
    if (decision.state === "due") return;
    const wire = this.wireOf(decision);
    const signature = JSON.stringify(wire);
    const previous = this.autoSent.get(projectId);
    if (previous === signature) return;
    this.autoSent.set(projectId, signature);
    const wasHeld = previous !== undefined && (JSON.parse(previous) as AutoWire).state === "held";
    const everyone = wire.state === "held" ? !wasHeld : wasHeld;
    const subscribed = this.subscribers.get(projectId) ?? new Set<string>();
    for (const peer of projectPeers(this.db, this.local, projectId)) if (everyone || subscribed.has(peer)) this.pushState(projectId, peer);
  }

  /** One push per peer and project in flight; the latest state goes. A peer that cannot take it now hears it at its next contact. */
  private pushState(projectId: string, peer: string): void {
    const key = `${peer}\n${projectId}`;
    const decision = this.autoStates.get(projectId);
    if (this.stopped || !decision) return;
    if (this.pushing.has(key)) { this.pushAgain.add(key); return; }
    const missed = (): void => {
      const projects = this.missedStates.get(peer) ?? new Set<string>();
      projects.add(projectId);
      this.missedStates.set(peer, projects);
    };
    this.pushing.add(key);
    void (async () => {
      try {
        const response = await this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/switch`, json: { projectId, auto: this.wireOf(decision) } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
        await response.body?.cancel().catch(() => undefined);
        // An older peer (404) has nothing to show it with; one that no longer shares the project (403) needs nothing.
        if (response.ok || response.status === 404 || response.status === 403) this.missedStates.get(peer)?.delete(projectId);
        else missed();
      } catch { missed(); }
      finally {
        this.pushing.delete(key);
        if (this.pushAgain.delete(key)) this.pushState(projectId, peer);
      }
    })();
  }

  /** A non-owner's Settings asks the owner what its automatic move of the project waits for, at most every few minutes; the owner then tells it of changes. */
  private askOwnerState(projectId: string, owner: string): void {
    const known = ownerKnowledge(this.db);
    const at = known.asked.get(projectId);
    if (this.stopped || (at !== undefined && this.clock.now() - at < OWNER_ASK_MS)) return;
    known.asked.set(projectId, this.clock.now());
    void this.askSwitch(owner, { projectId }).catch(() => undefined);
  }

  /** What Settings shows of the automatic move: the owner decides; a non-owner shows what the owner said, or what it knows itself. */
  private autoView(projectId: string, engine: EngineMode, phase: Phase): AutoSwitchView | null {
    if (engine !== "syncthing" || phase !== "syncthing") return null;
    const owner = this.ownerOf(projectId);
    if (owner === this.local) {
      const local = this.autoLocal(projectId);
      if (!local) return null;
      // Due, and a full check failed a moment ago: that check's reason until something changes.
      const checked = local.state === "due" ? this.autoChecked.get(projectId) : undefined;
      const shown = checked ? { ...local, state: "blocked" as const, reason: checked.reason } : local;
      return { state: shown.state, reason: shown.reason, cleanSince: shown.cleanSince, cleanHours: shown.cleanHours, decidedBy: null };
    }
    const name = this.peerName(owner);
    if (projectPeers(this.db, this.local, projectId).includes(owner)) this.askOwnerState(projectId, owner);
    const told = ownerKnowledge(this.db).states.get(projectId);
    if (told && told.owner === owner) {
      const reason = told.state === "matching" && told.cleanSince ? matchingReason(told.cleanSince, told.cleanHours, this.clock.now()) : told.reason;
      return { state: told.state, reason, cleanSince: told.cleanSince, cleanHours: told.cleanHours, decidedBy: name };
    }
    // The owner has not said (it may run a Joint Bob without automatic moves): what this machine knows itself.
    const cleanHours = this.autoConfig().cleanHours;
    const here = !this.deps.engine.enabled() ? "Waiting for file sync to be turned on on this machine" : !this.deps.engine.running() ? "Waiting for file sync to start on this machine" : undefined;
    const peer = here ?? [owner, ...projectPeers(this.db, this.local, projectId).filter((id) => id !== owner)].map((id) => this.capabilityWait(id)).find(Boolean);
    // fix: an owner whose hello said nothing of automatic moves runs a release without them.
    const manual = predatesAutoSwitch(this.deps.capability(owner));
    return { state: "blocked", reason: peer ?? (manual ? `${name} runs an older Joint Bob that does not move projects by itself` : `${name} moves this project when every machine is ready`), cleanSince: null, cleanHours, decidedBy: name };
  }

  /**
   * A non-owner keeps what the owner says about its automatic move (pushed, or in an answer). fix: and
   * the owner's hold, in node.db: should this node take the project over (a twin), it holds it too.
   */
  private noteOwnerState(projectId: string, owner: string, auto: AutoWire | undefined): void {
    if (!auto || owner === this.local || this.ownerOf(projectId) !== owner) return;
    ownerKnowledge(this.db).states.set(projectId, { ...auto, owner });
    try {
      const held = projectHold(this.db, projectId).stayOnSyncthing;
      if (auto.state === "held" && !held) updateProjectHold(this.db, projectId, { stayOnSyncthing: { by: this.peerName(owner), at: new Date(this.clock.now()).toISOString(), from: owner } });
      else if (auto.state !== "held" && held?.from === owner) updateProjectHold(this.db, projectId, { stayOnSyncthing: null });
    } catch (error) { this.log(`fileSync:hold:${projectId}`, `File sync could not keep ${this.name(projectId)}'s hold from its owner: ${messageOf(error)}`); }
  }

  /**
   * fix: the owner asks this node to compare the project. A chosen list takes it in unless an admin
   * here unticked it; this node's own Syncthing ignore lines join its rules before its first scan.
   */
  private async compareFor(projectId: string): Promise<"yes" | "off" | "declined"> {
    if (requestCompare(this.db, projectId, process.env, { write: false }) === "added") await this.deps.beforeCompare?.(projectId).catch(() => undefined);
    // Settings shows it ticked, with why; nothing moves, so no log line.
    if (requestCompare(this.db, projectId) === "declined") return "declined";
    return this.deps.engine.enabled() ? "yes" : "off";
  }

  /** `actorId` set (null: unknown) for a person's move; left out for the node's own. */
  private auditMove(projectId: string, target: EngineMode, details: { automatic: boolean; actorId?: string | null; reason?: string }): void {
    try {
      this.deps.audit?.({
        eventType: "fileSync.engine.moved", actorType: details.actorId !== undefined ? "user" : "system", actorId: details.actorId ?? null, entityType: "project", entityId: projectId,
        details: { engine: target, automatic: details.automatic, ...(details.reason ? { reason: details.reason.slice(0, 500) } : {}) },
      });
    } catch (error) { this.log(`fileSync:audit`, `File sync could not record the move of ${this.name(projectId)}: ${messageOf(error)}`); }
  }

  private async askPeer(peer: string, projectId: string, statuses: readonly ShareStatus[], withStatus: boolean): Promise<PeerAnswer> {
    const timeout = () => AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS);
    try {
      const response = await this.deps.peerRequest(peer, { method: "GET", target: `${FILES_API}/shares` }, timeout());
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { peer, error: peerFailure(response.status) }; }
      const shares = sharesAnswerSchema.parse(await response.json());
      if (shares.nodeId !== peer) return { peer, error: "another machine answered" };
      if (!withStatus) return { peer, shares };
      const known = statuses.filter((status) => status.indexId).map((status) => ({ kind: status.kind, indexId: status.indexId, maxSeq: status.maxSeq }));
      const [asked, release] = await Promise.all([
        this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/status`, json: { projectId, ...(known.length ? { shares: known } : {}) } }, timeout()),
        this.askSwitch(peer, { projectId, blockers: true }),
      ]);
      if (!asked.ok) { await asked.body?.cancel().catch(() => undefined); return { peer, shares, ...release, error: peerFailure(asked.status) }; }
      return { peer, shares, status: statusAnswerSchema.parse(await asked.json()), ...release };
    } catch (error) {
      return { peer, error: messageOf(error) };
    }
  }

  /** fix (P4+P5): a peer's own phase of the project (and, asked for, what would hold its release); what it says is kept for the listing. */
  private async askSwitch(peer: string, body: SwitchBody): Promise<{ release?: SwitchAnswer; releaseError?: string }> {
    try {
      const response = await this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/switch`, json: body }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return { releaseError: response.status === 404 ? "it needs a newer Joint Bob" : peerFailure(response.status) }; }
      const release = switchAnswerSchema.parse(await response.json());
      if (release.projectId !== body.projectId) return { releaseError: "it answered about another project" };
      this.notePeerPhase(body.projectId, peer, { phase: release.phase, error: release.error, leaving: release.leaving });
      this.noteOwnerState(body.projectId, peer, release.auto);
      return { release };
    } catch (error) {
      return { releaseError: messageOf(error) };
    }
  }

  private notePeerPhase(projectId: string, peer: string, report: PeerReport): void {
    const byPeer = this.peerReports.get(projectId) ?? new Map<string, PeerReport>();
    byPeer.set(peer, { phase: report.phase, error: report.error, ...(report.leaving ? { leaving: true } : {}) });
    this.peerReports.set(projectId, byPeer);
  }

  /** Once per start, the owner: where each peer's move of a switched project stands. */
  private async askPhases(projectId: string): Promise<void> {
    await Promise.allSettled(projectPeers(this.db, this.local, projectId).map((peer) => this.askSwitch(peer, { projectId })));
  }

  /** fix: file sync is being turned off here: the owner hears it with each report and answer, and moves the project back. */
  private leaving(): { leaving?: true } { return this.deps.engine.enabled() ? {} : { leaving: true }; }

  /** A peer: the owner hears of each change of this node's phase or its error, so a move stuck here shows there. Retried at the next step. */
  private reportToOwner(projectId: string): void {
    const owner = this.ownerOf(projectId);
    if (owner === this.local || this.delivering.has(projectId) || !projectPeers(this.db, this.local, projectId).includes(owner)) return;
    const held = phaseOf(this.db, projectId);
    const report = { phase: held?.phase ?? "syncthing", error: held?.error ?? null, ...this.leaving() };
    const text = JSON.stringify([owner, report]);
    if (this.delivered.get(projectId) === text) return;
    this.delivering.add(projectId);
    void (async () => {
      try {
        const response = await this.deps.peerRequest(owner, { method: "POST", target: `${FILES_API}/switch`, json: { projectId, report } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
        if (response.ok) {
          const answer = switchAnswerSchema.safeParse(await response.json().catch(() => undefined));
          if (answer.success && answer.data.projectId === projectId) this.noteOwnerState(projectId, owner, answer.data.auto);
          this.delivered.set(projectId, text);
          this.deps.settle?.(`fileSync:switch:report:${projectId}`);
        } else await response.body?.cancel().catch(() => undefined);
      } catch { /* the owner is away: the next step tries again, and the owner asks at its start */ }
      finally { this.delivering.delete(projectId); }
    })();
  }

  /**
   * POST /files/switch from `peer`: a peer that shares the project tells this node, its owner, where
   * its move stands; the owner asks this node the same, and what would hold its release.
   */
  async answerSwitch(peer: string, body: SwitchBody): Promise<SwitchAnswer | undefined> {
    if (!projectPeers(this.db, this.local, body.projectId).includes(peer)) return undefined;
    // auto-transition: it is in touch: whatever it missed from this node goes now.
    this.peerContact(peer);
    const owner = this.ownerOf(body.projectId);
    if (body.report && owner === this.local) {
      this.notePeerPhase(body.projectId, peer, body.report);
      // fix: the peer is turning file sync off: the move back goes now rather than at the next change.
      if (body.report.leaving && engineModeOf(this.db, body.projectId) === "builtin") this.run(body.projectId);
    }
    if (peer === owner) this.noteOwnerState(body.projectId, owner, body.auto);
    const held = phaseOf(this.db, body.projectId);
    const answer: SwitchAnswer = { projectId: body.projectId, phase: held?.phase ?? "syncthing", error: held?.error ?? null, ...this.leaving() };
    if (body.compare && peer === owner) answer.compares = await this.compareFor(body.projectId);
    if (owner === this.local) {
      // The asking peer shows what this node's automatic move waits for, and hears of each change from now on.
      const subscribed = this.subscribers.get(body.projectId) ?? new Set<string>();
      subscribed.add(peer);
      this.subscribers.set(body.projectId, subscribed);
      const local = this.autoLocal(body.projectId);
      const decision = local?.state === "due" ? this.autoStates.get(body.projectId) : local;
      if (decision && decision.state !== "due") answer.auto = this.wireOf(decision);
    }
    if (!body.blockers || peer !== owner) return answer;
    const release = await this.releaseBlockers(body.projectId);
    // Worded for the owner's screen, which puts "On <this machine>:" before it.
    const syncthing = release.syncthing === undefined ? []
      : release.syncthing === SYNCTHING_UNREACHABLE ? ["Joint Bob cannot reach the Syncthing there (it has no local address and API key for it); set JOINT_BOB_SYNCTHING_URL and JOINT_BOB_SYNCTHING_API_KEY there so Syncthing can let go of the project's folders"]
      : [`Syncthing did not answer there (${release.syncthing}), and it has to let go of the project's folders`];
    return { ...answer, blockers: [...release.blockers, ...syncthing] };
  }

  private capableCheck(answers: readonly PeerAnswer[]): Check {
    const problems = answers.flatMap((answer): Array<{ message: string; waiting: string }> => {
      const name = this.peerName(answer.peer);
      if (!answer.shares) return [{ message: `${name} did not answer (${answer.error})`, waiting: `Waiting for ${name} to answer` }];
      const engine = answer.shares.fileSync;
      if (engine.minProtocol > FILE_SYNC_PROTOCOL) return [{ message: `${name} needs a newer Joint Bob`, waiting: "Waiting for this machine to update Joint Bob" }];
      // An engine without the switch (2.157, 2.158) compares in shadow but never leaves Syncthing: it would stop receiving.
      if (engine.protocol < FILE_SYNC_SWITCH_PROTOCOL) return [{ message: `${name} needs a newer Joint Bob`, waiting: `Waiting for ${name} to update Joint Bob` }];
      // A release without automatic moves (2.159) has it off until someone turns it on; updating does that.
      if (!engine.enabled) return [predatesAutoSwitch(this.deps.capability(answer.peer))
        ? { message: `${name} has file sync turned off; its Joint Bob is older, and updating turns it on`, waiting: `Waiting for ${name} to update Joint Bob` }
        : { message: `${name} has file sync turned off`, waiting: `Waiting for ${name} to turn on file sync` }];
      return [];
    });
    return problems.length
      ? { key: "peers", ok: false, message: problems.map((problem) => problem.message).join("; "), waiting: problems[0].waiting }
      : { key: "peers", ok: true, message: "Every machine runs built-in file sync" };
  }

  private rulesCheck(answers: ReadonlyArray<{ peer: string; shares?: SharesAnswer }>, statuses: readonly ShareStatus[]): Check {
    const problems: string[] = [];
    for (const answer of answers) {
      if (!answer.shares) continue;
      for (const status of statuses) {
        const theirs = answer.shares.shares.find((share) => share.projectId === status.projectId && share.kind === status.kind);
        if (!theirs) problems.push(`${this.peerName(answer.peer)} is not checking this project's ${kindLabel(status.kind)} yet`);
        else if (theirs.rulesHash !== status.rulesHash) problems.push(`${this.peerName(answer.peer)} skips different files in this project's ${kindLabel(status.kind)} (its ignore rules differ)`);
      }
    }
    return problems.length ? { key: "rules", ok: false, message: problems.join("; ") } : { key: "rules", ok: true, message: "Every machine skips the same files" };
  }

  private differencesCheck(peers: readonly string[], statuses: readonly ShareStatus[]): Check {
    if (statuses.length < SHARE_KINDS.length || statuses.some((status) => status.state === "starting")) {
      return { key: "differences", ok: false, message: "File sync is not checking all of this project's folders on this machine yet" };
    }
    const problems: string[] = [];
    for (const peer of peers) {
      const compared = statuses.map((status) => status.peers.find((entry) => entry.peer === peer));
      if (compared.some((entry) => !entry)) { problems.push(`This machine has not compared files with ${this.peerName(peer)} yet`); continue; }
      const count = compared.reduce((sum, entry) => sum + entry!.differences, 0);
      if (count) problems.push(`${count} ${count === 1 ? "file differs" : "files differ"} with ${this.peerName(peer)}`);
    }
    return problems.length ? { key: "differences", ok: false, message: problems.join("; ") } : { key: "differences", ok: true, message: "Every machine has the same files" };
  }

  private caughtUpCheck(answers: ReadonlyArray<{ peer: string; status?: StatusAnswer; error?: string }>, statuses: readonly ShareStatus[]): Check {
    const problems: string[] = [];
    for (const answer of answers) {
      const name = this.peerName(answer.peer);
      if (!answer.status) { problems.push(`${name} did not report what it has seen${answer.error ? ` (${answer.error})` : ""}`); continue; }
      for (const status of statuses) {
        const theirs = answer.status.shares.find((share) => share.kind === status.kind);
        const ours = status.peers.find((peer) => peer.peer === answer.peer);
        if (!theirs || theirs.callerIndexId !== status.indexId || theirs.cursor < status.maxSeq) problems.push(`${name} has not seen this machine's latest changes yet`);
        else if (!ours?.caughtUp || ours.cursor < theirs.maxSeq) problems.push(`This machine has not seen ${name}'s latest changes yet`);
        else if (theirs.state === "error" || theirs.blocked || theirs.errors) problems.push(`${name} reports problems with this project's files`);
        else continue;
        break;
      }
    }
    return problems.length ? { key: "caughtUp", ok: false, message: [...new Set(problems)].join("; ") } : { key: "caughtUp", ok: true, message: "Every machine has seen the latest changes" };
  }

  /**
   * Nothing may hold any machine's release (nested projects, folders Syncthing may write in that are
   * not the project's own: each peer says what only it has), and this node's Syncthing for the project
   * is idle with nothing left to copy and caught up with every peer.
   */
  private async syncthingChecks(projectId: string, peers: readonly string[], answers: readonly PeerAnswer[]): Promise<Check[]> {
    const roots = this.roots(projectId);
    if (!roots) return [{ key: "syncthing", ok: false, message: "This project's folder is not known on this machine" }];
    const local = await this.releaseBlockers(projectId);
    // A peer that cannot say has not proved it can let go: on a peer, the move would wait until it can.
    const remote = answers.flatMap((answer) => {
      const name = this.peerName(answer.peer);
      if (!answer.release) return answer.shares ? [`${name} did not say what its Syncthing holds (${answer.releaseError ?? answer.error ?? "no answer"})`] : [];
      return (answer.release.blockers ?? []).map((blocker) => `On ${name}: ${blocker}`);
    });
    const blockers = [...local.blockers, ...remote];
    const checks: Check[] = [blockers.length
      ? { key: "folders", ok: false, message: blockers.join("; ") }
      : { key: "folders", ok: true, message: "Only Joint Bob's own Syncthing folders cover this project on every machine" }];
    if (local.syncthing !== undefined) {
      if (local.syncthing === SYNCTHING_UNREACHABLE) return [...checks, { key: "syncthing", ok: false, message: SYNCTHING_UNREACHABLE, waiting: "Waiting for an address and API key for this machine's Syncthing" }];
      return [...checks, { key: "syncthing", ok: false, message: `Syncthing did not answer on this machine (${local.syncthing}); it has to let go of the project's folders`, waiting: "Waiting for Syncthing to answer on this machine" }];
    }
    const remove = local.remove;
    if (!remove.length) return [...checks, { key: "syncthing", ok: true, message: "Syncthing does not sync this project on this machine" }];
    const ids = remove.map((folder) => folder.id);
    const states = await this.deps.syncthing.folderStatuses(ids).catch(() => ({} as Record<string, ProjectSyncStatus>));
    // fix: a folder in error never finishes copying by itself; someone has to look at it in Syncthing.
    const failing = remove.filter((folder) => states[folder.id]?.state === "error");
    if (failing.length) return [...checks, { key: "syncthing", ok: false, message: `Syncthing reports a problem with ${failing.map((folder) => `${folderLabel(folder)} (${states[folder.id]?.message ?? "error"})`).join(", ")}`, waiting: `Waiting for Syncthing's problem with ${folderLabel(failing[0])} to be fixed on this machine` }];
    const busy = remove.filter((folder) => !["synced", "paused"].includes(states[folder.id]?.state ?? ""));
    if (busy.length) return [...checks, { key: "syncthing", ok: false, message: `Syncthing is still copying files in ${busy.map(folderLabel).join(", ")}`, waiting: "Waiting for Syncthing to finish copying" }];
    const enrolled = tableExists(this.db, "cluster_v2_file_enrollments")
      ? this.db.prepare("SELECT peer_id, device_id, folder_id FROM cluster_v2_file_enrollments WHERE project_id = ?").all(projectId) as Array<{ peer_id: string; device_id: string; folder_id: string }>
      : [];
    const problems: string[] = [];
    for (const peer of peers) {
      const rows = enrolled.filter((row) => row.peer_id === peer && ids.includes(row.folder_id));
      if (!rows.length) continue;
      const caughtUp = await this.deps.syncthing.peerCaughtUp(rows[0].device_id, rows.map((row) => row.folder_id)).catch(() => false);
      if (!caughtUp) problems.push(this.peerName(peer));
    }
    return [...checks, problems.length
      ? { key: "syncthing", ok: false, message: problems.map((name) => `Syncthing has not finished copying this project to ${name}`).join("; "), waiting: `Waiting for Syncthing to finish copying to ${problems[0]}` }
      : { key: "syncthing", ok: true, message: "Syncthing has nothing left to copy" }];
  }

  // ---- what Settings shows ----

  project(projectId: string, candidates?: readonly string[]): FileSyncProject {
    const row = this.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
    const held = phaseOf(this.db, projectId);
    const statuses = this.deps.engine.statuses(projectId);
    const engine = engineModeOf(this.db, projectId);
    const phase = held?.phase ?? "syncthing";
    const owner = this.ownerOf(projectId) === this.local;
    const peers = projectPeers(this.db, this.local, projectId, candidates);
    const reports = owner ? this.peerReports.get(projectId) : undefined;
    return {
      projectId, name: row?.name ?? projectId, owner, engine,
      phase, phaseMessage: this.messages.get(projectId) ?? null, phaseError: held?.error ?? null,
      cleanSince: projectCleanSince(statuses), differences: projectDifferences(statuses),
      shares: this.deps.engine.specs(projectId).map((spec) => spec.kind).sort((a, b) => SHARE_KINDS.indexOf(a) - SHARE_KINDS.indexOf(b)),
      // A switched project not shared with anyone (or not known here) waits for that, not for the engine.
      waiting: Boolean(held?.error) || (engine === "builtin" && phase === "syncthing" && (!this.roots(projectId) || !peers.length)),
      peers: reports ? peers.flatMap((peer) => {
        const report = reports.get(peer);
        return report ? [{ peer, name: this.peerName(peer), phase: report.phase, error: report.error }] : [];
      }) : [],
      autoSwitch: peers.length ? this.autoView(projectId, engine, phase) : null,
    };
  }

  /** Every project shared with at least one peer, and any the switch touched. */
  projects(): FileSyncProject[] {
    const rows = this.db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
    let candidates: string[];
    try { candidates = replicationPeers(this.db, this.local).map((peer) => peer.nodeId); } catch { candidates = []; }
    const tracked = new Set(this.tracked());
    return rows.filter((row) => tracked.has(row.id) || projectPeers(this.db, this.local, row.id, candidates).length > 0)
      .map((row) => this.project(row.id, candidates)).sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
  }

  // ---- helpers ----

  roots(projectId: string): Record<ShareKind, string> | undefined {
    return (this.deps.roots ?? ((id: string) => defaultRoots(this.db, id)))(projectId);
  }

  /** Writes only what changed: every write bumps the revision, which derives and kicks the machine again. */
  private updatePhase(projectId: string, phase: Phase, options: { error?: string | null; builtinSince?: Record<string, number> } = {}): void {
    const held = phaseOf(this.db, projectId);
    const error = options.error === undefined ? (held?.phase === phase ? held.error : null) : options.error;
    const since = options.builtinSince ?? held?.builtinSince ?? {};
    if (held && held.phase === phase && held.error === error && JSON.stringify(held.builtinSince) === JSON.stringify(since)) return;
    setPhase(this.db, projectId, phase, { builtinSince: since, error });
  }

  /** Back to the start of the take-over: Syncthing may have written meanwhile, so every folder is scanned and decided again. */
  private toReleasing(projectId: string, error?: string): void {
    this.setPassed(projectId, null);
    this.updatePhase(projectId, "releasing", { builtinSince: {}, ...(error ? { error } : {}) });
    for (const kind of SHARE_KINDS) this.scanned.delete(`${kind}:${projectId}`);
  }

  private clearError(projectId: string, phase: Phase): void {
    if (phaseOf(this.db, projectId)?.error) this.updatePhase(projectId, phase, { error: null });
  }

  private waiting(projectId: string): boolean {
    const wait = this.waits.get(projectId);
    return Boolean(wait && wait.until > this.clock.now());
  }

  private wait(projectId: string): void {
    if (this.stopped) return;
    const held = this.waits.get(projectId);
    held?.timer?.cancel();
    const attempts = (held?.attempts ?? 0) + 1;
    const delay = Math.min(this.retry.maxMs, this.retry.minMs * 2 ** (attempts - 1));
    const timer = this.clock.setTimeout(() => {
      const wait = this.waits.get(projectId);
      if (wait) { wait.until = 0; wait.timer = undefined; }
      this.run(projectId);
    }, delay);
    this.waits.set(projectId, { attempts, until: this.clock.now() + delay, timer });
  }

  private clearWait(projectId: string): void {
    this.waits.get(projectId)?.timer?.cancel();
    this.waits.delete(projectId);
  }

  private name(projectId: string): string {
    try { return (this.db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId; } catch { return projectId; }
  }

  private peerName(nodeId: string): string {
    try {
      const row = this.db.prepare("SELECT name FROM cluster_v2_peer_endpoints WHERE node_id = ? ORDER BY context_kind, context_id LIMIT 1").get(nodeId) as { name: string } | undefined;
      if (row?.name) return row.name;
    } catch { /* no endpoints table yet */ }
    return nodeId.slice(0, 8);
  }

  private log(key: string, message: string): void { (this.deps.log ?? ((_key: string, text: string) => console.warn(text)))(key, message); }
}

function kindLabel(kind: ShareKind): string { return kind === "project" ? "files" : kind === "tickets" ? "ticket folders" : "worktrees"; }

function changedFiles(count: number): string { return `${count} changed ${count === 1 ? "file" : "files"}`; }

/** A running task or merge would write while the engines change hands. */
async function defaultActivity(projectId: string): Promise<string | undefined> {
  const [{ listTasks }, { harnessTaskRuns, projectHasMergeReservation }, { asNode }] = await Promise.all([import("../tasks.js"), import("../server/task-runs.js"), import("../account-context.js")]);
  const tasks = await asNode(() => listTasks(projectId));
  if (tasks.some((task) => task.executionState === "running") || [...harnessTaskRuns.values()].some((run) => run.projectId === projectId)) return "A task is running in this project; wait for it to finish";
  if (tasks.some((task) => task.mergeTx === "open") || projectHasMergeReservation(projectId)) return "A merge is in progress in this project; wait for it to finish";
  return undefined;
}

/** Production Syncthing access: no connection to a daemon reads as SyncthingNotConfigured, saying whether a Syncthing configuration is there all the same. */
export async function syncthingForMigration(): Promise<MigrationSyncthing> {
  const syncthing = await import("../syncthing.js");
  return {
    folders: async () => {
      try { return await syncthing.requireSyncthingFolders(); } catch (error) {
        if (messageOf(error) === "Syncthing is not configured on this node") throw new SyncthingNotConfigured(await syncthing.syncthingConfigPresent().catch(() => true));
        throw error;
      }
    },
    removeFolder: (folderId) => syncthing.removeSyncthingFolderConfig(folderId),
    pauseFolder: (folderId) => syncthing.pauseSyncthingFolders([folderId]),
    folderStatuses: (folderIds) => syncthing.syncthingFolderStatuses(folderIds),
    peerCaughtUp: (deviceId, folderIds) => syncthing.syncthingPeerCaughtUp(deviceId, folderIds),
    generation: () => syncthing.syncthingConnectionGeneration(),
  };
}

/**
 * fix (P4+P5): why a project that built-in sync moves here (or is moving) may not have its folder
 * moved to `target`: a Syncthing folder there would write in the same files (§0.12). Undefined on
 * Syncthing, and when Syncthing does not answer: the switch checks the new roots itself once they
 * changed (verifyBuiltin), and sends the project back to releasing if a folder covers them.
 */
export async function syncthingFolderOverTarget(db: DatabaseSync, projectId: string, target: string, syncthing?: Pick<MigrationSyncthing, "folders">): Promise<string | undefined> {
  if (projectFilesOnSyncthing(db, projectId)) return undefined;
  let folders: SyncthingFolder[];
  try { folders = await (syncthing ?? await syncthingForMigration()).folders(); } catch { return undefined; }
  const [folder] = (await syncthingFoldersCovering(folders, [target])).filter((candidate) => !(candidate.paused === true && jointBobFolderId(candidate.id)));
  return folder ? `Syncthing syncs “${folderLabel(folder)}” (${folder.path}) there, and built-in sync moves this project's files: both would write them. Pick another place, or remove that folder in Syncthing first` : undefined;
}
