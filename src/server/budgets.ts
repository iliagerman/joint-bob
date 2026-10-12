import type { DatabaseSync } from "node:sqlite";
import { clusterBudgetPolicySchema, EMPTY_POLICY, BudgetError, getClusterPolicy, peersMissingPolicy, publishClusterPolicy, receiveClusterPolicy, recordPolicyAck, type ClusterBudgetPolicy } from "../budgets.js";
import { getClusterNode } from "../cluster.js";
import { ensurePeerEndpointSchema, type PeerEndpoint } from "../cluster-peer-endpoints.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { signedPeerPost } from "./replication-v2.js";
import { peerAway } from "../peer-presence.js";

export interface ClusterBudgetView {
  id: string; name: string; managerNodeId: string | null; isManager: boolean;
  policy: ClusterBudgetPolicy; revision: number; hasPolicy: boolean;
  /** Members that have not confirmed the current revision; only the manager knows. */
  pendingNodeIds: string[];
}

function endpoints(db: DatabaseSync, clusterId: string): Map<string, PeerEndpoint> {
  ensurePeerEndpointSchema(db);
  const rows = db.prepare("SELECT node_id nodeId,name,url FROM cluster_v2_peer_endpoints WHERE context_kind='cluster' AND context_id=?").all(clusterId) as unknown as PeerEndpoint[];
  return new Map(rows.map((row) => [row.nodeId, row]));
}

function otherMembers(db: DatabaseSync, clusterId: string, local: string): string[] {
  return listSharingClusterMembers(db, clusterId).map((member) => member.nodeId).filter((id) => id !== local);
}

/** The clusters this node belongs to, with the budget each one currently has here. */
export async function clusterBudgets(): Promise<ClusterBudgetView[]> {
  const db = await clusterV2Database(), local = await getClusterNode();
  return listSharingMemberships(db, local.id).map((membership) => {
    const cluster = getSharingCluster(db, membership.clusterId);
    if (cluster.closed) return undefined;
    const stored = getClusterPolicy(db, cluster.id);
    const isManager = cluster.managerNodeId === local.id;
    return {
      id: cluster.id, name: cluster.name, managerNodeId: cluster.managerNodeId, isManager,
      policy: stored?.policy ?? EMPTY_POLICY, revision: stored?.revision ?? 0, hasPolicy: Boolean(stored),
      pendingNodeIds: isManager ? peersMissingPolicy(db, cluster.id, otherMembers(db, cluster.id, local.id)) : [],
    };
  }).filter((view): view is ClusterBudgetView => Boolean(view));
}

/** The manager's edit. Members hear about it on the next flush. */
export async function setClusterBudget(clusterId: string, input: unknown): Promise<ClusterBudgetView> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const policy = clusterBudgetPolicySchema.parse(input);
  const cluster = getSharingCluster(db, clusterId);
  if (cluster.closed) throw new BudgetError(409, "Cluster is closed");
  if (cluster.managerNodeId !== local.id) throw new BudgetError(403, "Only the cluster's manager can set its budget");
  publishClusterPolicy(db, clusterId, local.id, policy);
  await flushBudgetPolicies().catch((error) => console.warn("Budget policy delivery failed", error));
  return (await clusterBudgets()).find((view) => view.id === clusterId)!;
}

let flushing = false;
/** Sends each managed cluster's policy to every member that has not confirmed its revision. */
export async function flushBudgetPolicies(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database(), local = await getClusterNode();
    for (const membership of listSharingMemberships(db, local.id)) {
      const cluster = getSharingCluster(db, membership.clusterId);
      const stored = getClusterPolicy(db, cluster.id);
      if (cluster.closed || cluster.managerNodeId !== local.id || !stored) continue;
      const known = endpoints(db, cluster.id);
      for (const peerId of peersMissingPolicy(db, cluster.id, otherMembers(db, cluster.id, local.id))) {
        const peer = known.get(peerId);
        if (!peer || peerAway(peerId)) continue;
        try {
          await signedPeerPost(peer, "/api/cluster/v2/budgets/policy", { clusterId: cluster.id, revision: stored.revision, policy: stored.policy });
          recordPolicyAck(db, peerId, cluster.id, stored.revision);
        } catch (error) {
          console.warn(`Budget policy to ${peerId} failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    }
  } finally { flushing = false; }
}

/** A policy from `sender`; accepted only from the cluster's current manager, for a cluster this node is in. */
export async function receiveBudgetPolicy(sender: string, clusterId: string, revision: number, policy: unknown): Promise<boolean> {
  const db = await clusterV2Database(), local = await getClusterNode();
  let cluster;
  try { cluster = getSharingCluster(db, clusterId); } catch { throw new BudgetError(404, "Unknown cluster"); }
  if (cluster.closed || cluster.managerNodeId !== sender) throw new BudgetError(403, "Not this cluster's manager");
  if (!listSharingMemberships(db, local.id).some((membership) => membership.clusterId === clusterId)) throw new BudgetError(404, "Unknown cluster");
  return receiveClusterPolicy(db, clusterId, sender, revision, policy);
}
