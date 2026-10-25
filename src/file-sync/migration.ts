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
import { projectTicketSyncFolderId, ticketWorkspaceRoot } from "../task-workspaces.js";
import type { ProjectSyncStatus } from "../types.js";
import { projectWorktreeSyncFolderId } from "../worktree-filters.js";
import { engineModeOf, engineRecordOf, listEngineRecords, listPhases, phaseOf, projectFilesOnSyncthing, projectOwnerNode, saveEngineRecord, setPhase, withProjectFilesLock } from "./control.js";
import { compileRules, effectiveRules } from "./ignore.js";
import type { PeerFileSync } from "./peers.js";
import { FILE_SYNC_MIN_PROTOCOL, FILE_SYNC_PROTOCOL, FILE_SYNC_SWITCH_PROTOCOL, type OpArgs, type OpName, type OpResults, type ShareSpec, type ShareStatus } from "./protocol.js";
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
   capability), share reports and one-shot retries after a failure. */

export interface Check { key: string; ok: boolean; message: string }
export interface ChecksAnswer { engine: EngineMode; checks: Check[]; cleanSince: string | null }

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
}

export interface PeerPhase { peer: string; name: string; phase: Phase; error: string | null }

/* fix (P4+P5): POST /api/cluster/v2/files/switch, answered by main (routes.ts). The owner asks each
   peer, before a move, what would hold its own release (folders only it has); a peer tells the owner
   where its own move stands whenever that changes, so a peer that cannot finish shows on the owner. */
const phaseSchema = z.enum(["syncthing", "releasing", "bootstrapping", "builtin", "restoring"]);
const reason = z.string().max(4000);
export const switchBodySchema = z.object({
  projectId: projectIdSchema,
  /** The owner asks for what would hold this node's release of the project. */
  blockers: z.boolean().optional(),
  /** The sender's own phase of the project (a peer telling the owner). */
  report: z.object({ phase: phaseSchema, error: reason.nullable() }).optional(),
});
export const switchAnswerSchema = z.object({ projectId: projectIdSchema, phase: phaseSchema, error: reason.nullable(), blockers: z.array(reason).max(200).optional() });
export type SwitchBody = z.infer<typeof switchBodySchema>;
export type SwitchAnswer = z.infer<typeof switchAnswerSchema>;

/** The switch was refused; `checks` says why (every check, failing ones with ok false). */
export class EngineSwitchRefused extends Error {
  constructor(readonly checks: Check[]) { super(checks.filter((check) => !check.ok).map((check) => check.message).join("; ") || "The switch was refused"); }
}

/** This node's Syncthing as the switch needs it. Tests pass a fake; production wraps src/syncthing.ts. */
export interface MigrationSyncthing {
  /** A fresh folder list from a daemon that answered; throws when Syncthing does not answer or is not configured here. */
  folders(): Promise<SyncthingFolder[]>;
  /** Takes a folder out of Syncthing's configuration; Syncthing leaves its files on disk. */
  removeFolder(folderId: string): Promise<void>;
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
}

