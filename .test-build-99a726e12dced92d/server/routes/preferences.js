import { projectAdditionalPaths } from "../session-scope.js";
import path from "node:path";
import { runSyncCheck, syncCheckStatus } from "../sync-check.js";
import { z } from "zod";
import { syncLocalSkills } from "../../agent-resources.js";
import { listAuditEvents } from "../../audit.js";
import { clearCanvasShortcut, listCanvasShortcuts, releaseCanvasShortcuts, setCanvasShortcut } from "../../canvas-shortcuts.js";
import { getClusterNode } from "../../cluster.js";
import { clearHarnessSessionCache, harnessForSessionPath, listHarnessSessions } from "../../harnesses.js";
import { ensureManagedHome } from "../../managed-home.js";
import { getUserPreferences, normalizeCanvasKeymapPreference, normalizeCanvasLayoutPreference, readLegacyRecentSessions, updateUserPreferences } from "../../preferences.js";
import { listUserRecentSessions, migrateLegacyRecentSessions, removeUserRecentSession, setUserRecentSession } from "../../recent-sessions.js";
import { checkRuntimeSettings, getProjectResourcePaths, getRuntimeDefaults, getSettings, updateProjectResourcePaths, updateSettings } from "../../settings.js";
import { getProject, listWorkspaces } from "../../store.js";
import { resetSyncthingConnection } from "../../syncthing.js";
import { listTasks } from "../../tasks.js";
import { isHarnessId } from "../../types.js";
import { listUserPins, setUserPin } from "../../user-pins.js";
import { assertManagedHomeChangeAllowed } from "../cluster-helpers.js";
import { Feature, requireFeature, sendError } from "../http-auth.js";
import { broadcastToAllClients, reloadSharedSkills } from "../realtime.js";
import { auditQuerySchema, recentSessionIdentitySchema, recentSessionSchema, registeredHarnessIdSchema, resourcePathsSchema, runtimeCheckSchema, settingsSchema, userPinSchema, userPreferencesSchema } from "../schemas.js";
import { app } from "../state.js";
app.use("/api/settings", requireFeature(Feature.SETTINGS));
app.get("/api/preferences", (_request, response) => {
  const session = response.locals.authSession;
  response.json(getUserPreferences(session.userId));
});
function stableLegacyRecents(entries) {
  const stable = [];
  for (const entry of entries) {
    try {
      const adapter = entry.engine && entry.sessionId ? null : harnessForSessionPath(entry.sessionPath);
      const engine = entry.engine ?? adapter?.id;
      const sessionId = entry.sessionId ?? adapter?.paths.sessionId(entry.sessionPath);
      if (engine && sessionId && isHarnessId(engine) && Number.isFinite(Date.parse(entry.openedAt))) {
        stable.push({ ...entry, engine, sessionId, updatedAt: entry.updatedAt ?? null });
      }
    } catch {
    }
  }
  return stable;
}
app.get("/api/recents", async (_request, response, next) => {
  try {
    const session = response.locals.authSession;
    const local = await getClusterNode();
    migrateLegacyRecentSessions(session.username, stableLegacyRecents(readLegacyRecentSessions(session.userId)), local.id);
    response.json({ recentSessions: listUserRecentSessions(session.username) });
  } catch (error) {
    next(error);
  }
});
app.put("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const entry = recentSessionSchema.parse(request.body);
    const project = await getProject(entry.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const local = await getClusterNode();
    const { recentSessions, changed } = setUserRecentSession(session.username, { ...entry, projectId: project.id }, local.id);
    response.json({ recentSessions });
    if (changed) broadcastToAllClients({ type: "recentsChanged" });
  } catch (error) {
    next(error);
  }
});
app.delete("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const target = recentSessionIdentitySchema.parse(request.body);
    const project = await getProject(target.projectId);
    const local = await getClusterNode();
    response.json({ recentSessions: removeUserRecentSession(session.username, { ...target, projectId: project?.id ?? target.projectId }, local.id) });
    broadcastToAllClients({ type: "recentsChanged" });
  } catch (error) {
    next(error);
  }
});
app.get("/api/pins", (_request, response) => {
  const session = response.locals.authSession;
  response.json(listUserPins(session.username));
});
app.put("/api/pins", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const payload = userPinSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (payload.pinned && !project) {
      sendError(response, 404, "Project not found");
      return;
    }
    if (payload.pinned && project && payload.kind === "conversation") {
      const tasks = await listTasks(project.id);
      const sessions = await listHarnessSessions({ ...project, additionalPaths: await projectAdditionalPaths(project.id, tasks) });
      if (!sessions.some((candidate) => candidate.id === payload.sessionId && candidate.harnessId === payload.engine)) {
        sendError(response, 404, "Conversation not found");
        return;
      }
    }
    const local = await getClusterNode();
    const projectId = project?.id ?? payload.projectId;
    const target = payload.kind === "project" ? { kind: payload.kind, projectId } : { kind: payload.kind, projectId, engine: payload.engine, sessionId: payload.sessionId };
    const pins = setUserPin(session.username, target, payload.pinned, local.id);
    broadcastToAllClients({ type: "pinsChanged" });
    response.json(pins);
  } catch (error) {
    next(error);
  }
});
const canvasShortcutTargetSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  engine: registeredHarnessIdSchema,
  sessionId: z.string().trim().min(1).max(200)
}).strict();
app.get("/api/canvas/shortcuts", (_request, response) => {
  const session = response.locals.authSession;
  response.json({ shortcuts: listCanvasShortcuts(session.username) });
});
app.put("/api/canvas/shortcuts/:binding", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const target = canvasShortcutTargetSchema.parse(request.body);
    const local = await getClusterNode();
    const shortcuts = setCanvasShortcut(session.username, request.params.binding, target, local.id);
    broadcastToAllClients({ type: "shortcutsChanged" });
    response.json({ shortcuts });
  } catch (error) {
    if (error instanceof Error && /canvas binding/i.test(error.message)) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});
