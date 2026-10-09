import { getClusterNode } from "../cluster.js";
import { ensurePeerEndpointSchema } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { enqueueSecretCredentialSync, secretCredentialEventsForPeer, recordSecretCredentialReceipt, recordSecretCredentialFailure } from "../secret-replication.js";
import { isTrustedTwin, mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { replicationEventProjectId } from "../replication.js";
import { fetchPeer } from "./peer-availability.js";
function replicationPeers(db, local) {
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  const rows = db.prepare(`SELECT e.node_id nodeId,e.name,e.url FROM cluster_v2_peer_endpoints e
    WHERE e.node_id<>? AND (
      (e.context_kind='twin' AND EXISTS (SELECT 1 FROM cluster_v2_twin_relationships t
        WHERE t.relationship_id=e.context_id AND t.peer_node_id=e.node_id AND t.status='active'))
      OR (e.context_kind='cluster' AND EXISTS (SELECT 1 FROM sharing_memberships a
        JOIN sharing_memberships b ON a.cluster_id=b.cluster_id
        WHERE a.cluster_id=e.context_id AND a.node_id=? AND b.node_id=e.node_id)))
    ORDER BY e.context_kind,e.context_id`).all(local, local);
  return [...new Map(rows.map((row) => [row.nodeId, row])).values()];
}
function replicationEventProject(db, event) {
  const project = replicationEventProjectId(event);
  if (project || !["conversation.ownership", "name.override"].includes(event.entityType)) return project;
  const payload = event.payload;
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_records'").get();
  const rows = table ? db.prepare("SELECT DISTINCT project_id FROM conversation_records WHERE session_id=?").all(payload.sessionId ?? payload.key ?? "") : [];
  return rows.length === 1 ? rows[0].project_id : void 0;
}
function mayReplicateEvent(db, local, peer, event) {
  if (event.entityType === "cluster.routing") return false;
  if (event.entityType === "canvas.shortcut") return isTrustedTwin(db, local, peer);
  const project = replicationEventProject(db, event);
  if (!project) return isTrustedTwin(db, local, peer);
  const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(project);
  return Boolean(policy && !policy.deleted && mayReceiveResource(db, local, "project", project) && mayReceiveResource(db, peer, "project", project));
}
async function sendReplicationV2(peer, events) {
  return signedPeerPost(peer, "/api/cluster/v2/events", { events });
}
async function signedPeerPost(peer, target, payload) {
  const db = await clusterV2Database(), local = await getClusterNode();
  const body = Buffer.from(JSON.stringify(payload));
  const response = await fetchPeer(db, peer.nodeId, new URL(target, peer.url), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(1e4),
    body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, peer.nodeId, "POST", target, body) }
  });
  if (!response.ok) throw new ClusterV2HttpError(response.status, `Peer returned ${response.status}`);
  return response.json();
}
async function flushTwinCredentials() {
  const db = await clusterV2Database(), local = await getClusterNode();
  const peers = replicationPeers(db, local.id).filter((peer) => isTrustedTwin(db, local.id, peer.nodeId));
  if (!peers.length) return;
  await enqueueSecretCredentialSync(peers.map((peer) => peer.nodeId), void 0, true);
  for (const peer of peers) {
    const events = (await secretCredentialEventsForPeer(peer.nodeId)).filter((event) => event.originNodeId === local.id);
    const activeIds = db.prepare(`SELECT id FROM secret_accounts WHERE replicate=1 AND origin_node_id=?
      AND project_id IS NULL`).all(local.id).map((row) => row.id);
    try {
      const reply = await signedPeerPost(peer, "/api/cluster/v2/twins/credentials", { events, activeIds });
      if (!Array.isArray(reply.received) || reply.received.some((id) => !events.some((event) => event.id === id))) throw new Error("Invalid credential receipt");
      await recordSecretCredentialReceipt(peer.nodeId, reply.received);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid credential response";
      await recordSecretCredentialFailure(peer.nodeId, events.map((event) => event.id), message);
      console.warn(`Twin credential delivery to ${peer.nodeId} failed: ${message}`);
    }
  }
}
export {
  flushTwinCredentials,
  mayReplicateEvent,
  replicationEventProject,
  replicationPeers,
  sendReplicationV2,
  signedPeerPost
};
