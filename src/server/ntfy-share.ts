import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getNtfyService, importNewerNtfyService, type NtfyService } from "../ntfy.js";
import { settingsDatabase } from "../settings-store.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { pulledNtfyService } from "./schemas.js";

/**
 * ntfy service sharing is event driven: nothing runs on a timer. The sharing node pushes
 * once when a service is shared or edited; a node that was offline asks its peers for
 * what they share with it when it starts, and also pushes its own undelivered shares.
 */

const TWINS = "twins";

export interface NtfySharing { includeTwins: boolean; clusterIds: string[] }
export interface NtfySharingView extends NtfySharing { pendingNodes: number }
export interface NtfyShareResult { peerId: string; ok: boolean; error?: string }

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS ntfy_service_shares (
    service_id TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (service_id, target)
  ); CREATE TABLE IF NOT EXISTS ntfy_service_deliveries (
    service_id TEXT NOT NULL, peer_id TEXT NOT NULL, delivered_hash TEXT, attempted_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    PRIMARY KEY (service_id, peer_id)
  );`);
  return db;
}

export function ntfyServiceSharing(serviceId: string): NtfySharing {
  const targets = (database().prepare("SELECT target FROM ntfy_service_shares WHERE service_id=? ORDER BY target").all(serviceId) as Array<{ target: string }>).map((row) => row.target);
  return { includeTwins: targets.includes(TWINS), clusterIds: targets.filter((target) => target !== TWINS) };
}

/** The selection plus how many nodes still lack the current version of the service. */
export function ntfyServiceSharingView(serviceId: string): NtfySharingView {
  const sharing = ntfyServiceSharing(serviceId);
  const service = getNtfyService(serviceId);
  if (!service || (!sharing.includeTwins && !sharing.clusterIds.length)) return { ...sharing, pendingNodes: 0 };
  const row = database().prepare("SELECT COUNT(*) AS count FROM ntfy_service_deliveries WHERE service_id=? AND (delivered_hash IS NULL OR delivered_hash<>?)").get(serviceId, fingerprint(service)) as { count: number };
  return { ...sharing, pendingNodes: Number(row.count) };
}

/** The selection replaces the previous one; peers already holding the service keep their copy. */
export function setNtfyServiceSharing(serviceId: string, sharing: NtfySharing): void {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM ntfy_service_shares WHERE service_id=?").run(serviceId);
    const insert = db.prepare("INSERT INTO ntfy_service_shares VALUES (?, ?)");
    for (const target of [...(sharing.includeTwins ? [TWINS] : []), ...new Set(sharing.clusterIds)]) insert.run(serviceId, target);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function forgetNtfyServiceSharing(serviceId: string): void {
  const db = database();
  db.prepare("DELETE FROM ntfy_service_shares WHERE service_id=?").run(serviceId);
  db.prepare("DELETE FROM ntfy_service_deliveries WHERE service_id=?").run(serviceId);
}

const fingerprint = (service: NtfyService): string => createHash("sha256").update(JSON.stringify([service.id, service.name, service.url, service.token])).digest("hex");

/** Older receivers validate the push strictly, so it carries only the original fields. */
const pushPayload = ({ id, name, url, token }: NtfyService) => ({ id, name, url, token });

async function shareTargets(serviceId: string): Promise<Set<string>> {
  const sharing = ntfyServiceSharing(serviceId);
  const cluster = await clusterV2Database(), local = await getClusterNode();
  const targets = new Set<string>();
  if (sharing.includeTwins) for (const peer of replicationPeers(cluster, local.id)) if (isTrustedTwin(cluster, local.id, peer.nodeId)) targets.add(peer.nodeId);
  for (const clusterId of sharing.clusterIds) {
    const members = listSharingClusterMembers(cluster, clusterId);
    if (!members.some((member) => member.nodeId === local.id)) continue;
    for (const member of members) if (member.nodeId !== local.id) targets.add(member.nodeId);
  }
  return targets;
}

function recordDelivery(serviceId: string, peerId: string, hash: string | null, error: string | null): void {
  database().prepare(`INSERT INTO ntfy_service_deliveries VALUES (?, ?, ?, ?, ?) ON CONFLICT(service_id, peer_id) DO UPDATE SET
    delivered_hash=COALESCE(excluded.delivered_hash, delivered_hash), attempted_at=excluded.attempted_at, last_error=excluded.last_error`).run(serviceId, peerId, hash, Date.now(), error);
}

/** One push to every target still lacking the current version. Unreachable peers stay pending until one side restarts. */
async function deliverService(serviceId: string): Promise<NtfyShareResult[]> {
  const service = getNtfyService(serviceId);
  if (!service) { forgetNtfyServiceSharing(serviceId); return []; }
  const cluster = await clusterV2Database(), local = await getClusterNode();
  const peers = replicationPeers(cluster, local.id);
  const hash = fingerprint(service);
  const delivered = database().prepare("SELECT delivered_hash AS deliveredHash FROM ntfy_service_deliveries WHERE service_id=? AND peer_id=?");
  const due = [...await shareTargets(serviceId)].filter((peerId) => (delivered.get(serviceId, peerId) as { deliveredHash: string | null } | undefined)?.deliveredHash !== hash);
  // Parallel, so one offline node's timeout does not hold up the others.
  return Promise.all(due.map(async (peerId): Promise<NtfyShareResult> => {
    const peer = peers.find((candidate) => candidate.nodeId === peerId);
    if (!peer) {
      recordDelivery(serviceId, peerId, null, "Node is not reachable yet");
      return { peerId, ok: false, error: "Node is not reachable yet" };
    }
    try {
      await signedPeerPost(peer, "/api/cluster/v2/ntfy/services", pushPayload(service));
      recordDelivery(serviceId, peerId, hash, null);
      return { peerId, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Share failed";
      recordDelivery(serviceId, peerId, null, message);
      return { peerId, ok: false, error: message };
    }
  }));
}

/** Pushes a service now, after it is shared or edited. A service nobody shares from here sends nothing. */
export function shareNtfyServiceNow(serviceId: string): Promise<NtfyShareResult[]> {
  return deliverService(serviceId);
}

/** Answers a returning peer: every service this node shares with it, marked delivered on the way out. */
export async function ntfyServicesSharedWith(peerId: string): Promise<Array<NtfyService & { updatedAt: number }>> {
  const ids = (database().prepare("SELECT DISTINCT service_id AS id FROM ntfy_service_shares").all() as Array<{ id: string }>).map((row) => row.id);
  const services: Array<NtfyService & { updatedAt: number }> = [];
  for (const id of ids) {
    const service = getNtfyService(id);
    if (!service || !(await shareTargets(id)).has(peerId)) continue;
    services.push({ ...pushPayload(service), updatedAt: service.updatedAt ?? 0 });
    recordDelivery(id, peerId, fingerprint(service), null);
  }
  return services;
}

let syncing = false;
/** Runs when the node starts or joins a cluster: pull what peers share with this node, then push this node's pending shares. */
export async function syncNtfyServiceShares(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const cluster = await clusterV2Database(), local = await getClusterNode();
    await Promise.all(replicationPeers(cluster, local.id).map(async (peer) => {
      try {
        const reply = await signedPeerPost(peer, "/api/cluster/v2/ntfy/services/pull", {}) as { services?: unknown };
        for (const service of Array.isArray(reply.services) ? reply.services : []) {
          const parsed = pulledNtfyService.safeParse(service);
          if (parsed.success) importNewerNtfyService(parsed.data);
        }
      } catch (error) {
        // An offline or older peer has nothing to say now; it pushes to this node when it next starts.
        console.warn(`ntfy share pull from ${peer.nodeId} skipped: ${error instanceof Error ? error.message : error}`);
      }
    }));
    const services = (database().prepare("SELECT DISTINCT service_id AS id FROM ntfy_service_shares").all() as Array<{ id: string }>).map((row) => row.id);
    for (const id of services) {
      for (const result of await deliverService(id)) if (!result.ok) console.warn(`ntfy service share to ${result.peerId} pending: ${result.error}`);
    }
  } finally { syncing = false; }
}
