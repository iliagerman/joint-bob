import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getClusterNode, listClusterPeers, getClusterMachineToken } from "../../cluster.js";
import { getProject } from "../../store.js";
import { ensureTicketWorkspaceFolder } from "../../syncthing.js";
import { createTaskWorkspace, removeTaskWorkspace, TaskWorkspaceError, taskWorkspaceKey, TICKET_MERGE_DIR } from "../../task-workspaces.js";
import { createTask, deleteTask, listTasks, updateTask } from "../../tasks.js";
import { beginTicketMerge, discardTicketChanges, finalizeTicketMerge, resolveTicketChoiceConflict, restartTicketMerge, ticketMergeConflicts, TicketMergeError } from "../../ticket-merge-service.js";
import type { TaskRecord } from "../../types.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { persistTaskAttachments, updateTaskWithAttachments } from "../chat.js";
import { peerTaskEligibilityEntry, type TaskEligibilityEntry, taskHandoffEligibility } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable } from "../projects.js";
import { broadcastToProject } from "../realtime.js";
import { taskCreateSchema, taskHandoffSchema, taskUpdateSchema } from "../schemas.js";
import { app } from "../state.js";
import { archiveOwnedTask, assertTaskNotHandoffPending, deleteOwnedTask, handoffOwnedTask, mergeOwnedTask, mirrorTaskResponse, ownerPeer } from "../task-handoff.js";
import { acquireTaskMergeReservation, beginTaskMergeIfNeeded, mergeReservations, releaseTaskMergeReservation, startMergeRun, startTaskRun, taskRunActive } from "../task-runs.js";

