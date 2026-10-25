import type { DatabaseSync } from "node:sqlite";
import { pinnedClusterPublicKey } from "../cluster-identity.js";
import { onPeerReturned, peerAway } from "../peer-presence.js";
import type { PeerSpec } from "./protocol.js";

/* The peer directory the worker needs: whose signatures to accept (pinned keys), where a peer
   listens directly, and whether it is around. Direct origins arrive with the capability exchange
   (a later phase); until then every peer has none and is reached through the main server. */

/** One entry per peer with a pinned key, sorted, so an unchanged directory serializes identically. */
export function peerSpecs(db: DatabaseSync, peers: Iterable<string>): PeerSpec[] {
  const specs: PeerSpec[] = [];
  for (const nodeId of [...new Set(peers)].sort()) {
    let publicKey: string | undefined;
    try { publicKey = pinnedClusterPublicKey(db, nodeId); } catch { continue; }
    if (!publicKey) continue;
    specs.push({ nodeId, publicKey, origins: [], present: !peerAway(nodeId) });
  }
  return specs;
}

/** Called when a peer that was away answers again (a relay saw it, or it contacted us). */
export function onPeerPresent(listener: (peer: string) => void): () => void { return onPeerReturned(listener); }
