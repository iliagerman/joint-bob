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
const successionNoticeSchema = z.object({ clusterId: z.string().uuid(), lostNodeId: z.string().uuid(), certificate: twinCertificateSchema }).strict();
function ensureSchema(db) {
  ensureSuccessionSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS cluster_v2_succession_deliveries(cluster_id TEXT NOT NULL, peer_id TEXT NOT NULL, lost_node_id TEXT NOT NULL, PRIMARY KEY(cluster_id,peer_id,lost_node_id))");
}
function removeIfAllowed(db, local, clusterId, lost) {
  const state = getSharingCluster(db, clusterId), members = listSharingClusterMembers(db, clusterId);
  if (!members.some((member) => member.nodeId === lost)) return;
  const senior = members.find((member) => member.nodeId !== lost)?.nodeId;
  if (state.managerNodeId === local || state.managerNodeId === lost && senior === local) removeLostMember(db, local, clusterId, lost);
}
async function declareTwinLost(relationshipId) {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSchema(db);
  const relationship = db.prepare("SELECT peer_node_id,status FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId);
  if (!relationship) throw new ClusterV2HttpError(404, "Unknown twin relationship");
  if (relationship.status !== "active") throw new ClusterV2HttpError(409, "Only an active twin can be declared lost");
  const lost = relationship.peer_node_id, certificate = storedTwinCertificate(db, relationshipId);
  db.exec("SAVEPOINT twin_lost");
  let moved;
  try {
    revokeTwinHttp(db, local, relationshipId);
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
  } catch (error) {
    db.exec("ROLLBACK TO twin_lost; RELEASE twin_lost");
    throw error;
  }
  await flushSuccessionNotices();
  await flushV2MembershipOutbox();
  await flushResourcePolicyDeliveries();
  await flushProjectMetadataDeliveries();
  return { lostNodeId: lost, projects: moved.filter((resource) => resource.kind === "project").length };
}
async function receiveSuccession(sender, notice) {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  ensureSchema(db);
  const members = listSharingClusterMembers(db, notice.clusterId);
  if (!members.some((member) => member.nodeId === local) || !members.some((member) => member.nodeId === sender)) throw new ClusterV2HttpError(403, "Sender and receiver must share the cluster");
  let successor, certificate;
  try {
    ({ successor, certificate } = verifiedSuccessor(db, notice.lostNodeId, notice.certificate));
  } catch (error) {
    throw new ClusterV2HttpError(403, error instanceof Error ? error.message : "Invalid succession");
  }
  if (successor !== sender) throw new ClusterV2HttpError(403, "Only the lost machine's twin may succeed it");
  db.exec("SAVEPOINT twin_succession");
  try {
    recordSuccession(db, notice.lostNodeId, successor, certificate);
    removeIfAllowed(db, local, notice.clusterId, notice.lostNodeId);
    db.exec("RELEASE twin_succession");
  } catch (error) {
    db.exec("ROLLBACK TO twin_succession; RELEASE twin_succession");
    throw error;
  }
  await flushV2MembershipOutbox();
}
let flushing = false;
async function flushSuccessionNotices() {
  if (flushing) return;
  flushing = true;
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    ensureSchema(db);
    const rows = db.prepare("SELECT d.cluster_id,d.peer_id,d.lost_node_id,s.certificate FROM cluster_v2_succession_deliveries d JOIN cluster_v2_successions s ON s.lost_node_id=d.lost_node_id").all();
    for (const row of rows) {
      try {
        await signedPost(db, local, row.peer_id, row.cluster_id, "/api/cluster/v2/succession", { clusterId: row.cluster_id, lostNodeId: row.lost_node_id, certificate: JSON.parse(row.certificate) });
        db.prepare("DELETE FROM cluster_v2_succession_deliveries WHERE cluster_id=? AND peer_id=? AND lost_node_id=?").run(row.cluster_id, row.peer_id, row.lost_node_id);
      } catch (error) {
        console.warn(`Succession notice to ${row.peer_id} is pending: ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    flushing = false;
  }
}
export {
  declareTwinLost,
  flushSuccessionNotices,
  receiveSuccession,
  successionNoticeSchema
};
