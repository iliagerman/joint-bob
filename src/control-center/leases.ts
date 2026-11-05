/**
 * "You're in control": while a person has taken control of a conversation, Bob and auto respond leave it alone. A lease
 * lasts while the person's page keeps renewing it and lapses a minute after the last renewal (a closed window, a lost
 * connection), so nobody is locked out by a page that went away. Kept in memory on the node that owns the conversation.
 */
export const LEASE_MS = 60_000;

interface Lease { accountId: string; expiresAt: number }

const leases = new Map<string, Lease>();
const key = (projectId: string, conversationId: string) => `${projectId}:${conversationId}`;

/** Takes the lease, or renews it when the same person already holds it. False when someone else holds it. */
export function takeLease(projectId: string, conversationId: string, accountId: string, now = Date.now()): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (held && held.expiresAt > now && held.accountId !== accountId) return false;
  leases.set(key(projectId, conversationId), { accountId, expiresAt: now + LEASE_MS });
  return true;
}

/** Gives the conversation back. Only the holder can. */
export function releaseLease(projectId: string, conversationId: string, accountId: string): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (!held || held.accountId !== accountId) return false;
  leases.delete(key(projectId, conversationId));
  return true;
}

export function isLeased(projectId: string, conversationId: string, now = Date.now()): boolean {
  const held = leases.get(key(projectId, conversationId));
  if (!held) return false;
  if (held.expiresAt <= now) { leases.delete(key(projectId, conversationId)); return false; }
  return true;
}

export function leaseHolder(projectId: string, conversationId: string, now = Date.now()): string | null {
  return isLeased(projectId, conversationId, now) ? leases.get(key(projectId, conversationId))!.accountId : null;
}

/** Conversations the person holds right now, for the board. */
export function heldBy(accountId: string, now = Date.now()): string[] {
  return [...leases].filter(([, lease]) => lease.accountId === accountId && lease.expiresAt > now).map(([id]) => id);
}
