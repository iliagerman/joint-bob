import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_RESOURCES_FOLDER_ID, agentResourcesRoot } from "../../agent-resources.js";
import { getClusterNode, getClusterPeer, listClusterPeers, removeClusterPeer } from "../../cluster.js";
import { listHarnessSyncFolders } from "../../harnesses.js";
import { getProject } from "../../store.js";
import { ensureAgentResourcesFolder, ensureConversationSyncFolders, ensureSyncthingDevice, ensureSyncthingFolder, ensureTicketWorkspaceFolder, pauseEngineSyncFolders, syncthingPathForFolderId } from "../../syncthing.js";
import { createTaskWorkspace, removeTaskWorkspace, TaskWorkspaceError, taskWorkspaceKey, TICKET_MERGE_DIR, TICKET_WORKSPACE_FOLDER_ID, ticketWorkspaceRoot } from "../../task-workspaces.js";
import { listTasks, updateTask } from "../../tasks.js";
import { TaskWorktreeError } from "../../worktrees.js";
import { updateTaskWithAttachments } from "../chat.js";
import { fetchPeerInventory, importProjectsFromPeer, mapProjectFromPeer, type ProjectImportResult, requirePathInsideHome } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { broadcastToAllClients, broadcastToProject } from "../realtime.js";
import { absolutePathSchema, clusterProjectImportSchema, clusterProjectMapSchema, clusterSyncShareSchema, directoryBrowseSchema, routedTaskHandoffSchema, routedTaskSchema, routedTaskUpdateSchema, taskUpdateSchema } from "../schemas.js";
import { app } from "../state.js";
import { archiveOwnedTask, assertTaskNotHandoffPending, deleteOwnedTask, handoffOwnedTask, mergeOwnedTask } from "../task-handoff.js";
import { acquireTaskMergeReservation, beginTaskMergeIfNeeded, mergeReservations, releaseTaskMergeReservation, startTaskRun, taskRunActive } from "../task-runs.js";

app.patch("/api/cluster/tasks/update", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const routed = routedTaskUpdateSchema.parse(request.body);
    const project = await getProject(routed.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const update = taskUpdateSchema.parse(routed.update);
    const existing = (await listTasks(project.id)).find((task) => task.id === routed.taskId);
    const local = await getClusterNode();
    if (!existing) { sendError(response, 404, "Task not found"); return; }
    if (existing.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    assertTaskNotHandoffPending(existing);
    if (update.status === "planning" && !(update.planMode ?? existing.planMode)) { sendError(response, 400, "Planning status requires plan mode"); return; }
    let reopenClearsMerge = false;
    let reopenBaselineAnchor: string | undefined;
    if (existing.status === "done" && update.status !== undefined && update.status !== "done" && existing.worktreePath && !existing.worktreeBranch) {
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
    let task = await updateTaskWithAttachments(project.id, existing, update);
    if (reopenClearsMerge) task = await updateTask(project.id, existing.id, { mergedAt: null, mergeState: "none", conflictCount: 0, mergeWarning: null, mergeTx: null, mergeDigests: reopenBaselineAnchor ? { baseline: reopenBaselineAnchor } : null });
    const active = update.status !== undefined && update.status !== existing.status && (update.status === "planning" || update.status === "in_progress" || (update.status === "review" && task.reviewMode));
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
  } catch (error) { next(error); }
});

app.delete("/api/cluster/tasks/delete", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    await deleteOwnedTask(project, task);
    response.status(204).send();
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/archive", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    response.json({ task: await archiveOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorkspaceError || (error instanceof Error && error.message === "Wait for task agent to finish before deleting")) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/merge", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
    assertTaskNotHandoffPending(task);
    response.json({ task: await mergeOwnedTask(project, task) });
  } catch (error) {
    if (error instanceof TaskWorktreeError) { sendError(response, 409, error.message); return; }
    next(error);
  }
});

