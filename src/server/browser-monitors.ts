import { randomUUID } from "node:crypto";
import { z } from "zod";
import { browserCheckerSchema } from "../browser-monitor-checkers.js";
import { browserCheckerStore } from "../browser-checker-store.js";
import { BrowserMonitorCheckError, BrowserMonitorScheduler } from "../browser-monitor-scheduler.js";
import { monitorBindingSchema, monitorCheckpointSchema, monitorCheckResultSchema, monitorInputSchema, type MonitorCheckResult, type MonitorInput, type MonitorRecord } from "../browser-monitor-types.js";
import { browserMonitorStore } from "../browser-monitors.js";
import { getClusterMachineToken, getClusterNode, getClusterPeer, listClusterPeers } from "../cluster.js";
import { getProject } from "../store.js";
import { browserRuntime, BrowserRequestError } from "./browser.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";
import { broadcastToProject } from "./realtime.js";
import { flags } from "./state.js";

const id = z.string().uuid();
const generation = z.number().int().positive().safe();
const projectId = z.string().min(1).max(200);
const monitorPatchSchema = z.object({
  name: monitorInputSchema.shape.name.optional(), intervalSeconds: monitorInputSchema.shape.intervalSeconds.optional(), readAcknowledged: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Monitor patch is empty");
const projectCommand = <T extends z.ZodRawShape>(shape: T) => z.object({ projectId, ...shape }).strict();
export const browserMonitorCommandSchema = z.discriminatedUnion("action", [
  projectCommand({ action: z.literal("list") }), projectCommand({ action: z.literal("checkers") }),
  projectCommand({ action: z.literal("installChecker"), definition: browserCheckerSchema }),
  z.object({ action: z.literal("create"), input: monitorInputSchema }).strict(),
  projectCommand({ action: z.literal("history"), id }), projectCommand({ action: z.literal("preview"), id, generation }),
  projectCommand({ action: z.literal("enable"), id, generation, enabled: z.boolean() }),
  projectCommand({ action: z.literal("update"), id, generation, patch: monitorPatchSchema }),
  projectCommand({ action: z.literal("rebind"), id, generation, binding: monitorBindingSchema }),
  projectCommand({ action: z.literal("check"), id, generation }), projectCommand({ action: z.literal("delete"), id, generation }),
]);
export type BrowserMonitorCommand = z.infer<typeof browserMonitorCommandSchema>;

export const browserMonitorReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), projectId, monitorId: id, generation, runId: id }).strict(),
  z.object({ kind: z.literal("preview"), projectId, monitorId: id, generation, previewId: id }).strict(),
]);
export type BrowserMonitorReference = z.infer<typeof browserMonitorReferenceSchema>;
const authorizationSchema = z.object({ monitor: monitorInputSchema, checkpoint: monitorCheckpointSchema, checker: browserCheckerSchema }).strict();
type MonitorAuthorization = z.infer<typeof authorizationSchema>;
const previewContexts = new Map<string, { monitor: MonitorRecord; expiresAt: number }>();

function monitorInput(monitor: MonitorRecord): MonitorInput {
  const { id: _id, ownerNodeId: _owner, generation: _generation, enabled: _enabled, baseline: _baseline,
    checkpoint: _checkpoint, health: _health, detail: _detail, nextDueAt: _next, lastStartedAt: _started,
    lastFinishedAt: _finished, createdAt: _created, updatedAt: _updated, ...input } = monitor;
  return monitorInputSchema.parse(input);
}

async function projectScope(value: string, callerNodeId?: string) {
  const project = await getProject(value);
  if (!project) throw new BrowserRequestError(404, "Project not found");
  const local = await getClusterNode();
  if (callerNodeId && callerNodeId !== local.id && !(await clusterPeerMayAccessProject(callerNodeId, project.id)))
    throw new BrowserRequestError(403, "Project is not shared with this node");
  return project;
}

async function currentMonitor(scope: string, monitorId: string, expected?: number): Promise<MonitorRecord> {
  const project = await projectScope(scope);
  const local = await getClusterNode();
  const monitor = browserMonitorStore().getForProject(monitorId, project.id);
  if (monitor.ownerNodeId !== local.id) throw new BrowserRequestError(404, "Browser monitor not found");
  if (expected !== undefined && monitor.generation !== expected) throw new BrowserRequestError(409, "Browser monitor changed; refresh before continuing");
  return monitor;
}

function checkerFor(monitor: Pick<MonitorInput, "projectId" | "checkerId" | "checkerVersion" | "origin">) {
  const checker = browserCheckerStore().get(monitor.projectId, monitor.checkerId, monitor.checkerVersion).definition;
  if (!checker.origins.includes(monitor.origin)) throw new BrowserRequestError(409, "Browser checker does not support monitor origin");
  return checker;
}

async function knownNode(nodeId: string): Promise<void> {
  const local = await getClusterNode();
  if (nodeId !== local.id && !(await getClusterPeer(nodeId))) throw new BrowserRequestError(404, "Browser node is not paired");
}

