import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * An offline peer (a sleeping laptop, a Tailscale host that drops packets) makes every
 * request to it wait for its full timeout. Every request records whether the peer answered.
 * A read that can be answered from a stored reply (see peer-snapshots.ts) then skips a peer
 * that just failed, and one such read at a time probes whether it came back: once per
 * backoff window, or sooner when the peer has sent us a request since it failed. That is a
 * reason to look, not proof: a stuck node keeps sending requests it cannot answer. Actions
 * aimed at one peer are always attempted, and any answer clears the backoff at once.
 */
const BASE_BACKOFF_MS = 15_000;
/** A machine that comes back shows live data again within this long. */
const MAX_BACKOFF_MS = 60_000;
/** One probe at a time, and at most this often, even for a peer that keeps contacting us. */
const PROBE_MS = 10_000;

const failures = new Map<string, { count: number; failedAt: number; retryAt: number; probedAt: number }>();
const optionalReads = new AsyncLocalStorage<true>();

/** Runs a read that has a fallback answer: inside it, a peer known to be down fails at once. */
export function whilePeerOptional<T>(read: () => Promise<T>): Promise<T> { return optionalReads.run(true, read); }

export class PeerUnreachableError extends Error {
  constructor(readonly peerId: string, message = "Cluster peer is unreachable") { super(message); }
}

export function peerReachable(peerId: string, lastSeenAt?: string | null, now = Date.now()): boolean {
  const entry = failures.get(peerId);
  if (!entry) return true;
  if (now - entry.probedAt < PROBE_MS) return false;
  const contacted = Boolean(lastSeenAt && Date.parse(lastSeenAt) > entry.failedAt);
  if (now < entry.retryAt && !contacted) return false;
  entry.probedAt = now;
  return true;
}

export function markPeerUnreachable(peerId: string, now = Date.now()): void {
  const previous = failures.get(peerId);
  const count = (previous?.count ?? 0) + 1;
  failures.set(peerId, { count, failedAt: now, retryAt: now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1)), probedAt: previous?.probedAt ?? 0 });
}

export function markPeerReachable(peerId: string): void { failures.delete(peerId); }

/** A dropped connection or a request that saw no response headers in time. */
export function isPeerUnreachable(error: unknown): boolean {
  if (error instanceof PeerUnreachableError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || (error.name === "TypeError" && error.message === "fetch failed");
}

function lastSeenAt(db: DatabaseSync, peerId: string): string | null {
  try { return (db.prepare("SELECT last_seen_at FROM cluster_v2_peer_activity WHERE node_id=?").get(peerId) as { last_seen_at: string | null } | undefined)?.last_seen_at ?? null; }
  catch { return null; }
}

/** fetch for a request to one peer, recording whether it answered. */
export async function fetchPeer(db: DatabaseSync, peerId: string, input: string | URL, init: RequestInit): Promise<Response> {
  if (optionalReads.getStore() && !peerReachable(peerId, lastSeenAt(db, peerId))) throw new PeerUnreachableError(peerId);
  try {
    const response = await fetch(input, init);
    markPeerReachable(peerId);
    return response;
  } catch (error) {
    if (isPeerUnreachable(error)) markPeerUnreachable(peerId);
    throw error;
  }
}

export function resetPeerAvailability(): void { failures.clear(); }
