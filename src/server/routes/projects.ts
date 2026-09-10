import path from "node:path";
import { getClusterNode, listClusterPeers } from "../../cluster.js";
import { listHarnessCommands } from "../../commands.js";
import { ensureManagedHome, managedProjectPath } from "../../managed-home.js";
import { setProjectName, setSessionClassification, setSessionColor, setSessionTitle } from "../../names.js";
import { importProjectDirectory, ProjectDirectoryImportError } from "../../project-directory-import.js";
import { setProjectLock } from "../../project-locks.js";
import { getScopedResourcePaths, getSettings } from "../../settings.js";
import { defaultSkillRoots, listSkills } from "../../skills.js";
import { addProject, getProject, listProjects, listWorkspaces, removeProject, renameProject, updateProjectColor, updateProjectMacPath, WorkspaceError } from "../../store.js";
import { ensureSyncthingFolder, rescanSyncthingFolder } from "../../syncthing.js";
import { listTasks, unmergedWorkspaceBlocksClose } from "../../tasks.js";
import { sessionWatcher } from "../chat.js";
import { conversationBelongsToDoneTask, fetchPeerInventory, mappedPathInsideHome } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable, notifyPeersOfProjectInventory, projectsWithSharedNames, projectView, relocateProjectWorkspace } from "../projects.js";
import { broadcastToAllClients, broadcastToProject } from "../realtime.js";
import { projectListQuerySchema, projectLockSchema, projectPathMappingSchema, projectSchema, projectUpdateSchema, registeredHarnessIdSchema, sessionClassificationSchema, sessionColorSchema, sessionTitleSchema } from "../schemas.js";
import { app } from "../state.js";
import { projectHasMergeReservation } from "../task-runs.js";

