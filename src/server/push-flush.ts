import { getClusterNode } from "../cluster.js";
import { type PeerEndpoint } from "../cluster-peer-endpoints.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { pushSubscriptionEventsForPeer, recordPushSubscriptionFailure, recordPushSubscriptionReceipt } from "../push.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { replicationReceiptSchema } from "./schemas.js";

let flushInProgress = false;

/** Pushes queued push-subscription events, one 100-event batch at a time, until the twin has
    acknowledged all of it or a batch fails. */
async function sendPushSubscriptionEventsToTwin(peer: PeerEndpoint): Promise<void> {
  for (;;) {
    const events = await pushSubscriptionEventsForPeer(peer.nodeId);
    if (!events.length) return;
    try {
      const receipt = replicationReceiptSchema.parse(await signedPeerPost(peer, "/api/cluster/v2/push/events", { events }));
      // A peer that acknowledges nothing would loop forever on the same batch.
      if (!receipt.received.length) throw new Error("Peer acknowledged no events");
      await recordPushSubscriptionReceipt(peer.nodeId, receipt.received);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Peer push subscription replication failed";
      await recordPushSubscriptionFailure(peer.nodeId, events.map((event) => event.id), message);
      console.warn(`Push subscription replication to ${peer.nodeId} failed: ${message}`);
      return;
    }
  }
}

/** Push subscriptions replicate to twins only: a subscription lets its holder notify this
    user's devices, so it never leaves the user's own machines through a shared cluster. */
export async function flushPushSubscriptionOutbox(): Promise<void> {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const db = await clusterV2Database(), local = await getClusterNode();
    for (const peer of replicationPeers(db, local.id).filter((peer) => isTrustedTwin(db, local.id, peer.nodeId))) {
      await sendPushSubscriptionEventsToTwin(peer);
    }
  } finally {
    flushInProgress = false;
  }
}
