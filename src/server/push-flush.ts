import { type ClusterPeer, listClusterPeers } from "../cluster.js";
import { pushSubscriptionEventsForPeer, recordPushSubscriptionFailure, recordPushSubscriptionReceipt } from "../push.js";
import { replicationReceiptSchema } from "./schemas.js";

let flushInProgress = false;

/** Pushes queued push-subscription events, one 100-event batch at a time, until the peer has
    acknowledged all of it or a batch fails. Mirrors pushSecretCredentialsToPeer. */
export async function sendPushSubscriptionEventsToPeer(peer: ClusterPeer): Promise<void> {
  for (;;) {
    const events = await pushSubscriptionEventsForPeer(peer.id);
    if (!events.length) return;
    try {
      const response = await fetch(`${peer.url}/api/cluster/push/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Peer returned ${response.status}`);
      const receipt = replicationReceiptSchema.parse(await response.json());
      // A peer that acknowledges nothing would loop forever on the same batch.
      if (!receipt.received.length) throw new Error("Peer acknowledged no events");
      await recordPushSubscriptionReceipt(peer.id, receipt.received);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Peer push subscription replication failed";
      await recordPushSubscriptionFailure(peer.id, events.map((event) => event.id), message);
      console.warn(`Push subscription replication to ${peer.id} failed: ${message}`);
      return;
    }
  }
}

/** Every subscription replicates to every peer automatically: a phone must receive review
    notifications no matter which node observes the review or which node it subscribed on. */
export async function flushPushSubscriptionOutbox(): Promise<void> {
  if (flushInProgress) return;
  flushInProgress = true;
  try {
    for (const peer of await listClusterPeers()) await sendPushSubscriptionEventsToPeer(peer);
  } finally {
    flushInProgress = false;
  }
}
