import { createHash } from "node:crypto";
import { z } from "zod";
import { getDeliveryStatus } from "../background-completions.js";
import { readBackgroundTaskIdentity, readBackgroundTasks, readPersistedBackgroundTask, type BackgroundTask, type TaskCursor } from "../background-tasks.js";
import { getClusterMachineToken, getClusterNode, getClusterPeer, listClusterPeers } from "../cluster.js";
import { resolveDataDirectory } from "../data-directory.js";
import { systemPromptState } from "../prompt-queue.js";
import { getProject, projectAliasIds } from "../store.js";
import { supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { readCompletionDisposition, readCompletionDispositions, type CompletionDisposition } from "../../scripts/supervised-shell.mjs";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";

const scope = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
}).strict();
const cursor = z.object({ startedAt: z.string().min(1).max(100), id: z.string().uuid() }).strict();
const id = z.string().uuid();
export const backgroundTaskCommandSchema = z.discriminatedUnion("action", [
  scope.extend({ action: z.literal("list"), limit: z.number().int().min(1).max(100).default(50), before: cursor.optional() }).strict(),
  scope.extend({ action: z.literal("get"), id }).strict(),
  scope.extend({ action: z.literal("output"), id, offset: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(65536).default(65536) }).strict(),
  scope.extend({ action: z.literal("stop"), id }).strict(),
]);
export type BackgroundTaskCommand = z.infer<typeof backgroundTaskCommandSchema>;
export class TaskRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const status = z.enum(["starting", "running", "stopping", "completed", "failed", "stopped", "unknown"]);
const completionSchema = z.object({
  state: z.enum(["pending", "queued", "blocked", "starting", "consumed"]),
  targetNodeId: z.string().uuid().nullable(), error: z.string().max(200).nullable(),
}).strict();
const publicTaskSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status,
  pid: z.number().int().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  nodeId: z.string().uuid(),
  nodeName: z.string(),
  completion: completionSchema.optional(),
}).strict();
const outputSchema = z.object({
  chunk: z.string().max(87384).refine((value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), "Invalid output encoding"),
  nextOffset: z.number().int().nonnegative().safe(),
  size: z.number().int().nonnegative().safe(),
  eof: z.boolean(),
}).strict().refine((value) => value.nextOffset <= value.size, "Invalid output offsets");
type PublicTask = z.infer<typeof publicTaskSchema>;
interface ListResult {
  tasks: PublicTask[];
  node: {
    nodeId: string;
    nodeName: string;
    supported: boolean;
    available: boolean;
    nextCursor: TaskCursor | null;
    reason?: string;
  };
}

async function projectScope(command: BackgroundTaskCommand, callerNodeId?: string): Promise<{ identities: string[]; projectId: string }> {
  const project = await getProject(command.projectId);
  if (!project) throw new TaskRequestError(404, "Project not found");
  if (callerNodeId) {
    const local = (await getClusterNode()).id;
    if (callerNodeId !== local && !(await clusterPeerMayAccessProject(callerNodeId, project.id))) {
      throw new TaskRequestError(403, "Project is not shared with this node");
    }
  }
  const aliases = await projectAliasIds(project.id);
  if (aliases.length + 1 > 256) throw new TaskRequestError(400, "Too many project aliases");
  return {
    projectId: project.id,
    identities: [project.id, ...aliases].map((value) => JSON.stringify([value, command.conversationId])),
  };
}