app.post("/api/canvas/shortcuts/release", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const target = canvasShortcutTargetSchema.parse(request.body);
    const local = await getClusterNode();
    const shortcuts = releaseCanvasShortcuts(session.username, [target], local.id);
    broadcastToAllClients({ type: "shortcutsChanged" });
    response.json({ shortcuts });
  } catch (error) {
    next(error);
  }
});
app.delete("/api/canvas/shortcuts/:binding", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const local = await getClusterNode();
    const shortcuts = clearCanvasShortcut(session.username, request.params.binding, local.id);
    broadcastToAllClients({ type: "shortcutsChanged" });
    response.json({ shortcuts });
  } catch (error) {
    if (error instanceof Error && /canvas binding/i.test(error.message)) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});
function canvasLayoutExceedsLimits(value) {
  if (!value || typeof value !== "object") return false;
  const layout = value;
  if (Array.isArray(layout.pages)) {
    if (layout.pages.length > 9) return true;
    let nodes2 = 0;
    for (const page of layout.pages) {
      if (!page || typeof page !== "object") return true;
      const root2 = page.root;
      const stack2 = root2 ? [[root2, 0]] : [];
      let pagePanes = 0;
      while (stack2.length) {
        const [node, depth] = stack2.pop();
        if (!node || typeof node !== "object") continue;
        if (++nodes2 > 160 || depth > 8) return true;
        const item = node;
        if (item.kind === "pane" && ++pagePanes > 8) return true;
        stack2.push([item.first, depth + 1], [item.second, depth + 1]);
      }
    }
  }
  if (Array.isArray(layout.rows)) {
    if (layout.rows.length > 10) return true;
    const oversizedRow = layout.rows.some((row) => !row || typeof row !== "object" || !Array.isArray(row.panes) || row.panes.length > 8);
    if (oversizedRow) return true;
  }
  const root = layout.root;
  if (!root || typeof root !== "object") return false;
  const stack = [[root, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++nodes > 80 || depth > 8) return true;
    const item = node;
    stack.push([item.first, depth + 1], [item.second, depth + 1]);
  }
  return false;
}
app.put("/api/preferences", (request, response, next) => {
  try {
    const session = response.locals.authSession;
    if (canvasLayoutExceedsLimits(request.body.canvasLayout)) {
      sendError(response, 400, "Canvas layout is too large or too deep");
      return;
    }
    const parsed = userPreferencesSchema.parse(request.body);
    const { canvasLayout, canvasKeymap, ...preferences } = parsed;
    const update = preferences;
    if (canvasKeymap) update.canvasKeymap = normalizeCanvasKeymapPreference(canvasKeymap);
    if (canvasLayout) update.canvasLayout = normalizeCanvasLayoutPreference(canvasLayout);
    response.json(updateUserPreferences(session.userId, update));
  } catch (error) {
    next(error);
  }
});
app.get("/api/audit", async (request, response, next) => {
  try {
    const { limit } = auditQuerySchema.parse(request.query);
    response.json({ events: await listAuditEvents(limit) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    next(error);
  }
});
let syncingSkills = false;
const skillSyncSchema = z.object({ paths: resourcePathsSchema.shape.skills.min(1) }).strict();
app.post("/api/settings/skills/sync", async (request, response, next) => {
  if (syncingSkills) {
    sendError(response, 409, "A skill publish is already running");
    return;
  }
  try {
    const { paths } = skillSyncSchema.parse(request.body);
    syncingSkills = true;
    await (await import("../skill-sharing.js")).ensureLegacySkillSyncPaused();
    response.json(await syncLocalSkills(paths));
  } catch (error) {
    const validation = error instanceof Error && /^(Skill paths|Skill file|Invalid skill|No valid SKILL|Conflicting skill|Nested symbolic link|Unsupported file type|Skill source and destination overlap|Skill destination is a symbolic link|Received skills cannot)/.test(error.message);
    if (error instanceof z.ZodError || validation || error.code === "ENOENT") {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid skill paths");
      return;
    }
    next(error);
  } finally {
    syncingSkills = false;
  }
});
app.post("/api/settings/skills/reload", async (_request, response, next) => {
  try {
    response.json(await reloadSharedSkills());
  } catch (error) {
    next(error);
  }
});
app.get("/api/settings", (_request, response) => {
  response.json(getSettings());
});
app.get("/api/settings/sync-check", (_request, response) => {
  response.json(syncCheckStatus());
});
app.post("/api/settings/sync-check/run", async (_request, response, next) => {
  try {
    response.json(await runSyncCheck());
  } catch (error) {
    next(error);
  }
});
app.get("/api/settings/runtime-defaults", (_request, response) => {
  response.json(getRuntimeDefaults());
});
app.post("/api/settings/runtime-check", (request, response, next) => {
  try {
    response.json(checkRuntimeSettings(runtimeCheckSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    next(error);
  }
});
app.put("/api/settings", async (request, response, next) => {
  try {
    const session = response.locals.authSession;
    const payload = settingsSchema.parse(request.body);
    const homePath = payload.projects?.homePath ?? getSettings().projects.homePath;
    if (!homePath.trim() || !path.isAbsolute(homePath)) throw new Error("Joint Bob home folder must be absolute");
    await assertManagedHomeChangeAllowed(homePath);
    await ensureManagedHome(homePath, (await listWorkspaces()).map((workspace) => workspace.id));
    const settings = updateSettings(payload, session.userId);
    clearHarnessSessionCache();
    resetSyncthingConnection();
    response.json(settings);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && (error.message === "Syncthing endpoint must use a loopback host" || error.message === "Joint Bob home folder must be absolute" || /^(Pi|Claude) (config path|session path) must be blank or absolute$/.test(error.message) || /^(Pi|Claude) (config|session) path must (not be under the OS temporary directory|be under the current home directory)$/.test(error.message) || error.message === "Pi and Claude session paths must not overlap" || /^(Pi|Claude) executable must be a command name or absolute path$/.test(error.message) || error.message.includes("Resource paths") || error.message.includes("resource paths") || error.message.startsWith("Sync check "))) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});
app.get("/api/projects/:projectId/resource-paths", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    response.json({ resources: getProjectResourcePaths(project.id) });
  } catch (error) {
    next(error);
  }
});
app.put("/api/projects/:projectId/resource-paths", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) {
      sendError(response, 404, "Project not found");
      return;
    }
    const payload = z.object({ resources: resourcePathsSchema }).strict().parse(request.body);
    const session = response.locals.authSession;
    response.json({ resources: updateProjectResourcePaths(project.id, payload.resources, session.userId) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Resource paths")) {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid resource paths");
      return;
    }
    next(error);
  }
});
