import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { peerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { registerLocalSharingResource } from "../cluster-sharing.js";
import { isTrustedTwin, mayReceiveResource, registerOwnedResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { sharingFilesStatus, sharedProjectIds } from "./sharing-files.js";
import { flushSharedTranscripts, sharedTranscriptStatus } from "./shared-transcripts.js";
import { mayReplicateEvent, signedPeerPost } from "./replication-v2.js";
import { pendingEventsForPeer } from "../replication.js";
import { listProjectMetadataDeliveries } from "../cluster-project-metadata.js";
import { resumeSharedProjectFolder } from "../syncthing.js";
import { ensureTwinHttpSchema, pendingTwinDeliveries, bootstrapOwnedTwinPolicies } from "./twins.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
import { peerFetch } from "../relay/transport.js";
const adoptionInventorySchema = z.array(z.object({ id: z.string().min(1).max(300), ownerNodeId: z.string().uuid().nullable() }).strict()).max(1e4);
function sharingTwin(db, local, relationshipId) {
  ensureTwinHttpSchema(db);
  const row = db.prepare("SELECT peer_node_id,status FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId);
  if (!row) throw new ClusterV2HttpError(404, "Unknown twin relationship");
  if (row.status !== "active" || !isTrustedTwin(db, local, row.peer_node_id)) throw new ClusterV2HttpError(403, "Twin relationship is not active");
  return row.peer_node_id;
}
function adoptionInventory(db) {
  return db.prepare(`SELECT p.id,o.owner_node_id ownerNodeId FROM projects p LEFT JOIN sharing_resource_owners o
    ON o.kind='project' AND o.resource_id=p.id ORDER BY p.id`).all();
}
function adoptTwinProjects(db, local, relationshipId, owner, remote) {
  const peer = sharingTwin(db, local, relationshipId);
  if (owner !== local && owner !== peer) throw new ClusterV2HttpError(403, "Owner must be a twin participant");
  const choice = db.prepare("SELECT owner_node_id FROM cluster_v2_twin_sharing WHERE relationship_id=?").get(relationshipId);
  if (choice && choice.owner_node_id !== owner) throw new ClusterV2HttpError(409, "Twin sharing owner was already confirmed; retry with the confirmed owner");
  const inventory = new Map(remote.map((p) => [p.id, p]));
  db.exec("SAVEPOINT twin_adoption");
  try {
    for (const project of adoptionInventory(db)) {
      const mirror = inventory.get(project.id);
      if (project.ownerNodeId && mirror?.ownerNodeId && project.ownerNodeId !== mirror.ownerNodeId) {
        throw new ClusterV2HttpError(409, "Project original ownership conflicts across twins");
      }
      const established = project.ownerNodeId ?? mirror?.ownerNodeId;
      if (established && established !== local && established !== peer) continue;
      const original = established ?? (mirror ? owner : local);
      if (original === local) registerLocalSharingResource(db, local, { kind: "project", id: project.id });
      else registerOwnedResource(db, { kind: "project", id: project.id, ownerNodeId: original }, local);
    }
    db.prepare(`INSERT INTO cluster_v2_twin_sharing VALUES(?,?,NULL) ON CONFLICT(relationship_id)
      DO UPDATE SET owner_node_id=excluded.owner_node_id,error=NULL`).run(relationshipId, owner);
    bootstrapOwnedTwinPolicies(db, local);
    db.exec("RELEASE twin_adoption");
  } catch (error) {
    db.exec("ROLLBACK TO twin_adoption; RELEASE twin_adoption");
    throw error;
  }
}
async function resumeTwinProjectFolders(db, relationshipId) {
  const local = db.prepare("SELECT id FROM cluster_node LIMIT 1").get().id;
  const peer = sharingTwin(db, local, relationshipId);
  const rows = db.prepare(`SELECT p.id,p.sync_folder_id folder FROM projects p JOIN sharing_resource_owners o
    ON o.kind='project' AND o.resource_id=p.id WHERE p.sync_folder_id IS NOT NULL`).all();
  try {
    for (const row of rows) if (mayReceiveResource(db, local, "project", row.id) && mayReceiveResource(db, peer, "project", row.id)) await resumeSharedProjectFolder(row.folder);
  } catch (error) {
    db.prepare("UPDATE cluster_v2_twin_sharing SET error=? WHERE relationship_id=?").run(error instanceof Error ? error.message : "File enrollment failed", relationshipId);
  }
}
async function localTwinSharingStatus(db, local, relationshipId) {
  const peer = sharingTwin(db, local, relationshipId);
  const row = db.prepare("SELECT owner_node_id,error FROM cluster_v2_twin_sharing WHERE relationship_id=?").get(relationshipId);
  const projectCount = sharedProjectIds(db, local, peer).length;
  if (row) {
    let timer;
    await Promise.race([flushSharedTranscripts().catch(() => void 0), new Promise((resolve) => {
      timer = setTimeout(resolve, 1e3);
    })]);
    clearTimeout(timer);
  }
  const files = await sharingFilesStatus(db, local, peer), transcripts = sharedTranscriptStatus(db, local, peer);
  const events = await pendingEventsForPeer(peer, (event) => mayReplicateEvent(db, local, peer, event));
  const controls = db.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE peer_id=?").get(peer);
  let secretError = null;
  let pendingDeliveries = pendingTwinDeliveries(db, relationshipId) + transcripts.pending + events.pending + controls.count + listProjectMetadataDeliveries(db, local).filter((delivery) => delivery.peerId === peer).length;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='secret_credential_deliveries'").get()) {
    const secrets = db.prepare(`SELECT count(*) count,max(d.last_error) error FROM secret_credential_deliveries d JOIN secret_credential_events e ON e.event_id=d.event_id
      WHERE d.peer_id=? AND d.delivered_at IS NULL AND e.origin_node_id=?`).get(peer, local);
    pendingDeliveries += secrets.count;
    secretError = secrets.error;
  }
  const missing = db.prepare(`SELECT count(*) count FROM projects p LEFT JOIN cluster_v2_resource_policy r
    ON r.kind='project' AND r.resource_id=p.id WHERE r.resource_id IS NULL`).get();
  const job = db.prepare("SELECT error FROM cluster_v2_twin_sharing_jobs WHERE relationship_id=?").get(relationshipId);
  if (job) pendingDeliveries++;
  const error = job?.error ?? row?.error ?? files.error ?? transcripts.error ?? events.error ?? secretError;
  return {
    state: error ? "error" : row && files.ready && !pendingDeliveries && !missing.count ? "ready" : "pending",
    initialized: Boolean(row || job),
    ownerNodeId: row?.owner_node_id ?? defaultTwinOwner(db, local, peer, relationshipId),
    projectCount,
    pendingDeliveries,
    ...error ? { error } : {}
  };
}
async function twinSharingStatus(db, local, relationshipId) {
  const status = await localTwinSharingStatus(db, local, relationshipId);
  if (status.state !== "ready") return status;
  const peer = sharingTwin(db, local, relationshipId), endpoint = peerEndpoint(db, "twin", relationshipId, peer);
  try {
    const snapshot = await peerSnapshot(`twin-sharing:${relationshipId}`, peer, async () => z.object({ state: z.enum(["pending", "ready", "error"]), pendingDeliveries: z.number().int().nonnegative(), error: z.string().optional() }).passthrough().parse(await signedPeerPost(endpoint, "/api/cluster/v2/twins/sharing-status", { relationshipId })));
    if (!snapshot.fresh) return { ...status, state: "error", error: staleSnapshotReason(snapshot.fetchedAt) };
    const remote = snapshot.value;
    return { ...status, state: remote.state, pendingDeliveries: status.pendingDeliveries + remote.pendingDeliveries, ...remote.error ? { error: remote.error } : {} };
  } catch (error) {
    return { ...status, state: "error", error: error instanceof Error ? error.message : "Twin peer status unavailable" };
  }
}
function scheduleTwinSharing(db, relationshipId) {
  db.prepare("INSERT OR IGNORE INTO cluster_v2_twin_sharing_jobs VALUES(?,NULL)").run(relationshipId);
}
function defaultTwinOwner(db, local, peer, relationshipId) {
  const confirmed = db.prepare("SELECT owner_node_id FROM cluster_v2_twin_sharing WHERE relationship_id=?").get(relationshipId);
  if (confirmed) return confirmed.owner_node_id;
  const manager = db.prepare(`SELECT c.manager_node_id FROM sharing_clusters c
    JOIN sharing_memberships a ON a.cluster_id=c.id AND a.node_id=?
    JOIN sharing_memberships b ON b.cluster_id=c.id AND b.node_id=?
    WHERE c.closed=0 AND c.manager_node_id IN (?,?) ORDER BY c.id LIMIT 1`).get(local, peer, local, peer);
  if (manager) return manager.manager_node_id;
  const relationship = db.prepare("SELECT body FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId);
  return JSON.parse(relationship.body).inviter.nodeId;
}
const coordinators = /* @__PURE__ */ new Map();
async function completeTwinSharing(relationshipId, owner) {
  const db = await clusterV2Database(), local = await getClusterNode(), peer = sharingTwin(db, local.id, relationshipId);
  if (owner !== void 0 && owner !== local.id && owner !== peer) throw new ClusterV2HttpError(403, "Owner must be a twin participant");
  if (local.id > peer) {
    await signedPeerPost(peerEndpoint(db, "twin", relationshipId, peer), "/api/cluster/v2/twins/sharing-coordinate", { relationshipId, ...owner ? { ownerNodeId: owner } : {} });
    db.prepare("DELETE FROM cluster_v2_twin_sharing_jobs WHERE relationship_id=?").run(relationshipId);
    return twinSharingStatus(db, local.id, relationshipId);
  }
  const previous = coordinators.get(relationshipId) ?? Promise.resolve();
  const action = () => coordinateTwinSharing(db, local.id, peer, relationshipId, owner ?? defaultTwinOwner(db, local.id, peer, relationshipId));
  const result = previous.then(action, action);
  coordinators.set(relationshipId, result);
  try {
    return await result;
  } finally {
    if (coordinators.get(relationshipId) === result) coordinators.delete(relationshipId);
  }
}
async function coordinateTwinSharing(db, local, peer, relationshipId, owner) {
  const endpoint = peerEndpoint(db, "twin", relationshipId, peer);
  const remote = await signedPeerPost(endpoint, "/api/cluster/v2/twins/sharing-inventory", { relationshipId });
  adoptTwinProjects(db, local, relationshipId, owner, adoptionInventorySchema.parse(remote.projects));
  scheduleTwinSharing(db, relationshipId);
  const target = "/api/cluster/v2/twins/sharing", body = Buffer.from(JSON.stringify({ relationshipId, ownerNodeId: owner, projects: adoptionInventory(db) }));
  let response;
  try {
    response = await peerFetch(new URL(target, endpoint.url), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1e4),
      body,
      headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local, peer, "POST", target, body) }
    }, peer);
  } catch {
    throw new ClusterV2HttpError(503, "Twin peer is unavailable");
  }
  if (!response.ok) throw new ClusterV2HttpError(response.status, "Twin sharing request rejected");
  const inventory = adoptionInventorySchema.parse((await response.json()).projects);
  adoptTwinProjects(db, local, relationshipId, owner, inventory);
  await resumeTwinProjectFolders(db, relationshipId);
  db.prepare("DELETE FROM cluster_v2_twin_sharing_jobs WHERE relationship_id=?").run(relationshipId);
  return twinSharingStatus(db, local, relationshipId);
}
async function flushTwinSharing(relationshipId) {
  const db = await clusterV2Database();
  ensureTwinHttpSchema(db);
  const jobs = db.prepare("SELECT relationship_id FROM cluster_v2_twin_sharing_jobs").all();
  for (const job of jobs) {
    if (relationshipId && job.relationship_id !== relationshipId) continue;
    try {
      await completeTwinSharing(job.relationship_id);
    } catch (error) {
      db.prepare("UPDATE cluster_v2_twin_sharing_jobs SET error=? WHERE relationship_id=?").run(error instanceof Error ? error.message : "Twin adoption failed", job.relationship_id);
    }
  }
}
export {
  adoptTwinProjects,
  adoptionInventory,
  adoptionInventorySchema,
  completeTwinSharing,
  flushTwinSharing,
  localTwinSharingStatus,
  resumeTwinProjectFolders,
  scheduleTwinSharing,
  sharingTwin,
  twinSharingStatus
};