app.get("/api/projects", async (request, response, next) => {
  try {
    const query = projectListQuerySchema.parse(request.query);
    response.json({ projects: await projectsWithSharedNames(query.syncStatus === "true") });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:projectId/sync/rescan", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    if (!project.syncFolderId) {
      sendError(response, 409, "Project is not synchronized with Syncthing");
      return;
    }
    await rescanSyncthingFolder(project.syncFolderId);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (request, response, next) => {
  try {
    const payload = projectSchema.parse(request.body);
    const homePath = getSettings().projects.homePath;
    const workspaces = await listWorkspaces();
    if (!workspaces.some((workspace) => workspace.id === payload.type)) {
      throw new WorkspaceError(`Unknown workspace "${payload.type}"`);
    }
    const projectPath = payload.path ?? managedProjectPath(homePath, payload.type, payload.name);
    if (!payload.path) await ensureManagedHome(homePath, workspaces.map((workspace) => workspace.id));
    if (payload.sourcePath) {
      if (!payload.importMode) throw new ProjectDirectoryImportError("Choose how to import the project");
      const projects = await listProjects();
      if (projects.some((project) => path.resolve(project.path) === path.resolve(projectPath))) {
        throw new ProjectDirectoryImportError("Managed project folder is already registered");
      }
      const sourcePath = await mappedPathInsideHome(payload.sourcePath);
      if (projects.some((project) => path.resolve(project.path) === sourcePath)) {
        throw new ProjectDirectoryImportError("Source project folder is already registered");
      }
      await importProjectDirectory(sourcePath, projectPath, payload.importMode);
    }
    const project = await addProject(payload.name, projectPath, {
      synced: payload.synced,
      macPath: payload.macPath ?? payload.sourcePath,
      type: payload.type,
      color: payload.color ?? undefined,
      writeInstructions: !payload.sourcePath,
    });
    if (payload.synced && project.syncFolderId) {
      await ensureSyncthingFolder(project.syncFolderId, project.name, project.path);
      await notifyPeersOfProjectInventory();
    }
    sessionWatcher.ensureProject(project);
    broadcastToAllClients({ type: "projectsChanged" });
    response.status(201).json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/path-mapping", async (request, response, next) => {
  try {
    const existing = await getProject(request.params.projectId);
    if (!existing) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(existing);
    const payload = projectPathMappingSchema.parse(request.body);
    const project = await updateProjectMacPath(existing.id, payload.macPath);
    sessionWatcher.ensureProject(project);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ project });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:projectId", async (request, response, next) => {
  try {
    const existing = await getProject(request.params.projectId);
    if (!existing) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(existing);
    const payload = projectUpdateSchema.parse(request.body);
    if (payload.type && !(await listWorkspaces()).some((workspace) => workspace.id === payload.type)) {
      throw new WorkspaceError(`Unknown workspace "${payload.type}"`);
    }
    let project = existing;
    const typeChanged = Boolean(payload.type && payload.type !== existing.type);
    if (typeChanged && payload.type) project = await relocateProjectWorkspace(project, payload.type);
    if (payload.name !== undefined) {
      project = await renameProject(project.id, payload.name);
      await setProjectName(project.id, payload.name);
    }
    const colorChanged = payload.color !== undefined && payload.color !== (existing.color ?? null);
    if (payload.color !== undefined) project = await updateProjectColor(project.id, payload.color);
    if (typeChanged || colorChanged) await notifyPeersOfProjectInventory();
    broadcastToAllClients({ type: "projectsChanged" });
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// Any node may lock or unlock. The lock only stops accidental edits from a second node.
app.put("/api/projects/:projectId/lock", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = projectLockSchema.parse(request.body);
    await setProjectLock(project.id, payload.locked);
    broadcastToAllClients({ type: "projectsChanged" });
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// Rename a conversation. Works for both engines; an empty title clears the override.
app.put("/api/projects/:projectId/sessions/title", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionTitleSchema.parse(request.body);
    if (await conversationBelongsToDoneTask(project.id, payload.engine, payload.sessionId)) {
      sendError(response, 409, "Done ticket conversations are read-only");
      return;
    }
    // No conversation-list lookup: a conversation named at creation has no
    // transcript on disk yet, and the list is where that name matters most.
    await setSessionTitle(payload.sessionId, payload.title);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/classification", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionClassificationSchema.parse(request.body);
    if (await conversationBelongsToDoneTask(project.id, payload.engine, payload.sessionId)) {
      sendError(response, 409, "Done ticket conversations are read-only");
      return;
    }
    // Like titles, classification can be saved before the first transcript exists.
    await setSessionClassification(payload.sessionId, payload.classification);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/projects/:projectId/sessions/color", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionColorSchema.parse(request.body);
    if (await conversationBelongsToDoneTask(project.id, payload.engine, payload.sessionId)) {
      sendError(response, 409, "Done ticket conversations are read-only");
      return;
    }
    await setSessionColor(payload.sessionId, payload.color);
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:projectId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    await assertProjectEditable(project);
    const tasks = await listTasks(project.id);
    if (tasks.some((task) => task.mergeTx === "open")) {
      sendError(response, 409, "Wait for this project's ticket merge transaction to finish before deleting the project");
      return;
    }
    if (projectHasMergeReservation(project.id)) {
      sendError(response, 409, "A ticket merge reservation is active for this project");
      return;
    }
    if (tasks.some((task) => task.worktreePath && !task.worktreeBranch && unmergedWorkspaceBlocksClose(task))) {
      sendError(response, 409, "Resolve this project's ticket merges (or discard them) before deleting the project");
      return;
    }
    await removeProject(project.id);
    sessionWatcher.removeProject(project.id);
    broadcastToAllClients({ type: "projectsChanged" });
    response.status(204).send();
  } catch (error) {
    if (error instanceof Error && ["Settle task handoffs before deleting project", "Wait for task handoff settlement before deleting project", "Wait for task agents to finish before deleting project"].includes(error.message)) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});

app.get("/api/projects/:projectId/session-nodes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    const peerNodes = await Promise.all((await listClusterPeers()).map(async (peer) => {
      try {
        const inventory = await fetchPeerInventory(peer, 3_000);
        const mapped = inventory.projects.some((entry) => entry.project.id === project.id || entry.aliases?.includes(project.id) || Boolean(project.syncFolderId && entry.project.syncFolderId === project.syncFolderId));
        return { id: peer.id, name: peer.name, local: false, online: true, mapped };
      } catch {
        return { id: peer.id, name: peer.name, local: false, online: false, mapped: false };
      }
    }));
    response.json({ nodes: [{ id: local.id, name: local.name, local: true, online: true, mapped: true }, ...peerNodes] });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/skills", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const configured = getScopedResourcePaths(project.id);
    response.json({ skills: await listSkills(project.path, { ...defaultSkillRoots(), global: configured.global.skills, project: configured.project.skills }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/commands", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const harness = registeredHarnessIdSchema.parse(request.query.harness);
    response.json({ commands: await listHarnessCommands(project.path, harness, { resourcePaths: getScopedResourcePaths(project.id) }) });
  } catch (error) {
    next(error);
  }
});
