import { createHash } from "node:crypto";
import { getClusterNode } from "../cluster.js";
import { isTrustedTwin, listSharingClusterMembers } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getNtfyService, importNewerNtfyService } from "../ntfy.js";
import { settingsDatabase } from "../settings-store.js";
import { replicationPeers, signedPeerPost } from "./replication-v2.js";
import { pulledNtfyService } from "./schemas.js";
const TWINS = "twins";
function database() {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS ntfy_service_shares (
    service_id TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (service_id, target)
  ); CREATE TABLE IF NOT EXISTS ntfy_service_deliveries (
    service_id TEXT NOT NULL, peer_id TEXT NOT NULL, delivered_hash TEXT, attempted_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    PRIMARY KEY (service_id, peer_id)
  );`);
  return db;
}
function ntfyServiceSharing(serviceId) {
  const targets = database().prepare("SELECT target FROM ntfy_service_shares WHERE service_id=? ORDER BY target").all(serviceId).map((row) => row.target);
  return { includeTwins: targets.includes(TWINS), clusterIds: targets.filter((target) => target !== TWINS) };
}
function ntfyServiceSharingView(serviceId) {
  const sharing = ntfyServiceSharing(serviceId);
  const service = getNtfyService(serviceId);
  if (!service || !sharing.includeTwins && !sharing.clusterIds.length) return { ...sharing, pendingNodes: 0 };
  const row = database().prepare("SELECT COUNT(*) AS count FROM ntfy_service_deliveries WHERE service_id=? AND (delivered_hash IS NULL OR delivered_hash<>?)").get(serviceId, fingerprint(service));
  return { ...sharing, pendingNodes: Number(row.count) };
}
function setNtfyServiceSharing(serviceId, sharing) {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM ntfy_service_shares WHERE service_id=?").run(serviceId);
    const insert = db.prepare("INSERT INTO ntfy_service_shares VALUES (?, ?)");
    for (const target of [...sharing.includeTwins ? [TWINS] : [], ...new Set(sharing.clusterIds)]) insert.run(serviceId, target);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function forgetNtfyServiceSharing(serviceId) {
  const db = database();
  db.prepare("DELETE FROM ntfy_service_shares WHERE service_id=?").run(serviceId);
  db.prepare("DELETE FROM ntfy_service_deliveries WHERE service_id=?").run(serviceId);
}
const fingerprint = (service) => createHash("sha256").update(JSON.stringify([service.id, service.name, service.url, service.token])).digest("hex");
const pushPayload = ({ id, name, url, token }) => ({ id, name, url, token });
async function shareTargets(serviceId) {
  const sharing = ntfyServiceSharing(serviceId);
  const cluster = await clusterV2Database(), local = await getClusterNode();
  const targets = /* @__PURE__ */ new Set();
  if (sharing.includeTwins) {
    for (const peer of replicationPeers(cluster, local.id)) if (isTrustedTwin(cluster, local.id, peer.nodeId)) targets.add(peer.nodeId);
  }
  for (const clusterId of sharing.clusterIds) {
    const members = listSharingClusterMembers(cluster, clusterId);
    if (!members.some((member) => member.nodeId === local.id)) continue;
    for (const member of members) if (member.nodeId !== local.id) targets.add(member.nodeId);
  }
  return targets;
}
function recordDelivery(serviceId, peerId, hash, error) {
  database().prepare(`INSERT INTO ntfy_service_deliveries VALUES (?, ?, ?, ?, ?) ON CONFLICT(service_id, peer_id) DO UPDATE SET
    delivered_hash=COALESCE(excluded.delivered_hash, delivered_hash), attempted_at=excluded.attempted_at, last_error=excluded.last_error`).run(serviceId, peerId, hash, Date.now(), error);
}
async function deliverService(serviceId) {
  const service = getNtfyService(serviceId);
  if (!service) {
    forgetNtfyServiceSharing(serviceId);
    return [];
  }
  const cluster = await clusterV2Database(), local = await getClusterNode();
  const peers = replicationPeers(cluster, local.id);
  const hash = fingerprint(service);
  const delivered = database().prepare("SELECT delivered_hash AS deliveredHash FROM ntfy_service_deliveries WHERE service_id=? AND peer_id=?");
  const due = [...await shareTargets(serviceId)].filter((peerId) => delivered.get(serviceId, peerId)?.deliveredHash !== hash);
  return Promise.all(due.map(async (peerId) => {
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
function shareNtfyServiceNow(serviceId) {
  return deliverService(serviceId);
}
async function ntfyServicesSharedWith(peerId) {
  const ids = database().prepare("SELECT DISTINCT service_id AS id FROM ntfy_service_shares").all().map((row) => row.id);
  const services = [];
  for (const id of ids) {
    const service = getNtfyService(id);
    if (!service || !(await shareTargets(id)).has(peerId)) continue;
    services.push({ ...pushPayload(service), updatedAt: service.updatedAt ?? 0 });
    recordDelivery(id, peerId, fingerprint(service), null);
  }
  return services;
}
let syncing = false;
async function syncNtfyServiceShares() {
  if (syncing) return;
  syncing = true;
  try {
    const cluster = await clusterV2Database(), local = await getClusterNode();
    await Promise.all(replicationPeers(cluster, local.id).map(async (peer) => {
      try {
        const reply = await signedPeerPost(peer, "/api/cluster/v2/ntfy/services/pull", {});
        for (const service of Array.isArray(reply.services) ? reply.services : []) {
          const parsed = pulledNtfyService.safeParse(service);
          if (parsed.success) importNewerNtfyService(parsed.data);
        }
      } catch (error) {
        console.warn(`ntfy share pull from ${peer.nodeId} skipped: ${error instanceof Error ? error.message : error}`);
      }
    }));
    const services = database().prepare("SELECT DISTINCT service_id AS id FROM ntfy_service_shares").all().map((row) => row.id);
    for (const id of services) {
      for (const result of await deliverService(id)) if (!result.ok) console.warn(`ntfy service share to ${result.peerId} pending: ${result.error}`);
    }
  } finally {
    syncing = false;
  }
}
export {
  forgetNtfyServiceSharing,
  ntfyServiceSharing,
  ntfyServiceSharingView,
  ntfyServicesSharedWith,
  setNtfyServiceSharing,
  shareNtfyServiceNow,
  syncNtfyServiceShares
};
