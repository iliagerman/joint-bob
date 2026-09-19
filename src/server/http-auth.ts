import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { type AuthSession, sessionCookieName, sessionForId } from "../auth.js";
import { type ClusterPeer, getClusterMachineToken, getClusterNode, listClusterPeers } from "../cluster.js";
import { clusterMembershipMemberSchema } from "./schemas.js";
import { machineRoutes } from "./state.js";
import { browserAgentIdentity } from "../browser-agent.js";
import { backgroundTaskAgentIdentity } from "../background-task-agent.js";
import { ntfyAgentIdentity } from "../ntfy-agent.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../cluster-identity.js";
import { ClusterProtocolError, verifyClusterRequest } from "../cluster-protocol.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../cluster-v2-mode.js";

const clusterRawBodies = new WeakMap<IncomingMessage, Buffer>();

function isClusterV2Url(url: string | undefined): boolean {
  if (url === undefined) return false;
  const pathname = url.split("?", 1)[0].toLowerCase();
  return pathname === "/api/cluster/v2" || pathname.startsWith("/api/cluster/v2/");
}

export function captureClusterRawBody(request: IncomingMessage, _response: ServerResponse, body: Buffer): void {
  if (isClusterV2Url(request.url)) clusterRawBodies.set(request, Buffer.from(body));
}

export function rejectEncodedClusterBody(request: Request, response: Response, next: NextFunction): void {
  const encoding = request.header("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    response.status(415).json({ error: "Encoded cluster request bodies are not supported" });
    return;
  }
  next();
}

export function clusterBodyParserError(error: unknown, request: Request, response: Response, next: NextFunction): void {
  if (!isClusterV2Url(request.originalUrl)) { next(error); return; }
  const type = (error as { type?: string }).type;
  if (type === "entity.parse.failed") { response.status(400).json({ error: "Malformed cluster JSON" }); return; }
  if (type === "entity.too.large") { response.status(413).json({ error: "Cluster request body is too large" }); return; }
  if (type === "encoding.unsupported") { response.status(415).json({ error: "Encoded cluster request bodies are not supported" }); return; }
  next(error);
}

export function sendError(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).json({ error: message });
}

function isSecureClusterUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}

export function canonicalClusterUrl(value: string): string {
  return new URL(value).origin;
}

export function isClusterOriginUrl(value: string): boolean {
  const url = new URL(value);
  return isSecureClusterUrl(value) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}

export function parseClusterInvitationLink(link: string): { inviterUrl: string; invitationId: string; secret: string } {
  const invitationUrl = new URL(link);
  if (!isSecureClusterUrl(invitationUrl.href) || invitationUrl.username || invitationUrl.password) throw new Error("Cluster invitation link is invalid");
  const [invitationId, secret, extra] = invitationUrl.hash.slice(1).split(".");
  if (invitationUrl.pathname !== "/join" || invitationUrl.search || extra || !secret) throw new Error("Cluster invitation link is invalid");
  return {
    inviterUrl: invitationUrl.origin,
    invitationId: z.string().uuid().parse(invitationId),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(secret),
  };
}

export function clusterInvitationConflict(member: z.infer<typeof clusterMembershipMemberSchema>, localNode: Awaited<ReturnType<typeof getClusterNode>>, peers: ClusterPeer[], retry: boolean): string | undefined {
  const normalizedUrl = canonicalClusterUrl(member.url);
  if (member.id === localNode.id || (localNode.url && normalizedUrl === canonicalClusterUrl(localNode.url))) return "A node cannot join itself";
  const idPeer = peers.find((peer) => peer.id === member.id);
  const urlPeer = peers.find((peer) => canonicalClusterUrl(peer.url) === normalizedUrl);
  const samePeer = idPeer && canonicalClusterUrl(idPeer.url) === normalizedUrl && idPeer.token === member.token && (!urlPeer || urlPeer.id === member.id);
  if (retry && samePeer) return undefined;
  if (idPeer || urlPeer) return "A cluster member already uses this identity or URL";
  return undefined;
}

export function prospectiveClusterNode(node: Awaited<ReturnType<typeof getClusterNode>>, name: string, url: string): Awaited<ReturnType<typeof getClusterNode>> {
  return node.name === name && node.url === url ? node : { ...node, name, url, updatedAt: new Date().toISOString() };
}

