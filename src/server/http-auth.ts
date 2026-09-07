import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { type AuthSession, sessionCookieName, sessionForId } from "../auth.js";
import { type ClusterPeer, getClusterMachineToken, getClusterNode, listClusterPeers } from "../cluster.js";
import { clusterMembershipMemberSchema } from "./schemas.js";
import { machineRoutes } from "./state.js";

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

async function machineCredentialNodeId(token: string): Promise<string | undefined> {
  const [local, localToken, peers] = await Promise.all([getClusterNode(), getClusterMachineToken(), listClusterPeers()]);
  if (machineTokenMatches(token, localToken)) return local.id;
  return peers.find((peer) => machineTokenMatches(token, peer.token))?.id;
}

export async function requireHttpAuth(request: Request, response: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(request);
  const machineNodeId = machineRoutes.has(`${request.method} ${request.path}`) && token
    ? await machineCredentialNodeId(token)
    : undefined;
  if (machineNodeId) {
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
  if (["GET", "HEAD", "OPTIONS"].includes(request.method) || response.locals.machineAuth) {
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
