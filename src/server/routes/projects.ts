import { revokeAgentCapabilities } from "../../agent-capabilities.js";
import path from "node:path";
import { assertProjectFolderAllowed, projectHomeFor, withProjectRuntime } from "../../project-runtime.js";
import { liveHomeCatalog, projectHiddenFromOtherNodes, setProjectHiddenFromOtherNodes } from "../live-link.js";
import { actorOwns } from "../../ownership.js";
import { grantProjectFolder } from "../multi-user-setup.js";
import { actingAccount, asNode } from "../../account-context.js";
import { listHarnessSessions } from "../../harnesses.js";
import type { HarnessId, ProjectRecord } from "../../types.js";
import { terminalAccessSettings, terminalAllowedFor } from "../../settings.js";
import { cleanupDoneWorktrees } from "../worktree-cleanup.js";
import { z } from 'zod';
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { listRuntimePeers, runtimeFetch } from "../runtime-peers.js";
import { listHarnessCommands } from "../../commands.js";
import { ensureManagedHome, managedProjectPath } from "../../managed-home.js";
import { setProjectName, setSessionClassification, setSessionColor, setSessionDone, setSessionTitle } from "../../names.js";
import { importProjectDirectory, ProjectDirectoryImportError } from "../../project-directory-import.js";
import { setProjectLock } from "../../project-locks.js";
import { getScopedResourcePaths, getSettings } from "../../settings.js";
import { defaultSkillRoots, listSkills } from "../../skills.js";
import { conversationBelongsElsewhere, getConversationRecord } from "../../conversation-records.js";
import { addProject, getProject, listProjects, listWorkspaces, removeProject, renameProject, updateProjectColor, updateProjectMacPath, WorkspaceError } from "../../store.js";
import { ensureSyncthingFolder, rescanSyncthingFolder } from "../../syncthing.js";
import { listTasks, unmergedWorkspaceBlocksClose } from "../../tasks.js";
import { sessionWatcher } from "../chat.js";
import { clusterPeerMayAccessProject, conversationBelongsToDoneTask, mappedPathInsideHome, peerMayOpenTerminal } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable, projectsWithSharedNames, projectView, relocateProjectWorkspace } from "../projects.js";
import { broadcastToProject, projectAudience } from "../realtime.js";
import { projectListQuerySchema, projectLockSchema, projectPathMappingSchema, projectSchema, projectUpdateSchema, registeredHarnessIdSchema, sessionClassificationSchema, sessionColorSchema, sessionDoneSchema, sessionTitleSchema } from "../schemas.js";
import { app } from "../state.js";
import { peerSnapshot } from "../peer-snapshots.js";
import { projectHasMergeReservation } from "../task-runs.js";

