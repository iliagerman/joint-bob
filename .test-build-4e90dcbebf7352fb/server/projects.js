import path from "node:path";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { managedProjectRelocationPath } from "../managed-home.js";
import { projectNameOverrides } from "../names.js";
import { ProjectDirectoryImportError, relocateProjectDirectory } from "../project-directory-import.js";
import { getProjectLock, projectLocks } from "../project-locks.js";
import { getSettings } from "../settings.js";
import { listProjects, updateProjectWorkspaceAndPath } from "../store.js";
import { ensureSyncthingFolder, syncthingFolderStatuses } from "../syncthing.js";
import { listTasks } from "../tasks.js";
import { sessionWatcher } from "./chat.js";
import { harnessSessionBusy, harnessSessions } from "./harness-sessions.js";
import { harnessTaskRuns, projectHasMergeReservation } from "./task-runs.js";
import { projectUsage } from "../usage-ledger.js";
function unavailableProjectStatus(message = "No Syncthing folder is configured") {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}
async function projectsWithSharedNames(includeSyncStatusOrOptions) {
  const options = typeof includeSyncStatusOrOptions === "boolean" ? { includeSyncStatus: includeSyncStatusOrOptions } : includeSyncStatusOrOptions ?? {};
  const { includeSyncStatus = true, filterForHomeNodeId } = options;
  const [projects, overrides, locks, local] = await Promise.all([listProjects(), projectNameOverrides(), projectLocks(), getClusterNode()]);
  const statuses = includeSyncStatus ? await syncthingFolderStatuses(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : [])) : {};
  let visibleProjects = projects;
  if (filterForHomeNodeId) {
    const homeNodeClusters = await getHomeNodeClusters(filterForHomeNodeId);
    visibleProjects = projects.filter((project) => {
      if (!project.clusterIds || project.clusterIds.length === 0) return false;
      return project.clusterIds.some((clusterId) => homeNodeClusters.has(clusterId));
    });
  }
  return visibleProjects.map((project) => {
    const lock = locks[project.id];
    return {
      ...project,
      name: overrides[project.id] ?? project.name,
      syncStatus: project.syncFolderId ? statuses[project.syncFolderId] ?? unavailableProjectStatus("Loading sync status") : unavailableProjectStatus(),
      usage: projectUsage(project.id),
      ...lock ? { lock, lockedElsewhere: lock.nodeId !== local.id } : {}
    };
  });
}
async function getHomeNodeClusters(nodeId) {
  const db = await clusterV2Database();
  const rows = db.prepare("SELECT cluster_id FROM sharing_memberships WHERE node_id = ?").all(nodeId);
  return new Set(rows.map((row) => row.cluster_id));
}
class ProjectLockedError extends Error {
}
async function assertProjectEditable(project) {
  const lock = await getProjectLock(project.id);
  if (!lock) return;
  const local = await getClusterNode();
  if (lock.nodeId === local.id) return;
  throw new ProjectLockedError(`${project.name} is locked by ${lock.nodeName}. Unlock it to edit from this node.`);
}
async function projectView(project) {
  const views = await projectsWithSharedNames();
  return views.find((view) => view.id === project.id);
}
async function assertProjectRelocationIdle(project) {
  if ((await listTasks(project.id)).some((task) => task.executionState === "running")) {
    throw new ProjectDirectoryImportError("Wait for this project's task to finish before changing its type");
  }
  for (const session of harnessSessions.values()) {
    if (session.projectId === project.id && (session.clients.size || harnessSessionBusy(session))) {
      throw new ProjectDirectoryImportError("Close or finish this project's conversations before changing its type");
    }
  }
  if ([...harnessTaskRuns.values()].some((run) => run.projectId === project.id)) {
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
async function relocateProjectWorkspace(project, nextWorkspaceId) {
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
    const rollbackFailures = [];
    try {
      await relocateProjectDirectory(destination, project.path, project.macPath);
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError);
    }
    if (syncthingAttempted && project.syncFolderId) {
      try {
        await ensureSyncthingFolder(project.syncFolderId, project.name, project.path);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length) throw new AggregateError([error, ...rollbackFailures], "Project relocation rollback failed");
    throw error;
  }
}
const workspaceSchema = z.object({
  id: z.string().trim().max(40).optional(),
  label: z.string().trim().min(1).max(40)
}).strict();
export {
  ProjectLockedError,
  assertProjectEditable,
  projectView,
  projectsWithSharedNames,
  relocateProjectWorkspace,
  workspaceSchema
};
