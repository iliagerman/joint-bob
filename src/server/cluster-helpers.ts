import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { NextFunction, Request, Response } from "express";
import { type ClusterPeer, clusterProjectGrantFor, getClusterMachineToken, getClusterNode, listClusterPeers, markClusterPeerSeen } from "../cluster.js";
import { listConversationRecords } from "../conversation-records.js";
import type { ConversationEngine } from "../conversation-ownership.js";
import { harnessForSessionPath, harnessSyncFolderForSessionPath } from "../harnesses.js";
import { managedProjectPath } from "../managed-home.js";
import { resolveLocalSessionPath } from "../session-paths.js";
import { getSettings } from "../settings.js";
import { canonicalProjectId, getProject, importProject, listProjects, listWorkspaces, projectAliasIds, registerProjectAliases } from "../store.js";
import { assertSyncthingFolderReady, ensureSyncthingDevice, ensureSyncthingFolder, syncthingDeviceId, syncthingFolderStatuses, syncthingPathForFolderId } from "../syncthing.js";
import { assertTaskWorkspaceReady, TaskWorkspaceError, taskWorkspaceKey, TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL } from "../task-workspaces.js";
import { listTasks } from "../tasks.js";
import type { ProjectRecord, ProjectSyncStatus, TaskRecord } from "../types.js";
import { validateTaskRepository } from "../worktrees.js";
import { sessionWatcher } from "./chat.js";
import { sendError } from "./http-auth.js";
import { relocateProjectWorkspace } from "./projects.js";
import { execFileAsync, flags } from "./state.js";

interface PeerInventory {
  node: Awaited<ReturnType<typeof getClusterNode>>;
  syncDeviceId?: string;
  projectRoot?: string;
  projects: Array<{ project: ProjectRecord; aliases?: string[] }>;
}

/** May the authenticated machine peer see this project? A peer without a grant row is a
    legacy pairing and stays unrestricted; a granted peer sees exactly its invitation's
    selection, matched through aliases because each node may know the project under a
    different id. */
export async function clusterPeerMayAccessProject(machineNodeId: string, projectId: string, grant?: string[]): Promise<boolean> {
  const selection = grant ?? await clusterProjectGrantFor(machineNodeId);
  if (!selection) return true;
  if (selection.includes(projectId)) return true;
  const canonical = await canonicalProjectId(projectId);
  if (canonical && selection.includes(canonical)) return true;
  const aliases = canonical ? await projectAliasIds(canonical) : [];
  return aliases.some((alias) => selection.includes(alias));
}

/** Machine-route gate: any cluster machine call that names a project is refused unless the
    calling peer's grant covers it. Calls that do not name a project pass through; their own
    handlers decide. Secret traffic never names a project, so it is unaffected by design. */
export async function machineProjectAccessGuard(request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    if (!response.locals.machineAuth) { next(); return; }
    const machineNodeId = response.locals.machineNodeId as string;
    // Callers on older builds present the receiver's own token; treat them as legacy.
    if (machineNodeId === (await getClusterNode()).id) { next(); return; }
    const grant = await clusterProjectGrantFor(machineNodeId);
    if (!grant) { next(); return; }
    const candidate = typeof request.query.projectId === "string" ? request.query.projectId
      : (request.body as { projectId?: unknown } | undefined)?.projectId;
    if (typeof candidate !== "string" || !candidate) { next(); return; }
    if (await clusterPeerMayAccessProject(machineNodeId, candidate, grant)) { next(); return; }
    sendError(response, 403, "Project is not shared with this node");
  } catch (error) {
    next(error);
  }
}

export function publicClusterPeer(peer: ClusterPeer): Omit<ClusterPeer, "token"> & { tokenConfigured: boolean; online: boolean } {
  const { token, ...publicPeer } = peer;
  return { ...publicPeer, tokenConfigured: Boolean(token), online: Boolean(peer.lastSeenAt && Date.now() - Date.parse(peer.lastSeenAt) <= 90_000) };
}

async function runtimeAvailable(engine: TaskRecord["engine"]): Promise<string[]> {
  const settings = getSettings();
  if (engine === "pi") {
    if (settings.pi.configPath) {
      try { await access(settings.pi.configPath); } catch { return ["Pi config path is not available on this node"]; }
    }
    return [];
  }
  const executable = settings.claude.executable || "claude";
  try {
    if (path.isAbsolute(executable)) await access(executable, fsConstants.X_OK);
    else await execFileAsync("sh", ["-lc", "command -v -- \"$1\"", "sh", executable]);
    if (settings.claude.configPath) await access(settings.claude.configPath);
    return [];
  } catch {
    return [`Claude runtime ${executable} is not available on this node`];
  }
}

