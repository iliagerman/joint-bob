import path from "node:path";
import { z } from "zod";
import type { NextFunction, Request, Response } from "express";
import { ASSISTANT_FILE_MAX_BYTES, assistantFilePath, deleteAssistantFile, listAssistantFiles, saveAssistantFile } from "../../assistant-capabilities.js";
import { assistantMemoryEnabled } from "../../assistant-resources.js";
import { readWebhookMemory, setWebhookMemoryEnabled, WEBHOOK_MEMORY_MAX_BYTES, writeWebhookMemory } from "../../webhook-memory.js";
import { WebhookResourceError } from "../../webhook-resources.js";
import { discoverWebhookGitSkills, importWebhookGitSkill, listWebhookSkills, removeWebhookSkill, uploadWebhookSkill, WEBHOOK_SKILL_MAX_FILES } from "../../webhook-skills.js";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { assistantLoginProfileIds, getPersonalAssistant, listPersonalAssistantTopics, personalAssistantDatabase, type PersonalAssistant } from "../../personal-assistants.js";
import { resourceInventory } from "../../resource-inventory.js";
import { getProject, projectVisible } from "../../store.js";
import { browserWebUrlSchema, type BrowserActor, type BrowserSessionView } from "../../browser-types.js";
import { browserOperation, browserRuntime } from "../browser.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";
import { announceAssistantChanges } from "../../assistant-collaboration/twin-sync.js";

const resourceNameList = z.array(z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)).max(1000);
const preferencesSchema = z.object({ disabledSkills: resourceNameList, disabledPlugins: resourceNameList }).strict();
const newLoginSchema = z.object({ label: z.string().trim().min(1).max(80), url: browserWebUrlSchema }).strict();
const attachSchema = z.object({ profileId: z.string().uuid() }).strict();

export interface AssistantResourcePreferences { disabledSkills: string[]; disabledPlugins: string[] }

export async function assistantResourcePreferences(assistantId: string): Promise<AssistantResourcePreferences> {
  const db = await personalAssistantDatabase();
  const row = db.prepare("SELECT disabled_skills skills, disabled_plugins plugins FROM personal_assistant_resources WHERE assistant_id=?").get(assistantId) as { skills: string; plugins: string } | undefined;
  return row ? { disabledSkills: JSON.parse(row.skills) as string[], disabledPlugins: JSON.parse(row.plugins) as string[] } : { disabledSkills: [], disabledPlugins: [] };
}

async function saveResourcePreferences(assistantId: string, preferences: AssistantResourcePreferences): Promise<void> {
  const db = await personalAssistantDatabase();
  db.prepare(`INSERT INTO personal_assistant_resources (assistant_id, disabled_skills, disabled_plugins) VALUES (?,?,?)
    ON CONFLICT(assistant_id) DO UPDATE SET disabled_skills=excluded.disabled_skills, disabled_plugins=excluded.disabled_plugins`)
    .run(assistantId, JSON.stringify([...new Set(preferences.disabledSkills)].sort()), JSON.stringify([...new Set(preferences.disabledPlugins)].sort()));
}

/** Every topic conversation of the assistant may open every attached login. Only grants this
    feature created are recorded, so detaching never removes a grant the person made by hand. */
