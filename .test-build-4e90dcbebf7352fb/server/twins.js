import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { clusterPublicKeyFingerprint, pinClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { peerEndpoint, recordPeerEndpoint } from "../cluster-peer-endpoints.js";
import { signClusterRequest, verifyClusterRequest } from "../cluster-protocol.js";
import { ensureResourceSharingSchema, queueResourcePolicyBootstrap } from "../cluster-sharing.js";
import { applyTwinCertificate, applyTwinRevocation, confirmTwinAcceptance, createTwinInvitation, prepareTwinAcceptance, revokeTwinRelationship, twinAcceptanceSchema, twinCertificateSchema, twinInvitationSchema } from "../cluster-twins.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { localMembershipDescriptor } from "./cluster-v2.js";
import { clusterRequestRawBody, isClusterOriginUrl, assertRelayChannelSender } from "./http-auth.js";
import { flushTwinSharing, scheduleTwinSharing } from "./twin-sharing.js";
import { peerFetch } from "../relay/transport.js";
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const endpointSchema = z.object({ nodeId: uuid, name: z.string().trim().min(1).max(80), url: z.string().transform((value, context) => {
  try {
    const parsed = new URL(value);
    if (!isClusterOriginUrl(value)) throw new Error();
    return parsed.origin;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid endpoint" });
    return z.NEVER;
  }
}) }).strict();
const linkWrapperSchema = z.object({ invitation: twinInvitationSchema, endpoint: endpointSchema, endpointSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
const confirmSchema = z.object({ acceptance: twinAcceptanceSchema, acceptor: endpointSchema, secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
function ensureTwinHttpSchema(db) {
  ensureResourceSharingSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_twin_endpoint_invitations(
    relationship_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL,signature TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cluster_v2_twin_deliveries(
    relationship_id TEXT NOT NULL,peer_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('certificate','revocation')),
    payload TEXT NOT NULL,PRIMARY KEY(relationship_id,peer_id,kind));
  CREATE TABLE IF NOT EXISTS cluster_v2_twin_sharing(relationship_id TEXT PRIMARY KEY,owner_node_id TEXT NOT NULL,error TEXT);
  CREATE TABLE IF NOT EXISTS cluster_v2_twin_sharing_jobs(relationship_id TEXT PRIMARY KEY,error TEXT)`);
}
function savepoint(db, name, action) {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw error;
  }
}
function endpointPayload(relationshipId, endpoint, publicKey) {
  return JSON.stringify([2, relationshipId, endpoint.nodeId, publicKey, endpoint.name, endpoint.url]);
}
function bootstrapOwnedTwinPolicies(db, localNodeId) {
  ensureResourceSharingSchema(db);
  const rows = db.prepare(`SELECT kind,resource_id FROM cluster_v2_resource_policy
    WHERE owner_node_id=? AND deleted=0`).all(localNodeId);
  for (const row of rows) queueResourcePolicyBootstrap(db, localNodeId, row.kind, row.resource_id);
}
function queueDelivery(db, relationshipId, peerId, kind, payload) {
  db.prepare(`INSERT INTO cluster_v2_twin_deliveries VALUES(?,?,?,?) ON CONFLICT(relationship_id,peer_id,kind)
    DO UPDATE SET payload=excluded.payload`).run(relationshipId, peerId, kind, JSON.stringify(payload));
}
function parseTwinLink(link) {
  if (typeof link !== "string" || link.length > 32768) throw new ClusterV2HttpError(400, "Invalid twin request");
  let url;
  try {
    url = new URL(link);
  } catch {
    throw new ClusterV2HttpError(400, "Invalid twin request");
  }
  const parts = url.hash.slice(1).split(".");
  if (!isClusterOriginUrl(url.origin) || url.pathname !== "/join" || url.search || url.username || url.password || parts.length !== 2 || parts[0] !== "twin-v2" || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new ClusterV2HttpError(400, "Invalid twin request");
  const bytes = Buffer.from(parts[1], "base64url");
  if (bytes.toString("base64url") !== parts[1]) throw new ClusterV2HttpError(400, "Invalid twin request");
  let wrapper;
  try {
    wrapper = linkWrapperSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw new ClusterV2HttpError(400, "Invalid twin request");
    throw error;
  }
  const inviter = wrapper.invitation.body.inviter;
  if (wrapper.endpoint.nodeId !== inviter.nodeId || clusterPublicKeyFingerprint(inviter.publicKey) !== inviter.fingerprint || wrapper.endpoint.url !== url.origin || !verifyClusterMessage(inviter.publicKey, "twin-endpoint", endpointPayload(wrapper.invitation.body.relationshipId, wrapper.endpoint, inviter.publicKey), wrapper.endpointSignature)) throw new ClusterV2HttpError(401, "Unauthorized");
  return wrapper;
}
async function createTwinHttpInvitation() {
  const endpoint = await localMembershipDescriptor(), db = await clusterV2Database();
  ensureTwinHttpSchema(db);
  return savepoint(db, "twin_http_invite", () => {
    const invitation = createTwinInvitation(db, endpoint.nodeId);
    const endpointSignature = signClusterMessage(db, endpoint.nodeId, "twin-endpoint", endpointPayload(invitation.body.relationshipId, endpoint, invitation.body.inviter.publicKey));
    db.prepare("INSERT INTO cluster_v2_twin_endpoint_invitations VALUES(?,?,?)").run(invitation.body.relationshipId, JSON.stringify(endpoint), endpointSignature);
    const wrapper = { invitation, endpoint, endpointSignature };
    return { link: `${endpoint.url}/join#twin-v2.${Buffer.from(JSON.stringify(wrapper)).toString("base64url")}`, relationshipId: invitation.body.relationshipId };
  });
}
async function acceptTwinHttpLink(link) {
  const wrapper = parseTwinLink(link);
  const local = await localMembershipDescriptor(), db = await clusterV2Database();
  ensureTwinHttpSchema(db);
  const acceptance = savepoint(db, "twin_http_accept", () => {
    const result = prepareTwinAcceptance(db, local.nodeId, wrapper.invitation, wrapper.invitation.body.inviter.fingerprint);
    recordPeerEndpoint(db, { kind: "twin", id: result.body.relationshipId }, wrapper.endpoint);
    recordPeerEndpoint(db, { kind: "twin", id: result.body.relationshipId }, local);
    return result;
  });
  const target = "/api/cluster/v2/twins/confirm", body = Buffer.from(JSON.stringify({ acceptance, acceptor: local, secret: wrapper.invitation.secret }));
  let response;
  try {
    response = await peerFetch(new URL(target, wrapper.endpoint.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(1e4), body, headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.nodeId, wrapper.endpoint.nodeId, "POST", target, body) } }, wrapper.endpoint.nodeId);
  } catch {
    throw new ClusterV2HttpError(503, "Twin peer is unavailable");
  }
  if (!response.ok) throw new ClusterV2HttpError(response.status >= 400 && response.status < 500 ? response.status : 503, `Twin peer request failed (${response.status})`);
  let certificate;
  try {
    certificate = twinCertificateSchema.parse((await response.json()).certificate);
  } catch {
    throw new ClusterV2HttpError(503, "Twin peer returned an invalid response");
  }
  if (JSON.stringify(certificate.body) !== JSON.stringify(acceptance.body) || certificate.acceptorSignature !== acceptance.acceptorSignature) {
    throw new ClusterV2HttpError(503, "Twin peer returned an unrelated certificate");
  }
  savepoint(db, "twin_http_activate", () => {
    applyTwinCertificate(db, local.nodeId, certificate);
    bootstrapOwnedTwinPolicies(db, local.nodeId);
    scheduleTwinSharing(db, certificate.body.relationshipId);
  });
  await flushTwinSharing(certificate.body.relationshipId);
  return { relationshipId: acceptance.body.relationshipId, status: "active" };
}
async function confirmTwinHttp(request, response, next) {
  try {
    const payload = confirmSchema.parse(request.body), raw = clusterRequestRawBody(request);
    const local = await getClusterNode(), db = await clusterV2Database();
    ensureTwinHttpSchema(db);
    const certificate = savepoint(db, "twin_http_confirm", () => {
      pinClusterPublicKey(db, payload.acceptance.body.acceptor.nodeId, payload.acceptance.body.acceptor.publicKey);
      const sender = verifyClusterRequest(db, local.id, request.method, request.originalUrl, raw, request.header("authorization"));
      if (sender !== payload.acceptance.body.acceptor.nodeId || sender !== payload.acceptor.nodeId) throw new ClusterV2HttpError(401, "Unauthorized");
      assertRelayChannelSender(request, sender);
      const proof = db.prepare("SELECT endpoint FROM cluster_v2_twin_endpoint_invitations WHERE relationship_id=?").get(payload.acceptance.body.relationshipId);
      if (!proof) throw new ClusterV2HttpError(404, "Unknown twin relationship");
      const result = confirmTwinAcceptance(db, local.id, payload.acceptance, payload.secret);
      recordPeerEndpoint(db, { kind: "twin", id: result.body.relationshipId }, endpointSchema.parse(JSON.parse(proof.endpoint)));
      recordPeerEndpoint(db, { kind: "twin", id: result.body.relationshipId }, payload.acceptor);
      queueDelivery(db, result.body.relationshipId, payload.acceptor.nodeId, "certificate", result);
      bootstrapOwnedTwinPolicies(db, local.id);
      scheduleTwinSharing(db, result.body.relationshipId);
      return result;
    });
    response.status(201).json({ certificate });
  } catch (error) {
    mapTwinError(error, response, next);
  }
}
function revokeTwinHttp(db, localNodeId, relationshipId) {
  ensureTwinHttpSchema(db);
  return savepoint(db, "twin_http_revoke", () => {
    const revocation = revokeTwinRelationship(db, localNodeId, relationshipId);
    const row = db.prepare("SELECT peer_node_id FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(relationshipId);
    cleanupRevokedTwin(db, relationshipId);
    queueDelivery(db, relationshipId, row.peer_node_id, "revocation", revocation);
    return { revocation, pending: true };
  });
}
function applyRemoteTwinRevocation(db, localNodeId, revocation) {
  savepoint(db, "twin_http_remote_revoke", () => {
    applyTwinRevocation(db, localNodeId, revocation);
    cleanupRevokedTwin(db, revocation.relationshipId);
  });
}
function cleanupRevokedTwin(db, relationshipId) {
  db.prepare("DELETE FROM cluster_v2_twin_sharing_jobs WHERE relationship_id=?").run(relationshipId);
  db.prepare("UPDATE cluster_v2_resource_contexts SET active=0,effective_shares='[]' WHERE context_kind='twin' AND context_id=?").run(relationshipId);
  db.prepare("DELETE FROM cluster_v2_resource_deliveries WHERE context_kind='twin' AND context_id=? AND json_extract(statement,'$.body.operation')='upsert'").run(relationshipId);
  db.prepare("DELETE FROM cluster_v2_twin_deliveries WHERE relationship_id=? AND kind='certificate'").run(relationshipId);
}
function pendingTwinDeliveries(db, relationshipId) {
  const control = db.prepare("SELECT count(*) count FROM cluster_v2_twin_deliveries WHERE relationship_id=?").get(relationshipId);
  const resource = db.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE context_kind='twin' AND context_id=?").get(relationshipId);
  return control.count + resource.count;
}
async function flushTwinDeliveries() {
  const db = await clusterV2Database(), local = await getClusterNode();
  ensureTwinHttpSchema(db);
  const rows = db.prepare("SELECT relationship_id,peer_id,kind,payload FROM cluster_v2_twin_deliveries ORDER BY relationship_id,peer_id,kind").all();
  for (const row of rows) try {
    const endpoint = peerEndpoint(db, "twin", row.relationship_id, row.peer_id), target = `/api/cluster/v2/twins/${row.kind}`;
    const body = Buffer.from(JSON.stringify({ [row.kind]: JSON.parse(row.payload) }));
    const result = await peerFetch(new URL(target, endpoint.url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(1e4), body, headers: { "Content-Type": "application/json", Authorization: signClusterRequest(db, local.id, row.peer_id, "POST", target, body) } }, endpoint.nodeId);
    if (!result.ok) throw new ClusterV2HttpError(result.status, "Twin delivery rejected");
    db.prepare("DELETE FROM cluster_v2_twin_deliveries WHERE relationship_id=? AND peer_id=? AND kind=?").run(row.relationship_id, row.peer_id, row.kind);
  } catch (error) {
    const status = error instanceof ClusterV2HttpError ? error.statusCode : 500;
    console.warn(`Twin ${row.kind} delivery to ${row.peer_id} failed (${status})`);
  }
}
function mapTwinError(error, response, next) {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: "Invalid twin request" });
    return;
  }
  if (error instanceof ClusterV2HttpError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  if (error instanceof Error) {
    if (/expired|already been used/i.test(error.message)) {
      response.status(410).json({ error: error.message });
      return;
    }
    if (/invalid|fingerprint|signature|secret|public key conflict/i.test(error.message)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (/not a twin participant|signer is not a participant/i.test(error.message)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    if (/Unknown twin relationship/i.test(error.message)) {
      response.status(404).json({ error: error.message });
      return;
    }
    if (/conflict|revoked/i.test(error.message)) {
      response.status(409).json({ error: error.message });
      return;
    }
  }
  next(error);
}
export {
  acceptTwinHttpLink,
  applyRemoteTwinRevocation,
  bootstrapOwnedTwinPolicies,
  confirmTwinHttp,
  createTwinHttpInvitation,
  ensureTwinHttpSchema,
  flushTwinDeliveries,
  mapTwinError,
  parseTwinLink,
  pendingTwinDeliveries,
  revokeTwinHttp
};
