import { z } from "zod";
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

const commandSchema = z.discriminatedUnion("action", [
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
type Command = z.infer<typeof commandSchema>;

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
  if (command.input.providerProfileId) {
    if (!command.input.creatorAccountId) throw new Error("A signed-in creator is required to select a profile");
    accessibleProviderProfile(command.input.creatorAccountId, command.input.providerProfileId, "automation");
  }
  command.input.creatorAccountId = existing?.creatorAccountId ?? command.input.creatorAccountId ?? null;
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
    // Hosting a scheduled task is running on this node; listing, running, deleting and reading history of existing ones is not.
    if (["create", "install", "update"].includes(command.action) && !await peerMayRunHere(response.locals.machineNodeId)) { sendError(response, 403, "This node does not accept runs from other nodes"); return; }
    response.json(await manageCron(command));
  } catch (error) { next(error); }
});
app.post("/api/cron", async (request, response, next) => {
  try {
    const payload = z.object({ nodeId: z.string().uuid(), command: commandSchema }).strict().parse(request.body);
    if (payload.command.action === "install") { sendError(response, 403, "Task installation is reserved for owner transfer"); return; }
    // A person must be able to see the command's project here. A command this node runs
    // itself is checked against the task; one for another node must name its project.
    const named = "projectId" in payload.command ? payload.command.projectId : "input" in payload.command ? payload.command.input.projectId : undefined;
    const local = payload.nodeId === (await getClusterNode()).id;
    const stored = !named && local && "id" in payload.command ? cronStore().get(payload.command.id) : undefined;
    const projectId = named ?? stored?.projectId;
    if (!projectId || !await getProject(projectId)) { sendError(response, 404, "Scheduled task not found"); return; }
    if (payload.command.action === "profiles") payload.command.accountId = actingAccount()?.accountId ?? null;
    if (payload.command.action === "create" || payload.command.action === "update") {
      payload.command.input.creatorAccountId = actingAccount()?.accountId ?? null;
      if (local && payload.command.input.providerProfileId) {
        if (!payload.command.input.creatorAccountId) throw new Error("Sign in to select a profile");
        accessibleProviderProfile(payload.command.input.creatorAccountId, payload.command.input.providerProfileId, "automation");
      }
    }
    response.json(await routeCommand(payload.nodeId, payload.command));
  } catch (error) { next(error); }
});
app.get("/api/projects/:projectId/cron", async (request, response, next) => {
  try {
    response.json(await listProjectCronTasks(request.params.projectId));
  } catch (error) { next(error); }
});
