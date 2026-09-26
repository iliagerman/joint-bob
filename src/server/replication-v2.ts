import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { ensurePeerEndpointSchema, type PeerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { enqueueSecretCredentialSync, secretCredentialEventsForPeer, recordSecretCredentialReceipt, recordSecretCredentialFailure } from "../secret-replication.js";
import { isTrustedTwin, mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from '../cluster-v2-mode.js';
import { clusterV2Database } from "../cluster-v2-store.js";
import { replicationEventProjectId, type ReplicationEvent } from "../replication.js";

export function replicationPeers(db: DatabaseSync, local: string): PeerEndpoint[] {
  ensureResourceSharingSchema(db);
  ensurePeerEndpointSchema(db);
  const rows = db.prepare(`SELECT e.node_id nodeId,e.name,e.url FROM cluster_v2_peer_endpoints e
    WHERE e.node_id<>? AND (
      (e.context_kind='twin' AND EXISTS (SELECT 1 FROM cluster_v2_twin_relationships t
        WHERE t.relationship_id=e.context_id AND t.peer_node_id=e.node_id AND t.status='active'))
      OR (e.context_kind='cluster' AND EXISTS (SELECT 1 FROM sharing_memberships a
        JOIN sharing_memberships b ON a.cluster_id=b.cluster_id
        WHERE a.cluster_id=e.context_id AND a.node_id=? AND b.node_id=e.node_id)))
    ORDER BY e.context_kind,e.context_id`).all(local, local) as unknown as PeerEndpoint[];
  return [...new Map(rows.map((row) => [row.nodeId, row])).values()];
}

export function mayReplicateEvent(db: DatabaseSync, local: string, peer: string, event: ReplicationEvent): boolean {
  let project = replicationEventProjectId(event);
  // User-global keys cannot safely carry third-party project data through a twin.
  if (["cluster.routing", "canvas.shortcut"].includes(event.entityType)) return false;
  if (!project && ["conversation.ownership", "name.override"].includes(event.entityType)) {
    const payload = event.payload as { sessionId?: string; key?: string };
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_records'").get();
    if (!table) return false;
    const rows = db.prepare("SELECT DISTINCT project_id FROM conversation_records WHERE session_id=?").all(payload.sessionId ?? payload.key ?? "") as unknown as Array<{project_id:string}>;
    if (rows.length !== 1) return false;
    project = rows[0].project_id;
  }
  if (!project) return false;
  const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?")
    .get(project) as { deleted: number } | undefined;
  return Boolean(policy && !policy.deleted && mayReceiveResource(db, local, "project", project)
    && mayReceiveResource(db, peer, "project", project));
}

export async function sendReplicationV2(peer: PeerEndpoint, events: ReplicationEvent[]): Promise<unknown> {
  return signedPeerPost(peer, "/api/cluster/v2/events", { events });
}

export async function signedPeerPost(peer: PeerEndpoint, target: string, payload: unknown): Promise<unknown> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const body = Buffer.from(JSON.stringify(payload));
  const response = await fetch(new URL(target, peer.url), { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(10_000), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, peer.nodeId, "POST", target, body) } });
  if (!response.ok) throw new ClusterV2HttpError(response.status,`Peer returned ${response.status}`);
  return response.json();
}

export async function flushTwinCredentials(): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const peers = replicationPeers(db, local.id).filter(peer => isTrustedTwin(db, local.id, peer.nodeId));
  if (!peers.length) return;
  await enqueueSecretCredentialSync(peers.map(peer => peer.nodeId), undefined, true);
  for (const peer of peers) {
    const events = (await secretCredentialEventsForPeer(peer.nodeId)).filter(event => event.originNodeId === local.id);
    const activeIds=(db.prepare(`SELECT id FROM secret_accounts WHERE replicate=1 AND origin_node_id=?
      AND website_origin IS NULL AND provider<>'website' AND project_id IS NULL`).all(local.id) as unknown as Array<{id:string}>).map(row=>row.id);
    try {
      const reply = await signedPeerPost(peer, "/api/cluster/v2/twins/credentials", { events, activeIds }) as { received: string[] };
      if (!Array.isArray(reply.received) || reply.received.some(id => !events.some(event => event.id === id))) throw new Error("Invalid credential receipt");
      await recordSecretCredentialReceipt(peer.nodeId, reply.received);
    } catch (error) {
      const message=error instanceof Error?error.message:'Invalid credential response';
      await recordSecretCredentialFailure(peer.nodeId,events.map(event=>event.id),message);
      console.warn(`Twin credential delivery to ${peer.nodeId} failed: ${message}`);
    }
  }
}
