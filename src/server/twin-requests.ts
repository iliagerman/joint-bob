import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { pinnedClusterPublicKey } from "../cluster-identity.js";
import { listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { listTwinRelationships } from "../cluster-twins.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { signedPost } from "./cluster-v2.js";
import { acceptTwinHttpLink, createTwinHttpInvitation, ensureTwinHttpSchema, parseTwinLink } from "./twins.js";

/**
 * Twin requests between members of a shared cluster. The cluster already pins both
 * nodes' keys and addresses, so instead of copying a one-time link between machines
 * the requesting node delivers its signed twin invitation to the other member, and
 * that node's user accepts or declines it. Both users still consent; the link just
 * travels over the authenticated cluster channel.
 */

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
export const twinRequestDeliverySchema = z.object({ clusterId: uuid, link: z.string().max(32768) }).strict();
export const twinRequestDeclineSchema = z.object({ clusterId: uuid, relationshipId: uuid }).strict();

export interface TwinRequestView {
  relationshipId: string;
  direction: "incoming" | "outgoing";
  peerNodeId: string;
  peerName: string;
  clusterId: string;
  expiresAt: number;
}

interface TwinRequestRow {
  relationship_id: string;
  direction: "incoming" | "outgoing";
  peer_node_id: string;
  peer_name: string;
  cluster_id: string;
  link: string | null;
  expires_at: number;
}

function ensureTwinRequestSchema(db: DatabaseSync): void {
  ensureTwinHttpSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_twin_requests(
    relationship_id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
    peer_node_id TEXT NOT NULL, peer_name TEXT NOT NULL, cluster_id TEXT NOT NULL, link TEXT, expires_at INTEGER NOT NULL)`);
}

function coMembers(db: DatabaseSync, clusterId: string, localNodeId: string, peerNodeId: string): boolean {
  let members;
  try { members = listSharingClusterMembers(db, clusterId); } catch { return false; }
  return members.some((member) => member.nodeId === localNodeId) && members.some((member) => member.nodeId === peerNodeId);
}

function activeTwin(db: DatabaseSync, localNodeId: string, peerNodeId: string): boolean {
  return listTwinRelationships(db, localNodeId).some((item) => item.status === "active" && item.peer.nodeId === peerNodeId);
}

/** Drops expired requests and ones the handshake has since settled. */
function pruneTwinRequests(db: DatabaseSync, now = Date.now()): void {
  db.prepare(`DELETE FROM cluster_v2_twin_requests WHERE expires_at<=? OR relationship_id IN
    (SELECT relationship_id FROM cluster_v2_twin_relationships)`).run(now);
}

export async function listTwinRequests(): Promise<TwinRequestView[]> {
  const db = await clusterV2Database(); ensureTwinRequestSchema(db); pruneTwinRequests(db);
  const rows = db.prepare("SELECT * FROM cluster_v2_twin_requests ORDER BY expires_at").all() as unknown as TwinRequestRow[];
  return rows.map((row) => ({ relationshipId: row.relationship_id, direction: row.direction, peerNodeId: row.peer_node_id,
    peerName: row.peer_name, clusterId: row.cluster_id, expiresAt: row.expires_at }));
}

/** The local user asks another member of `clusterId` to become this node's twin. */
export async function requestTwin(clusterId: string, peerNodeId: string): Promise<TwinRequestView> {
  const local = await getClusterNode(), db = await clusterV2Database(); ensureTwinRequestSchema(db);
  if (peerNodeId === local.id) throw new ClusterV2HttpError(400, "A node cannot be its own twin");
  if (!coMembers(db, clusterId, local.id, peerNodeId)) throw new ClusterV2HttpError(403, "That node is not a member of this cluster");
  if (activeTwin(db, local.id, peerNodeId)) throw new ClusterV2HttpError(409, "These nodes are already twins");
  const { link, relationshipId } = await createTwinHttpInvitation();
  const { invitation } = parseTwinLink(link);
  await signedPost(db, local.id, peerNodeId, clusterId, "/api/cluster/v2/twins/requests", { clusterId, link });
  const peer = db.prepare("SELECT name FROM cluster_v2_membership_nodes WHERE cluster_id=? AND node_id=?").get(clusterId, peerNodeId) as { name: string } | undefined;
  const view: TwinRequestView = { relationshipId, direction: "outgoing", peerNodeId, peerName: peer?.name || peerNodeId, clusterId, expiresAt: invitation.body.expiresAt };
  db.prepare("INSERT OR REPLACE INTO cluster_v2_twin_requests VALUES(?,?,?,?,?,NULL,?)")
    .run(relationshipId, "outgoing", peerNodeId, view.peerName, clusterId, view.expiresAt);
  return view;
}

/** Machine route: a co-member delivered its twin invitation. Nothing is granted until the local user accepts. */
export async function receiveTwinRequest(senderNodeId: string, payload: unknown): Promise<void> {
  const body = twinRequestDeliverySchema.parse(payload);
  const local = await getClusterNode(), db = await clusterV2Database(); ensureTwinRequestSchema(db);
  if (!coMembers(db, body.clusterId, local.id, senderNodeId)) throw new ClusterV2HttpError(403, "Forbidden");
  const wrapper = parseTwinLink(body.link);
  const inviter = wrapper.invitation.body.inviter;
  if (inviter.nodeId !== senderNodeId || pinnedClusterPublicKey(db, senderNodeId) !== inviter.publicKey) throw new ClusterV2HttpError(403, "Forbidden");
  if (wrapper.invitation.body.expiresAt <= Date.now()) throw new ClusterV2HttpError(410, "Twin invitation has expired");
  if (activeTwin(db, local.id, senderNodeId)) throw new ClusterV2HttpError(409, "These nodes are already twins");
  // One open request per peer: a newer one replaces the last.
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE direction='incoming' AND peer_node_id=?").run(senderNodeId);
  db.prepare("INSERT OR REPLACE INTO cluster_v2_twin_requests VALUES(?,?,?,?,?,?,?)")
    .run(wrapper.invitation.body.relationshipId, "incoming", senderNodeId, wrapper.endpoint.name, body.clusterId, body.link, wrapper.invitation.body.expiresAt);
}

function incomingRequest(db: DatabaseSync, relationshipId: string): TwinRequestRow {
  pruneTwinRequests(db);
  const row = db.prepare("SELECT * FROM cluster_v2_twin_requests WHERE relationship_id=? AND direction='incoming'").get(relationshipId) as unknown as TwinRequestRow | undefined;
  if (!row?.link) throw new ClusterV2HttpError(404, "This twin request has expired or was withdrawn. Ask for a new one.");
  return row;
}

export async function acceptTwinRequest(relationshipId: string): Promise<{ relationshipId: string; status: "active" }> {
  const db = await clusterV2Database(); ensureTwinRequestSchema(db);
  const row = incomingRequest(db, relationshipId);
  const result = await acceptTwinHttpLink(row.link);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=?").run(relationshipId);
  return result;
}

/** Declining forgets the request here and tells the requester, best effort. */
export async function declineTwinRequest(relationshipId: string): Promise<void> {
  const local = await getClusterNode(), db = await clusterV2Database(); ensureTwinRequestSchema(db);
  const row = incomingRequest(db, relationshipId);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=?").run(relationshipId);
  try {
    await signedPost(db, local.id, row.peer_node_id, row.cluster_id, "/api/cluster/v2/twins/requests/decline", { clusterId: row.cluster_id, relationshipId });
  } catch (error) {
    console.warn(`Could not tell ${row.peer_node_id} that its twin request was declined: ${error instanceof Error ? error.message : error}`);
  }
}

/** Machine route: the peer declined a request this node sent it. */
export async function receiveTwinRequestDecline(senderNodeId: string, payload: unknown): Promise<void> {
  const body = twinRequestDeclineSchema.parse(payload);
  const db = await clusterV2Database(); ensureTwinRequestSchema(db);
  db.prepare("DELETE FROM cluster_v2_twin_requests WHERE relationship_id=? AND direction='outgoing' AND peer_node_id=? AND cluster_id=?")
    .run(body.relationshipId, senderNodeId, body.clusterId);
}
