import { AsyncLocalStorage } from "node:async_hooks";
import { peerFetch } from "../relay/transport.js";
const BASE_BACKOFF_MS = 15e3;
const MAX_BACKOFF_MS = 6e4;
const PROBE_MS = 1e4;
const failures = /* @__PURE__ */ new Map();
const optionalReads = new AsyncLocalStorage();
function whilePeerOptional(read) {
  return optionalReads.run(true, read);
}
class PeerUnreachableError extends Error {
  constructor(peerId, message = "Cluster peer is unreachable") {
    super(message);
    this.peerId = peerId;
  }
  peerId;
}
function peerReachable(peerId, lastSeenAt2, now = Date.now()) {
  const entry = failures.get(peerId);
  if (!entry) return true;
  if (now - entry.probedAt < PROBE_MS) return false;
  const contacted = Boolean(lastSeenAt2 && Date.parse(lastSeenAt2) > entry.failedAt);
  if (now < entry.retryAt && !contacted) return false;
  entry.probedAt = now;
  return true;
}
function markPeerUnreachable(peerId, now = Date.now()) {
  const previous = failures.get(peerId);
  const count = (previous?.count ?? 0) + 1;
  failures.set(peerId, { count, failedAt: now, retryAt: now + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (count - 1)), probedAt: previous?.probedAt ?? 0 });
}
function markPeerReachable(peerId) {
  failures.delete(peerId);
}
function isPeerUnreachable(error) {
  if (error instanceof PeerUnreachableError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "TypeError" && error.message === "fetch failed";
}
function lastSeenAt(db, peerId) {
  try {
    return db.prepare("SELECT last_seen_at FROM cluster_v2_peer_activity WHERE node_id=?").get(peerId)?.last_seen_at ?? null;
  } catch {
    return null;
  }
}
async function fetchPeer(db, peerId, input, init) {
  if (optionalReads.getStore() && !peerReachable(peerId, lastSeenAt(db, peerId))) throw new PeerUnreachableError(peerId);
  try {
    const response = await peerFetch(input, init, peerId);
    markPeerReachable(peerId);
    return response;
  } catch (error) {
    if (isPeerUnreachable(error)) markPeerUnreachable(peerId);
    throw error;
  }
}
function resetPeerAvailability() {
  failures.clear();
}
export {
  PeerUnreachableError,
  fetchPeer,
  isPeerUnreachable,
  markPeerReachable,
  markPeerUnreachable,
  peerReachable,
  resetPeerAvailability,
  whilePeerOptional
};