export async function abortPeerTaskHandoff(peer: ClusterPeer, handoffId: string): Promise<boolean> {
  try {
    const response = await fetch(`${peer.url}/api/cluster/tasks/abort`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(30_000) });
    if (response.ok) return true;
    console.warn(`Handoff abort failed: ${response.status}`);
  } catch (error) {
    console.warn("Handoff abort request failed", error);
  }
  return false;
}

async function assertTaskSessionReady(sessionPath: string, syncStatusChecked = false): Promise<void> {
  const session = resolveLocalSessionPath(sessionPath);
  const label = session.engine === "claude" ? "Claude" : "Pi";
  const filePath = session.engine === "claude" ? session.path.slice("claude:".length) : session.path;
  try {
    if (!syncStatusChecked) await assertSyncthingFolderReady(harnessSyncFolderForSessionPath(sessionPath).id, false);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Conversation is not a regular file");
  } catch {
    throw new Error(`${label} conversation is not synchronized on this node`);
  }
}

export async function assertTaskFilesReady(project: ProjectRecord, task: TaskRecord, syncStatusChecked = false): Promise<void> {
  if (task.worktreePath && !task.worktreeBranch) {
    if (!syncStatusChecked) await assertSyncthingFolderReady(TICKET_WORKSPACE_FOLDER_ID);
    await assertTaskWorkspaceReady(taskWorkspaceKey(task.worktreePath, task.id), task.id);
  } else if (project.syncFolderId && !syncStatusChecked) await assertSyncthingFolderReady(project.syncFolderId);
  if (task.worktreeBranch) await validateTaskRepository(project.path);
  if (task.sessionPath) await assertTaskSessionReady(task.sessionPath, syncStatusChecked);
}

export function taskConversationIdentity(task: TaskRecord): { engine: ConversationEngine; sessionId: string } | null {
  if (!task.sessionPath) return null;
  const adapter = harnessForSessionPath(task.sessionPath);
  const sessionId = adapter.paths.sessionId(task.sessionPath);
  if (!sessionId) throw new Error("Task conversation path has no transcript identity");
  return { engine: adapter.id, sessionId };
}

export function doneTaskOwnsConversation(task: TaskRecord, engine: string, sessionId: string): boolean {
  if (task.status !== "done" || !task.sessionPath || task.sessionPath === "watch") return false;
  const identity = taskConversationIdentity(task);
  return identity?.engine === engine && identity.sessionId === sessionId;
}

export async function conversationBelongsToDoneTask(projectId: string, engine: string, sessionId: string): Promise<boolean> {
  const tasks = await listTasks(projectId);
  const owns = (target: { engine: string; sessionId: string }): boolean => tasks.some((task) => doneTaskOwnsConversation(task, target.engine, target.sessionId));
  if (owns({ engine, sessionId })) return true;
  // The id may be a logical conversation id or any segment of a switched chain;
  // a Done ticket holding any segment locks the whole conversation.
  const records = await listConversationRecords(projectId);
  const record = records.find((candidate) => candidate.sessionId === sessionId || candidate.conversationId === sessionId);
  if (!record) return false;
  const conversationId = record.conversationId ?? record.sessionId;
  return records.filter((candidate) => (candidate.conversationId ?? candidate.sessionId) === conversationId).some(owns);
}

interface TaskSyncStatus extends ProjectSyncStatus { label: string }

export const peerTaskEligibilitySchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  syncStatuses: z.array(z.object({ label: z.string(), state: z.enum(["synced", "syncing", "paused", "error", "unavailable"]), remainingFiles: z.number(), remainingBytes: z.number(), message: z.string().optional() })).optional().default([]),
  waitingForSync: z.boolean().optional().default(false),
});

async function taskSyncStatuses(project: ProjectRecord, task: TaskRecord): Promise<TaskSyncStatus[]> {
  const targets: Array<{ id: string; label: string }> = [];
  if (task.worktreePath && !task.worktreeBranch) targets.push({ id: TICKET_WORKSPACE_FOLDER_ID, label: TICKET_WORKSPACE_FOLDER_LABEL });
  else if (project.syncFolderId) targets.push({ id: project.syncFolderId, label: project.name });
  if (task.sessionPath) {
    const folder = harnessSyncFolderForSessionPath(task.sessionPath);
    targets.push({ id: folder.id, label: folder.label });
  }
  const unique = targets.filter((target, index) => targets.findIndex(({ id }) => id === target.id) === index);
  const statuses = await syncthingFolderStatuses(unique.map((target) => target.id));
  return unique.map((target) => ({ label: target.label, ...statuses[target.id] }));
}

