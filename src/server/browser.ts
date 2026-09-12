import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import WebSocket from "ws";
import { z } from "zod";
import { getClusterNode, getClusterPeer, getClusterMachineToken, listClusterPeers } from "../cluster.js";
import { applyBrowserConfiguration, readBrowserConfiguration, browserConfigurationSchema, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../browser-configuration.js";
import { browserCapability, BrowserRuntime } from "../browser-runtime.js";
import { browserCommandSchema, browserStartSchema, browserIdentitySchema, type BrowserActor, type BrowserSessionView } from "../browser-types.js";
import { getProject } from "../store.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";

export class BrowserRequestError extends Error { constructor(public status: number, message: string) { super(message); } }
let runtime: BrowserRuntime | undefined;
export function browserRuntime(): BrowserRuntime { return runtime ??= new BrowserRuntime(); }
export async function closeBrowserRuntime(): Promise<void> { await runtime?.close(); runtime = undefined; }
export async function localBrowserStatus() {
  const node = await getClusterNode();
  return { node: { id: node.id, name: node.name }, config: readBrowserConfiguration(), capability: await browserCapability(), runningCount: (await browserRuntime().list()).filter(row => row.state === "running").length };
}
export async function browserStatus(nodeId?: string) {
  if (nodeId && idSchema.parse(nodeId) !== (await getClusterNode()).id) return (await peerRequest(nodeId, "status", {}, 5000)).json();
  const own = await localBrowserStatus();
  const nodes = [{ ...own.node, ...own.capability, reachable: true, runningCount: own.runningCount }];
  nodes.push(...await Promise.all((await listClusterPeers()).map(async peer => {
    try {
      const status = await (await peerRequest(peer.id, "status", {}, 5000)).json() as Awaited<ReturnType<typeof localBrowserStatus>>;
      applyBrowserConfiguration(browserConfigurationSchema.parse(status.config));
      return { id: peer.id, name: peer.name, ...status.capability, reachable: true, runningCount: status.runningCount };
    } catch (error) {
      return { id: peer.id, name: peer.name, supported: false, available: false, executable: null, reachable: false, runningCount: 0, reason: error instanceof Error ? error.message : "Browser node unavailable" };
    }
  })));
  return { ...own, config: readBrowserConfiguration(), nodes };
}
async function knownNode(nodeId: string): Promise<void> {
  idSchema.parse(nodeId);
  if (nodeId !== (await getClusterNode()).id && !(await getClusterPeer(nodeId))) throw new BrowserRequestError(503, "Browser node is no longer paired");
}
export async function configureBrowserExecutor(executorNodeId: string | null) {
  if (executorNodeId) await knownNode(executorNodeId);
  await browserStatus();
  applyBrowserConfiguration({ executorNodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserConfiguration().updatedAt) });
  await Promise.all((await listClusterPeers()).map(async peer => {
    try { await peerRequest(peer.id, "config", readBrowserConfiguration(), 5000); }
    catch (error) { console.warn(`Browser configuration sync to ${peer.id} failed`, error); }
  }));
  return browserStatus();
}
function nextVersion(previous?: string) { return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString(); }
export async function canonicalBrowserIdentity(input: z.infer<typeof browserIdentitySchema>) {
  const identity = browserIdentitySchema.parse(input);
  const project = await getProject(identity.projectId);
  if (!project) throw new BrowserRequestError(404, "Project not found");
  return { ...identity, projectId: project.id };
}
export async function browserPreferences(input: z.infer<typeof browserIdentitySchema>, update?: { nodeId: string | null }) {
  const identity = await canonicalBrowserIdentity(input);
  await browserStatus();
  const peers = await sharedBrowserPeers(identity.projectId);
  await Promise.all(peers.map(async peer => {
    try {
      const result = await (await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5000)).json();
      if (result.preference) applyBrowserPreference({ ...browserPreferenceSchema.parse(result.preference), ...identity });
    } catch (error) { console.warn(`Browser preference sync to ${peer.id} failed`, error); }
  }));
  if (update) {
    if (update.nodeId) await knownNode(update.nodeId);
    applyBrowserPreference({ ...identity, nodeId: update.nodeId, originNodeId: (await getClusterNode()).id, updatedAt: nextVersion(readBrowserPreference(identity)?.updatedAt) });
    await Promise.all(peers.map(async peer => {
      try { await peerRequest(peer.id, "preferences", { identity, preference: readBrowserPreference(identity) }, 5000); }
      catch (error) { console.warn(`Browser preference sync to ${peer.id} failed`, error); }
    }));
  }
  const preference = readBrowserPreference(identity);
  return { nodeId: preference?.nodeId ?? null, effectiveNodeId: preference?.nodeId ?? readBrowserConfiguration().executorNodeId };
}
async function sharedBrowserPeers(projectId?: string) {
  const peers = await listClusterPeers();
  if (!projectId) return peers;
  return (await Promise.all(peers.map(async peer => await clusterPeerMayAccessProject(peer.id, projectId) ? peer : null))).filter(peer => peer !== null);
}

