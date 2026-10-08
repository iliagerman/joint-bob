import { getClusterNode } from "../cluster.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { pushSubscriptionEventsForPeer, recordPushSubscriptionFailure, recordPushSubscriptionReceipt } from "../push.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { replicationReceiptSchema } from "./schemas.js";
let flushInProgress = false;
async function sendPushSubscriptionEventsToTwin(peer) {
  for (; ; ) {
    const events = await pushSubscriptionEventsForPeer(peer.nodeId);
    if (!events.length) return;
    try {
      const receipt = replicationReceiptSchema.parse(await signedPeerPost(peer, "/api/cluster/v2/push/events", { events }));
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
async function flushPushSubscriptionOutbox() {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    const db = await clusterV2Database(), local = await getClusterNode();
    for (const peer of replicationPeers(db, local.id).filter((peer2) => isTrustedTwin(db, local.id, peer2.nodeId))) {
      await sendPushSubscriptionEventsToTwin(peer);
    }
  } finally {
    flushInProgress = false;
  }
}
export {
  flushPushSubscriptionOutbox
};
