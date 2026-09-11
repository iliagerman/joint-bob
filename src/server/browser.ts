import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import { z } from "zod";
import { getClusterNode, getClusterPeer, getClusterMachineToken, listClusterPeers } from "../cluster.js";
import { applyBrowserConfiguration, readBrowserConfiguration, browserConfigurationSchema } from "../browser-configuration.js";
import { browserCapability, BrowserRuntime } from "../browser-runtime.js";
import { browserCommandSchema, browserStartSchema, browserIdentitySchema, type BrowserActor, type BrowserConfiguration, type BrowserCapability } from "../browser-types.js";
import { browserLoopbackHost, browserTcpConnect, createBrowserProxy } from "../browser-network.js";
import { getProject } from "../store.js";
import { clusterPeerMayAccessProject } from "./cluster-helpers.js";

export class BrowserRequestError extends Error { constructor(public status: number, message: string) { super(message); } }
let runtime: BrowserRuntime | undefined;
let pendingStarts = 0;
let configuring = false;
export function browserRuntime(): BrowserRuntime {
  return runtime ??= new BrowserRuntime({ proxyFor: async start => createBrowserProxy(async (host, port) => {
    if (!browserLoopbackHost(host)) return browserTcpConnect(host, port);
    const local = await getClusterNode();
    const loopback = host.replace(/^\[|\]$/g, "") === "::1" ? "::1" : "127.0.0.1";
    if (start.appNodeId === local.id) return browserTcpConnect(loopback, port);
    const peer = await getClusterPeer(start.appNodeId);
    if (!peer) throw new BrowserRequestError(503, "App node is no longer paired");
    const url = new URL("/ws", peer.url); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ mode: "browserTunnel", projectId: start.projectId, host: loopback, port: String(port) }).toString();
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${await getClusterMachineToken()}` }, handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("App node tunnel timed out")); }, 10000);
      const fail = () => { clearTimeout(timeout); reject(new Error("App node tunnel unavailable")); };
      socket.once("error", fail); socket.once("close", fail);
      socket.once("message", data => {
        clearTimeout(timeout); socket.off("error", fail); socket.off("close", fail);
        try { if (JSON.parse(data.toString()).ready !== true) throw Error(); resolve(); }
        catch { socket.terminate(); reject(new Error("Invalid app node tunnel response")); }
      });
    });
    return createWebSocketStream(socket);
  }) });
}
export async function closeBrowserRuntime(): Promise<void> { await runtime?.close(); runtime = undefined; }

async function peerRequest(peerId: string, route: string, body?: unknown, timeout = 15000): Promise<Response> {
  const peer = await getClusterPeer(peerId);
  if (!peer) throw new BrowserRequestError(503, "Browser executor is no longer paired");
  let response: Response;
  try {
    response = await fetch(`${peer.url}/api/cluster/browser/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${await getClusterMachineToken()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new BrowserRequestError(503, "Browser executor is unreachable. Sessions are not moved to another node."); }
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new BrowserRequestError(response.status, error.error || `Browser executor returned ${response.status}`);
  }
  return response;
}
export async function localBrowserStatus() {
  return { config: readBrowserConfiguration(), capability: await browserCapability(), runningCount: (await browserRuntime().list()).filter(row => row.state === "running").length + pendingStarts };
}
interface BrowserNodeStatus extends BrowserCapability { id: string; name: string; reachable: boolean; runningCount: number; }
export async function browserStatus() {
  const [local, peers, own] = await Promise.all([getClusterNode(), listClusterPeers(), localBrowserStatus()]);
  const nodes: BrowserNodeStatus[] = [{ id: local.id, name: local.name, reachable: true, runningCount: own.runningCount, ...own.capability }];
  const remote = await Promise.all(peers.map(async peer => {
    try {
      const response = await peerRequest(peer.id, "status", undefined, 4000);
      const status = await response.json() as Awaited<ReturnType<typeof localBrowserStatus>>;
      applyBrowserConfiguration(browserConfigurationSchema.parse(status.config));
      return { id: peer.id, name: peer.name, reachable: true, runningCount: status.runningCount, ...status.capability };
    } catch {
      return { id: peer.id, name: peer.name, reachable: false, runningCount: 0, supported: false, available: false, executable: null, reason: "Node unavailable or needs a Joint Bob update" };
    }
  }));
  nodes.push(...remote);
  return { config: readBrowserConfiguration(), nodes };
}
export async function configureBrowserExecutor(executorNodeId: string | null): Promise<Awaited<ReturnType<typeof browserStatus>>> {
  const [local, peers] = await Promise.all([getClusterNode(), listClusterPeers()]);
  // One coordinator serializes choices made from different signed-in nodes.
  const coordinator = [local.id, ...peers.map(peer => peer.id)].sort()[0];
  if (coordinator !== local.id) {
    await peerRequest(coordinator, "select", { executorNodeId }, 30000);
    return browserStatus();
  }
  if (configuring) throw new BrowserRequestError(409, "Browser executor configuration is already changing");
  configuring = true;
  try {
    const status = await browserStatus();
    if (executorNodeId === status.config.executorNodeId) return status;
    if (status.nodes.some(node => !node.reachable)) throw new BrowserRequestError(409, "Bring all paired nodes online before changing the browser executor");
    if (status.nodes.some(node => node.runningCount > 0)) throw new BrowserRequestError(409, "End running browser sessions or wait for starting browsers before changing the executor");
    if (executorNodeId && !status.nodes.some(node => node.id === executorNodeId && node.available && node.supported)) throw new BrowserRequestError(409, "Choose an available Ubuntu node with Chrome installed");
    const config: BrowserConfiguration = { executorNodeId, originNodeId: local.id, updatedAt: new Date(Math.max(Date.now(), Date.parse(status.config.updatedAt) + 1)).toISOString() };
    // Fence the previous executor first. Its atomic admission check counts in-flight
    // starts too; after it acknowledges, no stale caller can start another browser there.
    const previous = status.config.executorNodeId;
    if (previous && previous !== local.id) await peerRequest(previous, "config", config);
    applyBrowserConfiguration(config);
    await Promise.all(peers.filter(peer => peer.id !== previous).map(peer => peerRequest(peer.id, "config", config)));
    return browserStatus();
  } finally { configuring = false; }
}
async function executorNode() {
  const { config } = await browserStatus();
  if (!config.executorNodeId) throw new BrowserRequestError(409, "Choose a browser executor in Settings → Cluster first");
  return { config, local: (await getClusterNode()).id === config.executorNodeId };
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
  if (readBrowserConfiguration().executorNodeId !== local.id) throw new BrowserRequestError(409, "This node is not the selected browser executor");
  const service = browserRuntime();
  const projectId = "projectId" in operation.args ? operation.args.projectId : "id" in operation.args ? (await service.get(operation.args.id)).projectId : undefined;
  if (projectId) {
    const project = await getProject(projectId);
    if (!project) throw new BrowserRequestError(404, "Project not found on browser executor");
    if (machineNodeId && !(await clusterPeerMayAccessProject(machineNodeId, projectId))) throw new BrowserRequestError(403, "Project is not shared with this node");
    if ("projectId" in operation.args) operation.args.projectId = project.id;
  }
  switch (operation.operation) {
    case "start": {
      if (operation.args.appNodeId !== local.id && !(await getClusterPeer(operation.args.appNodeId))) throw new BrowserRequestError(400, "App node is not paired");
      if (configuring || readBrowserConfiguration().executorNodeId !== local.id) throw new BrowserRequestError(409, "Browser executor configuration changed; retry startup");
      pendingStarts++;
      try {
        const session = await service.create(operation.args);
        if (readBrowserConfiguration().executorNodeId !== local.id) {
          await service.execute(session.id, { action: "close" }, { kind: "agent" });
          throw new BrowserRequestError(409, "Browser executor changed during startup; browser closed, retry on selected node");
        }
        return { session };
      } finally { pendingStarts--; }
    }
    case "list": {
      const sessions = await service.list(operation.args);
      return { sessions: machineNodeId ? (await Promise.all(sessions.map(async session => await clusterPeerMayAccessProject(machineNodeId, session.projectId) ? session : null))).filter(Boolean) : sessions };
    }
    case "get": return { session: await service.get(operation.args.id) };
    case "command": return { result: await service.execute(operation.args.id, operation.args.command, actor), session: await service.get(operation.args.id) };
    case "profiles": return { profiles: await service.profiles(operation.args.projectId) };
    case "deleteProfile": await service.deleteProfile(operation.args.id, operation.args.projectId); return { deleted: true };
  }
}
export async function browserOperation(input: BrowserOperation, actor: BrowserActor): Promise<unknown> {
  const { config, local } = await executorNode();
  if (local) return localBrowserOperation(input, actor);
  return (await peerRequest(config.executorNodeId!, "operation", { ...input, actor, config }, 60000)).json();
}
export async function browserDownload(id: string, downloadId: string): Promise<{ stream: Readable; name: string }> {
  idSchema.parse(id); idSchema.parse(downloadId);
  const { config, local } = await executorNode();
  if (local) { const file = await browserRuntime().download(id, downloadId); return { stream: createReadStream(file.path), name: file.name }; }
  const response = await peerRequest(config.executorNodeId!, "download", { id, downloadId, config }, 120000);
  if (!response.body) throw new BrowserRequestError(502, "Browser download has no content");
  return { stream: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), name: decodeURIComponent(response.headers.get("x-browser-filename") || "download") };
}