// Relay browser control only. Website network traffic remains executor-local.
async function peerRequest(peerId: string, route: string, body: unknown, timeout = 60000): Promise<Response> {
  const peer = await getClusterPeer(peerId);
  if (!peer) throw new BrowserRequestError(503, "Browser node is no longer paired");
  let response: Response;
  try {
    response = await fetch(`${peer.url}/api/cluster/browser/${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new BrowserRequestError(503, "Browser node is unreachable. Its browser is not moved to another node."); }
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new BrowserRequestError(response.status, error.error || `Browser node returned ${response.status}`);
  }
  return response;
}
const idSchema = z.string().uuid();
export const browserOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("start"), args: browserStartSchema }),
  z.object({ operation: z.literal("list"), args: browserIdentitySchema.partial() }),
  z.object({ operation: z.literal("get"), args: z.object({ id: idSchema }) }),
  z.object({ operation: z.literal("command"), args: z.object({ id: idSchema, command: browserCommandSchema }) }),
  z.object({ operation: z.literal("profiles"), args: z.object({ projectId: z.string().min(1) }) }),
  z.object({ operation: z.literal("deleteProfile"), args: z.object({ id: idSchema, projectId: z.string().min(1) }) }),
]);
export type BrowserOperation = z.infer<typeof browserOperationSchema>;
export async function localBrowserOperation(input: BrowserOperation, actor: BrowserActor, machineNodeId?: string): Promise<unknown> {
  const operation = browserOperationSchema.parse(input);
  const local = await getClusterNode();
  const service = browserRuntime();
  // Legacy central-runner records name another app node, but their browser
  // history, downloads and profiles still belong to this physical node.
  const view = (session: BrowserSessionView) => ({ ...session, nodeId: local.id });
  const projectId = "projectId" in operation.args ? operation.args.projectId : "id" in operation.args ? (await service.get(operation.args.id)).projectId : undefined;
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) throw new BrowserRequestError(404, "Project not found on browser node");
    if (machineNodeId && !(await clusterPeerMayAccessProject(machineNodeId, projectId))) throw new BrowserRequestError(403, "Project is not shared with this node");
    if ("projectId" in operation.args) operation.args.projectId = project.id;
  }
  switch (operation.operation) {
    case "start": {
      await knownNode(operation.args.appNodeId);
      return { session: view(await service.create(operation.args)) };
    }
    case "list": {
      const sessions = (await service.list(operation.args)).map(view);
      return { sessions: machineNodeId ? (await Promise.all(sessions.map(async session => await clusterPeerMayAccessProject(machineNodeId, session.projectId) ? session : null))).filter(Boolean) : sessions };
    }
    case "get": return { session: view(await service.get(operation.args.id)) };
    case "command": return { result: await service.execute(operation.args.id, operation.args.command, actor), session: view(await service.get(operation.args.id)) };
    case "profiles": return { profiles: (await service.profiles(operation.args.projectId)).map(profile => ({ ...profile, nodeId: local.id })) };
    case "deleteProfile": await service.deleteProfile(operation.args.id, operation.args.projectId); return { deleted: true };
  }
}
export interface BrowserDiscovery { sessions: BrowserSessionView[]; unavailableNodes: Array<{ nodeId: string; reason: string }>; }
export function requireCompleteDiscovery(discovery: BrowserDiscovery) {
  if (discovery.unavailableNodes.length) throw new BrowserRequestError(503, `Browser attachment discovery incomplete: ${discovery.unavailableNodes.map(node => `${node.nodeId}: ${node.reason}`).join("; ")}. No account was selected or created.`);
}
export async function browserOperation(input: BrowserOperation, actor: BrowserActor, nodeId?: string, identity?: z.infer<typeof browserIdentitySchema>): Promise<unknown> {
  const operation = browserOperationSchema.parse(input);
  if (operation.operation === "list" && !nodeId) return discoverBrowsers(operation, actor, identity);
  if (operation.operation === "start") return startBrowser(operation, actor, nodeId, identity);
  if (!nodeId && (operation.operation === "get" || operation.operation === "command")) nodeId = await browserSessionOwner(operation.args.id, actor, identity);
  if (!nodeId || idSchema.parse(nodeId) === (await getClusterNode()).id) return localBrowserOperation(operation, actor);
  return (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
}
async function discoverBrowsers(operation: Extract<BrowserOperation, { operation: "list" }>, actor: BrowserActor, identity?: z.infer<typeof browserIdentitySchema>): Promise<BrowserDiscovery> {
  const local = await localBrowserOperation(operation, actor) as { sessions: BrowserSessionView[] };
  const result: BrowserDiscovery = { sessions: local.sessions, unavailableNodes: [] };
  await Promise.all((await sharedBrowserPeers(operation.args.projectId)).map(async peer => {
    try {
      const remote = await (await peerRequest(peer.id, "operation", { ...operation, actor, identity }, 5000)).json() as { sessions: BrowserSessionView[] };
      result.sessions.push(...remote.sessions.map(session => ({ ...session, nodeId: peer.id })));
    } catch (error) {
      if (error instanceof BrowserRequestError && ((error.status === 403 && /Project is not shared/.test(error.message)) || (error.status === 404 && /Project not found/.test(error.message)))) return;
      result.unavailableNodes.push({ nodeId: peer.id, reason: error instanceof Error ? error.message : "Browser node unavailable" });
    }
  }));
  return result;
}
async function startBrowser(operation: Extract<BrowserOperation, { operation: "start" }>, actor: BrowserActor, nodeId?: string, identity?: z.infer<typeof browserIdentitySchema>) {
  const scope = browserIdentitySchema.parse(operation.args);
  if (operation.args.profileId) {
    const listed = await discoverBrowsers({ operation: "list", args: scope }, actor, identity);
    const attached = listed.sessions.filter(session => session.profileId === operation.args.profileId);
    const owners = new Set(attached.map(session => session.nodeId));
    if (owners.size > 1) throw new BrowserRequestError(409, "Browser profile has multiple physical owners");
    const owner = attached[0]?.nodeId;
    if (owner && nodeId && owner !== nodeId) throw new BrowserRequestError(409, `Browser profile belongs to machine ${owner}, not ${nodeId}`);
    if (owner) nodeId = owner;
    else if (actor.kind === "agent" || !nodeId) {
      requireCompleteDiscovery(listed);
      throw new BrowserRequestError(actor.kind === "agent" ? 403 : 409, actor.kind === "agent" ? "This profile is not attached to this conversation. Open it in the browser viewer first." : "Specify the browser machine holding this profile");
    }
  } else if (!nodeId) nodeId = (await browserPreferences(scope)).effectiveNodeId ?? undefined;
  if (!nodeId) throw new BrowserRequestError(409, "Choose a browser machine in Settings first");
  await knownNode(nodeId);
  if (nodeId === (await getClusterNode()).id) return localBrowserOperation(operation, actor);
  return (await peerRequest(nodeId, "operation", { ...operation, actor, identity })).json();
}
export async function authorizeBrowserAgent(operation: BrowserOperation, input: z.infer<typeof browserIdentitySchema>) {
  const identity = await canonicalBrowserIdentity(input);
  if ("projectId" in operation.args) {
    const project = await getProject(operation.args.projectId!);
    if (project?.id !== identity.projectId) throw new BrowserRequestError(403, "Browser project does not match agent identity");
  }
  if (operation.operation === "deleteProfile") throw new BrowserRequestError(403, "Agents cannot delete profiles");
  if (operation.operation === "list" || operation.operation === "start") {
    if (operation.args.engine !== identity.engine || operation.args.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser conversation does not match agent identity");
  }
  if (operation.operation === "get" || operation.operation === "command") {
    const session = await browserRuntime().get(operation.args.id);
    if (session.projectId !== identity.projectId || session.conversationId !== identity.conversationId) throw new BrowserRequestError(403, "Browser is not attached to this conversation");
  }
  if (operation.operation === "start" && operation.args.profileId) {
    const attached = await browserRuntime().list(identity);
    if (!attached.some(session => session.profileId === operation.args.profileId)) throw new BrowserRequestError(403, "Profile is not attached to this conversation");
  }
  return identity;
}
export async function browserSessionOwner(id: string, actor: BrowserActor, identity?: z.infer<typeof browserIdentitySchema>): Promise<string> {
  idSchema.parse(id);
  const owners: string[] = [], unavailable: string[] = [];
  const local = await getClusterNode();
  try { await localBrowserOperation({ operation: "get", args: { id } }, actor); owners.push(local.id); }
  catch (error) { if (!(error instanceof Error) || error.message !== "Browser session not found") throw error; }
  await Promise.all((await listClusterPeers()).map(async peer => {
    try {
      await (await peerRequest(peer.id, "operation", { operation: "get", args: { id }, actor, identity }, 5000)).json();
      owners.push(peer.id);
    } catch (error) {
      if (error instanceof BrowserRequestError && ((error.status === 404 && error.message === "Browser session not found") || (error.status === 403 && /Project is not shared/.test(error.message)))) return;
      unavailable.push(peer.id);
    }
  }));
  if (owners.length > 1) throw new BrowserRequestError(409, "Browser session ID has multiple physical owners");
  if (owners.length === 1) return owners[0];
  if (unavailable.length) throw new BrowserRequestError(503, `Browser session owner unavailable: ${unavailable.join(", ")}. No other account was selected.`);
  throw new BrowserRequestError(404, "Browser session not found");
}
export async function browserDownload(id: string, downloadId: string, nodeId: string, identity?: z.infer<typeof browserIdentitySchema>): Promise<{ stream: Readable; name: string }> {
  idSchema.parse(id); idSchema.parse(downloadId);
  if (idSchema.parse(nodeId) === (await getClusterNode()).id) {
    const file = await browserRuntime().download(id, downloadId);
    return { stream: createReadStream(file.path), name: file.name };
  }
  const response = await peerRequest(nodeId, "download", { id, downloadId, identity }, 120000);
  if (!response.body) throw new BrowserRequestError(502, "Browser download has no content");
  return { stream: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), name: decodeURIComponent(response.headers.get("x-browser-filename") || "download") };
}

export async function attachBrowserViewer(socket: WebSocket, url: URL, actor: BrowserActor, machineNodeId?: string) {
  try {
    const id = idSchema.parse(url.searchParams.get("browserSessionId"));
    if (machineNodeId) {
      const session = await browserRuntime().get(id);
      if (!(await clusterPeerMayAccessProject(machineNodeId, session.projectId))) throw Error("Project is not shared");
      await browserRuntime().attachViewer(id, socket, actor); return;
    }
    const nodeId = idSchema.optional().parse(url.searchParams.get("nodeId") ?? undefined) ?? await browserSessionOwner(id, actor);
    if (nodeId === (await getClusterNode()).id) { await browserRuntime().attachViewer(id, socket, actor); return; }
    const peer = await getClusterPeer(nodeId);
    if (!peer) throw Error("Browser node unavailable");
    const remote = new URL("/ws", peer.url); remote.protocol = remote.protocol === "https:" ? "wss:" : "ws:";
    remote.search = new URLSearchParams({ mode: "browser", browserSessionId: id, controllerId: actor.kind === "human" ? actor.id : "agent" }).toString();
    const upstream = new WebSocket(remote, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024 });
    const queued: Buffer[] = []; let queuedBytes = 0;
    socket.on("message", data => {
      const buffer = Buffer.from(data as Buffer);
      if (upstream.readyState === WebSocket.OPEN) { if (upstream.bufferedAmount > 32 * 1024 * 1024) { socket.close(1009); return; } upstream.send(buffer); }
      else if (upstream.readyState === WebSocket.CONNECTING && (queuedBytes += buffer.length) < 1024 * 1024) queued.push(buffer);
      else socket.close(1009);
    });
    upstream.once("open", () => { if (socket.readyState !== WebSocket.OPEN) { upstream.close(); return; } for (const data of queued) upstream.send(data); queued.length = 0; });
    upstream.on("message", data => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 8 * 1024 * 1024) socket.send(data.toString()); });
    socket.once("close", () => upstream.terminate()); upstream.once("close", () => socket.close(1012, "Browser node disconnected; reconnect to resume viewing"));
    upstream.on("error", () => socket.close(1011, "Browser node unavailable")); socket.on("error", () => upstream.terminate());
  } catch (error) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "browserError", error: error instanceof Error ? error.message : "Browser unavailable" })); socket.close(1008, "Browser session unavailable"); }
}
