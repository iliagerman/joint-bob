import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getClusterNode } from "../../cluster.js";
import { getProject } from "../../store.js";
import { createTaskWorkspace, removeTaskWorkspace, TaskWorkspaceError, taskWorkspaceKey, TICKET_MERGE_DIR } from "../../task-workspaces.js";
import { listTasks, updateTask } from "../../tasks.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { updateTaskWithAttachments } from "../chat.js";
import { requirePathInsideHome } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { broadcastToProject } from "../realtime.js";
import { directoryBrowseSchema, routedTaskHandoffSchema, routedTaskSchema, routedTaskUpdateSchema, taskUpdateSchema } from "../schemas.js";
import { app } from "../state.js";
import { archiveOwnedTask, assertTaskNotHandoffPending, deleteOwnedTask, handoffOwnedTask, mergeOwnedTask } from "../task-handoff.js";
import { acquireTaskMergeReservation, beginTaskMergeIfNeeded, mergeReservations, releaseTaskMergeReservation, startTaskRun, taskRunActive } from "../task-runs.js";
app.patch(["/api/cluster/tasks/update", "/api/cluster/v2/runtime/tasks/update"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const routed = routedTaskUpdateSchema.parse(request.body);
    const project = await getProject(routed.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const update = taskUpdateSchema.parse(routed.update);
    const existing = (await listTasks(project.id)).find((task2) => task2.id === routed.taskId);
    const local = await getClusterNode();
    if (!existing) {
      sendError(response, 404, "Task not found");
      return;
    }
    if (existing.currentNodeId !== local.id) {
      sendError(response, 409, "Task is not owned by this node");
      return;
    }
    assertTaskNotHandoffPending(existing);
    if (update.status === "planning" && !(update.planMode ?? existing.planMode)) {
      sendError(response, 400, "Planning status requires plan mode");
      return;
    }
    let reopenClearsMerge = false;
    let reopenBaselineAnchor;
    if (existing.status === "done" && update.status !== void 0 && update.status !== "done" && existing.worktreePath && !existing.worktreeBranch) {
      acquireTaskMergeReservation(existing, project.id);
      try {
        let freshBaselineDigest;
        if (existing.mergeState === "merged") {
          const workspaceKey = taskWorkspaceKey(existing.worktreePath, existing.id);
          await removeTaskWorkspace(workspaceKey, existing.id);
          await createTaskWorkspace(project.path, project.id, existing.id);
          freshBaselineDigest = await readFile(path.join(existing.worktreePath, ".joint-bob-baseline", "manifest.json"), "utf8").then((raw) => createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex")).catch(() => void 0);
        } else {
          await rm(path.join(existing.worktreePath, TICKET_MERGE_DIR), { recursive: true, force: true });
        }
        reopenClearsMerge = true;
        reopenBaselineAnchor = freshBaselineDigest;
      } finally {
        releaseTaskMergeReservation(existing.id);
      }
    }
    let task = await updateTaskWithAttachments(project.id, existing, update);
    if (reopenClearsMerge) task = await updateTask(project.id, existing.id, { mergedAt: null, mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: reopenBaselineAnchor ? { baseline: reopenBaselineAnchor } : null });
    const active = update.status !== void 0 && update.status !== existing.status && (update.status === "planning" || update.status === "in_progress" || update.status === "review" && task.reviewMode);
    if (active && !taskRunActive(task.id)) startTaskRun(project, task).catch((error) => console.warn("Task start failed", error));
    if (update.status === "done" && existing.status !== "done" && !task.worktreeBranch) {
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
  } catch (error) {
    next(error);
  }
});
app.delete(["/api/cluster/tasks/delete", "/api/cluster/v2/runtime/tasks/delete"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) {
      sendError(response, 409, "Task is not owned by this node");
      return;
    }
    await deleteOwnedTask(project, task);
    response.status(204).send();
  } catch (error) {
    if (error instanceof TaskWorkspaceError || error instanceof Error && error.message === "Wait for task agent to finish before deleting") {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});
app.post(["/api/cluster/tasks/archive", "/api/cluster/v2/runtime/tasks/archive"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) {
      sendError(response, 409, "Task is not owned by this node");
      return;
    }
    response.json({ task: await archiveOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorkspaceError || error instanceof Error && error.message === "Wait for task agent to finish before deleting") {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});
app.post(["/api/cluster/tasks/merge", "/api/cluster/v2/runtime/tasks/merge"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) {
      sendError(response, 409, "Task is not owned by this node");
      return;
    }
    assertTaskNotHandoffPending(task);
    response.json({ task: await mergeOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorktreeError) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});
app.post(["/api/cluster/tasks/handoff", "/api/cluster/v2/runtime/tasks/handoff"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    const payload = routedTaskHandoffSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) {
      sendError(response, 404, "Task not found");
      return;
    }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) {
      sendError(response, 409, "Task is not owned by this node");
      return;
    }
    if (task.mergeTx === "open" || mergeReservations.has(task.id)) {
      sendError(response, 409, "Wait for the ticket merge to finish before handing off");
      return;
    }
    if ((task.mergeState === "conflicts" || task.mergeState === "resolved") && task.worktreePath && !task.worktreeBranch) {
      sendError(response, 409, "Resolve the ticket merge before handing off");
      return;
    }
    const result = await handoffOwnedTask(project, task, payload.peerId);
    response.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof TaskWorktreeError || error instanceof Error && error.message === "Wait for incoming task handoff settlement before handing off again") {
      sendError(response, 409, error.message);
      return;
    }
    if (error instanceof Error && error.message === "Peer not found") {
      sendError(response, 404, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/filesystem/directories", async (request, response, next) => {
  try {
    response.json(await directoryListing(request.query.path));
  } catch (error) {
    next(error);
  }
});
async function directoryListing(requestedPath) {
  const payload = directoryBrowseSchema.parse({ path: requestedPath });
  const homeDirectory = await realpath(os.homedir());
  const currentPath = await realpath(payload.path ?? homeDirectory);
  requirePathInsideHome(currentPath, homeDirectory);
  const info = await stat(currentPath);
  if (!info.isDirectory()) throw new Error("Selected path is not a directory");
  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) })).sort((left, right) => left.name.localeCompare(right.name));
  return { currentPath, parentPath: currentPath === homeDirectory ? null : path.dirname(currentPath), directories };
}