export async function syncAssistantLoginGrants(assistantId: string, accountId: string): Promise<void> {
  const profileIds = await assistantLoginProfileIds(assistantId);
  if (!profileIds.length) return;
  const db = await personalAssistantDatabase();
  const topics = await listPersonalAssistantTopics(accountId, assistantId);
  if (!topics) throw new Error("Assistant not found");
  const runtime = browserRuntime();
  const local = (await getClusterNode()).id;
  for (const profileId of profileIds) {
    const grants = runtime.profileGrants(profileId);
    for (const topic of topics) {
      const recorded = db.prepare("SELECT 1 FROM personal_assistant_login_grants WHERE assistant_id=? AND profile_id=? AND project_id=? AND conversation_id=?").get(assistantId, profileId, topic.projectId, topic.sessionId);
      if (recorded) continue;
      if (grants.some(grant => grant.scope === "conversation" && grant.projectId === topic.projectId && grant.conversationId === topic.sessionId)) continue;
      runtime.grantProfileAccess(profileId, { scope: "conversation", projectId: topic.projectId, conversationId: topic.sessionId }, local);
      db.prepare("INSERT INTO personal_assistant_login_grants (assistant_id, profile_id, project_id, conversation_id) VALUES (?,?,?,?)").run(assistantId, profileId, topic.projectId, topic.sessionId);
    }
  }
}

async function detachLogin(assistantId: string, profileId: string): Promise<boolean> {
  const db = await personalAssistantDatabase();
  const removed = db.prepare("DELETE FROM personal_assistant_logins WHERE assistant_id=? AND profile_id=?").run(assistantId, profileId).changes;
  if (!removed) return false;
  const runtime = browserRuntime();
  const created = db.prepare("SELECT project_id projectId, conversation_id conversationId FROM personal_assistant_login_grants WHERE assistant_id=? AND profile_id=?").all(assistantId, profileId) as Array<{ projectId: string; conversationId: string }>;
  for (const grant of created) {
    if (runtime.profileGrants(profileId).some(item => item.scope === "conversation" && item.projectId === grant.projectId && item.conversationId === grant.conversationId)) {
      runtime.revokeProfileAccess(profileId, { scope: "conversation", projectId: grant.projectId, conversationId: grant.conversationId });
    }
  }
  db.prepare("DELETE FROM personal_assistant_login_grants WHERE assistant_id=? AND profile_id=?").run(assistantId, profileId);
  return true;
}

async function human(response: Response): Promise<BrowserActor> {
  const auth = response.locals.authSession as AuthSession;
  return { kind: "human", id: `${(await getClusterNode()).id}:${auth.userId}` };
}

function accountOf(response: Response): string { return (response.locals.authSession as AuthSession).accountId; }

async function visibleAssistant(response: Response, id: string): Promise<PersonalAssistant | undefined> {
  const entry = await getPersonalAssistant(accountOf(response), id);
  return entry && await projectVisible(entry.projectId) ? entry : undefined;
}

/** Logins live where the assistant runs: its browser profiles must be on that machine. */
async function onExecutionNode(response: Response, entry: PersonalAssistant): Promise<boolean> {
  const local = await getClusterNode();
  if (entry.nodeId && entry.nodeId !== local.id) { sendError(response, 409, "Open this assistant on its execution machine to manage its browser logins"); return false; }
  return true;
}

type LoginState = "idle" | "in-use" | "needs-sign-in";
async function loginView(profileId: string, entry: PersonalAssistant) {
  const runtime = browserRuntime();
  const profile = runtime.profile(profileId);
  const holder = runtime.profileHolder(profileId);
  let state: LoginState = "idle";
  let session: BrowserSessionView | null = null;
  if (holder) {
    session = await runtime.get(holder.id);
    state = session.loginRequest ? "needs-sign-in" : "in-use";
  }
  return { profileId, label: profile.label, sites: profile.sites ?? [], state, sessionId: session?.id ?? null, sourceConversation: holder?.conversationId === entry.sessionId };
}

