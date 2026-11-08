import type { DatabaseSync } from "node:sqlite";
import { accountOfSomeoneElse, resourceOwner } from "../ownership.js";
import { getClusterNode } from "../cluster.js";
import { ensurePeerEndpointSchema, type PeerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { ensureResourceSharingSchema } from "../cluster-sharing.js";
import { enqueueSecretCredentialSync, secretCredentialEventsForPeer, recordSecretCredentialReceipt, recordSecretCredentialFailure } from "../secret-replication.js";
import { isTrustedTwin, mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from '../cluster-v2-errors.js';
import { clusterV2Database } from "../cluster-v2-store.js";
import { replicationEventProjectId, type ReplicationEvent } from "../replication.js";
import { fetchPeer, peerAway } from "./peer-availability.js";
import { settled, warnOnChange } from "./quiet-log.js";
import { nodesBlockedBetween } from "../node-blocks.js";

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
  return [...new Map(rows.filter((row) => !nodesBlockedBetween(db, local, row.nodeId)).map((row) => [row.nodeId, row])).values()];
}

/** The replication peers to send to now. One that stopped answering is left alone until it is
    heard from again or its next probe is due; what was meant for it stays queued. */
export function presentReplicationPeers(db: DatabaseSync, local: string): PeerEndpoint[] {
  return replicationPeers(db, local).filter((peer) => !peerAway(peer.nodeId));
}

/** The project an event belongs to, resolving conversation events through their record. */
export function replicationEventProject(db: DatabaseSync, event: ReplicationEvent): string | undefined {
  const project = replicationEventProjectId(event);
  if (project || !["conversation.ownership", "name.override"].includes(event.entityType)) return project;
  const payload = event.payload as { sessionId?: string; key?: string };
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_records'").get();
  const rows = table ? db.prepare("SELECT DISTINCT project_id FROM conversation_records WHERE session_id=?").all(payload.sessionId ?? payload.key ?? "") as unknown as Array<{project_id:string}> : [];
  return rows.length === 1 ? rows[0].project_id : undefined;
}

/** Where each event type may go. A type without a scope goes nowhere, so a new event
    type has to be placed here before it can leave the node. */
export const EVENT_SCOPES: Readonly<Record<string, "project" | "account" | "twins" | "twins-only" | "cluster" | "separate">> = {
  // Shared project state: nodes the project is shared with.
  "name.override": "project",
  "project.lock": "project",
  task: "project",
  "conversation.ownership": "project",
  "conversation.record": "project",
  "conversation.queue": "project",
  "conversation.routing": "project",
  "conversation.goal": "project",
  // A saved story and its podcast: the nodes the project is shared with.
  story: "project",
  "conversation.author": "project",
  "model.usage": "project",
  "usage.difficulty": "project",
  // One person's data, keyed by account: their twins, home and the nodes they signed in to.
  "conversation.review": "account",
  "conversation.notification": "account",
  "conversation.notification.delivered": "account",
  "user.pin": "account",
  "user.recent": "account",
  // A person's bindings, not tied to a project: their own machines only.
  "canvas.shortcut": "twins",
  // The AGENTS.md every project's agents read, kept the same on the owner's machines.
  "instructions.global": "twins",
  // Bob's memory topics: the person's own machines.
  "control.memory": "twins",
  // That the person uses Bob, with Bob's settings, and what Bob's review checks found: the person's own machines.
  "control.bob": "twins",
  "control.reviewCheck": "twins",
  // The person's chat with Bob, so they can go on from any of their machines.
  "control.bobMessage": "twins",
  // Subscription profile names and choices: the administrator's twins, never a visited node.
  "system.ai": "twins-only",
  "provider.profile": "twins-only",
  "provider.selection": "twins-only",
  "provider.pool": "twins-only",
  "provider.poolSelection": "twins-only",
  "provider.poolAssignment": "cluster",
  // Routing configurations have their own distribution (routing-configs.ts).
  "cluster.routing": "separate",
};

/** Event types an older node doesn't know. It rejects a whole batch over one unknown type,
    so these go only to peers that have accepted this node's account snapshot, which only an
    upgraded node can. The periodic full scan offers them again once a peer upgrades. */
const NEWER_EVENT_TYPES = new Set(["conversation.author", "provider.pool", "provider.poolSelection", "control.memory", "control.bob", "control.reviewCheck", "control.bobMessage"]);

function peerUnderstands(db: DatabaseSync, peer: string, entityType: string): boolean {
  if (!NEWER_EVENT_TYPES.has(entityType)) return true;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_replication_deliveries'").get()) return false;
  return Boolean(db.prepare("SELECT 1 FROM account_replication_deliveries WHERE peer_id = ?").get(peer));
}

/**
 * A person's account events (pins, recents, review marks, notification choices) go to their
 * own nodes only: twins, their home node from a node they signed in to, and from home to
 * every node they signed in to. They travel directly, never through a cluster's hub.
 */
export function visitorEventRoute(db: DatabaseSync, _local: string, peer: string, event: ReplicationEvent): boolean {
  const account = (event.payload as { username?: unknown } | null)?.username;
  if (typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account)) return false;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'account_roaming_nodes')").all() as unknown as Array<{ name: string }>).map((row) => row.name));
  // A visitor here, whose home is the peer.
  if (tables.has("users") && db.prepare("SELECT 1 FROM users WHERE account_id = ? AND home_node_id = ?").get(account, peer)) return true;
  // One of our people, signed in on the peer: only about a project that node can show them.
  if (!tables.has("account_roaming_nodes") || !db.prepare("SELECT 1 FROM account_roaming_nodes WHERE account_id = ? AND node_id = ?").get(account, peer)) return false;
  const project = replicationEventProjectId(event);
  return !project || visitedNodeSeesProject(db, _local, peer, account, project);
}