export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  // xterm.js sizes its rows by injecting a <style> element it rewrites on every
  // resize, and paints ANSI colours through per-cell style attributes. Neither can
  // carry a nonce or a stable hash, so the terminal needs inline styles allowed.
  // Scripts stay locked to 'self', and default-src/img-src keep CSS from reaching
  // any off-origin URL, so this does not open a data-exfiltration path.
  const inlineStyle = "'self' 'unsafe-inline'";
  response.setHeader("Content-Security-Policy", `default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src-elem ${inlineStyle}; style-src-attr ${inlineStyle}; script-src 'self'`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  // The canvas embeds the normal chat surface in a same-origin iframe; every other
  // document stays unframeable.
  response.setHeader("X-Frame-Options", request.path === "/" && request.query.canvasPane === "1" ? "SAMEORIGIN" : "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  next();
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.header("authorization") ?? "");
  return match?.[1];
}

export function machineTokenMatches(candidate: string, expected: string): boolean {
  const actual = Buffer.from(candidate);
  const expectedToken = Buffer.from(expected);
  return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken);
}

export function requestCookie(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.header("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

export async function machineCredentialNodeId(token: string): Promise<string | undefined> {
  const [local, localToken, peers] = await Promise.all([getClusterNode(), getClusterMachineToken(), listClusterPeers()]);
  if (machineTokenMatches(token, localToken)) return local.id;
  return peers.find((peer) => machineTokenMatches(token, peer.token))?.id;
}

export function clusterRequestRawBody(request: Request): Buffer {
  const captured = clusterRawBodies.get(request);
  const declaredBody = request.header("transfer-encoding") !== undefined || Number(request.header("content-length") ?? "0") > 0;
  if (!captured && declaredBody) throw new ClusterV2HttpError(415, "Unsupported cluster request body");
  return captured ?? Buffer.alloc(0);
}

async function requireClusterV2Auth(request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    const captured = clusterRequestRawBody(request);
    const node = await getClusterNode();
    const database = await clusterV2Database();
    const identity = getOrCreateClusterIdentity(database, node.id);
    pinClusterPublicKey(database, node.id, identity.publicKey);
    const sender = verifyClusterRequest(database, node.id, request.method, request.originalUrl, captured, request.header("authorization"));
    response.locals.machineAuth = true;
    response.locals.machineNodeId = sender;
    response.locals.machineProtocol = 2;
    next();
  } catch (error) {
    if (error instanceof ClusterProtocolError) { sendError(response, 401, "Unauthorized"); return; }
    if (error instanceof ClusterV2HttpError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
}

export async function requireHttpAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (isClusterV2Url(`/api${request.path}`)) {
    await requireClusterV2Auth(request, response, next);
    return;
  }
  const token = bearerToken(request);
  if (request.path === "/browser/agent" && request.method === "POST" && token) {
    const identity = browserAgentIdentity(token);
    if (identity) { response.locals.browserAgent = identity; response.locals.browserAgentToken = token; next(); return; }
  }
  if (request.path === "/background-tasks/agent" && request.method === "POST" && token) {
    const identity = backgroundTaskAgentIdentity(token);
    if (identity) { response.locals.taskAgent = identity; next(); return; }
  }
  if (request.path === "/ntfy/agent" && request.method === "POST" && token) {
    const identity = ntfyAgentIdentity(token);
    if (identity) { response.locals.ntfyAgent = identity; next(); return; }
  }
  const machineNodeId = machineRoutes.has(`${request.method} ${request.path}`) && token
    ? await machineCredentialNodeId(token)
    : undefined;
  if (machineNodeId) {
    if (await selectiveSharingActive()) { sendError(response, 409, "Legacy machine authentication is disabled in selective sharing mode"); return; }
    response.locals.machineAuth = true;
    response.locals.machineNodeId = machineNodeId;
    next();
    return;
  }
  const session = sessionForId(requestCookie(request, sessionCookieName));
  if (!session) {
    sendError(response, 401, "Unauthorized");
    return;
  }
  response.locals.authSession = session;
  if (session.mustChangePassword && !["/auth/change-password", "/auth/logout"].includes(request.path)) {
    sendError(response, 403, "Change the initial password before using the application");
    return;
  }
  next();
}

export function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || response.locals.machineAuth || response.locals.browserAgent || response.locals.taskAgent || response.locals.ntfyAgent) {
    next();
    return;
  }
  const session = response.locals.authSession as AuthSession | undefined;
  if (session && request.header("x-csrf-token") === session.csrfToken) {
    next();
    return;
  }
  sendError(response, 403, "Invalid CSRF token");
}