async function previewMonitor(monitor: MonitorRecord): Promise<MonitorCheckResult> {
  if (stopped) throw new BrowserRequestError(409, "Browser monitor scheduler is stopped");
  if (!monitor.readAcknowledged) throw new BrowserRequestError(409, "Acknowledge browser read effects before previewing");
  const previewId = randomUUID();
  previewContexts.set(previewId, { monitor, expiresAt: Date.now() + 15_000 });
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BrowserRequestError(409, "Browser monitor preview timed out")), 15_000);
    timer.unref();
  });
  try { return await Promise.race([routeMonitorRead(monitor.binding.nodeId, { kind: "preview", projectId: monitor.projectId, monitorId: monitor.id, generation: monitor.generation, previewId }), timeout]); }
  finally { clearTimeout(timer); previewContexts.delete(previewId); }
}

function changed(monitor: MonitorRecord): void {
  broadcastToProject(monitor.projectId, { type: "browserMonitorsChanged", monitorId: monitor.id });
}

type MonitorMutation = Extract<BrowserMonitorCommand, { action: "enable" | "update" | "check" | "delete" | "rebind" }>;

async function mutate(command: MonitorMutation, current: MonitorRecord): Promise<unknown> {
  const store = browserMonitorStore();
  if (command.action === "enable") {
    if (command.enabled) await previewMonitor(current);
    const monitor = store.setEnabled(current.id, command.generation, command.enabled); changed(monitor); return { monitor };
  }
  if (command.action === "update") { const monitor = store.update(current.id, command.generation, command.patch); changed(monitor); return { monitor }; }
  if (command.action === "check") { const monitor = store.requestCheck(current.id, command.generation); changed(monitor); return { monitor }; }
  if (command.action === "delete") { store.delete(current.id, command.generation); changed(current); return { deleted: true }; }
  const paused = store.setEnabled(current.id, command.generation, false);
  const proposed = { ...paused, binding: command.binding };
  await knownNode(command.binding.nodeId);
  await previewMonitor(proposed);
  const monitor = store.rebind(current.id, paused.generation, command.binding); changed(monitor); return { monitor };
}

export async function manageBrowserMonitor(value: BrowserMonitorCommand, createdBy: string, callerNodeId?: string): Promise<unknown> {
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
    const monitor = store.create(input, (await getClusterNode()).id); changed(monitor); return { monitor };
  }
  const current = await currentMonitor(project.id, command.id, "generation" in command ? command.generation : undefined);
  if (command.action === "history") return { runs: store.history(current.id), events: store.events(current.id) };
  if (command.action === "preview") return { result: await previewMonitor(current) };
  return mutate(command, current);
}

