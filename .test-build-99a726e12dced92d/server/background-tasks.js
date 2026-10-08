import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { readActiveConversationTaskIds, readBackgroundTaskIdentity, readBackgroundTasks, readPersistedBackgroundTask } from "../background-tasks.js";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "./runtime-peers.js";
import { resolveDataDirectory } from "../data-directory.js";
import { getProject, projectAliasIds } from "../store.js";
import { supervisorRequest } from "../../scripts/supervisor-client.mjs";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { isPeerUnreachable } from "./peer-availability.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
const scope = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200)
}).strict();
const cursor = z.object({ startedAt: z.string().min(1).max(100), id: z.string().uuid() }).strict();
const id = z.string().uuid();
const backgroundTaskCommandSchema = z.discriminatedUnion("action", [
  scope.extend({ action: z.literal("list"), limit: z.number().int().min(1).max(100).default(50), before: cursor.optional() }).strict(),
  scope.extend({ action: z.literal("get"), id }).strict(),
  scope.extend({ action: z.literal("output"), id, offset: z.number().int().nonnegative().safe().default(0), limit: z.number().int().min(1).max(65536).default(65536) }).strict(),
  scope.extend({ action: z.literal("stop"), id }).strict()
]);
class TaskRequestError extends Error {
  constructor(status2, message) {
    super(message);
    this.status = status2;
  }
  status;
}
const status = z.enum(["starting", "running", "stopping", "completed", "failed", "stopped", "unknown"]);
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
  nodeName: z.string()
}).strict();
const outputSchema = z.object({
  chunk: z.string().max(87384).refine((value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), "Invalid output encoding"),
  nextOffset: z.number().int().nonnegative().safe(),
  size: z.number().int().nonnegative().safe(),
  eof: z.boolean()
}).strict().refine((value) => value.nextOffset <= value.size, "Invalid output offsets");
async function projectScope(command, callerNodeId) {
  const project = await getProject(command.projectId);
  if (!project) throw new TaskRequestError(404, "Project not found");
  if (callerNodeId) {
    const local = (await getClusterNode()).id;
    if (callerNodeId !== local && !await clusterPeerMayAccessProject(callerNodeId, project.id)) {
      throw new TaskRequestError(403, "Project is not shared with this node");
    }
  }
  const aliases = await projectAliasIds(project.id);
  if (aliases.length + 1 > 256) throw new TaskRequestError(400, "Too many project aliases");
  return {
    projectId: project.id,
    identities: [project.id, ...aliases].map((value) => JSON.stringify([value, command.conversationId]))
  };
}
function publicTask(value, node) {
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
    nodeName: node.name
  });
}
function supervisorError(error) {
  const statusCode = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 503;
  if (statusCode === 400) return new TaskRequestError(400, "Invalid output range");
  if (statusCode === 409) return new TaskRequestError(409, "Task state changed; refresh and try again");
  if (statusCode === 404) return new TaskRequestError(404, "Background task not found");
  return new TaskRequestError(503, "Background task supervisor is unavailable");
}
async function localBackgroundTaskOperation(commandInput, callerNodeId) {
  const command = backgroundTaskCommandSchema.parse(commandInput);
  const { identities } = await projectScope(command, callerNodeId);
  const node = await getClusterNode();
  const data = resolveDataDirectory();
  if (command.action === "list") {
    const stored = readBackgroundTasks(data, identities, command.limit, command.before);
    let live = true;
    try {
      await supervisorRequest(data, { action: "status" }, { timeoutMs: 1e3 });
    } catch {
      live = false;
    }
    const tasks = stored.tasks.map((value) => publicTask({
      ...value,
      status: !live && ["starting", "running", "stopping"].includes(value.status) ? "unknown" : value.status
    }, node));
    return {
      tasks,
      node: {
        nodeId: node.id,
        nodeName: node.name,
        supported: true,
        available: stored.available && live,
        nextCursor: stored.nextCursor,
        ...!stored.available || !live ? { reason: "Background task supervisor is unavailable" } : {}
      }
    };
  }
  const identity = readBackgroundTaskIdentity(data, command.id);
  if (!identity || !identities.includes(identity)) throw new TaskRequestError(404, "Background task not found");
  try {
    if (command.action === "get" || command.action === "stop") {
      const value = await supervisorRequest(data, {
        action: command.action === "get" ? "task" : "stop",
        id: command.id
      });
      return publicTask(value, node);
    }
    const result = await supervisorRequest(data, {
      action: "output",
      id: command.id,
      offset: command.offset,
      limit: command.limit
    });
    return outputSchema.parse(result);
  } catch (error) {
    if (command.action === "get") {
      const stored = readPersistedBackgroundTask(data, command.id);
      if (stored && identities.includes(stored.identity)) return publicTask({ ...stored, status: ["starting", "running", "stopping"].includes(stored.status) ? "unknown" : stored.status }, node);
    }
    if (error instanceof z.ZodError) throw new TaskRequestError(503, "Background task supervisor is unavailable");
    throw supervisorError(error);
  }
}
async function stopConversationBackgroundTasks(conversationId, timeoutMs = 8e3) {
  const data = resolveDataDirectory();
  const deadline = Date.now() + timeoutMs;
  for (const id2 of readActiveConversationTaskIds(data, conversationId)) {
    try {
      await supervisorRequest(data, { action: "stop", id: id2 });
    } catch (error) {
      console.warn(`Could not stop background task ${id2} before transfer`, error);
    }
  }
  while (readActiveConversationTaskIds(data, conversationId).length) {
    if (Date.now() >= deadline) return false;
    await delay(250);
  }
  return true;
}
const peerTaskSchema = publicTaskSchema.extend({ completion: z.unknown().optional() }).transform(({ completion: _legacy, ...task }) => task);
const listResponse = z.object({
  tasks: z.array(peerTaskSchema).max(100),
  node: z.object({
    nodeId: z.string().uuid(),
    nodeName: z.string(),
    supported: z.boolean(),
    available: z.boolean(),
    nextCursor: cursor.nullable(),
    reason: z.string().max(200).optional()
  }).strict()
}).strict();
async function routeBackgroundTaskOperation(nodeId, commandInput) {
  const command = backgroundTaskCommandSchema.parse(commandInput);
  const local = await getClusterNode();
  if (nodeId === local.id) return localBackgroundTaskOperation(command);
  const peer = await getRuntimePeer(nodeId);
  if (!peer) throw new TaskRequestError(404, "Cluster node not found");
  try {
    const response = await runtimeFetch(`${peer.url}/api/cluster/background-tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5e3)
    });
    const body = await response.json();
    if (!response.ok) {
      const message = response.status === 403 && body.error === "Project is not shared with this node" ? body.error : response.status === 404 ? "Background task not found" : "Background task node is unavailable";
      throw new TaskRequestError(response.status === 401 ? 503 : response.status, message);
    }
    if (command.action === "list") {
      const result = listResponse.parse(body);
      if (result.node.nodeId !== nodeId || result.tasks.some((task2) => task2.nodeId !== nodeId)) {
        throw new Error("Peer returned mismatched task ownership");
      }
      return result;
    }
    if (command.action === "output") return outputSchema.parse(body);
    const task = peerTaskSchema.parse(body);
    if (task.nodeId !== nodeId) throw new Error("Peer returned mismatched task ownership");
    return task;
  } catch (error) {
    if (error instanceof TaskRequestError) throw error;
    throw new TaskRequestError(503, "Background task node is unavailable");
  }
}
async function discoverBackgroundTasks(projectId, conversationId) {
  const command = backgroundTaskCommandSchema.parse({ action: "list", projectId, conversationId });
  await projectScope(command);
  const local = await getClusterNode();
  const peers = (await listRuntimePeers()).filter((peer) => peer.id !== local.id);
  const allowed = [];
  for (const peer of peers) {
    if (await clusterPeerMayAccessProject(peer.id, projectId)) allowed.push(peer);
  }
  const results = await Promise.all(
    [{ id: local.id, name: local.name }, ...allowed.map((peer) => ({ id: peer.id, name: peer.name }))].map(async (node) => {
      try {
        if (node.id === local.id) return await routeBackgroundTaskOperation(node.id, command);
        const remote = await peerSnapshot(
          `background-tasks:${JSON.stringify(command)}`,
          node.id,
          async () => await routeBackgroundTaskOperation(node.id, command),
          { unreachable: (error) => error instanceof TaskRequestError && error.status === 503 || isPeerUnreachable(error) }
        );
        return remote.fresh ? remote.value : { ...remote.value, node: { ...remote.value.node, available: false, reason: staleSnapshotReason(remote.fetchedAt) } };
      } catch (error) {
        if (error instanceof TaskRequestError && error.status === 403) throw error;
        return {
          tasks: [],
          node: {
            nodeId: node.id,
            nodeName: node.name,
            supported: true,
            available: false,
            nextCursor: null,
            reason: "Background task node is unavailable"
          }
        };
      }
    })
  );
  return {
    tasks: results.flatMap((result) => result.tasks).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)),
    nodes: results.map((result) => result.node)
  };
}
export {
  TaskRequestError,
  backgroundTaskCommandSchema,
  discoverBackgroundTasks,
  localBackgroundTaskOperation,
  routeBackgroundTaskOperation,
  stopConversationBackgroundTasks
};
