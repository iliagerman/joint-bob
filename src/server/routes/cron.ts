import { z } from "zod";
import { getClusterMachineToken, getClusterNode, getClusterPeer, listClusterPeers } from "../../cluster.js";
import { cronInputSchema, cronRunSchema, cronStore, type CronTask } from "../../cron.js";
import { ensureConversationRecord, markCronConversation } from "../../conversation-records.js";
import { broadcastToProject } from "../realtime.js";
import { getProject } from "../../store.js";
import { cronConversationReady } from "../cron.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), projectId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("ready"), projectId: z.string().min(1), sessionId: z.string().min(1), engine: z.enum(["pi", "claude"]) }).strict(),
  z.object({ action: z.literal("create"), input: cronInputSchema }).strict(),
  z.object({ action: z.literal("install"), id: z.string().uuid(), input: cronInputSchema, runs: z.array(cronRunSchema).max(100) }).strict(),
  z.object({ action: z.literal("update"), id: z.string().uuid(), input: cronInputSchema }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("history"), id: z.string().uuid() }).strict(),
]);
type Command = z.infer<typeof commandSchema>;

async function routeCommand(nodeId: string, command: Command): Promise<unknown> {
  if (nodeId === (await getClusterNode()).id) return manageCron(command);
  const peer = await getClusterPeer(nodeId);
  if (!peer) throw new Error("Scheduled task owner is unavailable");
  const reply = await fetch(`${peer.url}/api/cluster/cron`, {
    method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(command), signal: AbortSignal.timeout(15000),
  });
  const body = await reply.json() as { error?: string };
  if (!reply.ok) throw new Error(body.error || `Scheduled task owner returned ${reply.status}`);
  return body;
}

async function savedTask(task: CronTask): Promise<{ task: CronTask }> {
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
  if (command.action === "list") {
    const project = await getProject(command.projectId);
    return { tasks: project ? store.list(project.id) : [] };
  }
  if (command.action === "ready") return { ready: await cronConversationReady(command.projectId, command.sessionId, command.engine) };
  if (command.action === "history") return { runs: store.history(command.id) };
  if (command.action === "delete") { store.delete(command.id); return { ok: true }; }
  const project = await getProject(command.input.projectId);
  if (!project) throw new Error("Project is not mapped on the execution node");
  command.input.projectId = project.id;
  if (command.input.sessionId) await cronConversationReady(command.input.projectId, command.input.sessionId, command.input.engine);
  if (command.action === "create" || command.action === "install") {
    if (command.input.ownerNodeId !== local.id) throw new Error("Task must be stored on its execution owner");
    return savedTask(command.action === "create" ? store.create(command.input) : store.install(command.id, command.input, command.runs));
  }
  const previous = store.get(command.id);
  if (!previous) throw new Error("Scheduled task not found");
  if (!previous.enabled && command.input.enabled && previous.lastRun?.sessionId && !await cronConversationReady(project.id, previous.lastRun.sessionId, previous.engine)) throw new Error("Previous scheduled conversation is still running");
  if (store.active(command.id)) {
    const { id, nextRun, lastRun, ...input } = previous;
    if (JSON.stringify({ ...input, enabled: command.input.enabled }) !== JSON.stringify(command.input)) throw new Error("Wait for the scheduled run to finish before editing");
  }
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
    response.json(await manageCron(commandSchema.parse(request.body)));
  } catch (error) { next(error); }
});
app.post("/api/cron", async (request, response, next) => {
  try {
    const payload = z.object({ nodeId: z.string().uuid(), command: commandSchema }).strict().parse(request.body);
    if (payload.command.action === "install") { sendError(response, 403, "Task installation is reserved for owner transfer"); return; }
    response.json(await routeCommand(payload.nodeId, payload.command));
  } catch (error) { next(error); }
});
app.get("/api/projects/:projectId/cron", async (request, response, next) => {
  try {
    const nodes = [await getClusterNode(), ...await listClusterPeers()];
    const results = await Promise.all(nodes.map(async node => {
      try { return { nodeId: node.id, ...await routeCommand(node.id, { action: "list", projectId: request.params.projectId }) as { tasks: unknown[] } }; }
      catch (error) { return { nodeId: node.id, tasks: [], error: error instanceof Error ? error.message : String(error) }; }
    }));
    response.json({ tasks: results.flatMap(result => result.tasks), errors: results.filter(result => "error" in result) });
  } catch (error) { next(error); }
});
