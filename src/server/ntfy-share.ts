import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getNtfyService, type NtfyService } from "../ntfy.js";
import { settingsDatabase } from "../settings-store.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";

const TWINS = "twins";
const RETRY_MS = 15_000;

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

async function deliverService(serviceId: string, force: boolean): Promise<NtfyShareResult[]> {
  const service = getNtfyService(serviceId);
  if (!service) { forgetNtfyServiceSharing(serviceId); return []; }
  const sharing = ntfyServiceSharing(serviceId);
  const cluster = await clusterV2Database(), local = await getClusterNode();
  const peers = replicationPeers(cluster, local.id);
  const targets = new Set<string>();
  if (sharing.includeTwins) for (const peer of peers) if (isTrustedTwin(cluster, local.id, peer.nodeId)) targets.add(peer.nodeId);
  for (const clusterId of sharing.clusterIds) {
    const members = listSharingClusterMembers(cluster, clusterId);
    if (!members.some((member) => member.nodeId === local.id)) continue;
    for (const member of members) if (member.nodeId !== local.id) targets.add(member.nodeId);
  }
  const db = database(), hash = fingerprint(service), now = Date.now();
  const state = db.prepare("SELECT delivered_hash AS deliveredHash, attempted_at AS attemptedAt FROM ntfy_service_deliveries WHERE service_id=? AND peer_id=?");
  const record = db.prepare(`INSERT INTO ntfy_service_deliveries VALUES (?, ?, ?, ?, ?) ON CONFLICT(service_id, peer_id) DO UPDATE SET
    delivered_hash=COALESCE(excluded.delivered_hash, delivered_hash), attempted_at=excluded.attempted_at, last_error=excluded.last_error`);
  const due = [...targets].filter((peerId) => {
    const row = state.get(serviceId, peerId) as { deliveredHash: string | null; attemptedAt: number } | undefined;
    return row?.deliveredHash !== hash && (force || !row || now - row.attemptedAt >= RETRY_MS);
  });
  // Parallel, so one offline node's timeout does not hold up the others.
  const results = await Promise.all(due.map(async (peerId): Promise<NtfyShareResult> => {
    const peer = peers.find((candidate) => candidate.nodeId === peerId);
    if (!peer) {
      record.run(serviceId, peerId, null, now, "Node is not reachable yet");
      return { peerId, ok: false, error: "Node is not reachable yet" };
    }
    try {
      await signedPeerPost(peer, "/api/cluster/v2/ntfy/services", service);
      record.run(serviceId, peerId, hash, Date.now(), null);
      return { peerId, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Share failed";
      record.run(serviceId, peerId, null, Date.now(), message);
      return { peerId, ok: false, error: message };
    }
  }));
  return results;
}

/** Delivers one service right away, ignoring the retry backoff. */
export function shareNtfyServiceNow(serviceId: string): Promise<NtfyShareResult[]> {
  return deliverService(serviceId, true);
}

let flushing = false;
/** Retries undelivered shares, reaches members that joined a shared cluster later, and re-sends changed services. */
export async function flushNtfyServiceShares(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const services = (database().prepare("SELECT DISTINCT service_id AS id FROM ntfy_service_shares").all() as Array<{ id: string }>).map((row) => row.id);
    for (const id of services) {
      for (const result of await deliverService(id, false)) if (!result.ok) console.warn(`ntfy service share to ${result.peerId} pending: ${result.error}`);
    }
  } finally { flushing = false; }
}