app.get("/api/personal-assistants/:id/resources", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    const project = await getProject(entry.projectId);
    if (!project) { sendError(response, 404, "Assistant not found"); return; }
    const local = await getClusterNode();
    const onNode = !entry.nodeId || entry.nodeId === local.id;
    const harness = entry.executionSettings?.harnessId ?? entry.engine;
    const inventory = await resourceInventory({ projectPath: project.path, projectId: project.id, conversationId: entry.sessionId, ignoreAssistantPreferences: true });
    const preferences = await assistantResourcePreferences(entry.id);
    const usable = (activation: Record<string, { enabled: boolean } | undefined> | undefined) => !activation || activation[harness] === undefined || Boolean(activation[harness]?.enabled);
    const skills = inventory.skills.filter(skill => skill.harnesses.includes(harness as never) && usable(skill.activation))
      .map(skill => ({ name: skill.name, description: skill.description, origin: skill.origin, enabled: !preferences.disabledSkills.includes(skill.name) }));
    const plugins = inventory.plugins.filter(plugin => plugin.harnesses.includes(harness as never) && usable(plugin.activation))
      .map(plugin => ({ name: plugin.name, source: plugin.source, enabled: !preferences.disabledPlugins.includes(plugin.name) }));
    const mcpServers = [...new Map(inventory.mcpServers.map(server => [server.name, server])).values()]
      .map(server => ({ name: server.name, source: server.source, enabled: entry.mcpServerNames === null || entry.mcpServerNames.includes(server.name) }));
    const attached = onNode ? await assistantLoginProfileIds(entry.id) : [];
    const logins = onNode ? await Promise.all(attached.map(profileId => loginView(profileId, entry))) : [];
    const listed = onNode ? await browserOperation({ operation: "profiles", args: { projectId: entry.projectId, conversationId: entry.sessionId } }, await human(response), local.id) as { profiles: Array<{ id: string; label: string; sites?: string[] }> } : { profiles: [] };
    const savedLogins = listed.profiles.filter(profile => !attached.includes(profile.id)).map(profile => ({ profileId: profile.id, label: profile.label, sites: profile.sites ?? [] }));
    response.json({
      executionNode: { id: entry.nodeId || local.id, name: entry.nodeId && entry.nodeId !== local.id ? null : local.name, local: onNode },
      allowBrowser: entry.allowBrowser, preferences, skills, plugins, mcpServers, logins, savedLogins,
    });
  } catch (error) { next(error); }
});

app.put("/api/personal-assistants/:id/resources", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    const preferences = preferencesSchema.parse(request.body);
    await saveResourcePreferences(entry.id, preferences);
    announceAssistantChanges();
    response.json({ preferences: await assistantResourcePreferences(entry.id) });
  } catch (error) { if (error instanceof z.ZodError) { sendError(response, 400, "Invalid resource choices"); return; } next(error); }
});

/** New sign-in: a new persistent profile on the execution machine, opened for the person to sign in. */
app.post("/api/personal-assistants/:id/logins", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    if (!await onExecutionNode(response, entry)) return;
    const input = newLoginSchema.parse(request.body);
    const local = await getClusterNode();
    const started = await browserOperation({ operation: "start", args: { projectId: entry.projectId, engine: entry.engine, conversationId: entry.sessionId, appNodeId: local.id, url: input.url, profileName: input.label } }, await human(response), local.id) as { session: BrowserSessionView };
    const profileId = started.session.profileId;
    if (!profileId) throw new Error("Browser started without a saved profile");
    const db = await personalAssistantDatabase();
    db.prepare("INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)").run(entry.id, profileId, new Date().toISOString());
    await syncAssistantLoginGrants(entry.id, accountOf(response));
    announceAssistantChanges();
    response.status(201).json({ login: await loginView(profileId, entry), session: { id: started.session.id, nodeId: local.id } });
  } catch (error) { if (error instanceof z.ZodError) { sendError(response, 400, "Enter a name and an http(s) address"); return; } next(error); }
});

