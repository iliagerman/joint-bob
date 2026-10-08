import { listProjectWorktrees } from "../project-worktrees.js";
import { lstat, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { listConversationRecords } from "../conversation-records.js";
import { getHarness, getHarnessRuntime, harnessForSessionPath } from "../harnesses.js";
import { resolveLocalSessionPath } from "../session-paths.js";
import { getSettings, remoteTerminalAllowed, remoteTerminalSettings } from "../settings.js";
import { canonicalProjectId, getProject, listProjects, listWorkspaces } from "../store.js";
import { assertSyncthingFolderReady, syncthingFolderStatuses } from "../syncthing.js";
import { assertTaskWorkspaceReady, TaskWorkspaceError, taskWorkspaceKey, projectTicketSyncFolderId, TICKET_WORKSPACE_FOLDER_LABEL } from "../task-workspaces.js";
import { listTasks } from "../tasks.js";
import { validateTaskRepository } from "../worktrees.js";
import { runtimeFetch } from "./runtime-peers.js";
import { recordSignedPeerSeen } from "../cluster-peer-endpoints.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { mayShareProject } from "./sharing-files.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { assertSharedTranscriptReady } from "./shared-transcripts.js";
async function clusterPeerMayAccessProject(machineNodeId, projectId) {
  const id = await canonicalProjectId(projectId);
  return Boolean(id && mayShareProject(await clusterV2Database(), (await getClusterNode()).id, machineNodeId, id));
}
async function peerMayOpenTerminal(machineNodeId) {
  const local = await getClusterNode();
  if (machineNodeId === local.id) return true;
  return remoteTerminalAllowed(remoteTerminalSettings(), isTrustedTwin(await clusterV2Database(), local.id, machineNodeId));
}
function publicClusterPeer(peer) {
  return { ...peer, online: Boolean(peer.lastSeenAt && Date.now() - Date.parse(peer.lastSeenAt) <= 9e4) };
}
async function runtimeAvailable(engine) {
  return (await getHarnessRuntime(engine)).readiness(process.cwd());
}
async function abortPeerTaskHandoff(peer, handoffId) {
  try {
    const response = await runtimeFetch(`${peer.url}/api/cluster/tasks/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(3e4) });
    if (response.ok) return true;
    console.warn(`Handoff abort failed: ${response.status}`);
  } catch (error) {
    console.warn("Handoff abort request failed", error);
  }
  return false;
}
async function assertTaskSessionReady(projectId, task, syncStatusChecked = false) {
  const sessionPath = task.sessionPath;
  const session = resolveLocalSessionPath(sessionPath);
  const adapter = getHarness(session.engine);
  if (!adapter.paths.transcriptFile) throw new Error(`${adapter.label} conversation is not synchronized on this node`);
  try {
    if (!syncStatusChecked) {
      await assertSharedTranscriptReady(projectId, sessionPath, task.currentNodeId);
    }
    const info = await lstat(adapter.paths.transcriptFile(session.path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Conversation is not a regular file");
  } catch {
    throw new Error(`${adapter.label} conversation is not synchronized on this node`);
  }
}
async function assertTaskFilesReady(project, task, syncStatusChecked = false) {
  if (task.worktreePath && !task.worktreeBranch) {
    if (!syncStatusChecked) await assertSyncthingFolderReady(projectTicketSyncFolderId(project.id));
    await assertTaskWorkspaceReady(taskWorkspaceKey(task.worktreePath, task.id), task.id);
  } else if (project.syncFolderId && !syncStatusChecked) await assertSyncthingFolderReady(project.syncFolderId);
  if (task.worktreeBranch) await validateTaskRepository(project.path);
  if (task.sessionPath) await assertTaskSessionReady(project.id, task, syncStatusChecked);
}
function taskConversationIdentity(task) {
  if (!task.sessionPath) return null;
  const adapter = harnessForSessionPath(task.sessionPath);
  const sessionId = adapter.paths.sessionId(task.sessionPath);
  if (!sessionId) throw new Error("Task conversation path has no transcript identity");
  return { engine: adapter.id, sessionId };
}
function doneTaskOwnsConversation(task, engine, sessionId) {
  if (task.status !== "done" || !task.sessionPath || task.sessionPath === "watch") return false;
  const identity = taskConversationIdentity(task);
  return identity?.engine === engine && identity.sessionId === sessionId;
}
async function conversationBelongsToDoneTask(projectId, engine, sessionId) {
  const tasks = await listTasks(projectId);
  const owns = (target) => tasks.some((task) => doneTaskOwnsConversation(task, target.engine, target.sessionId));
  if (owns({ engine, sessionId })) return true;
  const records = await listConversationRecords(projectId);
  const record = records.find((candidate) => candidate.sessionId === sessionId || candidate.conversationId === sessionId);
  if (!record) return false;
  const conversationId = record.conversationId ?? record.sessionId;
  return records.filter((candidate) => (candidate.conversationId ?? candidate.sessionId) === conversationId).some(owns);
}
const peerTaskEligibilitySchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  syncStatuses: z.array(z.object({ label: z.string(), state: z.enum(["synced", "syncing", "paused", "error", "unavailable"]), remainingFiles: z.number(), remainingBytes: z.number(), message: z.string().optional() })).optional().default([]),
  waitingForSync: z.boolean().optional().default(false)
});
async function taskSyncStatuses(project, task) {
  const targets = [];
  if (task.worktreePath && !task.worktreeBranch) targets.push({ id: projectTicketSyncFolderId(project.id), label: TICKET_WORKSPACE_FOLDER_LABEL });
  else if (project.syncFolderId) targets.push({ id: project.syncFolderId, label: project.name });
  const unique = targets.filter((target, index) => targets.findIndex(({ id }) => id === target.id) === index);
  const statuses = await syncthingFolderStatuses(unique.map((target) => target.id));
  const result = unique.map((target) => ({ label: target.label, ...statuses[target.id] }));
  if (task.sessionPath) {
    try {
      await assertSharedTranscriptReady(project.id, task.sessionPath, task.currentNodeId);
      result.push({ label: "Conversation transcript", state: "synced", remainingFiles: 0, remainingBytes: 0 });
    } catch (error) {
      result.push({ label: "Conversation transcript", state: "error", remainingFiles: 1, remainingBytes: 0, message: error instanceof Error ? error.message : "Transcript unavailable" });
    }
  }
  return result;
}
async function taskHandoffEligibility(projectId, task, requiresRuntime = true) {
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
  const retryableSync = syncPending && syncStatuses.every((status) => ["synced", "syncing", "error"].includes(status.state));
  if (syncPending) reasons.push("Ticket files are not synchronized on this node");
  try {
    await assertTaskFilesReady(project, task, true);
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : "Ticket files are not ready on this node");
  }
  return { reasons, syncStatuses, waitingForSync: retryableSync && permanentReasonCount === 0 };
}
async function peerTaskEligibilityEntry(peer, projectId, task, source = false) {
  const node = publicClusterPeer(peer);
  try {
    const remote = await runtimeFetch(`${peer.url}/api/cluster/tasks/eligibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, task, source }),
      signal: AbortSignal.timeout(3e3)
    });
    if (!remote.ok) throw new Error(`Peer returned ${remote.status}`);
    const result = peerTaskEligibilitySchema.parse(await remote.json());
    recordSignedPeerSeen(await clusterV2Database(), peer.id);
    return { node: { ...node, online: true }, ...result };
  } catch (error) {
    return { node: { ...node, online: false }, eligible: false, reasons: [error instanceof Error ? `Peer unreachable: ${error.message}` : "Peer unreachable"], syncStatuses: [], waitingForSync: false };
  }
}
function requirePathInsideHome(candidate, homeDirectory) {
  const relative = path.relative(homeDirectory, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Folder must be inside this node's home directory");
}
async function localWorkspaceId(candidate) {
  const workspaces = await listWorkspaces();
  if (candidate && workspaces.some((workspace) => workspace.id === candidate)) return candidate;
  return workspaces[0]?.id ?? "personal";
}
async function assertManagedHomeChangeAllowed(nextHomePath) {
  const currentHomePath = getSettings().projects.homePath;
  if (path.resolve(currentHomePath) === path.resolve(nextHomePath)) return;
  for (const project of await listProjects()) {
    if ((await listTasks(project.id)).some((task) => task.worktreePath && !task.worktreeBranch)) {
      throw new TaskWorkspaceError("Archive or delete board cards before changing the Joint Bob home folder");
    }
    if ((await listProjectWorktrees(project.id)).length) {
      throw new TaskWorkspaceError("Merge and delete worktrees before changing the Joint Bob home folder");
    }
  }
}
async function mappedPathInsideHome(candidate) {
  const homeDirectory = await realpath(os.homedir());
  const resolved = path.resolve(candidate);
  let existing = resolved;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  requirePathInsideHome(existing, homeDirectory);
  return resolved;
}
export {
  abortPeerTaskHandoff,
  assertManagedHomeChangeAllowed,
  assertTaskFilesReady,
  clusterPeerMayAccessProject,
  conversationBelongsToDoneTask,
  doneTaskOwnsConversation,
  mappedPathInsideHome,
  peerMayOpenTerminal,
  peerTaskEligibilityEntry,
  peerTaskEligibilitySchema,
  publicClusterPeer,
  requirePathInsideHome,
  taskConversationIdentity,
  taskHandoffEligibility
};
