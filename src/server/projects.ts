import path from "node:path";
import { z } from "zod";
import { getClusterNode, listClusterPeers } from "../cluster.js";
import { managedProjectRelocationPath } from "../managed-home.js";
import { projectNameOverrides } from "../names.js";
import { ProjectDirectoryImportError, relocateProjectDirectory } from "../project-directory-import.js";
import { getProjectLock, projectLocks } from "../project-locks.js";
import { getSettings } from "../settings.js";
import { listProjects, updateProjectWorkspaceAndPath } from "../store.js";
import { ensureSyncthingFolder, syncthingFolderStatuses } from "../syncthing.js";
import { listTasks } from "../tasks.js";
import type { ProjectRecord, ProjectSyncStatus, ProjectView } from "../types.js";
import { sessionWatcher } from "./chat.js";
import { claudeClients, sharedSessions } from "./state.js";
import { claudeTaskRuns, piTaskRuns, projectHasMergeReservation } from "./task-runs.js";

function unavailableProjectStatus(message = "No Syncthing folder is configured"): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

export async function projectsWithSharedNames(includeSyncStatus = true): Promise<ProjectView[]> {
  const [projects, overrides, locks, local] = await Promise.all([listProjects(), projectNameOverrides(), projectLocks(), getClusterNode()]);
  const statuses = includeSyncStatus
    ? await syncthingFolderStatuses(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))
    : {};
  return projects.map((project) => {
    const lock = locks[project.id];
    return {
      ...project,
      name: overrides[project.id] ?? project.name,
      syncStatus: project.syncFolderId
        ? statuses[project.syncFolderId] ?? unavailableProjectStatus("Loading sync status")
        : unavailableProjectStatus(),
      ...(lock ? { lock, lockedElsewhere: lock.nodeId !== local.id } : {}),
    };
  });
}

/** A project locked to a peer node must not be edited here. This prevents accidental parallel
    edits across nodes; any node may clear the lock, so it is not a security boundary. */
export class ProjectLockedError extends Error {}

export async function assertProjectEditable(project: ProjectRecord): Promise<void> {
  const lock = await getProjectLock(project.id);
  if (!lock) return;
  const local = await getClusterNode();
  if (lock.nodeId === local.id) return;
  throw new ProjectLockedError(`${project.name} is locked by ${lock.nodeName}. Unlock it to edit from this node.`);
}

export async function projectView(project: ProjectRecord): Promise<ProjectView> {
  const views = await projectsWithSharedNames();
  return views.find((view) => view.id === project.id)!;
}

async function assertProjectRelocationIdle(project: ProjectRecord): Promise<void> {
  if ((await listTasks(project.id)).some((task) => task.executionState === "running")) {
    throw new ProjectDirectoryImportError("Wait for this project's task to finish before changing its type");
  }
  for (const session of new Set(sharedSessions.values())) {
    if (session.projectId === project.id && (session.clients.size || session.handle.session.isStreaming)) {
      throw new ProjectDirectoryImportError("Close or finish this project's Pi conversations before changing its type");
    }
  }
  if ([...claudeClients.values()].some((client) => client.project.id === project.id)) {
    throw new ProjectDirectoryImportError("Close this project's Claude conversations before changing its type");
  }
  if ([...piTaskRuns.values()].some((run) => run.projectId === project.id) || [...claudeTaskRuns.values()].some((run) => run.projectId === project.id)) {
    throw new ProjectDirectoryImportError("Wait for this project's task run to finish before changing its workspace");
  }
  if ((await listTasks(project.id)).some((task) => task.mergeTx === "open")) {
    throw new ProjectDirectoryImportError("Wait for this project's ticket merge transaction to finish before changing its workspace");
  }
  if (projectHasMergeReservation(project.id)) {
    throw new ProjectDirectoryImportError("A ticket merge reservation is active for this project");
  }
  if ((await listTasks(project.id)).some((task) => (task.mergeState === "conflicts" || task.mergeState === "resolved") && task.worktreePath)) {
    throw new ProjectDirectoryImportError("Resolve this project's ticket merges before changing its workspace");
  }
}

export async function relocateProjectWorkspace(project: ProjectRecord, nextWorkspaceId: string): Promise<ProjectRecord> {
  const destination = managedProjectRelocationPath(getSettings().projects.homePath, project.type ?? "personal", project.path, nextWorkspaceId);
  if (!destination || path.resolve(destination) === path.resolve(project.path)) return updateProjectWorkspaceAndPath(project.id, nextWorkspaceId, project.path);
  await assertProjectRelocationIdle(project);
  let moved = false;
  let syncthingAttempted = false;
  try {
    await relocateProjectDirectory(project.path, destination, project.macPath);
    moved = true;
    if (project.syncFolderId) {
      syncthingAttempted = true;
      await ensureSyncthingFolder(project.syncFolderId, project.name, destination);
    }
    const updated = await updateProjectWorkspaceAndPath(project.id, nextWorkspaceId, destination);
    sessionWatcher.ensureProject(updated);
    return updated;
  } catch (error) {
    if (!moved) throw error;
    const rollbackFailures: unknown[] = [];
    try { await relocateProjectDirectory(destination, project.path, project.macPath); }
    catch (rollbackError) { rollbackFailures.push(rollbackError); }
    if (syncthingAttempted && project.syncFolderId) {
      try { await ensureSyncthingFolder(project.syncFolderId, project.name, project.path); }
      catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], "Project relocation rollback failed");
    throw error;
  }
}

export async function notifyPeersOfProjectInventory(): Promise<void> {
  const [local, peers] = await Promise.all([getClusterNode(), listClusterPeers()]);
  await Promise.all(peers.map(async (peer) => {
    try {
      const response = await fetch(`${peer.url}/api/cluster/projects/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ peerId: local.id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Peer returned ${response.status}`);
    } catch (error) {
      console.warn(`Project inventory notification to ${peer.id} failed`, error);
    }
  }));
}

export const workspaceSchema = z.object({
  id: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(40),
}).strict();