/** Sign in again: open the attached profile for the person, on its own machine. */
app.post("/api/personal-assistants/:id/logins/:profileId/open", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    if (!await onExecutionNode(response, entry)) return;
    const profileId = z.string().uuid().parse(request.params.profileId);
    if (!(await assistantLoginProfileIds(entry.id)).includes(profileId)) { sendError(response, 404, "Login not found"); return; }
    const local = await getClusterNode();
    const url = z.object({ url: browserWebUrlSchema.optional() }).strict().parse(request.body ?? {}).url;
    const started = await browserOperation({ operation: "start", args: { projectId: entry.projectId, engine: entry.engine, conversationId: entry.sessionId, appNodeId: local.id, profileId, ...(url ? { url } : {}) } }, await human(response), local.id) as { session: BrowserSessionView };
    response.json({ login: await loginView(profileId, entry), session: { id: started.session.id, nodeId: local.id } });
  } catch (error) { next(error); }
});

app.post("/api/personal-assistants/:id/logins/attach", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    if (!await onExecutionNode(response, entry)) return;
    const { profileId } = attachSchema.parse(request.body);
    const local = await getClusterNode();
    const listed = await browserOperation({ operation: "profiles", args: { projectId: entry.projectId, conversationId: entry.sessionId } }, await human(response), local.id) as { profiles: Array<{ id: string }> };
    if (!listed.profiles.some(profile => profile.id === profileId)) { sendError(response, 404, "This login isn't available to this assistant's conversation on this machine"); return; }
    const db = await personalAssistantDatabase();
    db.prepare("INSERT OR IGNORE INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)").run(entry.id, profileId, new Date().toISOString());
    await syncAssistantLoginGrants(entry.id, accountOf(response));
    announceAssistantChanges();
    response.status(201).json({ login: await loginView(profileId, entry) });
  } catch (error) { if (error instanceof z.ZodError) { sendError(response, 400, "Invalid login"); return; } next(error); }
});

app.delete("/api/personal-assistants/:id/logins/:profileId", async (request, response, next) => {
  try {
    const entry = await visibleAssistant(response, request.params.id);
    if (!entry) { sendError(response, 404, "Assistant not found"); return; }
    if (!await onExecutionNode(response, entry)) return;
    if (!await detachLogin(entry.id, z.string().uuid().parse(request.params.profileId))) { sendError(response, 404, "Login not found"); return; }
    announceAssistantChanges();
    response.status(204).end();
  } catch (error) { next(error); }
});

// ---- Files, memory and this assistant's own skills ----

/** The assistant, when this machine is where it runs. These live with it and don't move. */
async function localAssistant(response: Response, id: string): Promise<PersonalAssistant | undefined> {
  const entry = await visibleAssistant(response, id);
  if (!entry) { sendError(response, 404, "Assistant not found"); return undefined; }
  if (entry.nodeId && entry.nodeId !== (await getClusterNode()).id) { sendError(response, 409, "Open this assistant on its execution machine"); return undefined; }
  return entry;
}

export function resourceRoute(work: (request: Request, response: Response, entry: PersonalAssistant) => Promise<void>) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const entry = await localAssistant(response, request.params.id);
      if (entry) await work(request, response, entry);
    } catch (error) {
      if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map(issue => issue.message).join(", ")); return; }
      if (error instanceof WebhookResourceError) { sendError(response, error.statusCode, error.message); return; }
      next(error);
    }
  };
}

const filePath = (request: Request): string => z.string().min(1).max(1000).parse(request.query.path);

app.get("/api/personal-assistants/:id/files", resourceRoute(async (_request, response, entry) => {
  response.json({ files: await listAssistantFiles(entry.id) });
}));
app.post("/api/personal-assistants/:id/files", resourceRoute(async (request, response, entry) => {
  const body = z.object({ name: z.string().min(1).max(240), data: z.string().max(Math.ceil(ASSISTANT_FILE_MAX_BYTES * 4 / 3) + 4) }).strict().parse(request.body);
  await saveAssistantFile(entry.id, body.name, Buffer.from(body.data, "base64"));
  response.status(201).json({ files: await listAssistantFiles(entry.id) });
}));
app.get("/api/personal-assistants/:id/files/download", resourceRoute(async (request, response, entry) => {
  const file = await assistantFilePath(entry.id, filePath(request));
  response.download(file, path.basename(file), { dotfiles: "allow", headers: { "X-Content-Type-Options": "nosniff" } });
}));
app.delete("/api/personal-assistants/:id/files", resourceRoute(async (request, response, entry) => {
  await deleteAssistantFile(entry.id, filePath(request));
  response.json({ files: await listAssistantFiles(entry.id) });
}));