export async function authorizeMonitorRead(value: BrowserMonitorReference, browserNodeId: string): Promise<MonitorAuthorization> {
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
    const run = browserMonitorStore().history(current.id).find(candidate => candidate.id === reference.runId);
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

async function remoteAuthorization(ownerNodeId: string, reference: BrowserMonitorReference): Promise<MonitorAuthorization> {
  const response = await peerRequest(ownerNodeId, "monitor-authorize", { reference });
  const authorization = authorizationSchema.parse((await response.json() as { authorization: unknown }).authorization);
  const project = await projectScope(authorization.monitor.projectId);
  if (!(await clusterPeerMayAccessProject(ownerNodeId, project.id))) throw new BrowserRequestError(403, "Project is not shared with monitor owner");
  return authorizationSchema.parse({ ...authorization, monitor: { ...authorization.monitor, projectId: project.id } });
}

export async function localMonitorRead(ownerNodeId: string, value: BrowserMonitorReference): Promise<MonitorCheckResult> {
  const reference = browserMonitorReferenceSchema.parse(value);
  const local = await getClusterNode();
  const fetchAuthorization = () => ownerNodeId === local.id ? authorizeMonitorRead(reference, local.id) : remoteAuthorization(ownerNodeId, reference);
  const authorization = await fetchAuthorization();
  const serialized = JSON.stringify(authorization);
  const binding = authorization.monitor.binding;
  // A remote monitor owner reads this node's browser through the same profile the
  // conversation uses: a node-restricted profile refuses it here and again after
  // every queued page read, exactly like every other relayed browser path.
  const assertProfileNodeAccess = async () => {
    if (ownerNodeId === local.id) return;
    if (browserRuntime().profileOrNull(binding.profileId)?.crossNodeAccess === false) throw new BrowserRequestError(403, "Browser profile is restricted to this node");
  };
  await assertProfileNodeAccess();
  return browserRuntime().inspectMonitor({ sessionId: binding.sessionId, projectId: authorization.monitor.projectId, conversationId: binding.conversationId, profileId: binding.profileId, pageId: binding.pageId,
    assertValid: async () => {
      if (JSON.stringify(await fetchAuthorization()) !== serialized) throw new BrowserRequestError(409, "Browser monitor read authorization changed");
      await assertProfileNodeAccess();
    } },
  { checker: authorization.checker, origin: authorization.monitor.origin, accountId: authorization.monitor.accountId, targetIds: authorization.monitor.targetIds, checkpoint: authorization.checkpoint });
}

export async function routeMonitorRead(browserNodeId: string, reference: BrowserMonitorReference, signal?: AbortSignal): Promise<MonitorCheckResult> {
  const local = await getClusterNode();
  if (browserNodeId === local.id) return localMonitorRead(local.id, reference);
  const response = await peerRequest(browserNodeId, "monitor-read", { ownerNodeId: local.id, reference }, signal);
  return monitorCheckResultSchema.parse((await response.json() as { result: unknown }).result);
}

const failureHealth = z.enum(["needs-login", "wrong-account", "target-missing", "incompatible", "browser-stopped", "paused-by-human", "unavailable", "error"]);
async function peerRequest(nodeId: string, suffix: "monitor-manage" | "monitor-read" | "monitor-authorize", body: unknown, signal?: AbortSignal): Promise<Response> {
  const peer = await getClusterPeer(nodeId);
  if (!peer) throw new BrowserRequestError(503, "Browser monitor node is unavailable; no fallback was selected");
  let response: Response;
  try {
    const timeout = AbortSignal.timeout(15_000);
    response = await fetch(`${peer.url}/api/cluster/browser/${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch { throw new BrowserRequestError(503, "Browser monitor node is unavailable; no fallback was selected"); }
  if (!response.ok) {
    const parsed = z.object({ error: z.string().min(1).max(2000), health: failureHealth.optional() }).strict().safeParse(await response.json());
    if (!parsed.success) throw new BrowserRequestError(response.status, `Browser monitor node returned ${response.status}`);
    if (parsed.data.health) throw new BrowserMonitorCheckError(parsed.data.health, parsed.data.error);
    throw new BrowserRequestError(response.status, parsed.data.error);
  }
  return response;
}

export async function routeBrowserMonitor(nodeId: string, command: BrowserMonitorCommand, createdBy: string): Promise<unknown> {
  const local = await getClusterNode();
  if (nodeId === local.id) return manageBrowserMonitor(command, createdBy);
  return (await peerRequest(nodeId, "monitor-manage", { command, createdBy })).json();
}

export async function listBrowserMonitors(value: string): Promise<unknown> {
  const project = await projectScope(value);
  const local = await getClusterNode();
  const own = await manageBrowserMonitor({ action: "list", projectId: project.id }, `${local.id}:system`) as { monitors: MonitorRecord[]; runtime: ReturnType<typeof browserMonitorRuntimeStatus> };
  const monitors = [...own.monitors], nodes = [{ nodeId: local.id, runtime: own.runtime }], unavailableNodes: Array<{ nodeId: string; reason: string }> = [];
  const peers = await listClusterPeers();
  for (const peer of peers) {
    if (!(await clusterPeerMayAccessProject(peer.id, project.id))) continue;
    try {
      const result = await routeBrowserMonitor(peer.id, { action: "list", projectId: project.id }, `${local.id}:system`) as typeof own;
      monitors.push(...result.monitors); nodes.push({ nodeId: peer.id, runtime: result.runtime });
    } catch (error) {
      if (error instanceof BrowserRequestError && error.status === 403) throw error;
      unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message.slice(0, 2000) : "Browser monitor node is unavailable" });
    }
  }
  return { monitors, nodes, unavailableNodes };
}

let scheduler: BrowserMonitorScheduler | undefined;
let started = false;
let startupError: string | null = null;
let stopped = false;
export function browserMonitorRuntimeStatus() { return { started, activeCount: scheduler?.activeCount ?? 0, error: startupError }; }
export async function startBrowserMonitors(): Promise<void> {
  try {
    if (scheduler || stopped) throw new Error(stopped ? "Browser monitor scheduler is stopped" : "Browser monitor scheduler already started");
    const ownerNodeId = (await getClusterNode()).id;
    if (scheduler || stopped) throw new Error(stopped ? "Browser monitor scheduler is stopped" : "Browser monitor scheduler already started");
    scheduler = new BrowserMonitorScheduler(browserMonitorStore(), { ownerNodeId,
      check: (monitor, run, signal) => routeMonitorRead(monitor.binding.nodeId, { kind: "run", projectId: monitor.projectId, monitorId: monitor.id, generation: run.generation, runId: run.id }, signal),
      canRun: () => !stopped && flags.startupReady && !flags.updatePreparing,
      onEvents: (monitor, events) => broadcastToProject(monitor.projectId, { type: "browserMonitorEvents", monitorId: monitor.id, count: events.length }),
      onError: error => console.warn("Browser monitor scheduler error", error.message.slice(0, 2000)),
    });
    scheduler.start(); started = true; startupError = null;
  } catch (error) {
    startupError = error instanceof Error ? error.message.slice(0, 2000) : "Browser monitor startup failed";
    throw error;
  }
}
export function stopBrowserMonitors(): void {
  scheduler?.stop(); started = false; stopped = true; previewContexts.clear();
}
