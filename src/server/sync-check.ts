import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getClusterNode } from "../cluster.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import type { HarnessModelSettings } from "../harnesses/runtime.js";
import { getProjectLock } from "../project-locks.js";
import { getSettings, type SyncCheckSettings } from "../settings.js";
import { listProjects } from "../store.js";
import { reconcileSyncthingProjectFolders, rescanSyncthingFolder, syncthingFolderErrors, resetSyncthingConnection, syncthingFolderStatuses } from "../syncthing.js";
import type { ProjectRecord } from "../types.js";
import { flags } from "./state.js";

/* Syncthing leaves `name.sync-conflict-YYYYMMDD-HHMMSS-DEVICE.ext` beside a file two
   nodes changed at once, and a folder can wedge in an error state. This check runs in
   the background, fixes what it safely can without asking, and hands real two-sided
   edits to an unattended agent chosen in Settings. Only the project's owner node acts,
   so two nodes never resolve the same conflict copy. */

const CONFLICT_NAME = /^(.*?)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(.*)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".venv", "venv", "dist", "build", "coverage", ".joint-bob", ".pi-mobile-web", "__pycache__", ".dev-env", ".stversions", ".stfolder"]);
const MAX_SCANNED_ENTRIES = 50_000;
/* `.git` is node-local (it is in every project's ignore list), so conflict copies in it
   are leftovers from before that rule and never sync again. Only its bulky object
   stores are skipped. */
const SKIPPED_GIT_DIRECTORIES = new Set(["objects", "lfs", "modules", "worktrees"]);
/** Syncthing may still be writing a fresh conflict copy; leave it alone until it settles. */
export const CONFLICT_SETTLE_MS = 2 * 60_000;
/** An agent that could not resolve a copy is not asked again about it for this long. */
const AGENT_RETRY_MS = 60 * 60_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_AGENT_TEXT_BYTES = 512 * 1024;
const FOLDER_RESCAN_MS = 10 * 60_000;

export interface SyncConflict { projectId: string; root: string; conflictPath: string; originalPath: string; relativePath: string; gitMetadata?: boolean; }
export type SyncConflictOutcome = "kept-copy" | "removed-duplicate" | "removed-stale-git" | "needs-agent" | "manual" | "settling";

export interface SyncResolverInput {
  projectId: string;
  cwd: string;
  settings: SyncCheckSettings;
  conflicts: Array<{ conflict: string; original: string }>;
  prompt: string;
}
export type SyncResolver = (input: SyncResolverInput) => Promise<void>;

export interface SyncCheckStatus {
  enabled: boolean;
  lastCheckAt?: string;
  lastError?: string;
  resolvedTotal: number;
  /** Conflict copies this node could not fix on its own, relative to their project. */
  unresolved: Array<{ projectId: string; path: string; reason: string }>;
  folderIssues: Array<{ projectId: string; folderId: string; message: string }>;
}

const status: SyncCheckStatus = { enabled: true, resolvedTotal: 0, unresolved: [], folderIssues: [] };
const agentAttempts = new Map<string, number>();
const folderRescans = new Map<string, number>();
let checkInProgress = false;

export function syncCheckStatus(): SyncCheckStatus {
  return { ...status, enabled: getSettings().syncCheck.enabled, unresolved: [...status.unresolved], folderIssues: [...status.folderIssues] };
}

export function conflictOriginalPath(conflictPath: string): string | undefined {
  const match = CONFLICT_NAME.exec(path.basename(conflictPath));
  return match ? path.join(path.dirname(conflictPath), `${match[1]}${match[2]}`) : undefined;
}

export async function findSyncConflicts(projectId: string, root: string): Promise<SyncConflict[]> {
  const found: SyncConflict[] = [];
  const pending: Array<{ directory: string; git: boolean }> = [{ directory: root, git: false }];
  let scanned = 0;
  while (pending.length && scanned < MAX_SCANNED_ENTRIES) {
    const { directory, git } = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      scanned += 1;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (git ? !SKIPPED_GIT_DIRECTORIES.has(entry.name) : !SKIPPED_DIRECTORIES.has(entry.name)) pending.push({ directory: full, git: git || entry.name === ".git" });
        continue;
      }
      if (!entry.isFile()) continue;
      const originalPath = conflictOriginalPath(full);
      if (originalPath) found.push({ projectId, root, conflictPath: full, originalPath, relativePath: path.relative(root, originalPath), ...(git ? { gitMetadata: true } : {}) });
    }
  }
  return found;
}

