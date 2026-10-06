import type { NextFunction, Request, Response } from "express";
import type { AuthSession } from "../auth.js";
import { sendError } from "./http-auth.js";

/** The node's admin: its local admin account, signed in here, never a visitor from another node. */
export function isNodeAdmin(session: AuthSession | undefined): boolean {
  return Boolean(session && session.role === "admin" && !session.isRemoteLogin);
}

/** Admin routes don't exist for anyone else: they answer exactly like an unknown route. */
export function requireAdmin(_request: Request, response: Response, next: NextFunction): void {
  if (!isNodeAdmin(response.locals.authSession as AuthSession | undefined)) { sendError(response, 404, "Not found"); return; }
  next();
}
