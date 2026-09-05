import type { Response } from "express";
import { z } from "zod";
import { type ClusterPeer, getClusterNode, getClusterPeer } from "../cluster.js";
import { getProject } from "../store.js";
import { removeTaskWorkspace, TaskWorkspaceError, taskWorkspaceKey } from "../task-workspaces.js";
import { abortOutgoingTaskHandoff, acknowledgeOutgoingTaskHandoff, assertTaskCanBeDeleted, beginOutgoingTaskHandoff, completeTaskHandoff, deleteTask, getTaskHandoff, listTasks, listUnfinishedOutgoingTaskHandoffs, markOutgoingTaskHandoff, type TaskHandoffRecord, unmergedWorkspaceBlocksClose, updateTask } from "../tasks.js";
import type { ProjectRecord, TaskRecord } from "../types.js";
import { assertTaskWorktreeTransferable, exportTaskBranchBundle, mergeTaskWorktree, TaskWorktreeError } from "../worktrees.js";
import { abortPeerTaskHandoff, assertTaskFilesReady, peerTaskEligibilitySchema, publicClusterPeer } from "./cluster-helpers.js";
import { broadcastToProject } from "./realtime.js";
import { taskHandoffDeletionSchema } from "./schemas.js";
import { taskHandoffContext, taskRunActive } from "./task-runs.js";

export async function ownerPeer(task: TaskRecord, localId: string): Promise<ClusterPeer | undefined> {
  return task.currentNodeId === localId ? undefined : getClusterPeer(task.currentNodeId);
}

export function assertTaskNotHandoffPending(task: TaskRecord): void {
  if (task.executionState === "handoff_pending") throw new TaskWorktreeError("Task handoff is awaiting destination commit");
}

export async function mergeOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord> {
  assertTaskNotHandoffPending(task);
  if (task.status !== "done") throw new TaskWorktreeError("Move the ticket to Done before merging");
  if (taskRunActive(task.id)) throw new TaskWorktreeError("Wait for the ticket agent to finish before merging");
  if (!task.worktreePath || !task.worktreeBranch) throw new TaskWorktreeError("This ticket has no isolated worktree");
  if (task.mergedAt) throw new TaskWorktreeError("Ticket is already merged");
  await mergeTaskWorktree(project.path, task.worktreePath, task.worktreeBranch, task.title);
  const merged = await updateTask(project.id, task.id, { mergedAt: new Date().toISOString() });
  broadcastToProject(project.id, { type: "tasksChanged" });
  return merged;
}

function assertTaskWorkspaceCanClose(task: TaskRecord): void {
  assertTaskNotHandoffPending(task);
  if (taskRunActive(task.id)) throw new TaskWorkspaceError("Wait for task agent to finish before closing its workspace");
  assertTaskCanBeDeleted(task);
}

export async function archiveOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<TaskRecord> {
  assertTaskWorkspaceCanClose(task);
  if (task.worktreePath && !task.worktreeBranch && unmergedWorkspaceBlocksClose(task)) throw new TaskWorkspaceError("Merge the ticket workspace (or discard it) before archiving");
  const synchronizedWorkspace = !task.worktreeBranch;
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  const archived = await updateTask(project.id, task.id, {
    status: "done",
    ...(synchronizedWorkspace ? { worktreePath: null, attachments: [] } : {}),
  });
  if (synchronizedWorkspace) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  return archived;
}

export async function deleteOwnedTask(project: ProjectRecord, task: TaskRecord): Promise<void> {
  assertTaskWorkspaceCanClose(task);
  if (task.worktreePath && !task.worktreeBranch && unmergedWorkspaceBlocksClose(task)) throw new TaskWorkspaceError("Merge the ticket workspace (or discard it) before deleting");
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  await deleteTask(project.id, task.id);
  if (!task.worktreeBranch) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
}

type RemoteHandoffStatus = "pending" | "prepared" | "committed" | "aborted" | "missing";

async function remoteHandoffStatus(record: TaskHandoffRecord, peer: ClusterPeer): Promise<RemoteHandoffStatus> {
  const response = await fetch(`${peer.url}/api/cluster/tasks/status`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`Peer handoff status failed: ${response.status}`);
  const remote = z.object({ status: z.enum(["pending", "prepared", "committed", "aborted"]), taskId: z.string(), projectId: z.string(), sourceNodeId: z.string().uuid(), destinationNodeId: z.string().uuid() }).parse(await response.json());
  if (remote.taskId !== record.taskId || remote.projectId !== record.projectId || remote.sourceNodeId !== record.sourceNodeId || remote.destinationNodeId !== record.destinationNodeId) throw new Error("Peer returned an invalid handoff status");
  return remote.status;
}