const PEER_TIMEOUT_MS = 10_000;
const SCAN_TIMEOUT_MS = 2 * 60 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 60 * 60_000;
const RETRY = { minMs: 5_000, maxMs: 5 * 60_000 };
/** Steps one pass may take in a row (syncthing → releasing → bootstrapping → builtin is three). */
const STEPS_PER_PASS = 12;
/** Only these names, the temps Syncthing leaves when it stops mid-download. */
const SYNCTHING_TEMP = /^(?:\.syncthing\..*\.tmp|~syncthing~.*\.tmp)$/s;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** The folder IDs Joint Bob gives a project's three folders (sharing-files.ts enrollment). */
function projectFolderIds(projectId: string, syncFolderId: string | null | undefined): string[] {
  return [syncFolderId ?? `joint-bob-project-${hash(projectId)}`, `joint-bob-project-${hash(projectId)}`, projectTicketSyncFolderId(projectId), projectWorktreeSyncFolderId(projectId)];
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
interface PeerAnswer { peer: string; shares?: SharesAnswer; status?: StatusAnswer; error?: string; release?: SwitchAnswer; releaseError?: string }

function peerFailure(status: number): string {
  return status === 404 ? "it runs a Joint Bob without built-in file sync"
    : status === 503 ? "file sync is not running there" : status === 403 ? "it does not share this project with this machine" : `HTTP ${status}`;
}

interface Classified { remove: SyncthingFolder[]; blocked: Array<{ folder: SyncthingFolder; reason: string }> }

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
  /** Built-in projects checked against a folder list Syncthing gave: the Syncthing and the roots that check was for. */
  private readonly verified = new Map<string, string>();
  private readonly switching = new Map<string, Promise<unknown>>();
  /** Records written here that peers have not been told about: the worker must serve them first (its configure carries them). */
  private readonly unnotified = new Set<string>();
  /** The owner: each peer's phase of a project, as the peer said (its report, or its answer to the checks). In memory: asked again at start. */
  private readonly peerReports = new Map<string, Map<string, { phase: Phase; error: string | null }>>();
  /** Owned projects whose peers were asked for their phase since this node started. */
  private readonly asked = new Set<string>();
  /** A peer: the report the owner last took for each project, and the one on its way. */
  private readonly delivered = new Map<string, string>();
  private readonly delivering = new Set<string>();
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

  /** A derivation, a record or a capability changed: every tracked project takes a step if it has one. */
  kick(projectId?: string): void {
    if (this.stopped) return;
    for (const id of projectId ? [projectId] : this.tracked()) this.run(id);
  }

  /** A share report came in: a project waiting for its peers to catch up tries again at once when they have. */
  shareChanged(status: ShareStatus): void {
    if (this.stopped || phaseOf(this.db, status.projectId)?.phase !== "bootstrapping") return;
    if (status.state !== "idle" || status.scanning || !status.peers.every((peer) => peer.caughtUp)) return;
    const wait = this.waits.get(status.projectId);
    if (wait) wait.until = 0;
    this.run(status.projectId);
  }

  stop(): void {
    this.stopped = true;
    for (const wait of this.waits.values()) wait.timer?.cancel();
    this.waits.clear();
  }

  /** Tests: resolves once no step runs. */
  async idle(): Promise<void> {
    while (this.steps.size) await Promise.allSettled([...this.steps.values()]);
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
          if (this.verified.get(projectId) !== this.verifyKey(projectId)) {
            const verified = await this.verifyBuiltin(projectId);
            if (verified === "moved") continue;
            // Not known yet (Syncthing did not answer): asked again, with backoff, until it does.
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
      if (phase === "syncthing") { this.messages.delete(projectId); this.clearWait(projectId); this.clearError(projectId, phase); return; }
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
      this.clearWait(projectId);
      this.messages.delete(projectId);
      await this.deps.engine.apply();
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
    try { folders = await this.deps.syncthing.folders(); } catch (error) {
      this.messages.set(projectId, `Waiting for Syncthing to let go of this project's folders (Syncthing did not answer: ${messageOf(error)})`);
      return "wait";
    }
    const { remove, blocked } = await this.classify(projectId, folders, roots);
    if (blocked.length) {
      this.updatePhase(projectId, "releasing", { error: blocked[0].reason });
      this.messages.set(projectId, `Waiting for Syncthing to let go of ${folderLabel(blocked[0].folder)}`);
      return "wait";
    }
    for (const folder of remove) {
      try { await this.deps.syncthing.removeFolder(folder.id); } catch { /* the fresh list below decides */ }
    }
    let fresh: SyncthingFolder[];
    try { fresh = await this.deps.syncthing.folders(); } catch {
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
    try { folders = await this.deps.syncthing.folders(); } catch {
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
    try { folders = await this.deps.syncthing.folders(); } catch {
      this.messages.set(projectId, "Waiting for Syncthing to answer before taking over this project's files");
      return "wait";
    }
    if ((await this.holding(projectId, folders, roots)).length) {
      this.toReleasing(projectId);
      return "again";
    }
    this.updatePhase(projectId, "builtin", { builtinSince: since });
    this.messages.delete(projectId);
    this.verified.set(projectId, this.verifyKey(projectId));
    await engine.apply();
    return "done";
  }

  /** What a built-in project was last checked against: this node's Syncthing and the project's roots. */
  private verifyKey(projectId: string): string {
    return JSON.stringify([this.deps.syncthing.generation?.() ?? 0, this.roots(projectId) ?? null]);
  }

  /**
   * At each start, when the project's roots move and when this node is pointed at another Syncthing:
   * a folder over a built-in project's roots (added back by hand, or by a path that missed the guard)
   * sends the project back to releasing, which stops the engine writing there. A Syncthing that does
   * not answer may still hold such a folder in its configuration, so the check stays owed ("unknown").
   */
  private async verifyBuiltin(projectId: string): Promise<"clear" | "moved" | "unknown"> {
    const key = this.verifyKey(projectId);
    const roots = this.roots(projectId);
    if (!roots) { this.verified.set(projectId, key); return "clear"; }
    let folders: SyncthingFolder[];
    try { folders = await this.deps.syncthing.folders(); } catch (error) {
      this.messages.set(projectId, `Checking that Syncthing does not sync this project's folders (Syncthing did not answer: ${messageOf(error)})`);
      return "unknown";
    }
    this.messages.delete(projectId);
    const left = await this.holding(projectId, folders, roots);
    this.verified.set(projectId, key);
    if (!left.length) return "clear";
    this.log(`fileSync:switch:${projectId}`, `Syncthing syncs ${folderLabel(left[0])} again, over ${this.name(projectId)}: built-in sync stops writing there until Syncthing lets go of it`);
    this.toReleasing(projectId);
    await this.deps.engine.apply();
    return "moved";
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

  /** Only the project's own folders are ever removed; any other folder that may write over its roots blocks the switch, named. */
  private async classify(projectId: string, folders: readonly SyncthingFolder[], roots: Record<ShareKind, string>): Promise<Classified> {
    const owners = this.folderOwners(projectId);
    const result: Classified = { remove: [], blocked: [] };
    for (const folder of await this.holding(projectId, folders, roots, owners)) {
      const owner = owners.get(folder.id);
      if (owner?.id === projectId) result.remove.push(folder);
      // Another project's folder (nested projects): removing it would only see enrollment add it back, and a project on
      // built-in sync here lets go of it itself (verifyBuiltin). Two projects inside each other stay with Syncthing: on
      // built-in sync both would write the inner one's files (fix P4+P5).
      else if (owner) result.blocked.push({ folder, reason: projectFilesOnSyncthing(this.db, owner.id)
        ? `Syncthing syncs “${owner.name}” in ${folder.path}, which overlaps this project's files; projects inside each other stay with Syncthing`
        : `Syncthing syncs “${owner.name}” in ${folder.path} again, which overlaps this project's files; restarting Joint Bob on this machine makes it let go` });
      else if (jointBobFolderId(folder.id)) result.blocked.push({ folder, reason: `Joint Bob's old shared folder “${folderLabel(folder)}” (${folder.path}) is not paused in Syncthing and overlaps this project's files; Joint Bob pauses it again within a minute` });
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

  /** What would hold this node's release of the project: nested projects and folders Syncthing may write in that are not the project's own. */
  private async releaseBlockers(projectId: string): Promise<{ blockers: string[]; remove: SyncthingFolder[]; syncthing?: string }> {
    const roots = this.roots(projectId);
    if (!roots) return { blockers: ["This project's folder is not known on this machine"], remove: [] };
    const blockers = await this.nestedProjects(projectId, roots);
    let folders: SyncthingFolder[];
    try { folders = await this.deps.syncthing.folders(); } catch (error) { return { blockers, remove: [], syncthing: messageOf(error) }; }
    const { remove, blocked } = await this.classify(projectId, folders, roots);
    return { blockers: [...blockers, ...blocked.map((entry) => entry.reason)], remove };
  }

  // ---- continuous check: every eligible peer must be able to take files from the engine ----

  /**
   * A peer known to lack the engine, to run one too old to leave Syncthing for a switched project
   * (2.157, 2.158: it would stay on Syncthing while this node stops sending there), or to have it
   * off; an unheard peer is not a problem yet (every peer is unheard at start).
   */
  private peerProblem(projectId: string): string | undefined {
    for (const peer of projectPeers(this.db, this.local, projectId)) {
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
    this.log(`fileSync:switch:${projectId}`, `File sync moved ${this.name(projectId)} back to Syncthing: ${problem}`);
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
      : { key: "shared", ok: false, message: "This project is not shared with another machine" });
    // Peers learn of the switch from this node's engine (its answers carry the record), so it must run here either way.
    checks.push(!this.deps.engine.enabled() ? { key: "engine", ok: false, message: "Turn on file sync on this machine first" }
      : !this.deps.engine.running() ? { key: "engine", ok: false, message: "File sync is still starting on this machine" }
      : { key: "engine", ok: true, message: "File sync runs on this machine" });
    const answers = await Promise.all(peers.map((peer) => this.askPeer(peer, projectId, statuses, engine === "builtin")));
    if (engine === "syncthing") {
      const silent = answers.filter((answer) => !answer.shares);
      checks.push(silent.length
        ? { key: "reachable", ok: false, message: silent.map((answer) => `${this.peerName(answer.peer)} did not answer (${answer.error})`).join("; ") }
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

  /** Records the engine and tells every peer; refused with every check when one fails (a move back needs only the owner, a running engine and peers that answer). */
  async switchEngine(projectId: string, target: EngineMode): Promise<FileSyncProject> {
    const previous = this.switching.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const answer = await this.checks(projectId, target);
      if (answer.checks.some((check) => !check.ok)) throw new EngineSwitchRefused(answer.checks);
      // Moving back again re-announces (a peer that missed the first word still on built-in sync hears it now).
      if (engineModeOf(this.db, projectId) !== target || (target === "syncthing" && engineRecordOf(this.db, projectId))) {
        this.record(projectId, target);
        this.log(`fileSync:switch:${projectId}`, `File sync moves ${this.name(projectId)} to ${target === "builtin" ? "built-in sync" : "Syncthing"}`);
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

  /** generation + 1, never an older timestamp than the record it replaces (another node's clock may run ahead). */
  private record(projectId: string, mode: EngineMode): EngineRecord {
    const held = engineRecordOf(this.db, projectId);
    const at = Math.max(this.clock.now(), held ? Date.parse(held.updatedAt) + 1 : 0);
    const record: EngineRecord = { projectId, mode, generation: (held?.generation ?? 0) + 1, updatedAt: new Date(at).toISOString(), origin: this.local };
    saveEngineRecord(this.db, record);
    this.unnotified.add(projectId);
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
        const response = await this.deps.peerRequest(peer, { method: "POST", target: `${FILES_API}/changed`, json: { shares: [], records: true } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.deps.settle?.(`fileSync:switch:notify:${peer}`);
      } catch (error) {
        // It learns at its next contact with this node (start, wake, return): its answer is asked for then.
        this.log(`fileSync:switch:notify:${peer}`, `File sync could not tell ${this.peerName(peer)} about the move of ${this.name(projectId)} yet: ${messageOf(error)}`);
      }
    }));
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
      this.notePeerPhase(body.projectId, peer, { phase: release.phase, error: release.error });
      return { release };
    } catch (error) {
      return { releaseError: messageOf(error) };
    }
  }

  private notePeerPhase(projectId: string, peer: string, report: { phase: Phase; error: string | null }): void {
    const byPeer = this.peerReports.get(projectId) ?? new Map<string, { phase: Phase; error: string | null }>();
    byPeer.set(peer, { phase: report.phase, error: report.error });
    this.peerReports.set(projectId, byPeer);
  }

  /** Once per start, the owner: where each peer's move of a switched project stands. */
  private async askPhases(projectId: string): Promise<void> {
    await Promise.allSettled(projectPeers(this.db, this.local, projectId).map((peer) => this.askSwitch(peer, { projectId })));
  }

  /** A peer: the owner hears of each change of this node's phase or its error, so a move stuck here shows there. Retried at the next step. */
  private reportToOwner(projectId: string): void {
    const owner = this.ownerOf(projectId);
    if (owner === this.local || this.delivering.has(projectId) || !projectPeers(this.db, this.local, projectId).includes(owner)) return;
    const held = phaseOf(this.db, projectId);
    const report = { phase: held?.phase ?? "syncthing", error: held?.error ?? null };
    const text = JSON.stringify([owner, report]);
    if (this.delivered.get(projectId) === text) return;
    this.delivering.add(projectId);
    void (async () => {
      try {
        const response = await this.deps.peerRequest(owner, { method: "POST", target: `${FILES_API}/switch`, json: { projectId, report } }, AbortSignal.timeout(this.deps.peerTimeoutMs ?? PEER_TIMEOUT_MS));
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) { this.delivered.set(projectId, text); this.deps.settle?.(`fileSync:switch:report:${projectId}`); }
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
    const owner = this.ownerOf(body.projectId);
    if (body.report && owner === this.local) this.notePeerPhase(body.projectId, peer, body.report);
    const held = phaseOf(this.db, body.projectId);
    const answer: SwitchAnswer = { projectId: body.projectId, phase: held?.phase ?? "syncthing", error: held?.error ?? null };
    if (!body.blockers || peer !== owner) return answer;
    const release = await this.releaseBlockers(body.projectId);
    return { ...answer, blockers: [...release.blockers, ...release.syncthing !== undefined ? [`Syncthing did not answer there (${release.syncthing}), and it has to let go of the project's folders`] : []] };
  }

  private capableCheck(answers: readonly PeerAnswer[]): Check {
    const problems = answers.flatMap((answer) => {
      const name = this.peerName(answer.peer);
      if (!answer.shares) return [`${name} did not answer (${answer.error})`];
      const engine = answer.shares.fileSync;
      // An engine without the switch (2.157, 2.158) compares in shadow but never leaves Syncthing: it would stop receiving.
      if (engine.protocol < FILE_SYNC_SWITCH_PROTOCOL || engine.minProtocol > FILE_SYNC_PROTOCOL) return [`${name} needs a newer Joint Bob`];
      if (!engine.enabled) return [`${name} has file sync turned off`];
      return [];
    });
    return problems.length ? { key: "peers", ok: false, message: problems.join("; ") } : { key: "peers", ok: true, message: "Every machine runs built-in file sync" };
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
      return [...checks, { key: "syncthing", ok: false, message: `Syncthing did not answer on this machine (${local.syncthing}); it has to let go of the project's folders` }];
    }
    const remove = local.remove;
    if (!remove.length) return [...checks, { key: "syncthing", ok: true, message: "Syncthing does not sync this project on this machine" }];
    const ids = remove.map((folder) => folder.id);
    const states = await this.deps.syncthing.folderStatuses(ids).catch(() => ({} as Record<string, ProjectSyncStatus>));
    const busy = remove.filter((folder) => !["synced", "paused"].includes(states[folder.id]?.state ?? ""));
    if (busy.length) return [...checks, { key: "syncthing", ok: false, message: `Syncthing is still copying files in ${busy.map(folderLabel).join(", ")}` }];
    const enrolled = tableExists(this.db, "cluster_v2_file_enrollments")
      ? this.db.prepare("SELECT peer_id, device_id, folder_id FROM cluster_v2_file_enrollments WHERE project_id = ?").all(projectId) as Array<{ peer_id: string; device_id: string; folder_id: string }>
      : [];
    const problems: string[] = [];
    for (const peer of peers) {
      const rows = enrolled.filter((row) => row.peer_id === peer && ids.includes(row.folder_id));
      if (!rows.length) continue;
      const caughtUp = await this.deps.syncthing.peerCaughtUp(rows[0].device_id, rows.map((row) => row.folder_id)).catch(() => false);
      if (!caughtUp) problems.push(`Syncthing has not finished copying this project to ${this.peerName(peer)}`);
    }
    return [...checks, problems.length ? { key: "syncthing", ok: false, message: problems.join("; ") } : { key: "syncthing", ok: true, message: "Syncthing has nothing left to copy" }];
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
  private toReleasing(projectId: string): void {
    this.updatePhase(projectId, "releasing", { builtinSince: {} });
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

/** A running task or merge would write while the engines change hands. */
async function defaultActivity(projectId: string): Promise<string | undefined> {
  const [{ listTasks }, { harnessTaskRuns, projectHasMergeReservation }, { asNode }] = await Promise.all([import("../tasks.js"), import("../server/task-runs.js"), import("../account-context.js")]);
  const tasks = await asNode(() => listTasks(projectId));
  if (tasks.some((task) => task.executionState === "running") || [...harnessTaskRuns.values()].some((run) => run.projectId === projectId)) return "A task is running in this project; wait for it to finish";
  if (tasks.some((task) => task.mergeTx === "open") || projectHasMergeReservation(projectId)) return "A merge is in progress in this project; wait for it to finish";
  return undefined;
}

/** Production Syncthing access: a node without a configured daemon throws, which the switch treats as not verified. */
export async function syncthingForMigration(): Promise<MigrationSyncthing> {
  const syncthing = await import("../syncthing.js");
  return {
    folders: () => syncthing.requireSyncthingFolders(),
    removeFolder: (folderId) => syncthing.removeSyncthingFolderConfig(folderId),
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