/** The accounts whose events visitorEventRoute can send to a peer: visitors here whose home it
    is, and our people signed in on it. Every other event is refused for that peer. */
export function visitorEventAccounts(db: DatabaseSync, peer: string): string[] {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'account_roaming_nodes')").all() as unknown as Array<{ name: string }>).map((row) => row.name));
  const accounts = new Set<string>();
  if (tables.has("users")) for (const row of db.prepare("SELECT account_id FROM users WHERE home_node_id = ?").all(peer) as unknown as Array<{ account_id: string }>) accounts.add(row.account_id);
  if (tables.has("account_roaming_nodes")) for (const row of db.prepare("SELECT account_id FROM account_roaming_nodes WHERE node_id = ?").all(peer) as unknown as Array<{ account_id: string }>) accounts.add(row.account_id);
  return [...accounts];
}

/** Whether a node one of our people signed in to can show them this project: one shared
    with that node, or their own project here that isn't hidden from other nodes. A pin or
    recent about any other project stays home, title and path included. */
export function visitedNodeSeesProject(db: DatabaseSync, local: string, peer: string, accountId: string, projectId: string): boolean {
  try {
    if (mayReceiveResource(db, peer, "project", projectId)) return true;
    const owner = db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind = 'project' AND resource_id = ?").get(projectId) as { owner_node_id: string } | undefined;
    if (owner && owner.owner_node_id !== local) return false;
    if (resourceOwner("project", projectId, db) !== accountId) return false;
    const hidden = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_live_hidden'").get()
      && db.prepare("SELECT 1 FROM project_live_hidden WHERE project_id = ?").get(projectId);
    return !hidden;
  } catch {
    return false;
  }
}

/** The nodes our account events go to directly: visitors' home nodes and the nodes our
    people signed in to. */
export function accountEventPeers(db: DatabaseSync): Set<string> {
  const peers = visitorHomeNodes(db);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_roaming_nodes'").get()) {
    for (const row of db.prepare("SELECT DISTINCT node_id FROM account_roaming_nodes").all() as unknown as Array<{ node_id: string }>) peers.add(row.node_id);
  }
  return peers;
}

/** The home nodes of the visitors signed in here. */
export function visitorHomeNodes(db: DatabaseSync): Set<string> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) return new Set();
  return new Set((db.prepare("SELECT DISTINCT home_node_id FROM users WHERE home_node_id IS NOT NULL").all() as unknown as Array<{ home_node_id: string }>).map((row) => row.home_node_id));
}

/** Twins are the admin's own machines: a member's or a visitor's account data never goes to
    one, and none is taken from one. Rows from before accounts had ids are the admin's. */
function twinHoldsAccount(db: DatabaseSync, event: ReplicationEvent): boolean {
  const account = (event.payload as { username?: unknown } | null)?.username;
  return typeof account !== "string" || !/^[0-9a-f]{32}$/.test(account) || !accountOfSomeoneElse(account, db);
}

