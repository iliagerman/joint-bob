import type { NextFunction, Request, Response } from "express";
import type { AuthSession } from "../auth.js";
import { sendError } from "./http-auth.js";

/** The node's admin: its local admin account, signed in here, never a visitor from another node. */
export function isNodeAdmin(session: Pick<AuthSession, "role" | "isRemoteLogin" | "live"> | undefined): boolean {
  return Boolean(session && session.role === "admin" && !session.isRemoteLogin && !session.live);
}

/**
 * Routes that exist only for the node's admin. For anyone else they answer exactly like an
 * unknown route, so a member can't learn that they exist. `method` "*" matches any method.
 * Paths are matched without the `/api` prefix.
 */
export const ADMIN_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  // Node settings: harness paths, Syncthing, home folder, limits, sync check, skills publishing.
  { method: "PUT", path: /^\/settings$/ },
  { method: "*", path: /^\/settings\/(sync-check|runtime-defaults|runtime-check|skills)(\/|$)/ },
  { method: "*", path: /^\/terminal-policy$/ },
  { method: "*", path: /^\/node-blocks(\/|$)/ },
  { method: "*", path: /^\/users(\/|$)/ },
  { method: "*", path: /^\/multi-user(\/|$)/ },
  { method: "*", path: /^\/audit$/ },
  // Updates and the cluster inventory they read.
  { method: "*", path: /^\/update\// },
  { method: "*", path: /^\/cluster\/inventory$/ },
  // Node identity and twins.
  { method: "PUT", path: /^\/cluster\/node$/ },
  { method: "*", path: /^\/twins(\/|$)/ },
  { method: "*", path: /^\/clusters\/[^/]+\/members\/[^/]+\/twin-request$/ },
  // Global resource paths and node-wide resource inventory.
  { method: "*", path: /^\/resources\/inventory$/ },
  // Skills and MCP servers published from here load into everyone's agents on this node.
  { method: "*", path: /^\/resources\/skills(\/|$)/ },
  { method: "*", path: /^\/resources\/mcp\/share$/ },
  // Git repositories install skills, plugins and MCP servers for every agent on this node.
  { method: "*", path: /^\/resources\/git(\/|$)/ },
  // The browser executor's configuration for this machine.
  { method: "PUT", path: /^\/browser\/config$/ },
  // How this node, and a relay it serves, keeps conversation summaries.
  { method: "PUT", path: /^\/conversation-summary\/(settings|relay-policy)$/ },
];

/** Express matches routes whatever their letter case and with a trailing slash, so the gate
    must too: `/API/Users/` reaches the same handler as `/api/users`. */
export function isAdminRoute(method: string, requestPath: string): boolean {
  const path = requestPath.toLowerCase().replace(/\/+$/, "") || "/";
  return ADMIN_ROUTES.some((route) => (route.method === "*" || route.method === method) && route.path.test(path));
}

/** Mounted on `/api` after authentication. Peers and agents never reach admin routes either. */
export function adminGate(request: Request, response: Response, next: NextFunction): void {
  if (!isAdminRoute(request.method, request.path)) { next(); return; }
  if (isNodeAdmin(response.locals.authSession as AuthSession | undefined)) { next(); return; }
  sendError(response, 404, "Not found");
}

/** For a route that is admin-only but registered outside the gate's list. */
export function requireAdmin(_request: Request, response: Response, next: NextFunction): void {
  if (!isNodeAdmin(response.locals.authSession as AuthSession | undefined)) { sendError(response, 404, "Not found"); return; }
  next();
}