async function memoryView(entry: PersonalAssistant) {
  const memory = await readWebhookMemory(entry.id);
  return { enabled: assistantMemoryEnabled(await personalAssistantDatabase(), entry.id), content: memory.content, revision: memory.revision };
}
app.get("/api/personal-assistants/:id/memory", resourceRoute(async (_request, response, entry) => { response.json(await memoryView(entry)); }));
app.put("/api/personal-assistants/:id/memory", resourceRoute(async (request, response, entry) => {
  const body = z.object({ content: z.string().max(WEBHOOK_MEMORY_MAX_BYTES), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
  await writeWebhookMemory(await personalAssistantDatabase(), entry.id, body.expectedRevision, body.content);
  response.json(await memoryView(entry));
}));
app.put("/api/personal-assistants/:id/memory/enabled", resourceRoute(async (request, response, entry) => {
  setWebhookMemoryEnabled(await personalAssistantDatabase(), entry.id, z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled);
  response.json(await memoryView(entry));
}));

const ownSkillSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upload"), files: z.array(z.object({ relativePath: z.string().min(1).max(1000), data: z.string().max(5_592_408) }).strict()).max(WEBHOOK_SKILL_MAX_FILES) }).strict(),
  z.object({ action: z.literal("discover-git"), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional() }).strict(),
  z.object({ action: z.literal("import-git"), url: z.string().min(1).max(2048), ref: z.string().max(200).nullable().optional(), commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), key: z.string().min(1).max(1000) }).strict(),
]);
app.get("/api/personal-assistants/:id/own-skills", resourceRoute(async (_request, response, entry) => {
  response.json({ skills: listWebhookSkills(await personalAssistantDatabase(), entry.id) });
}));
app.post("/api/personal-assistants/:id/own-skills", resourceRoute(async (request, response, entry) => {
  const db = await personalAssistantDatabase();
  const body = ownSkillSchema.parse(request.body);
  if (body.action === "discover-git") { response.json(await discoverWebhookGitSkills(body.url, body.ref ?? null)); return; }
  const skill = body.action === "upload"
    ? await uploadWebhookSkill(db, entry.id, body.files.map(file => ({ relativePath: file.relativePath, data: Buffer.from(file.data, "base64") })))
    : await importWebhookGitSkill(db, entry.id, body.url, body.ref ?? null, body.commit, body.key);
  response.status(201).json({ skill });
}));
app.delete("/api/personal-assistants/:id/own-skills/:skillId", resourceRoute(async (request, response, entry) => {
  await removeWebhookSkill(await personalAssistantDatabase(), entry.id, z.string().uuid().parse(request.params.skillId));
  response.status(204).end();
}));

// The agent's side of memory: the capability token names the assistant, never the request.
app.post("/api/assistant-agent/memory", async (request, response, next) => {
  try {
    const assistantId = response.locals.assistantMemoryAgent as string | undefined;
    if (!assistantId) { sendError(response, 403, "Assistant memory capability required"); return; }
    const command = z.discriminatedUnion("action", [
      z.object({ action: z.literal("read") }).strict(),
      z.object({ action: z.literal("write"), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(WEBHOOK_MEMORY_MAX_BYTES) }).strict(),
    ]).parse(request.body);
    response.json(command.action === "read" ? await readWebhookMemory(assistantId) : await writeWebhookMemory(await personalAssistantDatabase(), assistantId, command.expectedRevision, command.content));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid memory command"); return; }
    if (error instanceof WebhookResourceError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});