function completionPromptId(sourceNodeId: string, taskId: string): string {
  const bytes = createHash("sha256").update(`${sourceNodeId}:${taskId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function completion(value: Record<string, unknown>, nodeId: string, projectId: string, conversationId: string, dispositions?: ReadonlyMap<string, CompletionDisposition>): z.infer<typeof completionSchema> | undefined {
  if (!["completed", "failed", "stopped", "unknown"].includes(String(value.status))) return undefined;
  if ((dispositions?.get(String(value.id)) ?? readCompletionDisposition(resolveDataDirectory(), String(value.id))) !== "deliver") return undefined;
  const delivery = getDeliveryStatus(String(value.id));
  if (!delivery) return { state: "pending", targetNodeId: null, error: null };
  let state: z.infer<typeof completionSchema>["state"] = delivery.deliveryState;
  if (delivery.targetNodeId === nodeId && delivery.deliveryState === "queued") {
    const queued = systemPromptState(`${projectId}:${conversationId}`, completionPromptId(nodeId, String(value.id)));
    if (queued === "starting" || queued === "consumed") state = queued;
  }
  return { state, targetNodeId: delivery.targetNodeId, error: delivery.error };
}

function publicTask(value: Record<string, unknown>, node: { id: string; name: string }, projectId?: string, conversationId?: string, dispositions?: ReadonlyMap<string, CompletionDisposition>): PublicTask {
  return publicTaskSchema.parse({
    id: value.id,
    name: value.name,
    status: value.status,
    pid: value.pid ?? null,
    startedAt: value.startedAt,
    endedAt: value.endedAt ?? null,
    exitCode: value.exitCode ?? null,
    signal: value.signal ?? null,
    nodeId: node.id,
    nodeName: node.name,
    ...(projectId && conversationId ? { completion: completion(value, node.id, projectId, conversationId, dispositions) } : {}),
  });
}

function supervisorError(error: unknown): TaskRequestError {
  const statusCode = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : 503;
  if (statusCode === 400) return new TaskRequestError(400, "Invalid output range");
  if (statusCode === 409) return new TaskRequestError(409, "Task state changed; refresh and try again");
  if (statusCode === 404) return new TaskRequestError(404, "Background task not found");
  return new TaskRequestError(503, "Background task supervisor is unavailable");
}

export async function localBackgroundTaskOperation(commandInput: BackgroundTaskCommand, callerNodeId?: string): Promise<unknown> {
  const command = backgroundTaskCommandSchema.parse(commandInput);
  const { identities } = await projectScope(command, callerNodeId);
  const node = await getClusterNode();
  const data = resolveDataDirectory();
  if (command.action === "list") {
    const stored = readBackgroundTasks(data, identities, command.limit, command.before);
    let live = true;
    try {
      await supervisorRequest(data, { action: "status" }, { timeoutMs: 1000 });
    } catch {
      live = false;
    }
    const dispositions = readCompletionDispositions(data, stored.tasks.map((value) => value.id));
    const tasks = stored.tasks.map((value) => publicTask({
      ...value,
      status: !live && ["starting", "running", "stopping"].includes(value.status) ? "unknown" : value.status,
    }, node, command.projectId, command.conversationId, dispositions));
    return {
      tasks,
      node: {
        nodeId: node.id,
        nodeName: node.name,
        supported: true,
        available: stored.available && live,
        nextCursor: stored.nextCursor,
        ...(!stored.available || !live ? { reason: "Background task supervisor is unavailable" } : {}),
      },
    } satisfies ListResult;
  }
  const identity = readBackgroundTaskIdentity(data, command.id);
  if (!identity || !identities.includes(identity)) throw new TaskRequestError(404, "Background task not found");
  try {
    if (command.action === "get" || command.action === "stop") {
      const value = await supervisorRequest<Record<string, unknown>>(data, {
        action: command.action === "get" ? "task" : "stop",
        id: command.id,
      });
      return publicTask(value, node, command.projectId, command.conversationId);
    }
    const result = await supervisorRequest(data, {
      action: "output",
      id: command.id,
      offset: command.offset,
      limit: command.limit,
    });
    return outputSchema.parse(result);
  } catch (error) {
    if (command.action === "get") {
      const stored = readPersistedBackgroundTask(data, command.id);
      if (stored && identities.includes(stored.identity)) return publicTask({ ...stored, status: ["starting", "running", "stopping"].includes(stored.status) ? "unknown" : stored.status }, node, command.projectId, command.conversationId);
    }
    if (error instanceof z.ZodError) throw new TaskRequestError(503, "Background task supervisor is unavailable");
    throw supervisorError(error);
  }
}

const listResponse = z.object({
  tasks: z.array(publicTaskSchema).max(100),
  node: z.object({
    nodeId: z.string().uuid(),
    nodeName: z.string(),
    supported: z.boolean(),
    available: z.boolean(),
    nextCursor: cursor.nullable(),
    reason: z.string().max(200).optional(),
  }).strict(),
}).strict();

export async function routeBackgroundTaskOperation(nodeId: string, commandInput: BackgroundTaskCommand): Promise<unknown> {
  const command = backgroundTaskCommandSchema.parse(commandInput);
  const local = await getClusterNode();
  if (nodeId === local.id) return localBackgroundTaskOperation(command);
  const peer = await getClusterPeer(nodeId);
  if (!peer) throw new TaskRequestError(404, "Cluster node not found");
  try {
    const response = await fetch(`${peer.url}/api/cluster/background-tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getClusterMachineToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) {
      const message = response.status === 403 && body.error === "Project is not shared with this node"
        ? body.error
        : response.status === 404
          ? "Background task not found"
          : "Background task node is unavailable";
      throw new TaskRequestError(response.status === 401 ? 503 : response.status, message);
    }
    if (command.action === "list") {
      const result = listResponse.parse(body);
      if (result.node.nodeId !== nodeId || result.tasks.some((task) => task.nodeId !== nodeId)) {
        throw new Error("Peer returned mismatched task ownership");
      }
      return result;
    }
    if (command.action === "output") return outputSchema.parse(body);
    const task = publicTaskSchema.parse(body);
    if (task.nodeId !== nodeId) throw new Error("Peer returned mismatched task ownership");
    return task;
  } catch (error) {
    if (error instanceof TaskRequestError) throw error;
    throw new TaskRequestError(503, "Background task node is unavailable");
  }
}

export async function discoverBackgroundTasks(projectId: string, conversationId: string): Promise<{ tasks: PublicTask[]; nodes: ListResult["node"][] }> {
  const command = backgroundTaskCommandSchema.parse({ action: "list", projectId, conversationId });
  await projectScope(command);
  const local = await getClusterNode();
  const peers = (await listClusterPeers()).filter((peer) => peer.id !== local.id);
  const allowed = [];
  for (const peer of peers) {
    if (await clusterPeerMayAccessProject(peer.id, projectId)) allowed.push(peer);
  }
  const results = await Promise.all(
    [{ id: local.id, name: local.name }, ...allowed.map((peer) => ({ id: peer.id, name: peer.name }))].map(async (node) => {
      try {
        return await routeBackgroundTaskOperation(node.id, command) as ListResult;
      } catch (error) {
        if (error instanceof TaskRequestError && error.status === 403) throw error;
        // Older peers do not expose this API during a rolling upgrade.
        return {
          tasks: [],
          node: {
            nodeId: node.id,
            nodeName: node.name,
            supported: true,
            available: false,
            nextCursor: null,
            reason: "Background task node is unavailable",
          },
        } satisfies ListResult;
      }
    }),
  );
  return {
    tasks: results.flatMap((result) => result.tasks).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)),
    nodes: results.map((result) => result.node),
  };
}