app.get("/api/projects/:projectId/tasks", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ tasks: await listTasks(project.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/tasks/:taskId/eligibility", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peers = await listClusterPeers();
    const nodes: TaskEligibilityEntry[] = [];
    const localEligibility = task.currentNodeId === local.id ? await taskHandoffEligibility(project.id, task, false) : undefined;
    if (task.currentNodeId !== local.id) {
      const eligibility = await taskHandoffEligibility(project.id, task);
      nodes.push({ node: { id: local.id, name: local.name, local: true, online: true }, eligible: eligibility.reasons.length === 0, ...eligibility });
    }
    const owner = peers.find((peer) => peer.id === task.currentNodeId);
    let source: TaskEligibilityEntry;
    if (localEligibility) {
      source = { node: { id: local.id, name: local.name, local: true, online: true }, eligible: localEligibility.reasons.length === 0, ...localEligibility };
    } else if (owner) {
      source = await peerTaskEligibilityEntry(owner, project.id, task, true);
    } else {
      source = { node: { id: task.currentNodeId, name: "Task owner", online: false }, eligible: false, reasons: ["Task owner is unavailable"], syncStatuses: [], waitingForSync: false };
    }
    const peerNodes = await Promise.all(peers.filter((peer) => peer.id !== task.currentNodeId).map((peer) => peerTaskEligibilityEntry(peer, project.id, task)));
    response.json({ source, nodes: [...nodes, ...peerNodes] });
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/tasks", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(project);
    const payload = taskCreateSchema.parse(request.body);
    await ensureTicketWorkspaceFolder();
    const engine = payload.engine ?? "pi";
    const planMode = payload.planMode === true;
    if (payload.status === "planning" && !planMode) {
      sendError(response, 400, "Planning status requires plan mode");
      return;
    }
    let task = await createTask(project.id, project.path, payload.title, payload.description, payload.status ?? "backlog", engine, planMode, payload.reviewMode === true, payload.phaseConfig ?? {});
    try {
      const attachments = await persistTaskAttachments(task.worktreePath!, payload.images ?? [], payload.files ?? []);
      if (attachments.length) task = await updateTask(project.id, task.id, { attachments });
    } catch (error) {
      await deleteTask(project.id, task.id);
      await removeTaskWorkspace(project.id, task.id);
      throw error;
    }
    if (task.status === "planning" || task.status === "in_progress" || (task.status === "review" && task.reviewMode)) {
      startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    }
    if (task.status === "done") beginTaskMergeIfNeeded(project, task).catch((error) => console.warn("Ticket merge failed to start", error));
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.status(201).json({ task });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:projectId/tasks/:taskId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const payload = taskUpdateSchema.parse(request.body);
    const existing = (await listTasks(project.id)).find((task) => task.id === request.params.taskId);
    if (!existing) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(existing, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/update`, { method: "PATCH", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: existing.id, update: payload }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (existing.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    assertTaskNotHandoffPending(existing);
    if (payload.status === "planning" && !(payload.planMode ?? existing.planMode)) { sendError(response, 400, "Planning status requires plan mode"); return; }
    // Reopening a done ticket resets its merge state (TICKET-MERGE-PLAN.md §10):
    // a merged ticket gets a fresh workspace copy, a conflicted one drops its
    // merge artifacts; the next move to Done runs a fresh prepare.
    let reopenClearsMerge = false;
    let reopenBaselineAnchor: string | undefined;
    if (existing.status === "done" && payload.status !== undefined && payload.status !== "done" && existing.worktreePath && !existing.worktreeBranch) {
      acquireTaskMergeReservation(existing, project.id);
      try {
        let freshBaselineDigest: string | undefined;
        if (existing.mergeState === "merged") {
          const workspaceKey = taskWorkspaceKey(existing.worktreePath, existing.id);
          await removeTaskWorkspace(workspaceKey, existing.id);
          await createTaskWorkspace(project.path, project.id, existing.id);
          freshBaselineDigest = await readFile(path.join(existing.worktreePath, ".joint-bob-baseline", "manifest.json"), "utf8")
            .then((raw) => createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"))
            .catch(() => undefined);
        } else {
          await rm(path.join(existing.worktreePath, TICKET_MERGE_DIR), { recursive: true, force: true });
        }
        reopenClearsMerge = true;
        reopenBaselineAnchor = freshBaselineDigest;
      } finally {
        releaseTaskMergeReservation(existing.id);
      }
    }
    let task = await updateTaskWithAttachments(project.id, existing, payload);
    if (reopenClearsMerge) task = await updateTask(project.id, existing.id, { mergedAt: null, mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: reopenBaselineAnchor ? { baseline: reopenBaselineAnchor } : null });
    const active = payload.status !== undefined && payload.status !== existing.status && (payload.status === "planning" || payload.status === "in_progress" || (payload.status === "review" && task.reviewMode));
    if (active && !taskRunActive(task.id)) startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    if (payload.status === "done" && existing.status !== "done" && !task.worktreeBranch) {
      const merged = await beginTaskMergeIfNeeded(project, task).catch((error) => {
        console.warn("Ticket merge failed to start", error);
        return updateTask(project.id, task.id, { mergeWarning: error instanceof Error ? error.message : "Merge failed to start" }).catch(() => task);
      });
      broadcastToProject(project.id, { type: "tasksChanged" });
      response.json({ task: merged ?? task });
      return;
    }
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task });
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/tasks/:taskId/handoff", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const payload = taskHandoffSchema.parse(request.body);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/handoff`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id, peerId: payload.peerId }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    if (task.mergeTx === "open" || mergeReservations.has(task.id)) { sendError(response, 409, "Wait for the ticket merge to finish before handing off"); return; }
    if ((task.mergeState === "conflicts" || task.mergeState === "resolved") && task.worktreePath && !task.worktreeBranch) { sendError(response, 409, "Resolve the ticket merge before handing off"); return; }
    const result = await handoffOwnedTask(project, task, payload.peerId);
    response.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof TaskWorktreeError || (error instanceof Error && error.message === "Wait for incoming task handoff settlement before handing off again")) { sendError(response, 409, error.message); return; }
    if (error instanceof Error && error.message === "Peer not found") { sendError(response, 404, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/archive", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/archive`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    response.json({ task: await archiveOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

const mergeActionSchema = z.object({ path: z.string().min(1).optional(), side: z.enum(["workspace", "project"]).optional() });

app.post("/api/projects/:projectId/tasks/:taskId/merge", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-action`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "merge", projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(120_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    if (task.worktreeBranch) {
      // Legacy Git-worktree tickets keep their branch-merge behavior.
      response.json({ task: await mergeOwnedTask(project, task) });
      return;
    }
    acquireTaskMergeReservation(task, project.id);
    let merged: TaskRecord;
    try {
      if (task.mergeState === "conflicts" || task.mergeState === "resolved") {
        // Human path: resolutions already staged (editor or earlier agent pass);
        // finalize validates them and applies, or refuses with what remains.
        merged = await finalizeTicketMerge(project, task);
      } else {
        const outcome = await beginTicketMerge(project, task);
        merged = outcome.task;
        if (outcome.prepared.conflicts.length) await startMergeRun(project, outcome.task).catch((error) => console.warn("Ticket merge agent run failed to start", error));
      }
    } finally { releaseTaskMergeReservation(task.id); }
    merged = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? merged;
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task: merged });
  } catch (error) {
    if (error instanceof TicketMergeError || error instanceof TaskWorkspaceError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/merge-resume", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-action`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "merge-resume", projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    if (task.mergeState !== "conflicts" && task.mergeState !== "resolved") { sendError(response, 409, "Ticket has no unresolved merge"); return; }
    acquireTaskMergeReservation(task, project.id);
    try { await startMergeRun(project, task); }
    finally { releaseTaskMergeReservation(task.id); }
    response.json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? task });
  } catch (error) {
    if (error instanceof TicketMergeError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/merge-restart", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-action`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "merge-restart", projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(120_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    acquireTaskMergeReservation(task, project.id);
    let updated: TaskRecord;
    try {
      const outcome = await restartTicketMerge(project, task);
      updated = outcome.task;
      if (outcome.prepared.conflicts.length) await startMergeRun(project, outcome.task).catch((error) => console.warn("Ticket merge agent run failed to start", error));
    } finally { releaseTaskMergeReservation(task.id); }
    updated = (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? updated;
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task: updated });
  } catch (error) {
    if (error instanceof TicketMergeError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.get("/api/projects/:projectId/tasks/:taskId/merge-conflicts", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-conflicts?projectId=${encodeURIComponent(project.id)}&taskId=${encodeURIComponent(task.id)}`, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    response.json({ conflicts: await ticketMergeConflicts(task), warning: task.mergeWarning });
  } catch (error) { next(error); }
});

app.get("/api/cluster/tasks/merge-conflicts", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const project = await getProject(String(request.query.projectId ?? ""));
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === String(request.query.taskId ?? ""));
    if (!task) { sendError(response, 404, "Task not found"); return; }
    response.json({ conflicts: await ticketMergeConflicts(task), warning: task.mergeWarning });
  } catch (error) { next(error); }
});

app.post("/api/projects/:projectId/tasks/:taskId/merge-resolve", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const payload = mergeActionSchema.parse(request.body);
    if (!payload.path || !payload.side) { sendError(response, 400, "path and side are required"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-action`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "merge-resolve", projectId: project.id, taskId: task.id, payload }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    acquireTaskMergeReservation(task, project.id);
    try {
      const updated = await resolveTicketChoiceConflict(project, task, payload.path, payload.side);
      broadcastToProject(project.id, { type: "tasksChanged" });
      response.json({ task: updated });
    } finally { releaseTaskMergeReservation(task.id); }
  } catch (error) {
    if (error instanceof TicketMergeError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post("/api/projects/:projectId/tasks/:taskId/discard", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/merge-action`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ action: "discard", projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    acquireTaskMergeReservation(task, project.id);
    let discarded: TaskRecord;
    try {
      discarded = await discardTicketChanges(project, task);
      if (task.worktreePath) await removeTaskWorkspace(taskWorkspaceKey(task.worktreePath, task.id), task.id);
    } finally { releaseTaskMergeReservation(task.id); }
    broadcastToProject(project.id, { type: "tasksChanged" });
    response.json({ task: discarded });
  } catch (error) {
    if (error instanceof TicketMergeError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

// Cluster mirror for ticket merge actions; routed to the task owner by the public routes.
app.post("/api/cluster/tasks/merge-action", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const body = z.object({ action: z.enum(["merge", "merge-resume", "merge-restart", "merge-resolve", "discard"]), projectId: z.string(), taskId: z.string(), payload: mergeActionSchema.optional() }).parse(request.body);
    const project = await getProject(body.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === body.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    acquireTaskMergeReservation(task, project.id);
    try {
      if (body.action === "discard") {
        const discarded = await discardTicketChanges(project, task);
        if (task.worktreePath) await removeTaskWorkspace(taskWorkspaceKey(task.worktreePath, task.id), task.id);
        response.json({ task: discarded });
        return;
      }
      if (body.action === "merge-resume") {
        if (task.mergeState !== "conflicts" && task.mergeState !== "resolved") { sendError(response, 409, "Ticket has no unresolved merge"); return; }
        await startMergeRun(project, task);
        response.json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? task });
        return;
      }
      if (body.action === "merge-resolve") {
        if (!body.payload?.path || !body.payload.side) { sendError(response, 400, "path and side are required"); return; }
        response.json({ task: await resolveTicketChoiceConflict(project, task, body.payload.path, body.payload.side) });
        return;
      }
      if (body.action === "merge" && (task.mergeState === "conflicts" || task.mergeState === "resolved")) {
        const merged = await finalizeTicketMerge(project, task);
        response.json({ task: merged });
        return;
      }
      const outcome = body.action === "merge-restart" ? await restartTicketMerge(project, task) : await beginTicketMerge(project, task);
      if (outcome.prepared.conflicts.length) await startMergeRun(project, outcome.task).catch((error) => console.warn("Ticket merge agent run failed to start", error));
      response.json({ task: (await listTasks(project.id)).find((candidate) => candidate.id === task.id) ?? outcome.task });
    } finally { releaseTaskMergeReservation(task.id); }
  } catch (error) {
    if (error instanceof TicketMergeError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.delete("/api/projects/:projectId/tasks/:taskId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === request.params.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    const peer = await ownerPeer(task, local.id);
    if (peer) {
      const routed = await fetch(`${peer.url}/api/cluster/tasks/delete`, { method: "DELETE", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, taskId: task.id }), signal: AbortSignal.timeout(30_000) });
      await mirrorTaskResponse(response, routed);
      return;
    }
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task owner is unavailable"); return; }
    await deleteOwnedTask(project, task);
    response.status(204).send();
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});
