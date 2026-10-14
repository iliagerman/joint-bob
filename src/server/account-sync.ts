import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { ensurePeerEndpointSchema, type PeerEndpoint } from "../cluster-peer-endpoints.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { applyBlockNotice, ensureNodeBlockSchema, pendingBlockNotices, recordBlockNoticeDelivered, setNodeBlock } from "../node-blocks.js";
import { accountSnapshotsDue, ensureAccountReplicationSchema, recordAccountSnapshotDelivered, removeReplicatedUsersFromNode } from "../user-replication.js";
import { presentReplicationPeers, replicationPeers, signedPeerPost } from "./replication-v2.js";
import { peerAway } from "../peer-presence.js";
import { refreshLocalAccountIds } from "../auth.js";
import { migrateAccountKeys, remapAccountKey } from "../account-keys.js";
import { accountClusterIds } from "../cluster-accounts.js";

/** Keeps local account ids current (pairing twins changes them) and moves per-person
    rows along, then runs the one-time move from usernames to account ids. */
export async function syncLocalAccountIds(): Promise<void> {
  const db = await clusterV2Database();
  const changes = refreshLocalAccountIds();
  migrateAccountKeys(db);
  for (const change of changes) remapAccountKey(db, change.from, change.to);
}

const ACCOUNT_SYNC_INTERVAL_MS = 15_000;
let accountSyncAt = 0;
let accountSyncRunning = false;

