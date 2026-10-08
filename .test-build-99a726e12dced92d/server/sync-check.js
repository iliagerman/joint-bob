import { internalSessionId } from "../internal-sessions.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getClusterNode } from "../cluster.js";
import { getHarness, getHarnessRuntime } from "../harnesses.js";
import { getProjectLock } from "../project-locks.js";
import { getSettings } from "../settings.js";
import { listProjects } from "../store.js";
import { reconcileSyncthingProjectFolders, rescanSyncthingFolder, syncthingFolderErrors, resetSyncthingConnection, syncthingFolderStatuses } from "../syncthing.js";
import { flags } from "./state.js";
const CONFLICT_NAME = /^(.*?)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(.*)$/;
const SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", ".venv", "venv", "dist", "build", "coverage", ".joint-bob", ".pi-mobile-web", "__pycache__", ".dev-env", ".stversions", ".stfolder"]);
const MAX_SCANNED_ENTRIES = 5e4;
const SKIPPED_GIT_DIRECTORIES = /* @__PURE__ */ new Set(["objects", "lfs", "modules", "worktrees"]);
const CONFLICT_SETTLE_MS = 2 * 6e4;
const AGENT_RETRY_MS = 60 * 6e4;
const AGENT_TIMEOUT_MS = 10 * 6e4;
const MAX_AGENT_TEXT_BYTES = 512 * 1024;
const FOLDER_RESCAN_MS = 10 * 6e4;
const status = { enabled: true, resolvedTotal: 0, unresolved: [], folderIssues: [] };
const agentAttempts = /* @__PURE__ */ new Map();
const folderRescans = /* @__PURE__ */ new Map();
let checkInProgress = false;
function syncCheckStatus() {
  return { ...status, enabled: getSettings().syncCheck.enabled, unresolved: [...status.unresolved], folderIssues: [...status.folderIssues] };
}
function conflictOriginalPath(conflictPath) {
  const match = CONFLICT_NAME.exec(path.basename(conflictPath));
  return match ? path.join(path.dirname(conflictPath), `${match[1]}${match[2]}`) : void 0;
}
async function findSyncConflicts(projectId, root) {
  const found = [];
  const pending = [{ directory: root, git: false }];
  let scanned = 0;
  while (pending.length && scanned < MAX_SCANNED_ENTRIES) {
    const { directory, git } = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (git ? !SKIPPED_GIT_DIRECTORIES.has(entry.name) : !SKIPPED_DIRECTORIES.has(entry.name)) pending.push({ directory: full, git: git || entry.name === ".git" });
        continue;
      }
      if (!entry.isFile()) continue;
      const originalPath = conflictOriginalPath(full);
      if (originalPath) found.push({ projectId, root, conflictPath: full, originalPath, relativePath: path.relative(root, originalPath), ...git ? { gitMetadata: true } : {} });
    }
  }
  return found;
}
function binary(bytes) {
  return bytes.subarray(0, 8192).includes(0);
}
async function readIfExists(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function resolveTrivialConflict(conflict, now = Date.now()) {
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
  if (conflict.gitMetadata) {
    await fs.unlink(conflict.conflictPath);
    return "removed-stale-git";
  }
  if (binary(copy) || binary(original) || copy.length > MAX_AGENT_TEXT_BYTES || original.length > MAX_AGENT_TEXT_BYTES) return "manual";
  return "needs-agent";
}
function syncResolverPrompt(conflicts) {
  return [
    "You are Joint Bob's background sync fixer. Syncthing found files that two machines edited at the same time and kept both versions.",
    "For each pair below, merge the changes from the conflict copy into the original so nobody's work is lost:",
    "- Read both files. Keep every change that only one side made.",
    "- Where both sides changed the same lines, combine their intent; for append-only files such as changelogs, logs, and notes keep both entries in order.",
    "- Keep the original's file name and format valid (JSON stays parseable, code still compiles).",
    "- Then delete the conflict copy.",
    "Change nothing else: do not edit other files, do not run git commands, do not commit or push, and do not ask questions.",
    "",
    ...conflicts.map((pair) => `- original: ${pair.original}
  conflict copy: ${pair.conflict}`),
    "",
    "When you are done, reply with one short line per file saying what you kept."
  ].join("\n");
}
async function runAgentResolver(input) {
  const override = process.env.JOINT_BOB_SYNC_RESOLVER;
  if (override) {
    const module = await import(override);
    return module.default(input);
  }
  const adapter = getHarness(input.settings.harnessId);
  if (!adapter.runtime) throw new Error(`${adapter.label} cannot run the sync check`);
  const runtime = await getHarnessRuntime(input.settings.harnessId);
  const session = await runtime.open({ projectId: input.projectId, cwd: input.cwd, sessionId: internalSessionId() });
  try {
    const base = session.settings();
    const settings = { ...base, provider: input.settings.provider || base.provider, modelId: input.settings.modelId || base.modelId, reasoning: input.settings.thinkingLevel || base.reasoning };
    await runtime.validateSettings(settings);
    await session.configure(settings);
    await session.preflight();
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void session.cancel().catch(() => {
        });
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
    try {
      if (session.isBusy()) await session.cancel();
    } catch {
    }
    session.dispose();
  }
}
async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
async function mayResolve(project, localNodeId) {
  if (project.ownerNodeId && project.ownerNodeId !== localNodeId) return false;
  const lock = await getProjectLock(project.id);
  return !lock || lock.nodeId === localNodeId;
}
function conflictsForNode(conflicts, owner) {
  return owner ? conflicts : conflicts.filter((conflict) => conflict.gitMetadata);
}
async function checkProjectConflicts(project, settings, now, owner) {
  const unresolved = [];
  let resolved = 0;
  const needsAgent = [];
  for (const conflict of conflictsForNode(await findSyncConflicts(project.id, project.path), owner)) {
    let outcome;
    try {
      outcome = await resolveTrivialConflict(conflict, now);
    } catch (error) {
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
  let failure;
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
async function checkFolders(projects, now) {
  const shared = projects.filter((project) => project.syncFolderId);
  if (!shared.length) return [];
  try {
    await reconcileSyncthingProjectFolders(shared);
  } catch (error) {
    console.warn(`Sync check could not update Syncthing ignore rules: ${error instanceof Error ? error.message : "update failed"}`);
  }
  let statuses = await syncthingFolderStatuses(shared.map((project) => project.syncFolderId));
  if (Object.values(statuses).some((folder) => folder.state === "unavailable")) {
    resetSyncthingConnection();
    statuses = await syncthingFolderStatuses(shared.map((project) => project.syncFolderId));
  }
  const issues = [];
  for (const project of shared) {
    const folderId = project.syncFolderId;
    const folder = statuses[folderId];
    if (!folder || folder.state === "synced" || folder.state === "syncing" || folder.state === "paused") continue;
    const stuck = folder.state === "error" ? await syncthingFolderErrors(folderId).catch(() => []) : [];
    const detail = stuck.length ? `: ${stuck.slice(0, 3).map((item) => `${item.path} (${item.error.replace(/^syncing: /, "")})`).join("; ")}${stuck.length > 3 ? `; and ${stuck.length - 3} more` : ""}` : "";
    issues.push({ projectId: project.id, folderId, message: `${project.name}: ${folder.message ?? folder.state}${detail}` });
    if (folder.state !== "error" || now - (folderRescans.get(folderId) ?? 0) < FOLDER_RESCAN_MS) continue;
    folderRescans.set(folderId, now);
    try {
      await rescanSyncthingFolder(folderId);
    } catch (error) {
      console.warn(`Sync check could not rescan Syncthing folder ${folderId}: ${error instanceof Error ? error.message : "rescan failed"}`);
    }
  }
  return issues;
}
async function runSyncCheck(now = Date.now()) {
  const settings = getSettings().syncCheck;
  if (!settings.enabled || checkInProgress || !flags.startupReady || flags.updatePreparing) return syncCheckStatus();
  checkInProgress = true;
  try {
    const local = await getClusterNode();
    const projects = await listProjects();
    const unresolved = [];
    let resolved = 0;
    for (const project of projects) {
      const result = await checkProjectConflicts(project, settings, now, await mayResolve(project, local.id));
      resolved += result.resolved;
      unresolved.push(...result.unresolved);
    }
    const folderIssues = await checkFolders(projects, now);
    Object.assign(status, { lastCheckAt: new Date(now).toISOString(), lastError: void 0, resolvedTotal: status.resolvedTotal + resolved, unresolved, folderIssues });
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
export {
  CONFLICT_SETTLE_MS,
  conflictOriginalPath,
  conflictsForNode,
  findSyncConflicts,
  resolveTrivialConflict,
  runSyncCheck,
  syncCheckStatus,
  syncResolverPrompt
};
