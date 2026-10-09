import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import {
  acknowledgeManagerTransferDelivery,
  applyMembershipManagerTransfer,
  ensureMembershipSchema,
  listManagerTransferDeliveries,
  managerTransferCertificateSchema
} from "../cluster-membership.js";
import { verifyClusterRequest } from "../cluster-protocol.js";
import { getSharingCluster } from "../cluster-sharing-policy.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { flushV2MembershipOutbox, mapV2Error } from "./cluster-v2.js";
import { clusterRequestRawBody, assertRelayChannelSender } from "./http-auth.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { flushTwinDeliveries } from "./twins.js";
import { flushTwinSharing } from "./twin-sharing.js";
import { flushProjectMetadataDeliveries } from "./project-metadata.js";
import { flushSharingFiles } from "./sharing-files.js";
import { disconnectRevokedRuntimeSockets } from "./runtime-peers.js";
import { flushScopedCredentials } from "./scoped-credentials.js";
import { flushSharedTranscripts } from "./shared-transcripts.js";
import { syncSharedQuickNotes } from "./shared-quick-notes.js";
import { flushTwinCredentials } from "./replication-v2.js";
import { flushResourcePolicyDeliveries } from "./resource-policy.js";
import { peerFetch } from "../relay/transport.js";
const certificatePayloadSchema = z.object({ certificate: managerTransferCertificateSchema }).strict();
function ensureManagerHttpSchema(db) {
  ensureMembershipSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_manager_steps(
    cluster_id TEXT NOT NULL,transfer_id TEXT NOT NULL,step TEXT NOT NULL CHECK(step IN('offer','acceptance')),
    peer_id TEXT NOT NULL,url TEXT NOT NULL,payload TEXT NOT NULL,
    PRIMARY KEY(cluster_id,transfer_id,step,peer_id))`);
}
function queueManagerStep(db, input) {
  ensureManagerHttpSchema(db);
  const offer = input.step === "offer" ? input.payload : input.payload.offer;
  const peerId = input.step === "offer" ? offer.body.toNodeId : offer.body.fromNodeId;
  const peer = offer.body.base.body.members.find((member) => member.nodeId === peerId);
  if (!peer) throw new Error("Manager transfer peer is not in signed base");
  const payload = JSON.stringify(input.payload);
  const result = db.prepare(`INSERT OR IGNORE INTO cluster_v2_manager_steps
    (cluster_id,transfer_id,step,peer_id,url,payload) VALUES(?,?,?,?,?,?)`).run(offer.body.base.body.clusterId, offer.body.transferId, input.step, peerId, peer.url, payload);
  if (result.changes === 0) {
    const row = db.prepare(`SELECT url,payload FROM cluster_v2_manager_steps
      WHERE cluster_id=? AND transfer_id=? AND step=? AND peer_id=?`).get(offer.body.base.body.clusterId, offer.body.transferId, input.step, peerId);
    if (row.url !== peer.url || row.payload !== payload) throw new Error("Conflicting manager transfer step");
  }
}
let flushing = false;
async function flushV2ClusterAdministration() {
  if (flushing) return;
  flushing = true;
  try {
    await disconnectRevokedRuntimeSockets();
    await flushTwinDeliveries();
    await flushTwinSharing();
    const db = await clusterV2Database();
    ensureManagerHttpSchema(db);
    const local = await getClusterNode();
    const steps = db.prepare("SELECT cluster_id,transfer_id,step,peer_id,url,payload FROM cluster_v2_manager_steps ORDER BY cluster_id,transfer_id,step").all();
    for (const step of steps) await deliverStep(db, local.id, step);
    for (const delivery of listManagerTransferDeliveries(db)) await deliverCertificate(db, local.id, delivery);
    await flushV2MembershipOutbox();
    await flushResourcePolicyDeliveries();
    await flushProjectMetadataDeliveries();
    await flushSharingFiles();
    await flushTwinCredentials();
    await flushSharedTranscripts();
    await syncSharedQuickNotes();
    await flushScopedCredentials();
  } finally {
    flushing = false;
  }
}
async function post(db, sender, peer, url, target, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return peerFetch(new URL(target, url), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(1e4),
    body,
    headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, sender, peer, "POST", target, body) }
  }, peer);
}
async function deliverStep(db, sender, step) {
  try {
    const target = `/api/cluster/v2/manager-transfer/${step.step}`;
    const key = step.step === "offer" ? "offer" : "acceptance";
    const response = await post(db, sender, step.peer_id, step.url, target, { [key]: JSON.parse(step.payload) });
    if (!response.ok) throw new ClusterV2HttpError(response.status, "Manager step rejected");
    if (step.step === "acceptance") {
      const result = certificatePayloadSchema.parse(await response.json());
      applyMembershipManagerTransfer(db, sender, result.certificate);
    }
    db.prepare("DELETE FROM cluster_v2_manager_steps WHERE cluster_id=? AND transfer_id=? AND step=? AND peer_id=?").run(step.cluster_id, step.transfer_id, step.step, step.peer_id);
  } catch (error) {
    const status = error instanceof ClusterV2HttpError ? error.statusCode : 500;
    console.warn(`V2 manager ${step.step} delivery to ${step.peer_id} failed (${status})`);
  }
}
async function deliverCertificate(db, sender, delivery) {
  try {
    const target = "/api/cluster/v2/manager-transfer/certificate";
    const response = await post(db, sender, delivery.peerId, delivery.url, target, { certificate: delivery.certificate });
    if (!response.ok) throw new ClusterV2HttpError(response.status, "Manager certificate rejected");
    acknowledgeManagerCertificate(db, delivery);
  } catch (error) {
    const status = error instanceof ClusterV2HttpError ? error.statusCode : 500;
    console.warn(`V2 manager certificate delivery to ${delivery.peerId} failed (${status})`);
  }
}
function acknowledgeManagerCertificate(db, delivery) {
  db.exec("SAVEPOINT manager_certificate_ack");
  try {
    acknowledgeManagerTransferDelivery(db, delivery.clusterId, delivery.peerId, delivery.transferId);
    const revision = delivery.certificate.acceptance.snapshot.body.revision;
    db.prepare("DELETE FROM cluster_v2_membership_deliveries WHERE cluster_id=? AND peer_id=? AND revision<=?").run(delivery.clusterId, delivery.peerId, revision);
    db.exec("RELEASE manager_certificate_ack");
  } catch (error) {
    db.exec("ROLLBACK TO manager_certificate_ack; RELEASE manager_certificate_ack");
    throw error;
  }
}
async function receiveManagerCertificate(request, response, next) {
  try {
    const payload = certificatePayloadSchema.parse(request.body);
    const raw = clusterRequestRawBody(request), local = await getClusterNode(), db = await clusterV2Database();
    ensureManagerHttpSchema(db);
    db.exec("SAVEPOINT manager_certificate_http");
    try {
      const offer = payload.certificate.acceptance.offer;
      try {
        applyMembershipManagerTransfer(db, local.id, payload.certificate);
      } catch (error) {
        const clusterId = offer.body.base.body.clusterId;
        const row = db.prepare(`SELECT certificate FROM cluster_v2_manager_wire
          WHERE cluster_id=? AND transfer_id=?`).get(clusterId, offer.body.transferId);
        const state = getSharingCluster(db, clusterId);
        const superseded = error instanceof Error && /stale/i.test(error.message) && row?.certificate === JSON.stringify(payload.certificate) && state.managerEpoch > offer.body.expectedEpoch + 1;
        if (!superseded) throw error;
      }
      const sender = verifyClusterRequest(db, local.id, request.method, request.originalUrl, raw, request.header("authorization"));
      if (sender !== offer.body.fromNodeId && sender !== offer.body.toNodeId) throw new ClusterV2HttpError(403, "Forbidden");
      assertRelayChannelSender(request, sender);
      db.exec("RELEASE manager_certificate_http");
      response.json({ ok: true });
    } catch (error) {
      db.exec("ROLLBACK TO manager_certificate_http; RELEASE manager_certificate_http");
      throw error;
    }
  } catch (error) {
    mapV2Error(error, response, next);
  }
}
export {
  acknowledgeManagerCertificate,
  ensureManagerHttpSchema,
  flushV2ClusterAdministration,
  queueManagerStep,
  receiveManagerCertificate
};