function binary(bytes: Buffer): boolean { return bytes.subarray(0, 8192).includes(0); }

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Fixes a conflict copy without a model when the answer is obvious. */
export async function resolveTrivialConflict(conflict: SyncConflict, now = Date.now()): Promise<SyncConflictOutcome> {
  const stat = await fs.stat(conflict.conflictPath);
  if (now - stat.mtimeMs < CONFLICT_SETTLE_MS) return "settling";
  const [copy, original] = await Promise.all([fs.readFile(conflict.conflictPath), readIfExists(conflict.originalPath)]);
  if (!original) {
    await fs.rename(conflict.conflictPath, conflict.originalPath);
    return "kept-copy";
  }
  if (copy.equals(original)) {
    await fs.unlink(conflict.conflictPath);
    return "removed-duplicate";
  }
  // Git keeps its own history; merging copies of its index or refs would corrupt it.
  if (conflict.gitMetadata) {
    await fs.unlink(conflict.conflictPath);
    return "removed-stale-git";
  }
  if (binary(copy) || binary(original) || copy.length > MAX_AGENT_TEXT_BYTES || original.length > MAX_AGENT_TEXT_BYTES) return "manual";
  return "needs-agent";
}

export function syncResolverPrompt(conflicts: Array<{ conflict: string; original: string }>): string {
  return [
    "You are Joint Bob's background sync fixer. Syncthing found files that two machines edited at the same time and kept both versions.",
    "For each pair below, merge the changes from the conflict copy into the original so nobody's work is lost:",
    "- Read both files. Keep every change that only one side made.",
    "- Where both sides changed the same lines, combine their intent; for append-only files such as changelogs, logs, and notes keep both entries in order.",
    "- Keep the original's file name and format valid (JSON stays parseable, code still compiles).",
    "- Then delete the conflict copy.",
    "Change nothing else: do not edit other files, do not run git commands, do not commit or push, and do not ask questions.",
    "",
    ...conflicts.map((pair) => `- original: ${pair.original}\n  conflict copy: ${pair.conflict}`),
    "",
    "When you are done, reply with one short line per file saying what you kept.",
  ].join("\n");
}

