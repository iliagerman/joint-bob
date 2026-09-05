import path from "node:path";
import { z } from "zod";
import { listAuditEvents } from "../../audit.js";
import type { AuthSession } from "../../auth.js";
import { clearCanvasShortcut, listCanvasShortcuts, releaseCanvasShortcuts, setCanvasShortcut } from "../../canvas-shortcuts.js";
import { getClusterNode } from "../../cluster.js";
import { harnessForSessionPath, listHarnessSessions } from "../../harnesses.js";
import { ensureManagedHome } from "../../managed-home.js";
import { getUserPreferences, migrateLegacyCanvasLayout, normalizeCanvasKeymapPreference, normalizeCanvasLayoutPreference, readLegacyRecentSessions, type RecentSession, updateUserPreferences, type UserPreferences } from "../../preferences.js";
import { listUserRecentSessions, migrateLegacyRecentSessions, removeUserRecentSession, setUserRecentSession, type SyncedRecentSession } from "../../recent-sessions.js";
import { getProjectResourcePaths, getSettings, updateProjectResourcePaths, updateSettings } from "../../settings.js";
import { getProject, listWorkspaces } from "../../store.js";
import { resetSyncthingConnection } from "../../syncthing.js";
import { listTasks } from "../../tasks.js";
import { isHarnessId } from "../../types.js";
import { listUserPins, setUserPin } from "../../user-pins.js";
import { assertManagedHomeChangeAllowed } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { broadcastToAllClients } from "../realtime.js";
import { auditQuerySchema, recentSessionIdentitySchema, recentSessionSchema, registeredHarnessIdSchema, resourcePathsSchema, settingsSchema, userPinSchema, userPreferencesSchema } from "../schemas.js";
import { app } from "../state.js";

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
    migrateLegacyRecentSessions(session.username, stableLegacyRecents(readLegacyRecentSessions(session.userId)), local.id);
    response.json({ recentSessions: listUserRecentSessions(session.username) });
  } catch (error) { next(error); }
});

app.put("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const entry = recentSessionSchema.parse(request.body);
    const project = await getProject(entry.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    response.json({ recentSessions: setUserRecentSession(session.username, { ...entry, projectId: project.id }, local.id) });
    broadcastToAllClients({ type: "recentsChanged" });
  } catch (error) { next(error); }
});

app.delete("/api/recents", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const target = recentSessionIdentitySchema.parse(request.body);
    const project = await getProject(target.projectId);
    const local = await getClusterNode();
    response.json({ recentSessions: removeUserRecentSession(session.username, { ...target, projectId: project?.id ?? target.projectId }, local.id) });
    broadcastToAllClients({ type: "recentsChanged" });
  } catch (error) { next(error); }
});

app.get("/api/pins", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json(listUserPins(session.username));
});

app.put("/api/pins", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    const payload = userPinSchema.parse(request.body);
    const project = await getProject(payload.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    if (payload.kind === "conversation") {
      const tasks = await listTasks(project.id);
      const sessions = await listHarnessSessions({ ...project, additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []) });
      if (!sessions.some((candidate) => candidate.id === payload.sessionId && candidate.harnessId === payload.engine)) {
        sendError(response, 404, "Conversation not found");
        return;
      }
    }
    const local = await getClusterNode();
    const target = payload.kind === "project"
      ? { kind: payload.kind, projectId: project.id } as const
      : { kind: payload.kind, projectId: project.id, engine: payload.engine, sessionId: payload.sessionId } as const;
    const pins = setUserPin(session.username, target, payload.pinned, local.id);
    broadcastToAllClients({ type: "pinsChanged" });
    response.json(pins);
  } catch (error) {
    next(error);
  }
});

/* Canvas keyboard bindings belong to the account, not the node, so every route keys
   on the signed-in username and the store replicates the change to the cluster. */
const canvasShortcutTargetSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  engine: registeredHarnessIdSchema,
  sessionId: z.string().trim().min(1).max(200),
}).strict();

app.get("/api/canvas/shortcuts", (_request, response) => {
  const session = response.locals.authSession as AuthSession;
  response.json({ shortcuts: listCanvasShortcuts(session.username) });
});

app.put("/api/canvas/shortcuts/:binding", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
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

/* Closing a conversation releases the key it holds right now. Deleting the binding the
   page last saw would take a key another node has since moved to a different pane. */
app.post("/api/canvas/shortcuts/release", async (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
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
    const session = response.locals.authSession as AuthSession;
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

/** Iterative bound checked before the recursive Zod schema, so a pathologically
 * nested layout is rejected as a 400 instead of exhausting the parse stack. */
function canvasLayoutExceedsLimits(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const layout = value as { root?: unknown; rows?: unknown };
  if (Array.isArray(layout.rows)) {
    if (layout.rows.length > 10) return true;
    // 10 rows x 8 panes bounds a row payload; anything beyond is malformed.
    const oversizedRow = layout.rows.some((row) => !row || typeof row !== "object"
      || !Array.isArray((row as { panes?: unknown }).panes) || (row as { panes: unknown[] }).panes.length > 8);
    if (oversizedRow) return true;
  }
  // Inspect a root even when a malicious payload also supplies rows; otherwise
  // the extra property could bypass this iterative guard before Zod sees it.
  const root = layout.root;
  if (!root || typeof root !== "object") return false;
  const stack: Array<[unknown, number]> = [[root, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== "object") continue;
    if (++nodes > 80 || depth > 8) return true;
    // Descend regardless of kind: a malformed kind must not reach the recursive
    // schema parser and blow the stack before validation can reject it.
    const item = node as { first?: unknown; second?: unknown };
    stack.push([item.first, depth + 1], [item.second, depth + 1]);
  }
  return false;
}

app.put("/api/preferences", (request, response, next) => {
  try {
    const session = response.locals.authSession as AuthSession;
    if (canvasLayoutExceedsLimits((request.body as { canvasLayout?: unknown }).canvasLayout)) {
      sendError(response, 400, "Canvas layout is too large or too deep");
      return;
    }
    const parsed = userPreferencesSchema.parse(request.body);
    const { canvasLayout, canvasKeymap, ...preferences } = parsed;
    const update: Partial<UserPreferences> = preferences;
    if (canvasKeymap) update.canvasKeymap = normalizeCanvasKeymapPreference(canvasKeymap);
    if (canvasLayout) update.canvasLayout = canvasLayout.version === 1
      ? migrateLegacyCanvasLayout(canvasLayout)
      : normalizeCanvasLayoutPreference(canvasLayout);
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

app.get("/api/settings", (_request, response) => {
  response.json(getSettings());
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
      /^(Pi|Claude) executable must be a command name or absolute path$/.test(error.message) ||
      error.message.includes("Resource paths") || error.message.includes("resource paths")
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
    response.json({ resources: updateProjectResourcePaths(project.id, payload.resources, session.userId) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error && error.message.includes("Resource paths")) { sendError(response, 400, error instanceof Error ? error.message : "Invalid resource paths"); return; }
    next(error);
  }
});
