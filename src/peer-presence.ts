import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which peers answer, so that background sync leaves alone a machine that is switched off.
 *
 * Every request to a peer records whether it answered. Background sync (the periodic
 * flushes in server.ts) and reads that have a stored answer to fall back on then send nothing
 * to a peer that stopped answering, apart from one probe per backoff window. The window
 * doubles from 15 seconds to 15 minutes, so a short outage is noticed quickly and a machine
 * that is off overnight costs four requests an hour instead of several a second.
 *
 * A peer does not have to wait for that probe. It is asked again at once when a relay reports
 * it online, when one of its own requests arrives here (a reason to look, not proof: a stuck
 * node keeps sending requests it cannot answer), or when it says it is back (see
 * server/peer-return.ts). Something a person asked for is always attempted, and any answer
 * clears the backoff.
 *
 * This module imports no other module of this application, so the transport, the request
 * verifier and the flush loops can all use it.
 */
const BASE_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/** One probe at a time, and at most this often, even for a peer that keeps contacting us. */
const PROBE_MS = 10_000;
/** Failures in a row before a peer's absence is worth a line in the log. */
const AWAY_AFTER = 3;

interface Failure { count: number; failedAt: number; retryAt: number; probedAt: number; contactedAt: number; logged: boolean }
const failures = new Map<string, Failure>();
const skippable = new AsyncLocalStorage<true>();
const returnListeners = new Set<(peerId: string) => void>();

/** Runs a read that has a fallback answer: inside it, a peer known to be down fails at once. */
export function whilePeerOptional<T>(read: () => Promise<T>): Promise<T> { return skippable.run(true, read); }

/** Runs background sync: nobody is waiting for it, so it sends nothing to a peer that is away. */
export function inBackground<T>(work: () => T): T { return skippable.run(true, work); }

export class PeerUnreachableError extends Error {
  constructor(readonly peerId: string, message = "Cluster peer is unreachable") { super(message); }
}

function due(entry: Failure, now: number): boolean { return now >= entry.retryAt || entry.contactedAt > entry.failedAt; }

/** Whether background sync should leave this peer alone for now. Asking changes nothing. */
export function peerAway(peerId: string, now = Date.now()): boolean {
  const entry = failures.get(peerId);
  return Boolean(entry) && (now - entry!.probedAt < PROBE_MS || !due(entry!, now));
}

/**
 * Whether a request that could be skipped may be sent. For a peer that is away this lets one
 * caller through per window as the probe, so only call it when the request follows.
 */
export function peerReachable(peerId: string, lastSeenAt?: string | null, now = Date.now()): boolean {
  const entry = failures.get(peerId);
  if (!entry) return true;
  if (now - entry.probedAt < PROBE_MS) return false;
  const contacted = entry.contactedAt > entry.failedAt || Boolean(lastSeenAt && Date.parse(lastSeenAt) > entry.failedAt);
  if (now < entry.retryAt && !contacted) return false;
  entry.probedAt = now;
  return true;
}

export function markPeerUnreachable(peerId: string, now = Date.now()): void {
  const previous = failures.get(peerId);
  const count = (previous?.count ?? 0) + 1;
  const logged = previous?.logged || count >= AWAY_AFTER;
  if (logged && !previous?.logged) console.log(`Peer ${peerId} is not answering. Background sync to it is paused until it is heard from; it is checked at most every ${MAX_BACKOFF_MS / 60_000} minutes.`);
  failures.set(peerId, { count, failedAt: now, retryAt: now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1)), probedAt: previous?.probedAt ?? 0, contactedAt: previous?.contactedAt ?? 0, logged });
}

export function markPeerReachable(peerId: string): void {
  const previous = failures.get(peerId);
  if (!previous) return;
  failures.delete(peerId);
  if (previous.logged) console.log(`Peer ${peerId} is answering again. Background sync to it has resumed.`);
  for (const listener of returnListeners) {
    try { listener(peerId); } catch (error) { console.warn("Resuming sync with a returned peer failed", error); }
  }
}

/** A request from this peer arrived: if it was away, it is asked again without waiting out the backoff. */
export function peerContacted(peerId: string, now = Date.now()): void {
  const entry = failures.get(peerId);
  if (entry) entry.contactedAt = now;
}

/** Called when a peer that was away answers again, so queued deliveries need not wait for their own retry timers. */
export function onPeerReturned(listener: (peerId: string) => void): () => void {
  returnListeners.add(listener);
  return () => returnListeners.delete(listener);
}

/** A dropped connection or a request that saw no response headers in time. */
export function isPeerUnreachable(error: unknown): boolean {
  if (error instanceof PeerUnreachableError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || (error.name === "TypeError" && error.message === "fetch failed");
}

/** For the transport: refuses a skippable request to a peer that is away. */
export function beforePeerRequest(peerId: string): void {
  if (skippable.getStore() && !peerReachable(peerId)) throw new PeerUnreachableError(peerId);
}

/** For the transport: records how a request that was sent ended. */
export function afterPeerRequest(peerId: string, error?: unknown): void {
  if (error === undefined) markPeerReachable(peerId);
  else if (isPeerUnreachable(error)) markPeerUnreachable(peerId);
}

/** Forgets what is known, for instance after this machine slept: its own view is then stale. */
export function resetPeerAvailability(): void { failures.clear(); }
