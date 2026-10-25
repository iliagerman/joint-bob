import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { onPeerReturned, resetPeerAvailability } from "../peer-presence.js";
import { resetDirectFailures } from "../relay/transport.js";
import { forgetHubRefusal, pullFromHubs } from "./cluster-hubs.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { quickNotesAfterReturn, syncSharedQuickNotes } from "./shared-quick-notes.js";
import { resetSharedTranscriptPulls } from "./shared-transcripts.js";

/**
 * Coming back. Background sync stops sending to a machine that does not answer
 * (peer-presence.ts), so a machine that returns says so instead of waiting to be found:
 *
 * - When this machine starts, or wakes from sleep, it tells every peer in its clusters and
 *   twins that it is back, and asks for what it missed (the cluster catch-up and the
 *   conversation history pulls run at once instead of on their next timer).
 * - When a peer says it is back, or simply answers again, whatever is queued for it goes out
 *   on the next pass instead of at each item's own retry time, which can be an hour away.
 */

function makeDue(db: DatabaseSync, sql: string, ...values: SQLInputValue[]): void {
  // Each queue's table is created by its own module on first use.
  try { db.prepare(sql).run(...values); } catch { /* nothing queued there yet */ }
}

/** Makes everything queued for a peer due now: replicated events, push subscriptions, routing configurations and hub deliveries. */
export async function resumeDeliveriesTo(peerId: string): Promise<void> {
  const db = await clusterV2Database(), now = new Date().toISOString();
  // It may have been updated since it last refused this node's events as a hub.
  forgetHubRefusal(peerId);
  makeDue(db, "UPDATE replication_deliveries SET next_attempt_at=? WHERE peer_id=? AND delivered_at IS NULL AND next_attempt_at>?", now, peerId, now);
  makeDue(db, "UPDATE push_subscription_deliveries SET next_attempt_at=? WHERE peer_id=? AND delivered_at IS NULL AND next_attempt_at>?", now, peerId, now);
  makeDue(db, "UPDATE routing_config_deliveries SET next_attempt_at=? WHERE target_node_id=? AND next_attempt_at>?", now, peerId, now);
  // Hub deliveries are queued per cluster, not per member; any member returning may be the hub they wait for.
  makeDue(db, "UPDATE cluster_v2_hub_queue SET next_attempt_at=? WHERE delivered_at IS NULL AND next_attempt_at>?", now, now);
}

let listening = false;
/** Resumes deliveries whenever a peer that was away answers again. */
export function resumeDeliveriesOnReturn(): void {
  if (listening) return;
  listening = true;
  onPeerReturned((peerId) => {
    void resumeDeliveriesTo(peerId).catch((error) => console.warn(`Resuming deliveries to ${peerId} failed`, error));
    void quickNotesAfterReturn(peerId).catch((error) => console.warn(`Fetching quick notes from ${peerId} failed`, error));
  });
}

let announcing: Promise<void> | undefined;
/**
 * Tells every peer this machine is back and catches up from them. `slept` is true after a
 * sleep rather than a start: what this machine believed about its peers is then stale too.
 */
export function announceReturn(slept: boolean): Promise<void> {
  announcing ??= (async () => {
    if (slept) { resetPeerAvailability(); resetDirectFailures(); }
    const db = await clusterV2Database(), local = await getClusterNode();
    const fileSync = await import("../file-sync/index.js").catch((error) => { console.warn("Loading file sync failed", error); return undefined; });
    // Older receivers ignore the body and answer {ok: true}, which says they have no file sync engine.
    const hello = await fileSync?.fileSyncHelloBody().catch(() => undefined) ?? {};
    // A real attempt at every peer: one that answers is known to be there, one that does not is left alone from here on.
    await Promise.all(replicationPeers(db, local.id).map((peer) => signedPeerPost(peer, "/api/cluster/v2/hello", hello)
      .then((answer) => fileSync?.fileSyncHelloAnswered(peer.nodeId, answer), () => undefined)));
    // With what the peers just said about their engines, it asks them what changed while it was away.
    fileSync?.fileSyncAnnounce(slept);
    resetSharedTranscriptPulls();
    // Drafts are no longer fetched on a timer: what peers offer is fetched now.
    await syncSharedQuickNotes().catch((error) => console.warn("Fetching peers' quick notes failed", error));
    await pullFromHubs().catch((error) => console.warn("Hub pull failed", error));
  })().finally(() => { announcing = undefined; });
  return announcing;
}