/** Sends each peer the accounts allowed to sign in there, when its copy is stale. */
export async function flushAccountReplication(force = false): Promise<void> {
  if (accountSyncRunning || (!force && Date.now() - accountSyncAt < ACCOUNT_SYNC_INTERVAL_MS)) return;
  accountSyncRunning = true;
  accountSyncAt = Date.now();
  try {
    await syncLocalAccountIds();
    const db = await clusterV2Database(), local = await getClusterNode();
    const peers = presentReplicationPeers(db, local.id);
    for (const due of accountSnapshotsDue(db, local.id, peers.map((peer) => peer.nodeId))) {
      const peer = peers.find((row) => row.nodeId === due.peer)!;
      try {
        try {
          await signedPeerPost(peer, "/api/cluster/v2/accounts/offline-mfa", due.snapshot);
        } catch (error) {
          if (!(error instanceof ClusterV2HttpError) || error.statusCode !== 404) throw error;
          // Older nodes reject unknown fields. Keep their password/MFA policy current,
          // but never send them TOTP material they do not understand.
          await signedPeerPost(peer, "/api/cluster/v2/accounts", {
            version: 2, accounts: due.snapshot.accounts.map(({ mfaSecret: _secret, ...account }) => account),
          });
        }
        recordAccountSnapshotDelivered(db, due.peer, due.digest);
      } catch (error) {
        console.warn(`Account delivery to ${due.peer} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  } finally {
    accountSyncRunning = false;
  }
}

/** Every node that shares a cluster with this one, as an endpoint. Blocked nodes are
    included: they need to hear about the block. */
function noticePeers(db: DatabaseSync, local: string): PeerEndpoint[] {
  ensurePeerEndpointSchema(db);
  const members = new Set<string>();
  for (const membership of listSharingMemberships(db, local)) {
    for (const member of listSharingClusterMembers(db, membership.clusterId)) if (member.nodeId !== local) members.add(member.nodeId);
  }
  const endpoints = db.prepare("SELECT node_id nodeId, name, url FROM cluster_v2_peer_endpoints WHERE node_id <> ?").all(local) as unknown as PeerEndpoint[];
  const byNode = new Map(endpoints.map((row) => [row.nodeId, row]));
  return [...members].map((node) => byNode.get(node)).filter((row): row is PeerEndpoint => Boolean(row));
}

export class NodeBlockError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** Blocks or unblocks `nodeId` on this node and queues notices to the cluster. */
export async function changeNodeBlock(nodeId: string, blocked: boolean): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureNodeBlockSchema(db);
  ensureAccountReplicationSchema(db);
  if (nodeId === local.id) throw new NodeBlockError(400, "A node can't block itself");
  if (blocked && isTrustedTwin(db, local.id, nodeId)) throw new NodeBlockError(409, "Unpair this twin before blocking it");
  const peers = noticePeers(db, local.id);
  const name = peers.find((peer) => peer.nodeId === nodeId)?.name
    ?? (db.prepare("SELECT name FROM cluster_v2_peer_endpoints WHERE node_id = ? LIMIT 1").get(nodeId) as { name: string } | undefined)?.name;
  if (!name) throw new NodeBlockError(404, "Unknown node");
  setNodeBlock(db, nodeId, name, blocked, peers.map((peer) => peer.nodeId));
  // Either way its copy of our accounts changes: removed now, or re-sent after unblocking.
  db.prepare("DELETE FROM account_replication_deliveries WHERE peer_id = ?").run(nodeId);
  if (blocked) { removeReplicatedUsersFromNode(nodeId); forgetRoamingTo(db, nodeId); }
  await flushBlockNotices();
}

export async function flushBlockNotices(): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const endpoints = new Map(noticePeers(db, local.id).map((peer) => [peer.nodeId, peer]));
  for (const notice of pendingBlockNotices(db)) {
    const peer = endpoints.get(notice.peerId);
    if (!peer) { recordBlockNoticeDelivered(db, notice.peerId, notice.blockedNodeId, notice.updatedAt); continue; }
    if (peerAway(notice.peerId)) continue;
    try {
      await signedPeerPost(peer, "/api/cluster/v2/blocks/notice", { blockedNodeId: notice.blockedNodeId, blocked: notice.blocked, updatedAt: notice.updatedAt });
      recordBlockNoticeDelivered(db, notice.peerId, notice.blockedNodeId, notice.updatedAt);
    } catch (error) {
      console.warn(`Block notice to ${notice.peerId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}

/** A notice from `blocker`. The node it blocks drops the blocker's accounts at once. */
export async function receiveBlockNotice(blocker: string, blockedNodeId: string, blocked: boolean, updatedAt: string): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  if (!applyBlockNotice(db, blocker, blockedNodeId, blocked, updatedAt)) return;
  if (blockedNodeId === local.id) {
    ensureAccountReplicationSchema(db);
    db.prepare("DELETE FROM account_replication_deliveries WHERE peer_id = ?").run(blocker);
    if (blocked) { removeReplicatedUsersFromNode(blocker); forgetRoamingTo(db, blocker); }
  }
}

/** A block ends roaming at once: our people's profiles there are forgotten on both sides
    (that node drops its copies with their sign-in records). */
function forgetRoamingTo(db: DatabaseSync, nodeId: string): void {
  for (const table of ["account_roaming_nodes", "account_profile_deliveries", "account_forget_notices"]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.prepare(`DELETE FROM ${table} WHERE node_id = ?`).run(nodeId);
  }
}

export type AccountNodeStatus = "home" | "signed in" | "can sign in" | "pending" | "not available";

/** The nodes one person can sign in to, as My nodes shows them: the nodes of the clusters
    they joined. A node is "not available" when blocked either way, with no more detail than
    for an offline one, and "signed in" once their profile went there. */
export async function accountNodes(accountId: string): Promise<Array<{ nodeId: string; name: string; status: AccountNodeStatus }>> {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensurePeerEndpointSchema(db);
  ensureAccountReplicationSchema(db);
  const { roamingNodes } = await import("./roaming.js");
  const roaming = new Set(await roamingNodes(accountId));
  const reachable = new Map(replicationPeers(db, local.id).map((peer) => [peer.nodeId, peer]));
  const due = new Set(accountSnapshotsDue(db, local.id, [...reachable.keys()], 0).map((entry) => entry.peer));
  const clusters = accountClusterIds(db, accountId, listSharingMemberships(db, local.id).map((membership) => membership.clusterId));
  const theirs = new Set(clusters.flatMap((clusterId) => listSharingClusterMembers(db, clusterId).map((member) => member.nodeId)));
  const rows: Array<{ nodeId: string; name: string; status: AccountNodeStatus }> = [{ nodeId: local.id, name: local.name, status: "home" }];
  const seen = new Set<string>([local.id]);
  for (const peer of [...reachable.values(), ...noticePeers(db, local.id)]) {
    if (seen.has(peer.nodeId)) continue;
    seen.add(peer.nodeId);
    if (!theirs.has(peer.nodeId) && !isTrustedTwin(db, local.id, peer.nodeId)) continue;
    rows.push({ nodeId: peer.nodeId, name: peer.name, status: !reachable.has(peer.nodeId) ? "not available" : roaming.has(peer.nodeId) ? "signed in" : due.has(peer.nodeId) ? "pending" : "can sign in" });
  }
  return rows;
}
