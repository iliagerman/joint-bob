import type WebSocket from "ws";
import type { ActingAccount } from "../account-context.js";
import { recordAuditEvent } from "../audit.js";
import { terminalAccessSettings, terminalAllowedFor } from "../settings.js";

/** Open terminals per account, so a person can't hold more than the admin allows. */
const openTerminals = new Map<string, Set<WebSocket>>();

export function openTerminalCount(accountId: string): number {
  return openTerminals.get(accountId)?.size ?? 0;
}

export type TerminalClaim = { ok: true; idleMinutes: number } | { ok: false; reason: string };

/**
 * Decides whether `account` may open one more terminal here. A refused person learns only
 * that a terminal isn't available, never the policy behind it; the limit is the one
 * exception, because it is about their own open terminals.
 */
export function claimTerminal(account: ActingAccount | undefined, socket: WebSocket, projectId: string): TerminalClaim {
  const settings = terminalAccessSettings();
  if (!account || !terminalAllowedFor(account, settings)) return { ok: false, reason: "Not available" };
  const sockets = openTerminals.get(account.accountId) ?? new Set<WebSocket>();
  if (sockets.size >= settings.maxPerUser) return { ok: false, reason: `You already have ${sockets.size} terminals open. Close one to open another.` };
  sockets.add(socket);
  openTerminals.set(account.accountId, sockets);
  recordAuditEvent({ eventType: "terminal.opened", actorType: "user", actorId: account.userId ?? account.accountId, entityType: "project", entityId: projectId });
  socket.once("close", () => {
    sockets.delete(socket);
    if (!sockets.size) openTerminals.delete(account.accountId);
    recordAuditEvent({ eventType: "terminal.closed", actorType: "user", actorId: account.userId ?? account.accountId, entityType: "project", entityId: projectId });
  });
  return { ok: true, idleMinutes: settings.idleMinutes };
}