interface TaskEligibility {
  reasons: string[];
  syncStatuses: TaskSyncStatus[];
  waitingForSync: boolean;
}

export interface TaskEligibilityEntry extends TaskEligibility {
  node: { id: string; name: string; local?: boolean; online: boolean };
  eligible: boolean;
}

export async function taskHandoffEligibility(projectId: string, task: TaskRecord, requiresRuntime = true): Promise<TaskEligibility> {
  const project = await getProject(projectId);
  if (!project) return { reasons: ["Project is not mapped on this node"], syncStatuses: [], waitingForSync: false };
  try {
    if (!(await stat(project.path)).isDirectory()) return { reasons: ["Mapped project path is not a directory"], syncStatuses: [], waitingForSync: false };
  } catch {
    return { reasons: ["Mapped project path is not available on this node"], syncStatuses: [], waitingForSync: false };
  }
  const reasons = requiresRuntime ? await runtimeAvailable(task.engine) : [];
  const permanentReasonCount = reasons.length;
  const syncStatuses = await taskSyncStatuses(project, task);
  const syncPending = syncStatuses.some((status) => status.state !== "synced");
  const retryableSync = syncPending
    && syncStatuses.every((status) => ["synced", "syncing", "error"].includes(status.state));
  if (syncPending) reasons.push("Ticket files are not synchronized on this node");
  try { await assertTaskFilesReady(project, task, true); }
  catch (error) { reasons.push(error instanceof Error ? error.message : "Ticket files are not ready on this node"); }
  return { reasons, syncStatuses, waitingForSync: retryableSync && permanentReasonCount === 0 };
}

export async function peerTaskEligibilityEntry(peer: ClusterPeer, projectId: string, task: TaskRecord, source = false): Promise<TaskEligibilityEntry> {
  const node = publicClusterPeer(peer);
  try {
    const remote = await fetch(`${peer.url}/api/cluster/tasks/eligibility`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, task, source }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!remote.ok) throw new Error(`Peer returned ${remote.status}`);
    const result = peerTaskEligibilitySchema.parse(await remote.json());
    await markClusterPeerSeen(peer.id);
    return { node: { ...node, online: true }, ...result };
  } catch (error) {
    return { node: { ...node, online: false }, eligible: false, reasons: [error instanceof Error ? `Peer unreachable: ${error.message}` : "Peer unreachable"], syncStatuses: [], waitingForSync: false };
  }
}

export function projectWithLocalLocation(project: ProjectRecord, nodeId: string): ProjectRecord {
  const locations = new Map((project.locations ?? []).map((location) => [location.nodeId, location]));
  locations.set(nodeId, { nodeId, path: project.path });
  return { ...project, locations: [...locations.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)) };
}

