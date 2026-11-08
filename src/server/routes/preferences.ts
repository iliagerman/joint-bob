import { forwardRoamingEdit, HomeOfflineError, roamingPreferences } from "../roaming.js";
import { projectAdditionalPaths } from "../session-scope.js";
import { assertProjectFolderAllowed, ProjectFolderError, projectHomeFor } from "../../project-runtime.js";
import { actingAccount } from "../../account-context.js";
import { isNodeAdmin } from "../admin.js";
import { personalSettings, terminalAccessSettings, updatePersonalSettings, updateTerminalAccessSettings } from "../../settings.js";
import path from "node:path";
import { runSyncCheck, syncCheckStatus } from "../sync-check.js";
import { z } from "zod";
import { syncLocalSkills } from "../../agent-resources.js";
import { listAuditEvents } from "../../audit.js";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { clearHarnessSessionCache, harnessForSessionPath, listHarnessSessions } from "../../harnesses.js";
import { ensureManagedHome } from "../../managed-home.js";
import { getUserPreferences, normalizeKeymapPreference, readLegacyRecentSessions, type RecentSession, updateUserPreferences, type UserPreferences } from "../../preferences.js";
import { listUserRecentSessions, migrateLegacyRecentSessions, removeUserRecentSession, setUserRecentSession, type SyncedRecentSession } from "../../recent-sessions.js";
import { checkRuntimeSettings, getProjectResourcePaths, getRuntimeDefaults, getSettings, updateProjectResourcePaths, updateSettings } from "../../settings.js";
import { getProject, listWorkspaces } from "../../store.js";
import { resetSyncthingConnection } from "../../syncthing.js";
import { listTasks } from "../../tasks.js";
import { isHarnessId } from "../../types.js";
import { listUserPins, setUserPin } from "../../user-pins.js";
import { assertManagedHomeChangeAllowed } from "../cluster-helpers.js";
import { Feature, requireFeature, sendError } from "../http-auth.js";
import { broadcastToAllClients, reloadSharedSkills } from "../realtime.js";
import { auditQuerySchema, labelIconRequestSchema, recentSessionIdentitySchema, recentSessionSchema, registeredHarnessIdSchema, resourcePathsSchema, runtimeCheckSchema, settingsSchema, userPinSchema, userPreferencesSchema } from "../schemas.js";
import { generateLabelIcon } from "../label-icon.js";
import { currentBackgroundAgent, forgetHarnessReadiness } from "../../background-agent.js";
import { knownReadyHarnesses } from "../../harness-readiness.js";
import { app } from "../state.js";
import { announceCommandChanges, registerSavedCommandRoutes } from "../saved-commands.js";

registerSavedCommandRoutes();

// Block settings access for replicated users
// Settings are shaped by role: the admin sees the node's, everyone else only their own.

app.get("/api/preferences", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json(getUserPreferences(session.userId));
});

function stableLegacyRecents(entries: RecentSession[]): SyncedRecentSession[] {
  const stable: SyncedRecentSession[] = [];
  for (const entry of entries) {
    try {
      const adapter = entry.engine && entry.sessionId ? null : harnessForSessionPath(entry.sessionPath);
      const engine = entry.engine ?? adapter?.id;
      const sessionId = entry.sessionId ?? adapter?.paths.sessionId(entry.sessionPath);
      if (engine && sessionId && isHarnessId(engine) && Number.isFinite(Date.parse(entry.openedAt))) {
        stable.push({ ...entry, engine, sessionId, updatedAt: entry.updatedAt ?? null });
      }
    } catch { /* Stored legacy preference JSON is an external persistence boundary. */ }
  }
  return stable;
}

app.get("/api/recents", async (_request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const local = await getClusterNode();
    migrateLegacyRecentSessions(session.accountId, stableLegacyRecents(readLegacyRecentSessions(session.userId)), local.id);
    response.json({ recentSessions: listUserRecentSessions(session.accountId) });
  } catch (error) { next(error); }
});

app.put("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const entry = recentSessionSchema.parse(request.body);
    const project = await getProject(entry.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    const { recentSessions, changed } = setUserRecentSession(session.accountId, { ...entry, projectId: project.id }, local.id);
    response.json({ recentSessions });
    if (changed) broadcastToAllClients({ type: "recentsChanged" }, (response.locals.authSession as AuthSession).accountId);
  } catch (error) { next(error); }
});

app.delete("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const target = recentSessionIdentitySchema.parse(request.body);
    const project = await getProject(target.projectId);
    const local = await getClusterNode();
    response.json({ recentSessions: removeUserRecentSession(session.accountId, { ...target, projectId: project?.id ?? target.projectId }, local.id) });
    broadcastToAllClients({ type: "recentsChanged" }, (response.locals.authSession as AuthSession).accountId);
  } catch (error) { next(error); }
});

