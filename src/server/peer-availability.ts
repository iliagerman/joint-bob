import type { DatabaseSync } from "node:sqlite";
import { isAdministrationPath, isNodeBlocked } from "../node-blocks.js";
import { PeerUnreachableError } from "../peer-presence.js";
import { peerFetch } from "../relay/transport.js";

/**
 * Requests to one peer. Whether the peer answers is recorded by the transport for every
 * request, and background sync skips a peer that is away: see peer-presence.ts.
 */
export { inBackground, isPeerUnreachable, markPeerReachable, markPeerUnreachable, onPeerReturned, peerAway, peerContacted, peerReachable, PeerUnreachableError, resetPeerAvailability, whilePeerOptional } from "../peer-presence.js";

/** Reported to callers like an offline peer: a blocked node is simply "not available". */
export class PeerBlockedError extends PeerUnreachableError {
  constructor(peerId: string) { super(peerId, "Cluster peer is not available"); }
}

function localNodeId(db: DatabaseSync): string | undefined {
  try { return (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id; }
  catch { return undefined; }
}

/** fetch for a request to one peer. */
export async function fetchPeer(db: DatabaseSync, peerId: string, input: string | URL, init: RequestInit): Promise<Response> {
  const local = localNodeId(db);
  let target = "";
  try { target = typeof input === "string" ? new URL(input).pathname : input.pathname; } catch { target = String(input); }
  if (local && isNodeBlocked(db, local, peerId) && !isAdministrationPath(target)) throw new PeerBlockedError(peerId);
  return peerFetch(input, init, peerId);
}