app.get("/api/projects", async (request, response, next) => {
  try {
    const query = projectListQuerySchema.parse(request.query);
    const session = response.locals.authSession as AuthSession | undefined;
    const projects = await projectsWithSharedNames({
      includeSyncStatus: query.syncStatus === "true",
      filterForHomeNodeId: session?.isRemoteLogin ? session.homeNodeId : undefined,
    });
    // A visitor also sees their own projects at home, live; offline, only that home is offline.
    const live = session ? await liveHomeCatalog(session) : undefined;
    response.json({ projects: [...projects, ...(live?.projects ?? [])], ...(live ? { liveHome: live.home } : {}) });
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
    const homePath = projectHomeFor(actingAccount(), getSettings().projects.homePath);
    const workspaces = await listWorkspaces();
    if (!workspaces.some((workspace) => workspace.id === payload.type)) {
      throw new WorkspaceError(`Unknown workspace "${payload.type}"`);
    }
    const projectPath = payload.path ?? managedProjectPath(homePath, payload.type, payload.name);
    // In multi-user mode a folder must be the person's own; the admin's may need a grant.
    const grantTo = await assertProjectFolderAllowed(actingAccount(), projectPath);
    if (payload.sourcePath) await assertProjectFolderAllowed(actingAccount(), payload.sourcePath);
    if (!payload.path) await ensureManagedHome(homePath, workspaces.map((workspace) => workspace.id));
    if (payload.sourcePath) {
      if (!payload.importMode) throw new ProjectDirectoryImportError("Choose how to import the project");
      // Every project on the node, so no two people register one folder; the message names none.
      const projects = await asNode(() => listProjects());
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
    if (grantTo) await grantProjectFolder(grantTo, project.path);
    if (payload.synced && project.syncFolderId) {
      await ensureSyncthingFolder(project.syncFolderId, project.name, project.path);
    }
    sessionWatcher.ensureProject(project);
    (await projectAudience(project.id))({ type: "projectsChanged" });
    response.status(201).json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// The owner keeps a project off the nodes they visit, even with their projects shown there.
app.put("/api/projects/:projectId/other-nodes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project || !actorOwns("project", project.id)) { sendError(response, 404, "Project not found"); return; }
    const { hidden } = z.object({ hidden: z.boolean() }).strict().parse(request.body);
    await setProjectHiddenFromOtherNodes(project.id, hidden);
    response.json({ hiddenFromOtherNodes: hidden });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:projectId/other-nodes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project || !actorOwns("project", project.id)) { sendError(response, 404, "Project not found"); return; }
    response.json({ hiddenFromOtherNodes: await projectHiddenFromOtherNodes(project.id) });
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
    if (payload.color !== undefined) project = await updateProjectColor(project.id, payload.color);
    (await projectAudience(project.id))({ type: "projectsChanged" });
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
    (await projectAudience(project.id))({ type: "projectsChanged" });
    response.json({ project: await projectView(project) });
  } catch (error) {
    next(error);
  }
});

// Rename a conversation. Works for both engines; an empty title clears the override.
/**
 * Whether a conversation named from this project is really another project's. A conversation
 * is marked by its id alone, so the id must be this project's own, or nobody's yet (one named
 * before its first message). Older conversations have no record: with several people on the
 * node, those are looked up in the projects the caller can't see.
 */
export async function conversationOfAnotherProject(project: ProjectRecord, engine: HarnessId, sessionId: string): Promise<boolean> {
  if (await getConversationRecord(project.id, engine, sessionId)) return false;
  if (await conversationBelongsElsewhere(project.id, engine, sessionId)) return true;
  if (!actingAccount()) return false;
  const visible = new Set((await listProjects()).map((candidate) => candidate.id));
  for (const other of await asNode(() => listProjects())) {
    if (visible.has(other.id)) continue;
    const sessions = await asNode(() => withProjectRuntime(other.id, () => listHarnessSessions(other))).catch(() => []);
    if (sessions.some((session) => session.id === sessionId)) return true;
  }
  return false;
}

app.put("/api/projects/:projectId/sessions/title", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionTitleSchema.parse(request.body);
    if (await conversationOfAnotherProject(project, payload.engine, payload.sessionId)) { sendError(response, 404, "Conversation not found"); return; }
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
    if (await conversationOfAnotherProject(project, payload.engine, payload.sessionId)) { sendError(response, 404, "Conversation not found"); return; }
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

app.put("/api/projects/:projectId/sessions/done", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = sessionDoneSchema.parse(request.body);
    if (await conversationOfAnotherProject(project, payload.engine, payload.sessionId)) { sendError(response, 404, "Conversation not found"); return; }
    // Like classification, a conversation can be closed out before its transcript exists.
    await setSessionDone(payload.sessionId, payload.done);
    const cleanup = payload.done ? await cleanupDoneWorktrees(project).catch((error) => {
      console.warn("Done worktree cleanup failed", error);
      return undefined;
    }) : undefined;
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ ok: true, ...cleanup });
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
    if (await conversationOfAnotherProject(project, payload.engine, payload.sessionId)) { sendError(response, 404, "Conversation not found"); return; }
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
    const tellAudience = await projectAudience(project.id);
    await removeProject(project.id);
    revokeAgentCapabilities(project.id);
    sessionWatcher.removeProject(project.id);
    tellAudience({ type: "projectsChanged" });
    response.status(204).send();
  } catch (error) {
    if (error instanceof Error && ["Settle task handoffs before deleting project", "Wait for task handoff settlement before deleting project", "Wait for task agents to finish before deleting project"].includes(error.message)) {
      sendError(response, 409, error.message);
      return;
    }
    next(error);
  }
});

app.get('/api/cluster/projects/presence',async(request,response,next)=>{
  try{
    if(!response.locals.machineAuth){sendError(response,401,'Unauthorized');return;}
    const projectId=z.string().min(1).parse(request.query.projectId);
    if(!await clusterPeerMayAccessProject(response.locals.machineNodeId,projectId)){sendError(response,403,'Project is not shared with this node');return;}
    response.json({mapped:Boolean(await getProject(projectId)),terminal:terminalAccessSettings().mode!=="off"&&await peerMayOpenTerminal(response.locals.machineNodeId)});
  }catch(error){next(error);}
});

app.get("/api/projects/:projectId/session-nodes", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    // Opening one conversation needs only its owner. Unrelated offline peers
    // must not delay the local node or a reachable selected owner.
    const targetNodeId = typeof request.query.nodeId === "string" ? request.query.nodeId : undefined;
    // Only machines in a cluster this project is shared with may run its conversations.
    const peers = targetNodeId === local.id ? [] : (await listRuntimePeers(project.id)).filter(peer => !targetNodeId || peer.id === targetNodeId);
    const peerNodes = await Promise.all(peers.map(async (peer) => {
      try {
        // A peer that is slow or offline answers from what it last reported, marked offline.
        const presence=await peerSnapshot(`presence:${project.id}`,peer.id,async()=>{
          const reply=await runtimeFetch(`${peer.url}/api/cluster/projects/presence?projectId=${encodeURIComponent(project.id)}`,{signal:AbortSignal.timeout(3000)});
          if(!reply.ok)throw new Error('Project presence unavailable');
          return await reply.json() as {mapped:boolean;terminal?:boolean};
        });
        // A peer that predates the terminal setting does not restrict it.
        return {id:peer.id,name:peer.name,local:false,online:presence.fresh,mapped:presence.value.mapped,terminal:presence.value.terminal!==false};
      } catch {
        return { id: peer.id, name: peer.name, local: false, online: false, mapped: false, terminal: false };
      }
    }));
    // The local terminal follows the admin's policy for the signed-in person.
    response.json({ nodes: [{ id: local.id, name: local.name, local: true, online: true, mapped: true, terminal: terminalAllowedFor(actingAccount()) }, ...peerNodes] });
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