function hasMembers(db: DatabaseSync): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM users WHERE home_node_id IS NULL AND role = 'member' LIMIT 1").get()); }
  catch { return false; } // No accounts table yet, or one from before roles: nobody but the admin.
}

export function mayReplicateEvent(db: DatabaseSync, local: string, peer: string, event: ReplicationEvent): boolean {
  const scope = EVENT_SCOPES[event.entityType];
  if (!scope || scope === "separate") return false;
  if (!peerUnderstands(db, peer, event.entityType)) return false;
  // A block between any two of the three nodes involved stops the event, relays included.
  if (nodesBlockedBetween(db, local, peer) || nodesBlockedBetween(db, local, event.originNodeId, peer)) return false;
  if (scope === "twins-only") return isTrustedTwin(db, local, peer) && twinHoldsAccount(db, event);
  if (scope === "account" || scope === "twins") return isTrustedTwin(db, local, peer) ? twinHoldsAccount(db, event) : visitorEventRoute(db, local, peer, event);
  if (scope === "cluster") {
    const clusterId = (event.payload as { clusterId?: unknown } | null)?.clusterId;
    if (typeof clusterId !== "string") return false;
    const state = db.prepare("SELECT manager_node_id,closed FROM sharing_clusters WHERE id=?").get(clusterId) as { manager_node_id: string | null; closed: number } | undefined;
    if (!state || state.closed || state.manager_node_id !== event.originNodeId) return false;
    const member = (nodeId: string) => Boolean(db.prepare("SELECT 1 FROM sharing_memberships WHERE cluster_id=? AND node_id=?").get(clusterId, nodeId));
    return member(local) && member(peer);
  }
  const project = replicationEventProject(db, event);
  // Data outside any project stays on the user's own machines: twins only.
  // With several people here nothing says whose it is, so it stays.
  if (!project) return isTrustedTwin(db, local, peer) && !hasMembers(db);
  const policy = db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?")
    .get(project) as { deleted: number } | undefined;
  return Boolean(policy && !policy.deleted && mayReceiveResource(db, local, "project", project)
    && mayReceiveResource(db, peer, "project", project));
}

/** A previous release rejects unknown event types as a whole batch. Keep system settings
 * on their own endpoint and retry queue so an older twin still receives ordinary events. */
export function replicationDeliveryBatches(events: ReplicationEvent[]): ReplicationEvent[][] {
  return [events.filter(event => event.entityType !== "system.ai"), events.filter(event => event.entityType === "system.ai")].filter(batch => batch.length);
}

export async function sendReplicationV2(peer: PeerEndpoint, events: ReplicationEvent[]): Promise<unknown> {
  const target = events[0].entityType === "system.ai" ? "/api/cluster/v2/system-ai/events" : "/api/cluster/v2/events";
  return signedPeerPost(peer, target, { events });
}

export async function signedPeerPost(peer: PeerEndpoint, target: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const body = Buffer.from(JSON.stringify(payload));
  const response = await fetchPeer(db, peer.nodeId, new URL(target, peer.url), { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(timeoutMs), body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, peer.nodeId, "POST", target, body) } });
  if (!response.ok) throw new ClusterV2HttpError(response.status,`Peer returned ${response.status}`);
  return response.json();
}

export async function flushTwinCredentials(): Promise<void> {
  const db = await clusterV2Database(), local = await getClusterNode();
  const peers = presentReplicationPeers(db, local.id).filter(peer => isTrustedTwin(db, local.id, peer.nodeId));
  if (!peers.length) return;
  await enqueueSecretCredentialSync(peers.map(peer => peer.nodeId));
  for (const peer of peers) {
    const events = (await secretCredentialEventsForPeer(peer.nodeId)).filter(event => event.originNodeId === local.id);
    try {
      const reply = await signedPeerPost(peer, "/api/cluster/v2/twins/credentials", { events }) as { received: string[] };
      if (!Array.isArray(reply.received) || reply.received.some(id => !events.some(event => event.id === id))) throw new Error("Invalid credential receipt");
      await recordSecretCredentialReceipt(peer.nodeId, reply.received);
      settled(`twin-credentials:${peer.nodeId}`);
    } catch (error) {
      const message=error instanceof Error?error.message:'Invalid credential response';
      await recordSecretCredentialFailure(peer.nodeId,events.map(event=>event.id),message);
      warnOnChange(`twin-credentials:${peer.nodeId}`, `Twin credential delivery to ${peer.nodeId} failed: ${message}`);
    }
  }
}
