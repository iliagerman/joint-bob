// Declaring a twin lost and telling its clusters (see src/cluster-succession.ts).
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { removeLostMember } from "../cluster-membership.js";
import { reissueResourcePolicy } from "../cluster-sharing.js";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "../cluster-sharing-policy.js";
import { ensureSuccessionSchema, recordSuccession, verifiedSuccessor } from "../cluster-succession.js";
import { storedTwinCertificate, twinCertificateSchema } from "../cluster-twins.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { flushV2MembershipOutbox, signedPost } from "./cluster-v2.js";
import { flushProjectMetadataDeliveries } from "./project-metadata.js";
import { flushResourcePolicyDeliveries } from "./resource-policy.js";
import { revokeTwinHttp } from "./twins.js";

export const successionNoticeSchema = z.object({ clusterId: z.string().uuid(), lostNodeId: z.string().uuid(), certificate: twinCertificateSchema }).strict();

function ensureSchema(db: DatabaseSync): void {
  ensureSuccessionSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS cluster_v2_succession_deliveries(cluster_id TEXT NOT NULL, peer_id TEXT NOT NULL, lost_node_id TEXT NOT NULL, PRIMARY KEY(cluster_id,peer_id,lost_node_id))");
}

/** Removes the lost machine from a cluster when this node may: as manager, or as the most
    senior remaining member when the lost machine was the manager. */
function removeIfAllowed(db: DatabaseSync, local: string, clusterId: string, lost: string): void {
  const state = getSharingCluster(db, clusterId), members = listSharingClusterMembers(db, clusterId);
  if (!members.some((member) => member.nodeId === lost)) return;
  const senior = members.find((member) => member.nodeId !== lost)?.nodeId;
  if (state.managerNodeId === local || (state.managerNodeId === lost && senior === local)) removeLostMember(db, local, clusterId, lost);
}

/** This node's twin is gone for good: take over what it owned, revoke the twin, and tell
    every cluster the lost machine belonged to. */
export async function declareTwinLost(relationshipId: string): Promise<{ lostNodeId: string; projects: number }> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSchema(db);
  const relationship = db.prepare("SELECT peer_node_id,status FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId) as { peer_node_id: string; status: string } | undefined;
  if (!relationship) throw new ClusterV2HttpError(404, "Unknown twin relationship");
  if (relationship.status !== "active") throw new ClusterV2HttpError(409, "Only an active twin can be declared lost");
  const lost = relationship.peer_node_id, certificate = storedTwinCertificate(db, relationshipId);
  db.exec("SAVEPOINT twin_lost");
  let moved: Array<{ kind: "project" | "secret"; id: string }>;
  try {
    revokeTwinHttp(db, local, relationshipId);
    // The lost machine never receives the revocation.
    db.prepare("DELETE FROM cluster_v2_twin_deliveries WHERE relationship_id=?").run(relationshipId);
    moved = recordSuccession(db, lost, local, certificate);
    for (const resource of moved) reissueResourcePolicy(db, local, resource.kind, resource.id);
    for (const { clusterId } of listSharingMemberships(db, local)) {
      const members = listSharingClusterMembers(db, clusterId);
      if (!members.some((member) => member.nodeId === lost)) continue;
      for (const member of members) {
        if (member.nodeId !== lost && member.nodeId !== local) db.prepare("INSERT OR IGNORE INTO cluster_v2_succession_deliveries VALUES(?,?,?)").run(clusterId, member.nodeId, lost);
      }
      removeIfAllowed(db, local, clusterId, lost);
    }
    db.exec("RELEASE twin_lost");
  } catch (error) { db.exec("ROLLBACK TO twin_lost; RELEASE twin_lost"); throw error; }
  await flushSuccessionNotices();
  await flushV2MembershipOutbox();
  await flushResourcePolicyDeliveries();
  await flushProjectMetadataDeliveries();
  return { lostNodeId: lost, projects: moved.filter((resource) => resource.kind === "project").length };
}

/** A member learns that the sender succeeds a lost machine. Only the twin named in the
    lost machine's own certificate is accepted. */
export async function receiveSuccession(sender: string, notice: z.infer<typeof successionNoticeSchema>): Promise<void> {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSchema(db);
  const members = listSharingClusterMembers(db, notice.clusterId);
  if (!members.some((member) => member.nodeId === local) || !members.some((member) => member.nodeId === sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  let successor: string, certificate: z.infer<typeof twinCertificateSchema>;
  try { ({ successor, certificate } = verifiedSuccessor(db, notice.lostNodeId, notice.certificate)); }
  catch (error) { throw new ClusterV2HttpError(403, error instanceof Error ? error.message : "Invalid succession"); }
  if (successor !== sender) throw new ClusterV2HttpError(403, "Only the lost machine's twin may succeed it");
  db.exec("SAVEPOINT twin_succession");
  try {
    recordSuccession(db, notice.lostNodeId, successor, certificate);
    removeIfAllowed(db, local, notice.clusterId, notice.lostNodeId);
    db.exec("RELEASE twin_succession");
  } catch (error) { db.exec("ROLLBACK TO twin_succession; RELEASE twin_succession"); throw error; }
  await flushV2MembershipOutbox();
}

let flushing = false;
/** Retries succession notices until every member has one: a member without it would refuse
    the successor's reissued policy. */
export async function flushSuccessionNotices(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    ensureSchema(db);
    const rows = db.prepare("SELECT d.cluster_id,d.peer_id,d.lost_node_id,s.certificate FROM cluster_v2_succession_deliveries d JOIN cluster_v2_successions s ON s.lost_node_id=d.lost_node_id").all() as unknown as Array<{ cluster_id: string; peer_id: string; lost_node_id: string; certificate: string }>;
    for (const row of rows) {
      try {
        await signedPost(db, local, row.peer_id, row.cluster_id, "/api/cluster/v2/succession", { clusterId: row.cluster_id, lostNodeId: row.lost_node_id, certificate: JSON.parse(row.certificate) });
        db.prepare("DELETE FROM cluster_v2_succession_deliveries WHERE cluster_id=? AND peer_id=? AND lost_node_id=?").run(row.cluster_id, row.peer_id, row.lost_node_id);
      } catch (error) {
        console.warn(`Succession notice to ${row.peer_id} is pending: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally { flushing = false; }
}