async function settlePeerTaskHandoff(peer: ClusterPeer, handoffId: string): Promise<boolean> {
  try {
    const response = await fetch(`${peer.url}/api/cluster/tasks/settle`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(30_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function commitOutgoingTaskHandoff(record: TaskHandoffRecord): Promise<TaskRecord | null> {
  const peer = await getClusterPeer(record.destinationNodeId);
  if (!peer) throw new Error("Peer not found");
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  await assertTaskFilesReady(project, record.task);
  const response = await fetch(`${peer.url}/api/cluster/tasks/commit`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Peer handoff commit failed: ${response.status}`);
  const committed = z.object({ task: z.object({ id: z.string(), currentNodeId: z.string().uuid(), executionState: z.literal("idle"), sessionPath: z.string().nullable() }).passthrough().nullable(), deleted: taskHandoffDeletionSchema.optional() }).parse(await response.json());
  if (committed.task === null) {
    if (!committed.deleted) throw new Error("Peer returned a deleted task without a deletion version");
    const task = await completeTaskHandoff(record.handoffId, record.projectId, record.taskId, record.sourceNodeId, record.destinationNodeId, committed.deleted);
    await markOutgoingTaskHandoff(record.handoffId, "committed");
    if (await settlePeerTaskHandoff(peer, record.handoffId)) await acknowledgeOutgoingTaskHandoff(record.handoffId);
    broadcastToProject(record.projectId, { type: "tasksChanged" });
    broadcastToProject(record.projectId, { type: "sessionsChanged" });
    return task;
  }
  if (committed.task.id !== record.taskId || committed.task.currentNodeId !== record.destinationNodeId) throw new Error("Peer returned an invalid committed task");
  await completeTaskHandoff(record.handoffId, record.projectId, record.taskId, record.sourceNodeId, record.destinationNodeId);
  await markOutgoingTaskHandoff(record.handoffId, "committed");
  if (await settlePeerTaskHandoff(peer, record.handoffId)) await acknowledgeOutgoingTaskHandoff(record.handoffId);
  broadcastToProject(record.projectId, { type: "tasksChanged" });
  broadcastToProject(record.projectId, { type: "sessionsChanged" });
  return committed.task as unknown as TaskRecord;
}

async function resumeRemotePendingHandoff(record: TaskHandoffRecord, peer: ClusterPeer): Promise<TaskRecord | null | undefined> {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  const task = record.task;
  let bundle: Awaited<ReturnType<typeof exportTaskBranchBundle>> | null = null;
  if (task.worktreeBranch) {
    if (!task.worktreePath) throw new TaskWorktreeError("Task worktree metadata is incomplete.");
    await assertTaskWorktreeTransferable(project.path, task.worktreePath, task.worktreeBranch);
    bundle = await exportTaskBranchBundle(project.path, task.worktreePath, task.worktreeBranch);
  }
  const handoffContext = await taskHandoffContext(project, task);
  await assertTaskFilesReady(project, task);
  const response = await fetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: record.projectId, task, handoffId: record.handoffId, handoffContext, handoffVersion: record.createdAt, bundle }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) return undefined;
  await markOutgoingTaskHandoff(record.handoffId, "prepared");
  return commitOutgoingTaskHandoff(record);
}

export async function reconcileOutgoingTaskHandoff(record: TaskHandoffRecord, peer: ClusterPeer): Promise<TaskRecord | null | undefined> {
  if (record.status === "pending") {
    const remoteStatus = await remoteHandoffStatus(record, peer);
    if (remoteStatus === "pending") return resumeRemotePendingHandoff(record, peer);
    if (["prepared", "committed"].includes(remoteStatus)) {
      await markOutgoingTaskHandoff(record.handoffId, "prepared");
      return commitOutgoingTaskHandoff(record);
    }
    if (remoteStatus === "aborted") {
      await abortOutgoingTaskHandoff(record.handoffId);
      return undefined;
    }
    if (remoteStatus === "missing" && await abortPeerTaskHandoff(peer, record.handoffId)) {
      await abortOutgoingTaskHandoff(record.handoffId);
      return undefined;
    }
    return undefined;
  }
  if (record.status === "committed") {
    if (!(await settlePeerTaskHandoff(peer, record.handoffId))) return undefined;
    await acknowledgeOutgoingTaskHandoff(record.handoffId);
    const task = (await listTasks(record.projectId)).find((candidate) => candidate.id === record.taskId);
    return task ?? null;
  }
  return commitOutgoingTaskHandoff(record);
}

async function pendingHandoffResponse(task: TaskRecord, peer: ClusterPeer): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: 202, body: { task, destination: publicClusterPeer(peer), handoffPendingCommit: true, message: "Handoff prepared; ownership remains on this node until destination commit is confirmed." } };
}

export async function handoffOwnedTask(project: ProjectRecord, task: TaskRecord, peerId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const local = await getClusterNode();
  if (peerId === local.id) throw new TaskWorktreeError("Task is already owned by this node");
  if (task.executionState === "handoff_pending") {
    const record = (await listUnfinishedOutgoingTaskHandoffs()).find((candidate) => candidate.projectId === project.id && candidate.taskId === task.id);
    if (!record || record.destinationNodeId !== peerId) throw new TaskWorktreeError("Task handoff is awaiting destination commit");
    const peer = await getClusterPeer(peerId);
    if (!peer) throw new Error("Peer not found");
    try {
      const reconciled = await reconcileOutgoingTaskHandoff(record, peer);
      if (reconciled !== undefined) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer) } };
      return pendingHandoffResponse(task, peer);
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  if (taskRunActive(task.id) || (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now())) throw new TaskWorktreeError("Task has an active run or lease");
  const peer = await getClusterPeer(peerId);
  if (!peer) throw new Error("Peer not found");
  const eligibility = await fetch(`${peer.url}/api/cluster/tasks/eligibility`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task }), signal: AbortSignal.timeout(3_000) });
  if (!eligibility.ok) throw new Error(`Peer eligibility check failed: ${eligibility.status}`);
  const eligibilityResult = peerTaskEligibilitySchema.parse(await eligibility.json());
  if (!eligibilityResult.eligible) throw new TaskWorktreeError(eligibilityResult.reasons.join("; "));
  const previous = (await listUnfinishedOutgoingTaskHandoffs()).find((candidate) => candidate.projectId === project.id && candidate.taskId === task.id && candidate.destinationNodeId === peer.id);
  await assertTaskFilesReady(project, task);
  let outgoing = await beginOutgoingTaskHandoff(project.id, task, local.id, peer.id);
  let outgoingWasNew = !previous;
  if (previous?.status === "pending") {
    try {
      const reconciled = await reconcileOutgoingTaskHandoff(outgoing, peer);
      if (reconciled !== undefined) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer) } };
      if ((await getTaskHandoff(outgoing.handoffId))?.status !== "aborted") return pendingHandoffResponse(task, peer);
      outgoing = await beginOutgoingTaskHandoff(project.id, task, local.id, peer.id);
      outgoingWasNew = true;
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  if (previous?.status === "prepared") {
    try { return { status: 200, body: { task: await commitOutgoingTaskHandoff(outgoing), destination: publicClusterPeer(peer) } }; }
    catch { return pendingHandoffResponse(task, peer); }
  }
  let bundle: Awaited<ReturnType<typeof exportTaskBranchBundle>> | null;
  let handoffContext: string;
  try {
    if (task.worktreeBranch) {
      if (!task.worktreePath) throw new TaskWorktreeError("Task worktree metadata is incomplete.");
      await assertTaskWorktreeTransferable(project.path, task.worktreePath, task.worktreeBranch);
    }
    bundle = task.worktreePath && task.worktreeBranch ? await exportTaskBranchBundle(project.path, task.worktreePath, task.worktreeBranch) : null;
    handoffContext = await taskHandoffContext(project, task);
  } catch (error) {
    if (outgoingWasNew) await abortOutgoingTaskHandoff(outgoing.handoffId);
    throw error;
  }
  try {
    await assertTaskFilesReady(project, task);
    const prepared = await fetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task: outgoing.task, handoffId: outgoing.handoffId, handoffContext, handoffVersion: outgoing.createdAt, bundle }), signal: AbortSignal.timeout(30_000) });
    if (!prepared.ok) return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer);
  } catch {
    return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer);
  }
  try { await markOutgoingTaskHandoff(outgoing.handoffId, "prepared"); }
  catch { return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer); }
  try { return { status: 200, body: { task: await commitOutgoingTaskHandoff(await getTaskHandoff(outgoing.handoffId) as TaskHandoffRecord), destination: publicClusterPeer(peer) } }; }
  catch { return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id) as TaskRecord, peer); }
}

export function mirrorTaskResponse(response: Response, routed: globalThis.Response): Promise<void> {
  return routed.text().then((body) => {
    const contentType = routed.headers.get("content-type");
    if (contentType) response.setHeader("Content-Type", contentType);
    response.status(routed.status).send(body);
  });
}
