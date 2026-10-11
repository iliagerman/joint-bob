import type { NextFunction, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import { listLocalUsers, type AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { actorOwns } from "../ownership.js";
import { personalSettings } from "../settings.js";
import { getProject, listWorkspaces } from "../store.js";
import type { ProjectView } from "../types.js";
import { accountSnapshotFor } from "../user-replication.js";
import { fetchPeer } from "./peer-availability.js";
import { projectsWithSharedNames } from "./projects.js";
import { replicationPeers } from "./replication-v2.js";
import { ensureRoamingSchema } from "./roaming.js";
import { mayShareProject } from "./sharing-files.js";
import { app } from "./state.js";
import WebSocket from "ws";
import { encodeAuthor } from "../message-authors.js";
import type { MessageAuthor } from "../message-author-schema.js";
import { proxySocket } from "./chat.js";
import { runtimeSocketHeaders } from "./runtime-peers.js";

/**
 * Your unshared projects on a node you signed in to. They travel live and are never copied:
 * that node relays your requests about them to your home node, signed and naming you, and
 * streams the answers back without keeping them. Your home node answers only while you are
 * signed in there, it is in one of your clusters, neither blocks the other, you show your
 * projects on other nodes, and the project is yours and not hidden from other nodes.
 */
export function ensureLiveSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS project_live_hidden (project_id TEXT PRIMARY KEY, hidden_at TEXT NOT NULL)");
}

export async function projectHiddenFromOtherNodes(projectId: string): Promise<boolean> {
  const db = await clusterV2Database();
  ensureLiveSchema(db);
  return Boolean(db.prepare("SELECT 1 FROM project_live_hidden WHERE project_id = ?").get(projectId));
}

export async function setProjectHiddenFromOtherNodes(projectId: string, hidden: boolean): Promise<void> {
  const db = await clusterV2Database();
  ensureLiveSchema(db);
  if (hidden) db.prepare("INSERT OR IGNORE INTO project_live_hidden (project_id, hidden_at) VALUES (?, ?)").run(projectId, new Date().toISOString());
  else db.prepare("DELETE FROM project_live_hidden WHERE project_id = ?").run(projectId);
}

/** The projects a relayed request names, or nothing when it isn't one a node may relay. */
function relayedProjectIds(inner: URL, body: unknown): string[] | undefined {
  const match = /^\/api\/projects\/([^/]+)(\/|$)/i.exec(inner.pathname);
  if (!match) return undefined;
  const ids = new Set<string>();
  try { ids.add(decodeURIComponent(match[1])); } catch { return undefined; }
  for (const [key, value] of inner.searchParams) {
    if (/^nodeid(\[|$)/i.test(key)) return undefined;
    if (/^projectids?(\[|$)/i.test(key)) ids.add(value);
  }
  if (body && typeof body === "object") {
    const fields = body as { projectId?: unknown; projectIds?: unknown; nodeId?: unknown };
    if (fields.nodeId !== undefined && fields.nodeId !== null && fields.nodeId !== "") return undefined;
    for (const value of [fields.projectId, ...(Array.isArray(fields.projectIds) ? fields.projectIds : fields.projectIds === undefined ? [] : [fields.projectIds])]) {
      if (value === undefined) continue;
      if (typeof value !== "string" || !value) return undefined;
      ids.add(value);
    }
  }
  return [...ids];
}

/** Every project a request names: in its path, its query or its body. */
export function projectIdsIn(pathname: string, query: Record<string, unknown>, body: unknown): string[] {
  const ids = new Set<string>();
  const match = /^\/api\/projects\/([^/?]+)/.exec(pathname);
  if (match) { try { ids.add(decodeURIComponent(match[1])); } catch { ids.add(match[1]); } }
  for (const value of [query.projectId, (body as { projectId?: unknown } | null | undefined)?.projectId]) if (typeof value === "string" && value) ids.add(value);
  return [...ids];
}

// ---------------------------------------------------------------------------------------------
// At home

const accountIdPattern = /^[0-9a-f]{32}$/;

/** The person a live request from `sender` acts for, as a session here; 404 unless allowed. */
async function liveSession(sender: string, accountId: string): Promise<AuthSession> {
  if (!accountIdPattern.test(accountId)) throw new ClusterV2HttpError(404, "Not found");
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureRoamingSchema(db);
  const user = listLocalUsers().find((candidate) => candidate.accountId === accountId && !candidate.disabled);
  const signedInThere = db.prepare("SELECT 1 FROM account_roaming_nodes WHERE account_id = ? AND node_id = ?").get(accountId, sender);
  // A twin holds every sign-in record, but a member's things go only to nodes of a cluster they joined.
  if (!user || !signedInThere || !accountSnapshotFor(db, local.id, sender).accounts.some((account) => account.accountId === accountId && (user.role === "admin" || account.clusterIds.length > 0))) throw new ClusterV2HttpError(404, "Not found");
  const session: AuthSession = { id: `live:${accountId}:${sender}`, userId: user.userId, username: user.username, accountId, email: user.email, role: user.role, csrfToken: "", mustChangePassword: false, isRemoteLogin: false, homeNodeId: null, live: true };
  if (!personalSettings(actingAccountFromSession(session)).showProjectsOnOtherNodes) throw new ClusterV2HttpError(404, "Not found");
  return session;
}

/** Whether a project of this node travels live to `sender` for the acting person. */
async function travelsLive(db: DatabaseSync, local: string, sender: string, projectId: string): Promise<boolean> {
  ensureLiveSchema(db);
  const project = await getProject(projectId);
  if (!project || !actorOwns("project", project.id)) return false;
  const owner = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind = 'project' AND resource_id = ?").get(project.id) as { owner_node_id: string } | undefined;
  if (owner && owner.owner_node_id !== local) return false;
  if (db.prepare("SELECT 1 FROM project_live_hidden WHERE project_id = ?").get(project.id)) return false;
  // A project shared with that node is already there, as itself.
  return !mayShareProject(db, local, sender, project.id);
}

async function liveCatalog(sender: string, session: AuthSession): Promise<{ projects: ProjectView[]; workspaces: Awaited<ReturnType<typeof listWorkspaces>> }> {
  const db = await clusterV2Database(), local = await getClusterNode();
  return runAsAccount(actingAccountFromSession(session), async () => {
    const projects: ProjectView[] = [];
    for (const project of await projectsWithSharedNames({ includeSyncStatus: false })) if (await travelsLive(db, local.id, sender, project.id)) projects.push(project);
    const types = new Set(projects.map((project) => project.type));
    return { projects, workspaces: (await listWorkspaces()).filter((workspace) => types.has(workspace.id)) };
  });
}

/**
 * `/api/cluster/v2/live/<account>/<request>`: a visited node's relay of one of our people's
 * requests. It runs here as that person, through the same routes as at home, for their own
 * live projects only; anything else answers like an unknown route.
 */
export function receiveLiveRequest(request: Request, response: Response, next: NextFunction): void {
  void (async () => {
    const sender = response.locals.machineProtocol === 2 && typeof response.locals.machineNodeId === "string" ? response.locals.machineNodeId as string : undefined;
    if (!sender) throw new ClusterV2HttpError(401, "Unauthorized");
    const session = await liveSession(sender, request.params.accountId);
    const outer = new URL(request.originalUrl, "http://live");
    const prefix = `/api/cluster/v2/live/${request.params.accountId}/`;
    if (!outer.pathname.startsWith(prefix)) throw new ClusterV2HttpError(404, "Not found");
    const inner = new URL(`/api/${outer.pathname.slice(prefix.length)}${outer.search}`, "http://live");
    if (request.method === "GET" && inner.pathname === "/api/live-catalog") { response.setHeader("Cache-Control", "no-store"); response.json(await liveCatalog(sender, session)); return; }
    // A relayed request is about one of the person's projects and nothing else: only a
    // project's own routes, every project it names anywhere must travel live, and it is
    // never passed on to a third node.
    const ids = relayedProjectIds(inner, request.body);
    const db = await clusterV2Database(), local = await getClusterNode();
    const allowed = ids !== undefined && await runAsAccount(actingAccountFromSession(session), async () => {
      for (const id of ids) if (!await travelsLive(db, local.id, sender, id)) return false;
      return true;
    });
    if (!allowed) throw new ClusterV2HttpError(404, "Not found");
    // From here the request is the person's own, at home.
    request.url = `${inner.pathname.toLowerCase().startsWith("/api/projects/") ? `/api/projects/${inner.pathname.slice("/api/projects/".length)}` : inner.pathname}${inner.search}`;
    (request as { query?: unknown }).query = undefined;
    for (const key of ["machineAuth", "machineNodeId", "machineProtocol"]) delete response.locals[key];
    response.locals.authSession = session;
    response.locals.liveRelay = sender;
    response.setHeader("Cache-Control", "no-store");
    (app as unknown as { handle: (request: Request, response: Response, next: NextFunction) => void }).handle(request, response, next);
  })().catch((error) => {
    if (error instanceof ClusterV2HttpError) { response.status(error.statusCode).json({ error: error.statusCode === 404 ? "Not found" : error.message }); return; }
    next(error);
  });
}

/** A live socket from `sender` for one of our people: the session it runs as, if allowed. */
export async function liveSocketSession(sender: string, accountId: string, projectId: string): Promise<AuthSession | undefined> {
  try {
    const session = await liveSession(sender, accountId);
    const db = await clusterV2Database(), local = await getClusterNode();
    return await runAsAccount(actingAccountFromSession(session), () => travelsLive(db, local.id, sender, projectId)) ? session : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// On the node a visitor signed in to

async function homePeer(session: AuthSession) {
  if (!session.homeNodeId) return undefined;
  const db = await clusterV2Database(), local = await getClusterNode();
  return { db, local, peer: replicationPeers(db, local.id).find((candidate) => candidate.nodeId === session.homeNodeId) };
}

async function fetchHome(session: AuthSession, method: string, inner: string, body: Buffer, timeoutMs: number): Promise<globalThis.Response> {
  const home = await homePeer(session);
  if (!home?.peer) throw new ClusterV2HttpError(503, "Your home node is offline");
  const target = `/api/cluster/v2/live/${session.accountId}/${inner}`;
  const authorization = signClusterRequest(home.db, home.local.id, home.peer.nodeId, method, target, body);
  return fetchPeer(home.db, home.peer.nodeId, new URL(target, home.peer.url), {
    method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: authorization, ...(body.length ? { "Content-Type": "application/json" } : {}) },
    ...(body.length ? { body: new Uint8Array(body) } : {}),
  });
}

/** A visitor's projects at home, live. Offline, there is nothing to list, only that it's offline. */
export async function liveHomeCatalog(session: AuthSession): Promise<{ projects: Array<ProjectView & { live: { homeNodeId: string } }>; workspaces: unknown[]; home: { nodeId: string; name: string | null; online: boolean } } | undefined> {
  if (!session.isRemoteLogin || !session.homeNodeId) return undefined;
  const home = await homePeer(session);
  const base = { nodeId: session.homeNodeId, name: home?.peer?.name ?? null };
  try {
    const response = await fetchHome(session, "GET", "live-catalog", Buffer.alloc(0), 5000);
    if (response.status === 404) return { projects: [], workspaces: [], home: { ...base, online: true } };
    if (!response.ok) throw new Error(`Home answered ${response.status}`);
    const catalog = await response.json() as { projects: ProjectView[]; workspaces: unknown[] };
    return { projects: catalog.projects.map((project) => ({ ...project, live: { homeNodeId: session.homeNodeId! } })), workspaces: catalog.workspaces, home: { ...base, online: true } };
  } catch {
    return { projects: [], workspaces: [], home: { ...base, online: false } };
  }
}

/**
 * Relays a visitor's request about a project this node doesn't have to their home node, and
 * streams the answer back. Nothing of it is written here.
 */
export function relayLiveRequests(request: Request, response: Response, next: NextFunction): void {
  const session = response.locals.authSession as AuthSession | undefined;
  if (!session?.isRemoteLogin || !session.homeNodeId || response.locals.machineAuth) { next(); return; }
  const url = new URL(request.originalUrl, "http://visited");
  const ids = projectIdsIn(url.pathname, Object.fromEntries(url.searchParams), request.body);
  if (!ids.length) { next(); return; }
  void (async () => {
    const remote: string[] = [];
    for (const id of ids) if (!await getProject(id)) remote.push(id);
    if (!remote.length) { next(); return; }
    const body = ["GET", "HEAD"].includes(request.method) ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request.body ?? {}));
    let upstream: globalThis.Response;
    try { upstream = await fetchHome(session, request.method, `${url.pathname.slice("/api/".length)}${url.search}`, body, 120_000); }
    catch { response.status(503).json({ error: "Your home node is offline; this project opens when it's back" }); return; }
    response.status(upstream.status);
    for (const header of ["content-type", "content-disposition", "content-length", "last-modified", "etag"]) {
      const value = upstream.headers.get(header);
      if (value) response.setHeader(header, value);
    }
    response.setHeader("Cache-Control", "no-store");
    if (!upstream.body || request.method === "HEAD") { response.end(); return; }
    Readable.fromWeb(upstream.body as unknown as WebReadableStream).pipe(response);
  })().catch(next);
}

/** A visitor's conversation socket for one of their projects at home, relayed there. They
    get no terminal on another node, here as anywhere else. */
export async function relayLiveSocket(socket: WebSocket, url: URL, session: AuthSession, author: MessageAuthor | undefined): Promise<void> {
  if (url.searchParams.get("mode")) { socket.close(1008, "Not available on another node"); return; }
  const home = await homePeer(session);
  if (!home?.peer) { socket.close(1011, "Your home node is offline"); return; }
  const target = new URL("/ws", home.peer.url);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  for (const [key, value] of url.searchParams) if (key !== "nodeId") target.searchParams.set(key, value);
  target.searchParams.set("liveAccount", session.accountId);
  if (author) target.searchParams.set("author", encodeAuthor(author)); else target.searchParams.delete("author");
  proxySocket(socket, new WebSocket(target, { headers: await runtimeSocketHeaders(home.peer.nodeId, target) }));
}