app.get("/api/pins", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json(listUserPins(session.accountId));
});

app.put("/api/pins", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = userPinSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (payload.pinned && !project) { sendError(response, 404, "Project not found"); return; }
    // Removing an account pin must work even when its transcript or project is gone.
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
    const target = payload.kind === "project"
      ? { kind: payload.kind, projectId } as const
      : { kind: payload.kind, projectId, engine: payload.engine, sessionId: payload.sessionId } as const;
    const pins = setUserPin(session.accountId, target, payload.pinned, local.id);
    broadcastToAllClients({ type: "pinsChanged" }, (response.locals.authSession as AuthSession).accountId);
    response.json(pins);
  } catch (error) {
    next(error);
  }
});

app.put("/api/preferences", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const parsed = userPreferencesSchema.parse(request.body);
    const { canvasLayout: _removedCanvasLayout, canvasKeymap, ...preferences } = parsed;
    const update: Partial<UserPreferences> = preferences;
    if (canvasKeymap) update.canvasKeymap = normalizeKeymapPreference(canvasKeymap);
    // A visitor's travelling preferences (theme, sounds, keymap…) change at home first.
    if (session.isRemoteLogin) {
      const current = getUserPreferences(session.userId) as unknown as Record<string, unknown>;
      const changed = Object.fromEntries(Object.keys(roamingPreferences.shape).filter((key) => key in update && JSON.stringify((update as Record<string, unknown>)[key]) !== JSON.stringify(current[key])).map((key) => [key, (update as Record<string, unknown>)[key]]));
      if (Object.keys(changed).length) await forwardRoamingEdit(session.accountId, { preferences: changed });
    }
    response.json(updateUserPreferences(session.userId, update));
  } catch (error) {
    if (error instanceof HomeOfflineError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

app.get("/api/audit", async (request, response, next) => {
  try {
    const { limit } = auditQuerySchema.parse(request.query);
    // Even the admin sees node events and their own, not other people's activity.
    response.json({ events: await listAuditEvents(limit, (response.locals.authSession as AuthSession).userId) });
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
  if (syncingSkills) { sendError(response, 409, "A skill publish is already running"); return; }
  try {
    const { paths } = skillSyncSchema.parse(request.body);
    syncingSkills = true;
    const sharing = await import("../skill-sharing.js");
    await sharing.ensureLegacySkillSyncPaused();
    const result = await syncLocalSkills(paths);
    response.json(result);
    // Nodes these skills are shared with fetch the new copies now rather than on their next refresh.
    if (result.published.length) sharing.announceSkillChanges(result.published).catch((error) => console.warn("Skill change notices failed", error));
  } catch (error) {
    const validation = error instanceof Error && /^(Skill paths|Skill file|Invalid skill|No valid SKILL|Conflicting skill|Nested symbolic link|Unsupported file type|Skill source and destination overlap|Skill destination is a symbolic link|Received skills cannot)/.test(error.message);
    if (error instanceof z.ZodError || validation || (error as NodeJS.ErrnoException).code === "ENOENT") {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid skill paths"); return;
    }
    next(error);
  } finally { syncingSkills = false; }
});

app.post("/api/settings/skills/reload", async (_request, response, next) => {
  try { response.json(await reloadSharedSkills()); } catch (error) { next(error); }
});

app.get("/api/settings", (_request, response) => {
  if (isNodeAdmin(response.locals.authSession as AuthSession)) { response.json(getSettings()); return; }
  response.json(personalSettingsView());
});

/** What a member or visitor sees of settings: their own values, and where their projects go. */
function personalSettingsView(): Record<string, unknown> {
  return { ...personalSettings(), projects: { homePath: projectHomeFor(actingAccount(), getSettings().projects.homePath) } };
}

const personalSettingsSchema = z.object({
  conversationLabels: z.array(z.string()).optional(),
  conversationHistoryDays: z.number().int().min(1).max(3650).optional(),
  autoCompactThreshold: z.number().int().min(1).max(100).nullable().optional(),
  digestAttachments: z.boolean().optional(),
  showProjectsOnOtherNodes: z.boolean().optional(),
  conversationCommands: z.unknown().optional(),
  conversationDefaults: z.unknown().optional(),
}).strict();

app.put("/api/settings/personal", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const input = personalSettingsSchema.parse(request.body) as Parameters<typeof updatePersonalSettings>[0];
    // A visitor's settings belong to their home node; the edit goes there first.
    if (session.isRemoteLogin) await forwardRoamingEdit(session.accountId, { settings: input as Record<string, unknown> });
    else {
      updatePersonalSettings(input, undefined, session.userId);
      if (input.conversationCommands) await announceCommandChanges();
    }
    response.json(isNodeAdmin(session) ? getSettings() : personalSettingsView());
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    if (error instanceof HomeOfflineError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

const terminalPolicySchema = z.object({
  mode: z.enum(["off", "admin", "everyone", "selected"]).optional(),
  accounts: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(1000).optional(),
  maxPerUser: z.number().int().min(1).max(20).optional(),
  idleMinutes: z.number().int().min(1).max(1440).optional(),
  dismissNotice: z.boolean().optional(),
}).strict();

app.get("/api/terminal-policy", (_request, response) => {
  response.json(terminalAccessSettings());
});

app.put("/api/terminal-policy", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    response.json(updateTerminalAccessSettings(terminalPolicySchema.parse(request.body), session.userId));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    next(error);
  }
});

app.get("/api/settings/sync-check", (_request, response) => {
  response.json(syncCheckStatus());
});

// Which agent runs background work here now, and which agents are signed in; checked again when asked with ?check=1.
app.get("/api/settings/background-agent", async (request, response, next) => {
  try {
    if (request.query.check === "1") forgetHarnessReadiness();
    const agent = await currentBackgroundAgent();
    response.json({ agent, ready: knownReadyHarnesses()?.ready ?? [] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/sync-check/run", async (_request, response, next) => {
  try { response.json(await runSyncCheck()); } catch (error) { next(error); }
});

app.get("/api/settings/runtime-defaults", (_request, response) => {
  response.json(getRuntimeDefaults());
});

app.post("/api/settings/runtime-check", (request, response, next) => {
  try {
    response.json(checkRuntimeSettings(runtimeCheckSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    next(error);
  }
});

app.post("/api/settings/label-icon", async (request, response, next) => {
  try {
    const payload = labelIconRequestSchema.parse(request.body);
    response.json({ icon: await generateLabelIcon(payload.label, payload) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
    if (error instanceof Error && /^(Icon harness|No agent|The agent did not)/.test(error.message)) { sendError(response, 422, error.message); return; }
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = settingsSchema.parse(request.body);
    const homePath = payload.projects?.homePath ?? getSettings().projects.homePath;
    if (!homePath.trim() || !path.isAbsolute(homePath)) throw new Error("Joint Bob home folder must be absolute");
    await assertManagedHomeChangeAllowed(homePath);
    await ensureManagedHome(homePath, (await listWorkspaces()).map((workspace) => workspace.id));
    const settings = updateSettings(payload, session.userId);
    const { publishSystemAiSettings } = await import("../../system-ai-replication.js");
    await publishSystemAiSettings(["backgroundAgent", "syncCheck", "dashboards"].filter(key => key in payload));
    // Paths, Kiro on or off, or defaults can change which agents are ready for background work.
    forgetHarnessReadiness();
    if (payload.conversationCommands) await announceCommandChanges();
    clearHarnessSessionCache();
    resetSyncthingConnection();
    response.json(settings);
  } catch (error) {
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => issue.message).join(", "));
      return;
    }
    if (error instanceof Error && (
      error.message === "Syncthing endpoint must use a loopback host" ||
      error.message === "Joint Bob home folder must be absolute" ||
      /^(Pi|Claude) (config path|session path) must be blank or absolute$/.test(error.message) ||
      /^(Pi|Claude) (config|session) path must (not be under the OS temporary directory|be under the current home directory)$/.test(error.message) ||
      error.message === "Pi and Claude session paths must not overlap" ||
      /^(Pi|Claude) executable must be a command name or absolute path$/.test(error.message) ||
      error.message.includes("Resource paths") || error.message.includes("resource paths") ||
      error.message.startsWith("Sync check ") ||
      error.message.startsWith("Dashboard agent ") ||
      error.message.startsWith("Background agent ")
    )) {
      sendError(response, 400, error.message);
      return;
    }
    next(error);
  }
});

app.get("/api/projects/:projectId/resource-paths", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ resources: getProjectResourcePaths(project.id) });
  } catch (error) { next(error); }
});

app.put("/api/projects/:projectId/resource-paths", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const payload = z.object({ resources: resourcePathsSchema }).strict().parse(request.body);
    const session = response.locals.authSession as AuthSession;
    // The node reads these folders with its own rights, so they stay inside the person's home.
    for (const entry of Object.values(payload.resources).flat()) await assertProjectFolderAllowed(actingAccount(), entry);
    response.json({ resources: updateProjectResourcePaths(project.id, payload.resources, session.userId) });
  } catch (error) {
    if (error instanceof ProjectFolderError) { sendError(response, 400, error.message); return; }
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Resource paths")) { sendError(response, 400, error instanceof Error ? error.message : "Invalid resource paths"); return; }
    next(error);
  }
});
