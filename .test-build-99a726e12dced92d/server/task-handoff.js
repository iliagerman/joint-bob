import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, runtimeFetch } from "./runtime-peers.js";
import { getProject } from "../store.js";
import { removeTaskWorkspace, TaskWorkspaceError, taskWorkspaceKey } from "../task-workspaces.js";
import { abortOutgoingTaskHandoff, acknowledgeOutgoingTaskHandoff, assertTaskCanBeDeleted, beginOutgoingTaskHandoff, completeTaskHandoff, deleteTask, getTaskHandoff, listTasks, listUnfinishedOutgoingTaskHandoffs, markOutgoingTaskHandoff, unmergedWorkspaceBlocksClose, updateTask } from "../tasks.js";
import { assertTaskWorktreeTransferable, exportTaskBranchBundle, mergeTaskWorktree, TaskWorktreeError } from "../worktrees.js";
import { abortPeerTaskHandoff, assertTaskFilesReady, peerTaskEligibilitySchema, publicClusterPeer } from "./cluster-helpers.js";
import { broadcastToProject } from "./realtime.js";
import { taskHandoffDeletionSchema } from "./schemas.js";
import { taskHandoffContext, taskRunActive } from "./task-runs.js";
async function ownerPeer(task, localId) {
  return task.currentNodeId === localId ? void 0 : getRuntimePeer(task.currentNodeId);
}
function assertTaskNotHandoffPending(task) {
  if (task.executionState === "handoff_pending") throw new TaskWorktreeError("Task handoff is awaiting destination commit");
}
async function mergeOwnedTask(project, task) {
  assertTaskNotHandoffPending(task);
  if (task.status !== "done") throw new TaskWorktreeError("Move the ticket to Done before merging");
  if (taskRunActive(task.id)) throw new TaskWorktreeError("Wait for the ticket agent to finish before merging");
  if (!task.worktreePath || !task.worktreeBranch) throw new TaskWorktreeError("This ticket has no isolated worktree");
  if (task.mergedAt) throw new TaskWorktreeError("Ticket is already merged");
  await mergeTaskWorktree(project.path, task.worktreePath, task.worktreeBranch, task.title);
  const merged = await updateTask(project.id, task.id, { mergedAt: (/* @__PURE__ */ new Date()).toISOString() });
  broadcastToProject(project.id, { type: "tasksChanged" });
  return merged;
}
function assertTaskWorkspaceCanClose(task) {
  assertTaskNotHandoffPending(task);
  if (taskRunActive(task.id)) throw new TaskWorkspaceError("Wait for task agent to finish before closing its workspace");
  assertTaskCanBeDeleted(task);
}
async function archiveOwnedTask(project, task) {
  assertTaskWorkspaceCanClose(task);
  if (task.worktreePath && !task.worktreeBranch && unmergedWorkspaceBlocksClose(task)) throw new TaskWorkspaceError("Merge the ticket workspace (or discard it) before archiving");
  const synchronizedWorkspace = !task.worktreeBranch;
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  const archived = await updateTask(project.id, task.id, {
    status: "done",
    ...synchronizedWorkspace ? { worktreePath: null, attachments: [] } : {}
  });
  if (synchronizedWorkspace) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
  return archived;
}
async function deleteOwnedTask(project, task) {
  assertTaskWorkspaceCanClose(task);
  if (task.worktreePath && !task.worktreeBranch && unmergedWorkspaceBlocksClose(task)) throw new TaskWorkspaceError("Merge the ticket workspace (or discard it) before deleting");
  const workspaceKey = task.worktreePath ? taskWorkspaceKey(task.worktreePath, task.id) : project.id;
  await deleteTask(project.id, task.id);
  if (!task.worktreeBranch) await removeTaskWorkspace(workspaceKey, task.id);
  broadcastToProject(project.id, { type: "tasksChanged" });
}
async function remoteHandoffStatus(record, peer) {
  const response = await runtimeFetch(`${peer.url}/api/cluster/tasks/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(1e4) });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`Peer handoff status failed: ${response.status}`);
  const remote = z.object({ status: z.enum(["pending", "prepared", "committed", "aborted"]), taskId: z.string(), projectId: z.string(), sourceNodeId: z.string().uuid(), destinationNodeId: z.string().uuid() }).parse(await response.json());
  if (remote.taskId !== record.taskId || remote.projectId !== record.projectId || remote.sourceNodeId !== record.sourceNodeId || remote.destinationNodeId !== record.destinationNodeId) throw new Error("Peer returned an invalid handoff status");
  return remote.status;
}
async function settlePeerTaskHandoff(peer, handoffId) {
  try {
    const response = await runtimeFetch(`${peer.url}/api/cluster/tasks/settle`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handoffId }), signal: AbortSignal.timeout(3e4) });
    return response.ok;
  } catch {
    return false;
  }
}
async function commitOutgoingTaskHandoff(record) {
  const peer = await getRuntimePeer(record.destinationNodeId);
  if (!peer) throw new Error("Peer not found");
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  await assertTaskFilesReady(project, record.task);
  const response = await runtimeFetch(`${peer.url}/api/cluster/tasks/commit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: record.handoffId }), signal: AbortSignal.timeout(3e4) });
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
  return committed.task;
}
async function resumeRemotePendingHandoff(record, peer) {
  const project = await getProject(record.projectId);
  if (!project) throw new Error("Handoff project is not mapped on this node");
  const task = record.task;
  let bundle = null;
  if (task.worktreeBranch) {
    if (!task.worktreePath) throw new TaskWorktreeError("Task worktree metadata is incomplete.");
    await assertTaskWorktreeTransferable(project.path, task.worktreePath, task.worktreeBranch);
    bundle = await exportTaskBranchBundle(project.path, task.worktreePath, task.worktreeBranch);
  }
  const handoffContext = await taskHandoffContext(project, task);
  await assertTaskFilesReady(project, task);
  const response = await runtimeFetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: record.projectId, task, handoffId: record.handoffId, handoffContext, handoffVersion: record.createdAt, bundle }), signal: AbortSignal.timeout(3e4) });
  if (!response.ok) return void 0;
  await markOutgoingTaskHandoff(record.handoffId, "prepared");
  return commitOutgoingTaskHandoff(record);
}
async function reconcileOutgoingTaskHandoff(record, peer) {
  if (record.status === "pending") {
    const remoteStatus = await remoteHandoffStatus(record, peer);
    if (remoteStatus === "pending") return resumeRemotePendingHandoff(record, peer);
    if (["prepared", "committed"].includes(remoteStatus)) {
      await markOutgoingTaskHandoff(record.handoffId, "prepared");
      return commitOutgoingTaskHandoff(record);
    }
    if (remoteStatus === "aborted") {
      await abortOutgoingTaskHandoff(record.handoffId);
      return void 0;
    }
    if (remoteStatus === "missing" && await abortPeerTaskHandoff(peer, record.handoffId)) {
      await abortOutgoingTaskHandoff(record.handoffId);
      return void 0;
    }
    return void 0;
  }
  if (record.status === "committed") {
    if (!await settlePeerTaskHandoff(peer, record.handoffId)) return void 0;
    await acknowledgeOutgoingTaskHandoff(record.handoffId);
    const task = (await listTasks(record.projectId)).find((candidate) => candidate.id === record.taskId);
    return task ?? null;
  }
  return commitOutgoingTaskHandoff(record);
}
async function pendingHandoffResponse(task, peer) {
  return { status: 202, body: { task, destination: publicClusterPeer(peer), handoffPendingCommit: true, message: "Handoff prepared; ownership remains on this node until destination commit is confirmed." } };
}
async function handoffOwnedTask(project, task, peerId) {
  const local = await getClusterNode();
  if (peerId === local.id) throw new TaskWorktreeError("Task is already owned by this node");
  if (task.executionState === "handoff_pending") {
    const record = (await listUnfinishedOutgoingTaskHandoffs()).find((candidate) => candidate.projectId === project.id && candidate.taskId === task.id);
    if (!record || record.destinationNodeId !== peerId) throw new TaskWorktreeError("Task handoff is awaiting destination commit");
    const peer2 = await getRuntimePeer(peerId);
    if (!peer2) throw new Error("Peer not found");
    try {
      const reconciled = await reconcileOutgoingTaskHandoff(record, peer2);
      if (reconciled !== void 0) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer2) } };
      return pendingHandoffResponse(task, peer2);
    } catch {
      return pendingHandoffResponse(task, peer2);
    }
  }
  if (taskRunActive(task.id) || task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) > Date.now()) throw new TaskWorktreeError("Task has an active run or lease");
  const peer = await getRuntimePeer(peerId);
  if (!peer) throw new Error("Peer not found");
  const eligibility = await runtimeFetch(`${peer.url}/api/cluster/tasks/eligibility`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task }), signal: AbortSignal.timeout(3e3) });
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
      if (reconciled !== void 0) return { status: 200, body: { task: reconciled, destination: publicClusterPeer(peer) } };
      if ((await getTaskHandoff(outgoing.handoffId))?.status !== "aborted") return pendingHandoffResponse(task, peer);
      outgoing = await beginOutgoingTaskHandoff(project.id, task, local.id, peer.id);
      outgoingWasNew = true;
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  if (previous?.status === "prepared") {
    try {
      return { status: 200, body: { task: await commitOutgoingTaskHandoff(outgoing), destination: publicClusterPeer(peer) } };
    } catch {
      return pendingHandoffResponse(task, peer);
    }
  }
  let bundle;
  let handoffContext;
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
    const prepared = await runtimeFetch(`${peer.url}/api/cluster/tasks/prepare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task: outgoing.task, handoffId: outgoing.handoffId, handoffContext, handoffVersion: outgoing.createdAt, bundle }), signal: AbortSignal.timeout(3e4) });
    if (!prepared.ok) return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id), peer);
  } catch {
    return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id), peer);
  }
  try {
    await markOutgoingTaskHandoff(outgoing.handoffId, "prepared");
  } catch {
    return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id), peer);
  }
  try {
    return { status: 200, body: { task: await commitOutgoingTaskHandoff(await getTaskHandoff(outgoing.handoffId)), destination: publicClusterPeer(peer) } };
  } catch {
    return pendingHandoffResponse((await listTasks(project.id)).find((candidate) => candidate.id === task.id), peer);
  }
}
function mirrorTaskResponse(response, routed) {
  return routed.text().then((body) => {
    const contentType = routed.headers.get("content-type");
    if (contentType) response.setHeader("Content-Type", contentType);
    response.status(routed.status).send(body);
  });
}
export {
  archiveOwnedTask,
  assertTaskNotHandoffPending,
  deleteOwnedTask,
  handoffOwnedTask,
  mergeOwnedTask,
  mirrorTaskResponse,
  ownerPeer,
  reconcileOutgoingTaskHandoff
};
