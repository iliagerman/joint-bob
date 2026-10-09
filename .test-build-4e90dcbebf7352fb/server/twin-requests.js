import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { pinnedClusterPublicKey } from "../cluster-identity.js";
import { listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { listTwinRelationships } from "../cluster-twins.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { signedPost } from "./cluster-v2.js";
import { acceptTwinHttpLink, createTwinHttpInvitation, ensureTwinHttpSchema, parseTwinLink } from "./twins.js";
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const twinRequestDeliverySchema = z.object({ clusterId: uuid, link: z.string().max(32768) }).strict();
const twinRequestDeclineSchema = z.object({ clusterId: uuid, relationshipId: uuid }).strict();
function ensureTwinRequestSchema(db) {
  ensureTwinHttpSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_twin_requests(
    relationship_id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
    peer_node_id TEXT NOT NULL, peer_name TEXT NOT NULL, cluster_id TEXT NOT NULL, link TEXT, expires_at INTEGER NOT NULL)`);
}
function coMembers(db, clusterId, localNodeId, peerNodeId) {
  let members;
  try {
    members = listSharingClusterMembers(db, clusterId);
  } catch {
    return false;
  }
  return members.some((member) => member.nodeId === localNodeId) && members.some((member) => member.nodeId === peerNodeId);
}
function activeTwin(db, localNodeId, peerNodeId) {
  return listTwinRelationships(db, localNodeId).some((item) => item.status === "active" && item.peer.nodeId === peerNodeId);
}
function pruneTwinRequests(db, now = Date.now()) {
  db.prepare(`DELETE FROM cluster_v2_twin_requests WHERE expires_at<=? OR relationship_id IN
    (SELECT relationship_id FROM cluster_v2_twin_relationships)`).run(now);
}
async function listTwinRequests() {
  const db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  pruneTwinRequests(db);
  const rows = db.prepare("SELECT * FROM cluster_v2_twin_requests ORDER BY expires_at").all();
  return rows.map((row) => ({
    relationshipId: row.relationship_id,
    direction: row.direction,
    peerNodeId: row.peer_node_id,
    peerName: row.peer_name,
    clusterId: row.cluster_id,
    expiresAt: row.expires_at
  }));
}
async function requestTwin(clusterId, peerNodeId) {
  const local = await getClusterNode(), db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  if (peerNodeId === local.id) throw new ClusterV2HttpError(400, "A node cannot be its own twin");
  if (!coMembers(db, clusterId, local.id, peerNodeId)) throw new ClusterV2HttpError(403, "That node is not a member of this cluster");
  if (activeTwin(db, local.id, peerNodeId)) throw new ClusterV2HttpError(409, "These nodes are already twins");
  const { link, relationshipId } = await createTwinHttpInvitation();
  const { invitation } = parseTwinLink(link);
  await signedPost(db, local.id, peerNodeId, clusterId, "/api/cluster/v2/twins/requests", { clusterId, link });
  const peer = db.prepare("SELECT name FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(clusterId, peerNodeId);
  const view = { relationshipId, direction: "outgoing", peerNodeId, peerName: peer?.name || peerNodeId, clusterId, expiresAt: invitation.body.expiresAt };
  db.prepare("INSERT OR REPLACE INTO cluster_v2_twin_requests VALUES(?,?,?,?,?,NULL,?)").run(relationshipId, "outgoing", peerNodeId, view.peerName, clusterId, view.expiresAt);
  return view;
}
async function receiveTwinRequest(senderNodeId, payload) {
  const body = twinRequestDeliverySchema.parse(payload);
  const local = await getClusterNode(), db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  if (!coMembers(db, body.clusterId, local.id, senderNodeId)) throw new ClusterV2HttpError(403, "Forbidden");
  const wrapper = parseTwinLink(body.link);
  const inviter = wrapper.invitation.body.inviter;
  if (inviter.nodeId !== senderNodeId || pinnedClusterPublicKey(db, senderNodeId) !== inviter.publicKey) throw new ClusterV2HttpError(403, "Forbidden");
  if (wrapper.invitation.body.expiresAt <= Date.now()) throw new ClusterV2HttpError(410, "Twin invitation has expired");
  if (activeTwin(db, local.id, senderNodeId)) throw new ClusterV2HttpError(409, "These nodes are already twins");
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE direction='incoming' AND peer_node_id=?").run(senderNodeId);
  db.prepare("INSERT OR REPLACE INTO cluster_v2_twin_requests VALUES(?,?,?,?,?,?,?)").run(wrapper.invitation.body.relationshipId, "incoming", senderNodeId, wrapper.endpoint.name, body.clusterId, body.link, wrapper.invitation.body.expiresAt);
}
function incomingRequest(db, relationshipId) {
  pruneTwinRequests(db);
  const row = db.prepare("SELECT * FROM cluster_v2_twin_requests WHERE relationship_id=? AND direction='incoming'").get(relationshipId);
  if (!row?.link) throw new ClusterV2HttpError(404, "This twin request has expired or was withdrawn. Ask for a new one.");
  return row;
}
async function acceptTwinRequest(relationshipId) {
  const db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  const row = incomingRequest(db, relationshipId);
  const result = await acceptTwinHttpLink(row.link);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=?").run(relationshipId);
  return result;
}
async function declineTwinRequest(relationshipId) {
  const local = await getClusterNode(), db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  const row = incomingRequest(db, relationshipId);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=?").run(relationshipId);
  try {
    await signedPost(db, local.id, row.peer_node_id, row.cluster_id, "/api/cluster/v2/twins/requests/decline", { clusterId: row.cluster_id, relationshipId });
  } catch (error) {
    console.warn(`Could not tell ${row.peer_node_id} that its twin request was declined: ${error instanceof Error ? error.message : error}`);
  }
}
async function receiveTwinRequestDecline(senderNodeId, payload) {
  const body = twinRequestDeclineSchema.parse(payload);
  const db = await clusterV2Database();
  ensureTwinRequestSchema(db);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=? AND direction='outgoing' AND peer_node_id=? AND cluster_id=?").run(body.relationshipId, senderNodeId, body.clusterId);
}
export {
  acceptTwinRequest,
  declineTwinRequest,
  listTwinRequests,
  receiveTwinRequest,
  receiveTwinRequestDecline,
  requestTwin,
  twinRequestDeclineSchema,
  twinRequestDeliverySchema
};