export async function fetchPeerInventory(peer: ClusterPeer, timeoutMs = 10_000): Promise<PeerInventory> {
  // Our own machine token identifies the caller, which is what lets the peer filter
  // this inventory down to the projects our invitation granted us.
  const response = await fetch(`${peer.url}/api/cluster/local-inventory`, {
    headers: { Authorization: `Bearer ${await getClusterMachineToken()}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Peer returned ${response.status}`);
  const inventory = await response.json() as PeerInventory;
  await markClusterPeerSeen(peer.id);
  return inventory;
}

export type ProjectImportResult = {
  imported: string[];
  skipped: string[];
  pending: Array<{ peerId: string; projectId: string; name: string; remotePath: string; syncFolderId?: string; suggestedPath: string }>;
};

export async function importProjectsFromPeer(peer: ClusterPeer, missingOnly = false): Promise<ProjectImportResult> {
  const inventory = await fetchPeerInventory(peer);
  const imported: string[] = [];
  const skipped: string[] = [];
  const localProjects = await listProjects();
  const pending: ProjectImportResult["pending"] = [];
  for (const entry of inventory.projects) {
    const remoteProject = entry.project;
    const localWorkspace = await localWorkspaceId(remoteProject.type);
    const existing = await getProject(remoteProject.id) ?? localProjects.find((project) => remoteProject.syncFolderId !== undefined && project.syncFolderId === remoteProject.syncFolderId);
    if (existing && missingOnly) {
      skipped.push(remoteProject.name);
      continue;
    }
    let localPath = existing?.path;
    if (existing && existing.type !== localWorkspace) {
      localPath = (await relocateProjectWorkspace(existing, localWorkspace)).path;
    }
    if (!localPath && remoteProject.syncFolderId) {
      try {
        localPath = await syncthingPathForFolderId(remoteProject.syncFolderId);
      } catch {
        localPath = undefined;
      }
    }
    if (!existing && !localPath) {
      localPath = managedProjectPath(getSettings().projects.homePath, localWorkspace, remoteProject.name);
    }
    if (!existing && !localPath) {
      pending.push({
        peerId: peer.id,
        projectId: remoteProject.id,
        name: remoteProject.name,
        remotePath: remoteProject.path,
        ...(remoteProject.syncFolderId ? { syncFolderId: remoteProject.syncFolderId } : {}),
        suggestedPath: managedProjectPath(getSettings().projects.homePath, localWorkspace, remoteProject.name),
      });
      continue;
    }
    const importedProject = !existing && localPath
      ? await mapProjectFromPeer(peer, inventory, entry, localPath)
      : await importProject({ ...remoteProject, type: localWorkspace }, localPath, inventory.node.id);
    await registerProjectAliases(importedProject.id, [remoteProject.id, ...(entry.aliases ?? [])]);
    imported.push(remoteProject.name);
  }
  return { imported, skipped, pending };
}

export async function syncPairedProjects(peer: ClusterPeer, localNodeId: string): Promise<ProjectImportResult> {
  const localImport = await importProjectsFromPeer(peer);
  // The reverse import is best effort: a peer may still hold a credential this node rotated
  // moments ago during membership merging, and the periodic project discovery reconciles
  // anything this call misses. Failing the whole join for it would leave an established
  // membership reporting an error.
  const response = await fetch(`${peer.url}/api/cluster/projects/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ peerId: localNodeId }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => {
    console.warn(`Reverse project import to ${peer.id} failed`, error);
    return undefined;
  });
  if (response && !response.ok) console.warn(`Reverse project import to ${peer.id} failed: ${peer.url} returned ${response.status}`);
  return localImport;
}

export async function discoverMissingPeerProjects(): Promise<void> {
  if (!flags.startupReady || flags.projectDiscoveryInProgress) return;
  flags.projectDiscoveryInProgress = true;
  try {
    for (const peer of await listClusterPeers()) {
      try {
        await importProjectsFromPeer(peer, true);
      } catch (error) {
        console.warn(`Project discovery from ${peer.id} failed`, error);
      }
    }
  } finally {
    flags.projectDiscoveryInProgress = false;
  }
}

export function requirePathInsideHome(candidate: string, homeDirectory: string): void {
  const relative = path.relative(homeDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Folder must be inside this node's home directory");
}

/** A peer can carry a workspace this node never defined; fall back to a local one rather than inventing a folder. */
async function localWorkspaceId(candidate: string | undefined): Promise<string> {
  const workspaces = await listWorkspaces();
  if (candidate && workspaces.some((workspace) => workspace.id === candidate)) return candidate;
  return workspaces[0]?.id ?? "personal";
}

export async function assertManagedHomeChangeAllowed(nextHomePath: string): Promise<void> {
  const currentHomePath = getSettings().projects.homePath;
  if (path.resolve(currentHomePath) === path.resolve(nextHomePath)) return;
  for (const project of await listProjects()) {
    if ((await listTasks(project.id)).some((task) => task.worktreePath && !task.worktreeBranch)) {
      throw new TaskWorkspaceError("Archive or delete board cards before changing the Joint Bob home folder");
    }
  }
}

export async function mappedPathInsideHome(candidate: string): Promise<string> {
  const homeDirectory = await realpath(os.homedir());
  const resolved = path.resolve(candidate);
  let existing = resolved;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  requirePathInsideHome(existing, homeDirectory);
  return resolved;
}

export async function mapProjectFromPeer(peer: ClusterPeer, inventory: PeerInventory, entry: PeerInventory["projects"][number], requestedPath: string): Promise<ProjectRecord> {
  const remoteProject = entry.project;
  const localPath = await mappedPathInsideHome(requestedPath);
  if (remoteProject.syncFolderId) {
    if (inventory.syncDeviceId) await ensureSyncthingDevice(inventory.syncDeviceId, inventory.node.name);
    await ensureSyncthingFolder(remoteProject.syncFolderId, remoteProject.name, localPath, inventory.syncDeviceId);
    const localDeviceId = await syncthingDeviceId();
    if (localDeviceId) {
      const shareResponse = await fetch(`${peer.url}/api/cluster/sync/share`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: remoteProject.syncFolderId, deviceId: localDeviceId, deviceName: (await getClusterNode()).name }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!shareResponse.ok) throw new Error(`Peer Syncthing share failed: ${shareResponse.status}`);
    }
  }
  const project = await importProject({ ...remoteProject, type: await localWorkspaceId(remoteProject.type) }, localPath, inventory.node.id);
  await registerProjectAliases(project.id, [remoteProject.id, ...(entry.aliases ?? [])]);
  sessionWatcher.ensureProject(project);
  return project;
}
