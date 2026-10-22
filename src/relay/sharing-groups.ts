import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createMembershipCluster, createMembershipInvitation, getMembershipSnapshot, redeemMembershipInvitation, removeMembershipMember, type MembershipJoinRequest, type SignedMembershipSnapshot } from "../cluster-membership.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships, mayReceiveResource, relaySharingGroupActive } from "../cluster-sharing-policy.js";
import { ensurePeerEndpointSchema, recordMembershipEndpoints } from "../cluster-peer-endpoints.js";
import { relayMachine } from "./store.js";
import { virtualRelayUrl } from "./protocol.js";

/** Relay discovery must not turn pinned keys into unrelated runtime or login access. */
export function relayPeerRequestAllowed(db: DatabaseSync, local: string, peer: string, pathname: string): boolean {
  const groups = db.prepare(`SELECT r.cluster_id FROM relay_sharing_groups r JOIN sharing_memberships a ON a.cluster_id=r.cluster_id AND a.node_id=?
    JOIN sharing_memberships b ON b.cluster_id=r.cluster_id AND b.node_id=?`).all(local, peer) as Array<{cluster_id: string}>;
  if (isTrustedTwin(db, local, peer) || listSharingMemberships(db, local).some(membership => listSharingClusterMembers(db, membership.clusterId).some(member => member.nodeId === peer))) return true;
  const discovered = db.prepare("SELECT 1 FROM cluster_v2_peer_endpoints e JOIN relay_sharing_groups r ON r.cluster_id=e.context_id WHERE e.context_kind='cluster' AND e.node_id=? LIMIT 1").get(peer);
  if (!discovered) return true;
  if (!groups.length) return false;
  if (!groups.some(group => relaySharingGroupActive(db, group.cluster_id))) return false;
  if (["/api/cluster/v2/resources/policy", "/api/cluster/v2/membership/snapshot", "/api/cluster/v2/membership/descriptor", "/api/cluster/v2/workspaces/manifest", "/api/cluster/v2/workspaces/changed"].includes(pathname)) return true;
  const projects = db.prepare("SELECT resource_id FROM sharing_resource_owners WHERE kind='project'").all() as Array<{resource_id: string}>;
  return projects.some(project => mayReceiveResource(db, local, "project", project.resource_id) && mayReceiveResource(db, peer, "project", project.resource_id));
}

/** A relay's resource-sharing group is distinct from all manually managed clusters. */
export function relaySharingGroupId(relayNodeId: string): string {
  const digest = createHash("sha256").update(`joint-bob-relay-workspaces-v1:${relayNodeId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function ensureRelaySharingGroupSchema(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS relay_sharing_groups(relay_node_id TEXT PRIMARY KEY,cluster_id TEXT NOT NULL UNIQUE)");
}

export function ensureRelaySharingGroup(db: DatabaseSync, relayNodeId: string, name: string): string {
  ensureRelaySharingGroupSchema(db);
  ensurePeerEndpointSchema(db);
  const clusterId = relaySharingGroupId(relayNodeId);
  if (!db.prepare("SELECT 1 FROM relay_sharing_groups WHERE relay_node_id=?").get(relayNodeId)) {
    const snapshot = createMembershipCluster(db, { nodeId: relayNodeId, name: name.slice(0, 80) || "Relay", url: virtualRelayUrl(relayNodeId) }, { id: clusterId, name: `Relay: ${name}`.slice(0, 80) });
    db.prepare("INSERT INTO relay_sharing_groups VALUES(?,?)").run(relayNodeId, clusterId);
    recordMembershipEndpoints(db, snapshot);
  }
  return clusterId;
}

export function relaySharingInvitation(db: DatabaseSync, relayNodeId: string, nodeId: string, name: string) {
  if (relayMachine(db, nodeId)?.status !== "admitted") throw new Error("Machine is not admitted to this relay");
  const clusterId = ensureRelaySharingGroup(db, relayNodeId, name);
  return createMembershipInvitation(db, relayNodeId, relayNodeId, clusterId, 1);
}

export function redeemRelaySharingInvitation(db: DatabaseSync, relayNodeId: string, nodeId: string, request: MembershipJoinRequest, secret: string): SignedMembershipSnapshot {
  const machine = relayMachine(db, nodeId);
  if (machine?.status !== "admitted" || request.member.nodeId !== nodeId || request.member.publicKey !== machine.publicKey || request.clusterId !== relaySharingGroupId(relayNodeId)) throw new Error("Machine is not admitted to this relay");
  const snapshot = redeemMembershipInvitation(db, relayNodeId, request, secret);
  recordMembershipEndpoints(db, snapshot);
  return snapshot;
}

export function reconcileRelaySharingGroup(db: DatabaseSync, relayNodeId: string, name: string): SignedMembershipSnapshot {
  const clusterId = ensureRelaySharingGroup(db, relayNodeId, name);
  for (const member of listSharingClusterMembers(db, clusterId)) {
    if (member.nodeId !== relayNodeId && relayMachine(db, member.nodeId)?.status !== "admitted") removeMembershipMember(db, relayNodeId, relayNodeId, clusterId, member.nodeId, 1);
  }
  return getMembershipSnapshot(db, clusterId);
}
