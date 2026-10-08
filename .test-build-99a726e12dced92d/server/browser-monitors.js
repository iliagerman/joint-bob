import { randomUUID } from "node:crypto";
import { z } from "zod";
import { browserCheckerSchema } from "../browser-monitor-checkers.js";
import { browserCheckerStore } from "../browser-checker-store.js";
import { BrowserMonitorCheckError, BrowserMonitorScheduler } from "../browser-monitor-scheduler.js";
import { monitorBindingSchema, monitorCheckpointSchema, monitorCheckResultSchema, monitorInputSchema } from "../browser-monitor-types.js";
import { browserMonitorStore } from "../browser-monitors.js";
import { getClusterNode } from "../cluster.js";
import { getRuntimePeer, listRuntimePeers, runtimeFetch } from "./runtime-peers.js";
import { getProject } from "../store.js";
import { browserRuntime, BrowserRequestError } from "./browser.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { broadcastToProject } from "./realtime.js";
import { flags } from "./state.js";
import { isPeerUnreachable } from "./peer-availability.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
const id = z.string().uuid();
const generation = z.number().int().positive().safe();
const projectId = z.string().min(1).max(200);
const monitorPatchSchema = z.object({
  name: monitorInputSchema.shape.name.optional(),
  intervalSeconds: monitorInputSchema.shape.intervalSeconds.optional(),
  readAcknowledged: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Monitor patch is empty");
const projectCommand = (shape) => z.object({ projectId, ...shape }).strict();
const browserMonitorCommandSchema = z.discriminatedUnion("action", [
  projectCommand({ action: z.literal("list") }),
  projectCommand({ action: z.literal("checkers") }),
  projectCommand({ action: z.literal("installChecker"), definition: browserCheckerSchema }),
  z.object({ action: z.literal("create"), input: monitorInputSchema }).strict(),
  projectCommand({ action: z.literal("history"), id }),
  projectCommand({ action: z.literal("preview"), id, generation }),
  projectCommand({ action: z.literal("enable"), id, generation, enabled: z.boolean() }),
  projectCommand({ action: z.literal("update"), id, generation, patch: monitorPatchSchema }),
  projectCommand({ action: z.literal("rebind"), id, generation, binding: monitorBindingSchema }),
  projectCommand({ action: z.literal("check"), id, generation }),
  projectCommand({ action: z.literal("delete"), id, generation })
]);
const browserMonitorReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), projectId, monitorId: id, generation, runId: id }).strict(),
  z.object({ kind: z.literal("preview"), projectId, monitorId: id, generation, previewId: id }).strict()
]);
const authorizationSchema = z.object({ monitor: monitorInputSchema, checkpoint: monitorCheckpointSchema, checker: browserCheckerSchema }).strict();
const previewContexts = /* @__PURE__ */ new Map();
function monitorInput(monitor) {
  const {
    id: _id,
    ownerNodeId: _owner,
    generation: _generation,
    enabled: _enabled,
    baseline: _baseline,
    checkpoint: _checkpoint,
    health: _health,
    detail: _detail,
    nextDueAt: _next,
    lastStartedAt: _started,
    lastFinishedAt: _finished,
    createdAt: _created,
    updatedAt: _updated,
    ...input
  } = monitor;
  return monitorInputSchema.parse(input);
}
async function projectScope(value, callerNodeId) {
  const project = await getProject(value);
  if (!project) throw new BrowserRequestError(404, "Project not found");
  const local = await getClusterNode();
  if (callerNodeId && callerNodeId !== local.id && !await clusterPeerMayAccessProject(callerNodeId, project.id))
    throw new BrowserRequestError(403, "Project is not shared with this node");
  return project;
}
async function currentMonitor(scope, monitorId, expected) {
  const project = await projectScope(scope);
  const local = await getClusterNode();
  const monitor = browserMonitorStore().getForProject(monitorId, project.id);
  if (monitor.ownerNodeId !== local.id) throw new BrowserRequestError(404, "Browser monitor not found");
  if (expected !== void 0 && monitor.generation !== expected) throw new BrowserRequestError(409, "Browser monitor changed; refresh before continuing");
  return monitor;
}
function checkerFor(monitor) {
  const checker = browserCheckerStore().get(monitor.projectId, monitor.checkerId, monitor.checkerVersion).definition;
  if (!checker.origins.includes(monitor.origin)) throw new BrowserRequestError(409, "Browser checker does not support monitor origin");
  return checker;
}
async function knownNode(nodeId) {
  const local = await getClusterNode();
  if (nodeId !== local.id && !await getRuntimePeer(nodeId)) throw new BrowserRequestError(404, "Browser node is not paired");
}
async function previewMonitor(monitor) {
  if (stopped) throw new BrowserRequestError(409, "Browser monitor scheduler is stopped");
  if (!monitor.readAcknowledged) throw new BrowserRequestError(409, "Acknowledge browser read effects before previewing");
  const previewId = randomUUID();
  previewContexts.set(previewId, { monitor, expiresAt: Date.now() + 15e3 });
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserRequestError(409, "Browser monitor preview timed out")), 15e3);
    timer.unref();
  });
  try {
    return await Promise.race([routeMonitorRead(monitor.binding.nodeId, { kind: "preview", projectId: monitor.projectId, monitorId: monitor.id, generation: monitor.generation, previewId }), timeout]);
  } finally {
    clearTimeout(timer);
    previewContexts.delete(previewId);
  }
}
function changed(monitor) {
  broadcastToProject(monitor.projectId, { type: "browserMonitorsChanged", monitorId: monitor.id });
}
async function mutate(command, current) {
  const store = browserMonitorStore();
  if (command.action === "enable") {
    if (command.enabled) await previewMonitor(current);
    const monitor2 = store.setEnabled(current.id, command.generation, command.enabled);
    changed(monitor2);
    return { monitor: monitor2 };
  }
  if (command.action === "update") {
    const monitor2 = store.update(current.id, command.generation, command.patch);
    changed(monitor2);
    return { monitor: monitor2 };
  }
  if (command.action === "check") {
    const monitor2 = store.requestCheck(current.id, command.generation);
    changed(monitor2);
    return { monitor: monitor2 };
  }
  if (command.action === "delete") {
    store.delete(current.id, command.generation);
    changed(current);
    return { deleted: true };
  }
  const paused = store.setEnabled(current.id, command.generation, false);
  const proposed = { ...paused, binding: command.binding };
  await knownNode(command.binding.nodeId);
  await previewMonitor(proposed);
  const monitor = store.rebind(current.id, paused.generation, command.binding);
  changed(monitor);
  return { monitor };
}
async function manageBrowserMonitor(value, createdBy, callerNodeId) {
  const command = browserMonitorCommandSchema.parse(value);
  const requestedProject = command.action === "create" ? command.input.projectId : command.projectId;
  const project = await projectScope(requestedProject, callerNodeId);
  const store = browserMonitorStore();
  if (command.action === "list") return { monitors: store.list(project.id), runtime: browserMonitorRuntimeStatus() };
  if (command.action === "checkers") return { checkers: browserCheckerStore().list(project.id) };
  if (command.action === "installChecker") return { checker: browserCheckerStore().install(project.id, command.definition, createdBy) };
  if (command.action === "create") {
    const input = monitorInputSchema.parse({ ...command.input, projectId: project.id });
    checkerFor(input);
    await knownNode(input.binding.nodeId);
    const monitor = store.create(input, (await getClusterNode()).id);
    changed(monitor);
    return { monitor };
  }
  const current = await currentMonitor(project.id, command.id, "generation" in command ? command.generation : void 0);
  if (command.action === "history") return { runs: store.history(current.id), events: store.events(current.id) };
  if (command.action === "preview") return { result: await previewMonitor(current) };
  return mutate(command, current);
}
async function authorizeMonitorRead(value, browserNodeId) {
  const reference = browserMonitorReferenceSchema.parse(value);
  const project = await projectScope(reference.projectId, browserNodeId);
  const local = await getClusterNode();
  if (stopped) throw new BrowserRequestError(409, "Browser monitor scheduler is stopped");
  const current = browserMonitorStore().getForProject(reference.monitorId, project.id);
  if (current.ownerNodeId !== local.id) throw new BrowserRequestError(404, "Browser monitor not found");
  if (current.generation !== reference.generation) throw new BrowserRequestError(409, "Browser monitor read authorization changed");
  if (!current.readAcknowledged) throw new BrowserRequestError(409, "Browser monitor read is not acknowledged");
  let snapshot = current;
  if (reference.kind === "run") {
    const run = browserMonitorStore().history(current.id).find((candidate) => candidate.id === reference.runId);
    if (!current.enabled || !run || run.status !== "running" || run.generation !== reference.generation) throw new BrowserRequestError(409, "Browser monitor run is not authorized");
  } else {
    const context = previewContexts.get(reference.previewId);
    if (!context || context.expiresAt < Date.now() || context.monitor.id !== current.id || context.monitor.generation !== current.generation)
      throw new BrowserRequestError(409, "Browser monitor preview is not authorized");
    snapshot = context.monitor;
  }
  if (snapshot.binding.nodeId !== browserNodeId) throw new BrowserRequestError(403, "Browser node is not authorized for this monitor");
  return authorizationSchema.parse({ monitor: monitorInput(snapshot), checkpoint: snapshot.checkpoint, checker: checkerFor(snapshot) });
}
async function remoteAuthorization(ownerNodeId, reference) {
  const response = await peerRequest(ownerNodeId, "monitor-authorize", { reference });
  const authorization = authorizationSchema.parse((await response.json()).authorization);
  const project = await projectScope(authorization.monitor.projectId);
  if (!await clusterPeerMayAccessProject(ownerNodeId, project.id)) throw new BrowserRequestError(403, "Project is not shared with monitor owner");
  return authorizationSchema.parse({ ...authorization, monitor: { ...authorization.monitor, projectId: project.id } });
}
async function localMonitorRead(ownerNodeId, value) {
  const reference = browserMonitorReferenceSchema.parse(value);
  const local = await getClusterNode();
  const fetchAuthorization = () => ownerNodeId === local.id ? authorizeMonitorRead(reference, local.id) : remoteAuthorization(ownerNodeId, reference);
  const authorization = await fetchAuthorization();
  const serialized = JSON.stringify(authorization);
  const binding = authorization.monitor.binding;
  const assertProfileNodeAccess = async () => {
    if (ownerNodeId === local.id) return;
    if (!browserRuntime().profileUsable(binding.profileId, { nodeId: ownerNodeId, projectId: authorization.monitor.projectId, conversationId: binding.conversationId }))
      throw new BrowserRequestError(403, "Browser profile is not shared with this node");
  };
  await assertProfileNodeAccess();
  return browserRuntime().inspectMonitor(
    {
      sessionId: binding.sessionId,
      projectId: authorization.monitor.projectId,
      conversationId: binding.conversationId,
      profileId: binding.profileId,
      pageId: binding.pageId,
      assertValid: async () => {
        if (JSON.stringify(await fetchAuthorization()) !== serialized) throw new BrowserRequestError(409, "Browser monitor read authorization changed");
        await assertProfileNodeAccess();
      }
    },
    { checker: authorization.checker, origin: authorization.monitor.origin, accountId: authorization.monitor.accountId, targetIds: authorization.monitor.targetIds, checkpoint: authorization.checkpoint }
  );
}
async function routeMonitorRead(browserNodeId, reference, signal) {
  const local = await getClusterNode();
  if (browserNodeId === local.id) return localMonitorRead(local.id, reference);
  const response = await peerRequest(browserNodeId, "monitor-read", { ownerNodeId: local.id, reference }, signal);
  return monitorCheckResultSchema.parse((await response.json()).result);
}
const failureHealth = z.enum(["needs-login", "wrong-account", "target-missing", "incompatible", "browser-stopped", "paused-by-human", "unavailable", "error"]);
async function peerRequest(nodeId, suffix, body, signal) {
  const peer = await getRuntimePeer(nodeId);
  if (!peer) throw new BrowserRequestError(503, "Browser monitor node is unavailable; no fallback was selected");
  let response;
  try {
    const timeout = AbortSignal.timeout(15e3);
    response = await runtimeFetch(`${peer.url}/api/cluster/browser/${suffix}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    throw new BrowserRequestError(503, "Browser monitor node is unavailable; no fallback was selected");
  }
  if (!response.ok) {
    const parsed = z.object({ error: z.string().min(1).max(2e3), health: failureHealth.optional() }).strict().safeParse(await response.json());
    if (!parsed.success) throw new BrowserRequestError(response.status, `Browser monitor node returned ${response.status}`);
    if (parsed.data.health) throw new BrowserMonitorCheckError(parsed.data.health, parsed.data.error);
    throw new BrowserRequestError(response.status, parsed.data.error);
  }
  return response;
}
async function routeBrowserMonitor(nodeId, command, createdBy) {
  const local = await getClusterNode();
  if (nodeId === local.id) return manageBrowserMonitor(command, createdBy);
  return (await peerRequest(nodeId, "monitor-manage", { command, createdBy })).json();
}
async function listBrowserMonitors(value) {
  const project = await projectScope(value);
  const local = await getClusterNode();
  const own = await manageBrowserMonitor({ action: "list", projectId: project.id }, `${local.id}:system`);
  const monitors = [...own.monitors], nodes = [{ nodeId: local.id, runtime: own.runtime }], unavailableNodes = [];
  const allPeers = await listRuntimePeers();
  const peers = [];
  for (const peer of allPeers) if (await clusterPeerMayAccessProject(peer.id, project.id)) peers.push(peer);
  const results = await Promise.all(peers.map(async (peer) => {
    try {
      return { peer, remote: await peerSnapshot(
        `browser-monitors:${project.id}`,
        peer.id,
        async () => await routeBrowserMonitor(peer.id, { action: "list", projectId: project.id }, `${local.id}:system`),
        { unreachable: (error) => error instanceof BrowserRequestError ? error.status === 503 : isPeerUnreachable(error) }
      ) };
    } catch (error) {
      return { peer, error };
    }
  }));
  for (const { peer, remote, error } of results) {
    if (remote) {
      monitors.push(...remote.value.monitors);
      nodes.push({ nodeId: peer.id, runtime: remote.value.runtime });
      if (!remote.fresh) unavailableNodes.push({ nodeId: peer.id, reason: staleSnapshotReason(remote.fetchedAt) });
      continue;
    }
    if (error instanceof BrowserRequestError && error.status === 403) throw error;
    unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message.slice(0, 2e3) : "Browser monitor node is unavailable" });
  }
  return { monitors, nodes, unavailableNodes };
}
let scheduler;
let started = false;
let startupError = null;
let stopped = false;
function browserMonitorRuntimeStatus() {
  return { started, activeCount: scheduler?.activeCount ?? 0, error: startupError };
}
async function startBrowserMonitors() {
  try {
    if (scheduler || stopped) throw new Error(stopped ? "Browser monitor scheduler is stopped" : "Browser monitor scheduler already started");
    const ownerNodeId = (await getClusterNode()).id;
    if (scheduler || stopped) throw new Error(stopped ? "Browser monitor scheduler is stopped" : "Browser monitor scheduler already started");
    scheduler = new BrowserMonitorScheduler(browserMonitorStore(), {
      ownerNodeId,
      check: (monitor, run, signal) => routeMonitorRead(monitor.binding.nodeId, { kind: "run", projectId: monitor.projectId, monitorId: monitor.id, generation: run.generation, runId: run.id }, signal),
      canRun: () => !stopped && flags.startupReady && !flags.updatePreparing,
      onEvents: (monitor, events) => broadcastToProject(monitor.projectId, { type: "browserMonitorEvents", monitorId: monitor.id, count: events.length }),
      onError: (error) => console.warn("Browser monitor scheduler error", error.message.slice(0, 2e3))
    });
    scheduler.start();
    started = true;
    startupError = null;
  } catch (error) {
    startupError = error instanceof Error ? error.message.slice(0, 2e3) : "Browser monitor startup failed";
    throw error;
  }
}
function stopBrowserMonitors() {
  scheduler?.stop();
  started = false;
  stopped = true;
  previewContexts.clear();
}
export {
  authorizeMonitorRead,
  browserMonitorCommandSchema,
  browserMonitorReferenceSchema,
  browserMonitorRuntimeStatus,
  listBrowserMonitors,
  localMonitorRead,
  manageBrowserMonitor,
  routeBrowserMonitor,
  routeMonitorRead,
  startBrowserMonitors,
  stopBrowserMonitors
};
