import { z } from "zod";
import { DEFAULT_AUTO_RESPOND_INSTRUCTIONS, DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, validateAutoRespondProfile } from "../../conversation-auto-respond.js";
import { getHarnessRuntime, listHarnesses, listHarnessModels } from "../../harnesses.js";
import type { HarnessId } from "../../types.js";
import { actingAccount } from "../../account-context.js";
import { assertAutomationCreator } from "../automation-profile.js";
import { accessibleProviderProfile, listAccessibleProviderProfiles } from "../../provider-profiles/store.js";
import { NotFoundError } from "../../not-found.js";
import { getClusterNode } from "../../cluster.js";
import { getRuntimePeer, runtimeFetch } from "../runtime-peers.js";
import { cronInputSchema, cronRunSchema, cronStore, type CronTask } from "../../cron.js";
import { automationWorkspaceIdentity, validateAutomationTagAssignments } from "../../automation-tags.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ensureConversationRecord, markCronConversation } from "../../conversation-records.js";
import { broadcastToProject } from "../realtime.js";
import { getProject } from "../../store.js";
import { cronConversationReady } from "../cron.js";
import { sendError } from "../http-auth.js";
import { registeredHarnessIdSchema } from "../schemas.js";
import { app } from "../state.js";
import { listProjectCronTasks } from "../cron-list.js";
import { peerMayRunHere } from "../cluster-helpers.js";
import { getPersonalAssistant } from "../../personal-assistants.js";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("models"), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("profiles"), projectId: z.string().min(1), accountId: z.string().nullable().optional() }).strict(),
  z.object({ action: z.literal("list"), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("ready"), projectId: z.string().min(1), sessionId: z.string().min(1), engine: registeredHarnessIdSchema }).strict(),
  z.object({ action: z.literal("create"), input: cronInputSchema }).strict(),
  z.object({ action: z.literal("install"), id: z.string().uuid(), input: cronInputSchema, runs: z.array(cronRunSchema).max(100) }).strict(),
  z.object({ action: z.literal("update"), id: z.string().uuid(), input: cronInputSchema }).strict(),
  // The project lets every node check that the task belongs where the caller says it does.
  z.object({ action: z.literal("run"), id: z.string().uuid(), projectId: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid(), projectId: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal("history"), id: z.string().uuid(), projectId: z.string().min(1).optional() }).strict(),
]);
export type CronCommand = z.infer<typeof commandSchema>;
type Command = CronCommand;

async function routeCommand(nodeId: string, command: Command, timeoutMs = 15000): Promise<unknown> {
  if (nodeId === (await getClusterNode()).id) return manageCron(command);
  const peer = await getRuntimePeer(nodeId);
  if (!peer) throw new Error("Scheduled task owner is unavailable");
  const reply = await runtimeFetch(`${peer.url}/api/cluster/cron`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command), signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await reply.json() as { error?: string };
  if (!reply.ok) throw new Error(body.error || `Scheduled task owner returned ${reply.status}`);
  return body;
}

async function savedTask(task: CronTask): Promise<{ task: CronTask }> {
  broadcastToProject(task.projectId, { type: "cronChanged" });
  if (task.sessionId) {
    await ensureConversationRecord(task.projectId, task.engine, task.sessionId, task.ownerNodeId);
    await markCronConversation(task.projectId, task.engine, task.sessionId, task.id, task.ownerNodeId);
    broadcastToProject(task.projectId, { type: "sessionsChanged" });
  }
  return { task };
}

