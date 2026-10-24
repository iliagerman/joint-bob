import { getProject } from "../store.js";
import { assertSyncthingFolderReady, listSyncthingFolders, rescanSyncthingFolder, syncthingFolderStatuses } from "../syncthing.js";
import { projectTicketSyncFolderId } from "../task-workspaces.js";
import type { ProjectRecord, ProjectSyncStatus } from "../types.js";
import { projectWorktreeSyncFolderId } from "../worktree-filters.js";

/* The one place callers ask about a project's files on other machines. Syncthing is the only
   backend for now; the built-in engine joins later and is chosen per project (FILE-SYNC-PLAN.md §8). */

export type ProjectShareKind = "project" | "tickets";

export class ProjectNotSynchronizedError extends Error {
  constructor() { super("Project is not synchronized"); }
}

export function unavailableProjectStatus(message = "No Syncthing folder is configured"): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

function shareFolderId(project: ProjectRecord, kind: ProjectShareKind): string | undefined {
  return kind === "tickets" ? projectTicketSyncFolderId(project.id) : project.syncFolderId;
}

/** Keyed by project id. */
export async function projectSyncStatuses(projects: ProjectRecord[]): Promise<Record<string, ProjectSyncStatus>> {
  const statuses = await syncthingFolderStatuses(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []));
  return Object.fromEntries(projects.map((project) => [project.id, project.syncFolderId
    ? statuses[project.syncFolderId] ?? unavailableProjectStatus("Loading sync status")
    : unavailableProjectStatus()]));
}

/** Asks for an immediate scan of the project and of its ticket and worktree folders. */
export async function rescanProjectFiles(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  if (!project.syncFolderId) throw new ProjectNotSynchronizedError();
  const configured = new Set((await listSyncthingFolders()).map((folder) => folder.id));
  // The project folder is always asked, so a missing folder or daemon still reports its error.
  const optional = [projectTicketSyncFolderId(project.id), projectWorktreeSyncFolderId(project.id)].filter((id) => configured.has(id));
  await Promise.all([project.syncFolderId, ...optional].map(rescanSyncthingFolder));
}

/** Read-only: a handoff check must not rewrite ignore rules (the sync check keeps project, ticket and worktree rules current). */
export async function assertProjectFilesReady(project: ProjectRecord, kind: ProjectShareKind): Promise<void> {
  const folderId = shareFolderId(project, kind);
  if (folderId) await assertSyncthingFolderReady(folderId, false);
}

/** This node's view of each share a ticket needs; a project without a folder has nothing to wait for. */
export async function taskShareStatuses(project: ProjectRecord, targets: Array<{ kind: ProjectShareKind; label: string }>): Promise<Array<ProjectSyncStatus & { label: string }>> {
  const resolved = targets.flatMap((target) => {
    const folderId = shareFolderId(project, target.kind);
    return folderId ? [{ folderId, label: target.label }] : [];
  });
  const unique = resolved.filter((target, index) => resolved.findIndex(({ folderId }) => folderId === target.folderId) === index);
  const statuses = await syncthingFolderStatuses(unique.map((target) => target.folderId));
  return unique.map((target) => ({ label: target.label, ...statuses[target.folderId] }));
}

/** Syncthing's watcher waits before it notices a change; a worktree write asks for an immediate scan. */
export function worktreeFilesChanged(projectId: string): void {
  const folderId = projectWorktreeSyncFolderId(projectId);
  void listSyncthingFolders()
    .then((folders) => folders.some((folder) => folder.id === folderId) ? rescanSyncthingFolder(folderId) : undefined)
    .catch((error) => console.warn("Worktree folder rescan failed", error));
}

/** Syncthing has no per-path answer; the built-in engine answers from its need list. */
export async function worktreeHasPendingFiles(_projectId: string, _worktreeId: string): Promise<boolean> {
  return false;
}