export async function attachBrowserTunnel(socket: WebSocket, url: URL, machineNodeId: string | undefined) {
  if (!machineNodeId) { socket.close(1008, "Machine authentication required"); return; }
  try {
    const projectId = z.string().min(1).parse(url.searchParams.get("projectId"));
    if (!(await getProject(projectId)) || !(await clusterPeerMayAccessProject(machineNodeId, projectId))) throw Error("Project is not shared with this node");
    const host = z.string().min(1).parse(url.searchParams.get("host"));
    if (!browserLoopbackHost(host)) throw Error("Browser app tunnels only permit loopback targets");
    const port = z.coerce.number().int().min(1).max(65535).parse(url.searchParams.get("port"));
    const tcp = await browserTcpConnect(host === "::1" || host === "[::1]" ? "::1" : "127.0.0.1", port);
    if (socket.readyState !== WebSocket.OPEN) { tcp.destroy(); return; }
    socket.send(JSON.stringify({ ready: true }));
    const stream = createWebSocketStream(socket);
    stream.on("error", () => tcp.destroy()); tcp.on("error", () => stream.destroy());
    stream.on("close", () => tcp.destroy()); tcp.on("close", () => stream.destroy());
    tcp.pipe(stream); stream.pipe(tcp);
  } catch { socket.close(1008, "Browser app tunnel unavailable or not permitted"); }
}
export async function attachBrowserViewer(socket: WebSocket, url: URL, actor: BrowserActor, machineNodeId?: string) {
  try {
    const id = idSchema.parse(url.searchParams.get("browserSessionId"));
    if (machineNodeId) {
      const session = await browserRuntime().get(id);
      if (!(await clusterPeerMayAccessProject(machineNodeId, session.projectId))) throw Error("Project is not shared");
      if (readBrowserConfiguration().executorNodeId !== (await getClusterNode()).id) throw Error("Executor changed");
      await browserRuntime().attachViewer(id, socket, actor); return;
    }
    const target = await executorNode();
    if (target.local) { await browserRuntime().attachViewer(id, socket, actor); return; }
    const peer = await getClusterPeer(target.config.executorNodeId!);
    if (!peer) throw Error("Executor unavailable");
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
    socket.once("close", () => upstream.terminate()); upstream.once("close", () => socket.close(1012, "Browser executor disconnected; reconnect to resume viewing"));
    upstream.on("error", () => socket.close(1011, "Browser executor unavailable")); socket.on("error", () => upstream.terminate());
  } catch (error) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "browserError", error: error instanceof Error ? error.message : "Browser unavailable" })); socket.close(1008, "Browser session unavailable"); }
}