app.post("/api/cluster/tasks/handoff", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const payload = routedTaskHandoffSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const task = (await listTasks(project.id)).find((candidate) => candidate.id === payload.taskId);
    if (!task) { sendError(response, 404, "Task not found"); return; }
    const local = await getClusterNode();
    if (task.currentNodeId !== local.id) { sendError(response, 409, "Task is not owned by this node"); return; }
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

app.post("/api/cluster/projects/import", async (request, response, next) => {
  try {
    const payload = clusterProjectImportSchema.parse(request.body);
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) {
      sendError(response, 404, "Peer not found");
      return;
    }
    const result = await importProjectsFromPeer(peer);
    broadcastToAllClients({ type: "projectsChanged" });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/projects/map", async (request, response, next) => {
  try {
    const payload = clusterProjectMapSchema.parse(request.body);
    const peer = await getClusterPeer(payload.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const inventory = await fetchPeerInventory(peer);
    const entry = inventory.projects.find((candidate) => candidate.project.id === payload.projectId || candidate.aliases?.includes(payload.projectId));
    if (!entry) { sendError(response, 404, "Remote project not found"); return; }
    response.status(201).json({ project: await mapProjectFromPeer(peer, inventory, entry, payload.localPath) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/projects/discover", async (_request, response, next) => {
  try {
    const result: ProjectImportResult = { imported: [], skipped: [], pending: [] };
    for (const peer of await listClusterPeers()) {
      try {
        const peerResult = await importProjectsFromPeer(peer);
        result.imported.push(...peerResult.imported);
        result.skipped.push(...peerResult.skipped);
        result.pending.push(...peerResult.pending);
      } catch (error) {
        result.skipped.push(`${peer.name}: ${error instanceof Error ? error.message : "unavailable"}`);
      }
    }
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/peers/:peerId/projects/:projectId/map", async (request, response, next) => {
  try {
    const peer = await getClusterPeer(request.params.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const localPath = absolutePathSchema.parse(request.body?.localPath);
    const local = await getClusterNode();
    const peerResponse = await fetch(`${peer.url}/api/cluster/projects/map`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: local.id, projectId: request.params.projectId, localPath }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await peerResponse.json();
    response.status(peerResponse.status).json(body);
  } catch (error) {
    next(error);
  }
});

app.post("/api/cluster/sync/share", async (request, response, next) => {
  try {
    const payload = clusterSyncShareSchema.parse(request.body);
    if (payload.folderId === AGENT_RESOURCES_FOLDER_ID) {
      await ensureAgentResourcesFolder(agentResourcesRoot(), payload.deviceId, payload.deviceName);
      response.json({ ok: true });
      return;
    }
    if (payload.folderId === TICKET_WORKSPACE_FOLDER_ID) {
      await ensureTicketWorkspaceFolder(ticketWorkspaceRoot(), payload.deviceId, payload.deviceName);
      response.json({ ok: true });
      return;
    }
    if (payload.folderId === "dot-pi" || payload.folderId === "dot-claude") {
      await pauseEngineSyncFolders();
      response.json({ ok: true });
      return;
    }
    const conversationFolder = listHarnessSyncFolders().find((folder) => folder.id === payload.folderId);
    if (conversationFolder) {
      await ensureConversationSyncFolders([conversationFolder], payload.deviceId, payload.deviceName);
      response.json({ ok: true });
      return;
    }
    const folderPath = await syncthingPathForFolderId(payload.folderId);
    if (!folderPath) { sendError(response, 404, "Syncthing folder not found"); return; }
    await ensureSyncthingDevice(payload.deviceId, payload.deviceName ?? payload.deviceId);
    await ensureSyncthingFolder(payload.folderId, payload.folderId, folderPath, payload.deviceId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

async function directoryListing(requestedPath: unknown): Promise<{ currentPath: string; parentPath: string | null; directories: Array<{ name: string; path: string }> }> {
  const payload = directoryBrowseSchema.parse({ path: requestedPath });
  const homeDirectory = await realpath(os.homedir());
  const currentPath = await realpath(payload.path ?? homeDirectory);
  requirePathInsideHome(currentPath, homeDirectory);
  const info = await stat(currentPath);
  if (!info.isDirectory()) throw new Error("Selected path is not a directory");
  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { currentPath, parentPath: currentPath === homeDirectory ? null : path.dirname(currentPath), directories };
}

for (const route of ["/api/filesystem/directories", "/api/cluster/filesystem/directories"]) {
  app.get(route, async (request, response, next) => {
    try { response.json(await directoryListing(request.query.path)); }
    catch (error) { next(error); }
  });
}

app.get("/api/cluster/peers/:peerId/filesystem/directories", async (request, response, next) => {
  try {
    const peer = await getClusterPeer(request.params.peerId);
    if (!peer) { sendError(response, 404, "Peer not found"); return; }
    const peerUrl = new URL("/api/cluster/filesystem/directories", peer.url);
    if (typeof request.query.path === "string") peerUrl.searchParams.set("path", request.query.path);
    const peerResponse = await fetch(peerUrl, { headers: { Authorization: `Bearer ${peer.token}` }, signal: AbortSignal.timeout(10_000) });
    const body = await peerResponse.json();
    response.status(peerResponse.status).json(body);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/cluster/peers/:peerId", async (request, response, next) => {
  try {
    await removeClusterPeer(request.params.peerId);
    response.status(204).send();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Transfer owned tasks and settle handoffs")) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});