async function manageCron(command: Command): Promise<unknown> {
  const store = cronStore();
  const local = await getClusterNode();
  if (command.action === "profiles") return { profiles: command.accountId ? listAccessibleProviderProfiles(command.accountId, "automation") : [] };
  if (command.action === "models") {
    if (!await getProject(command.projectId)) throw new NotFoundError("Project not found");
    const groups = await Promise.all(listHarnesses().filter(({ models }) => models).map(async ({ id }) =>
      (await listHarnessModels(id)).map(model => ({ ...model, harnessId: id }))));
    return { models: groups.flat() };
  }
  if (command.action === "list") {
    const project = await getProject(command.projectId);
    return { tasks: project ? store.list(project.id) : [] };
  }
  if (command.action === "ready") {
    if (!await getProject(command.projectId)) throw new NotFoundError("Project not found");
    return { ready: await cronConversationReady(command.projectId, command.sessionId, command.engine) };
  }
  // A task id from someone who can't see its project, or named under another project, is unknown.
  if (command.action !== "create" && command.action !== "install") {
    const task = store.get(command.id);
    const named = "projectId" in command && command.projectId ? command.projectId : "input" in command ? command.input.projectId : undefined;
    const project = task ? await getProject(task.projectId) : undefined;
    if (task && (!project || (named && (await getProject(named))?.id !== project.id))) throw new NotFoundError("Scheduled task not found");
  }
  if (command.action === "history") return { runs: store.history(command.id) };
  if (command.action === "run") return { task: store.runNow(command.id) };
  if (command.action === "delete") {
    const task = store.get(command.id);
    store.delete(command.id);
    if (task) broadcastToProject(task.projectId, { type: "cronChanged" });
    return { ok: true };
  }
  const project = await getProject(command.input.projectId);
  if (!project) throw new Error("Project is not mapped on the execution node");
  command.input.projectId = project.id;
  const tagDatabase = await clusterV2Database();
  const workspace = automationWorkspaceIdentity(tagDatabase, local.id, project.type ?? "personal");
  validateAutomationTagAssignments(tagDatabase, workspace.workspaceId, command.input.tags, workspace.ownerNodeId);
  const existing = command.action === "update" ? store.get(command.id) : null;
  if (existing) assertAutomationCreator(existing.creatorAccountId, command.input.creatorAccountId);
  if (command.input.assistantId) {
    const assistant = command.input.creatorAccountId ? await getPersonalAssistant(command.input.creatorAccountId, command.input.assistantId) : undefined;
    if (!assistant || assistant.projectId !== project.id || assistant.nodeId && assistant.nodeId !== local.id || command.input.ownerNodeId !== local.id || command.input.sessionId) {
      throw new Error("Assistant scheduled tasks must stay on their assistant's execution node");
    }
    if (command.input.model || command.input.reasoning) throw new Error("Assistant scheduled tasks use the assistant's execution settings");
    command.input.engine = assistant.executionSettings?.harnessId ?? command.input.engine;
    if (existing && existing.assistantId !== command.input.assistantId) throw new Error("Assistant target cannot be changed in place");
  }
  if (command.input.providerProfileId) {
    if (!command.input.creatorAccountId) throw new Error("A signed-in creator is required to select a profile");
    accessibleProviderProfile(command.input.creatorAccountId, command.input.providerProfileId, "automation");
  }
  command.input.creatorAccountId = existing?.creatorAccountId ?? command.input.creatorAccountId ?? null;
  if (command.input.autoRespond) {
    if (!command.input.creatorAccountId) throw new Error("Sign in to configure scheduled auto reply");
    validateAutoRespondProfile(command.input.creatorAccountId, command.input.autoRespond);
    const runtime = await getHarnessRuntime(command.input.autoRespond.harnessId as HarnessId);
    await runtime.validateSettings({ provider: command.input.autoRespond.provider, modelId: command.input.autoRespond.modelId, reasoning: command.input.autoRespond.thinkingLevel });
  }
  command.input.providerProfileId ??= null;
  if (command.input.providerProfileId) {
    if (!command.input.creatorAccountId) throw new Error("A signed-in creator is required to select a profile");
    accessibleProviderProfile(command.input.creatorAccountId, command.input.providerProfileId, "automation");
  }
  if (command.input.sessionId) await cronConversationReady(command.input.projectId, command.input.sessionId, command.input.engine);
  if (command.action === "create" || command.action === "install") {
    if (command.input.ownerNodeId !== local.id) throw new Error("Task must be stored on its execution owner");
    return savedTask(command.action === "create" ? store.create(command.input) : store.install(command.id, command.input, command.runs));
  }
  const previous = store.get(command.id);
  if (!previous) throw new Error("Scheduled task not found");
  if (store.active(command.id) && command.input.ownerNodeId !== previous.ownerNodeId) throw new Error("Wait for the scheduled run to finish before changing its execution node");
  if (command.input.ownerNodeId === local.id) return savedTask(store.update(command.id, command.input));
  // Pause the source durably before creating the destination. If a network
  // response is lost, neither copy can dispatch; the error asks the user to reconcile.
  const { id, nextRun, lastRun, ...input } = previous;
  store.update(id, { ...input, enabled: false });
  await routeCommand(command.input.ownerNodeId, { action: "install", id, input: { ...command.input, enabled: false }, runs: store.history(id) });
  store.delete(id);
  return routeCommand(command.input.ownerNodeId, { action: "update", id, input: command.input });
}

app.post("/api/cluster/cron", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const command = commandSchema.parse(request.body);
    // Hosting a schedule or triggering a run requires execution permission; reading and deleting do not.
    if (["create", "install", "update", "run"].includes(command.action) && !await peerMayRunHere(response.locals.machineNodeId)) { sendError(response, 403, "This node does not accept runs from other nodes"); return; }
    response.json(await manageCron(command));
  } catch (error) { next(error); }
});
/**
 * A person's scheduled-task command once it is parsed: they must be able to see its project, the creator is their
 * account, and the owner node (this one or a peer) runs it. The control center's automations table calls this too.
 */
export async function runCronCommand(nodeId: string, command: Command): Promise<unknown> {
  // A person must be able to see the command's project here. A command this node runs
  // itself is checked against the task; one for another node must name its project.
  const named = "projectId" in command ? command.projectId : "input" in command ? command.input.projectId : undefined;
  const local = nodeId === (await getClusterNode()).id;
  const stored = !named && local && "id" in command ? cronStore().get(command.id) : undefined;
  const projectId = named ?? stored?.projectId;
  if (!projectId || !await getProject(projectId)) throw new NotFoundError("Scheduled task not found");
  if (command.action === "profiles") command.accountId = actingAccount()?.accountId ?? null;
  if (command.action === "create" || command.action === "update") {
    command.input.creatorAccountId = actingAccount()?.accountId ?? null;
    if (local && command.input.providerProfileId) {
      if (!command.input.creatorAccountId) throw new Error("Sign in to select a profile");
      accessibleProviderProfile(command.input.creatorAccountId, command.input.providerProfileId, "automation");
    }
  }
  return routeCommand(nodeId, command);
}
app.post("/api/cron", async (request, response, next) => {
  try {
    const payload = z.object({ nodeId: z.string().uuid(), command: commandSchema }).strict().parse(request.body);
    if (payload.command.action === "install") { sendError(response, 403, "Task installation is reserved for owner transfer"); return; }
    response.json(await runCronCommand(payload.nodeId, payload.command));
  } catch (error) { next(error); }
});
app.get("/api/auto-respond/defaults", (_request, response) => {
  response.json({ instructions: DEFAULT_AUTO_RESPOND_INSTRUCTIONS, stopInstructions: DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, maxResponses: 10 });
});
app.get("/api/projects/:projectId/cron", async (request, response, next) => {
  try {
    response.json(await listProjectCronTasks(request.params.projectId));
  } catch (error) { next(error); }
});