async function runAgentResolver(input: SyncResolverInput): Promise<void> {
  const override = process.env.JOINT_BOB_SYNC_RESOLVER;
  if (override) {
    const module = await import(override) as { default: SyncResolver };
    return module.default(input);
  }
  const adapter = getHarness(input.settings.harnessId);
  if (!adapter.runtime) throw new Error(`${adapter.label} cannot run the sync check`);
  const runtime = await getHarnessRuntime(input.settings.harnessId);
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: randomUUID() });
  try {
    const base = session.settings();
    const settings: HarnessModelSettings = { ...base, provider: input.settings.provider || base.provider, modelId: input.settings.modelId || base.modelId, reasoning: input.settings.thinkingLevel || base.reasoning };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void session.cancel().catch(() => {});
        reject(new Error("The sync fixer timed out"));
      }, AGENT_TIMEOUT_MS);
      timer.unref();
      const stop = session.subscribe((event) => {
        if (event.type !== "agent_end" && event.type !== "error") return;
        clearTimeout(timer);
        stop();
        if (event.type === "error") reject(new Error(typeof event.error === "string" ? event.error : "The sync fixer failed"));
        else resolve();
      });
    });
    await session.prompt({ text: input.prompt });
    await done;
  } finally {
    try { if (session.isBusy()) await session.cancel(); } catch { /* torn down regardless */ }
    session.dispose();
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function mayResolve(project: ProjectRecord, localNodeId: string): Promise<boolean> {
  if (project.ownerNodeId && project.ownerNodeId !== localNodeId) return false;
  const lock = await getProjectLock(project.id);
  return !lock || lock.nodeId === localNodeId;
}

async function checkProjectConflicts(project: ProjectRecord, settings: SyncCheckSettings, now: number): Promise<{ resolved: number; unresolved: SyncCheckStatus["unresolved"] }> {
  const unresolved: SyncCheckStatus["unresolved"] = [];
  let resolved = 0;
  const needsAgent: SyncConflict[] = [];
  for (const conflict of await findSyncConflicts(project.id, project.path)) {
    let outcome: SyncConflictOutcome;
    try { outcome = await resolveTrivialConflict(conflict, now); } catch (error) {
      unresolved.push({ projectId: project.id, path: path.relative(project.path, conflict.conflictPath), reason: error instanceof Error ? error.message : "Could not read the conflict copy" });
      continue;
    }
    if (outcome === "kept-copy" || outcome === "removed-duplicate" || outcome === "removed-stale-git") resolved += 1;
    else if (outcome === "manual") unresolved.push({ projectId: project.id, path: path.relative(project.path, conflict.conflictPath), reason: "Binary or large file; choose a version by hand" });
    else if (outcome === "needs-agent") needsAgent.push(conflict);
  }
  const due = needsAgent.filter((conflict) => now - (agentAttempts.get(conflict.conflictPath) ?? 0) >= AGENT_RETRY_MS);
  for (const conflict of needsAgent.filter((candidate) => !due.includes(candidate))) {
    unresolved.push({ projectId: project.id, path: path.relative(project.path, conflict.conflictPath), reason: "The sync fixer could not merge it; it will try again later" });
  }
  if (!due.length) return { resolved, unresolved };
  for (const conflict of due) agentAttempts.set(conflict.conflictPath, now);
  const pairs = due.map((conflict) => ({ conflict: path.relative(project.path, conflict.conflictPath), original: path.relative(project.path, conflict.originalPath) }));
  let failure: string | undefined;
  try {
    await runAgentResolver({ projectId: project.id, cwd: project.path, settings, conflicts: pairs, prompt: syncResolverPrompt(pairs) });
  } catch (error) {
    failure = error instanceof Error ? error.message : "The sync fixer failed";
    console.warn(`Sync check could not merge conflicts in ${project.name}: ${failure}`);
  }
  for (const conflict of due) {
    if (!await exists(conflict.conflictPath)) {
      resolved += 1;
      agentAttempts.delete(conflict.conflictPath);
      continue;
    }
    unresolved.push({ projectId: project.id, path: path.relative(project.path, conflict.conflictPath), reason: failure ?? "The sync fixer left the conflict copy in place" });
  }
  return { resolved, unresolved };
}

async function checkFolders(projects: ProjectRecord[], now: number): Promise<SyncCheckStatus["folderIssues"]> {
  const shared = projects.filter((project) => project.syncFolderId);
  if (!shared.length) return [];
  // Keeps managed ignore rules current without a restart; a stale rule without `(?d)`
  // makes remote folder deletions fail with "contains ignored files".
  try { await reconcileSyncthingProjectFolders(shared); } catch (error) {
    console.warn(`Sync check could not update Syncthing ignore rules: ${error instanceof Error ? error.message : "update failed"}`);
  }
  let statuses = await syncthingFolderStatuses(shared.map((project) => project.syncFolderId!));
  // A restarted Syncthing can come back on a new port or key; rediscover it once.
  if (Object.values(statuses).some((folder) => folder.state === "unavailable")) {
    resetSyncthingConnection();
    statuses = await syncthingFolderStatuses(shared.map((project) => project.syncFolderId!));
  }
  const issues: SyncCheckStatus["folderIssues"] = [];
  for (const project of shared) {
    const folderId = project.syncFolderId!;
    const folder = statuses[folderId];
    if (!folder || folder.state === "synced" || folder.state === "syncing" || folder.state === "paused") continue;
    const stuck = folder.state === "error" ? await syncthingFolderErrors(folderId).catch(() => []) : [];
    const detail = stuck.length ? `: ${stuck.slice(0, 3).map((item) => `${item.path} (${item.error.replace(/^syncing: /, "")})`).join("; ")}${stuck.length > 3 ? `; and ${stuck.length - 3} more` : ""}` : "";
    issues.push({ projectId: project.id, folderId, message: `${project.name}: ${folder.message ?? folder.state}${detail}` });
    if (folder.state !== "error" || now - (folderRescans.get(folderId) ?? 0) < FOLDER_RESCAN_MS) continue;
    folderRescans.set(folderId, now);
    try { await rescanSyncthingFolder(folderId); } catch (error) {
      console.warn(`Sync check could not rescan Syncthing folder ${folderId}: ${error instanceof Error ? error.message : "rescan failed"}`);
    }
  }
  return issues;
}

/** One pass of the background sync check. Quiet by design: it logs only what it could not fix. */
export async function runSyncCheck(now = Date.now()): Promise<SyncCheckStatus> {
  const settings = getSettings().syncCheck;
  if (!settings.enabled || checkInProgress || !flags.startupReady || flags.updatePreparing) return syncCheckStatus();
  checkInProgress = true;
  try {
    const local = await getClusterNode();
    const projects = await listProjects();
    const unresolved: SyncCheckStatus["unresolved"] = [];
    let resolved = 0;
    for (const project of projects) {
      if (!await mayResolve(project, local.id)) continue;
      const result = await checkProjectConflicts(project, settings, now);
      resolved += result.resolved;
      unresolved.push(...result.unresolved);
    }
    const folderIssues = await checkFolders(projects, now);
    Object.assign(status, { lastCheckAt: new Date(now).toISOString(), lastError: undefined, resolvedTotal: status.resolvedTotal + resolved, unresolved, folderIssues });
    if (resolved) console.log(`Sync check resolved ${resolved} Syncthing conflict cop${resolved === 1 ? "y" : "ies"}`);
  } catch (error) {
    status.lastCheckAt = new Date(now).toISOString();
    status.lastError = error instanceof Error ? error.message : "Sync check failed";
    console.warn("Sync check failed", error);
  } finally {
    checkInProgress = false;
  }
  return syncCheckStatus();
}
