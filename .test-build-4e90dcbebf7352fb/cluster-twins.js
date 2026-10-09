import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  clusterPublicKeyFingerprint,
  ensureClusterIdentitySchema,
  getOrCreateClusterIdentity,
  pinClusterPublicKey,
  pinnedClusterPublicKey,
  signClusterMessage,
  verifyClusterMessage
} from "./cluster-identity.js";
import { ensureClusterSharingPolicySchema, setTrustedTwin } from "./cluster-sharing-policy.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const identitySchema = z.object({ nodeId: z.string().regex(UUID), publicKey: z.string().max(1024).refine((v) => !/PRIVATE KEY/.test(v)), fingerprint: z.string().regex(HASH) }).strict();
const invitationBodySchema = z.object({ version: z.literal(2), relationshipId: z.string().regex(UUID), inviter: identitySchema, expiresAt: z.number().int().safe(), secretHash: z.string().regex(HASH) }).strict();
const invitationSchema = z.object({ body: invitationBodySchema, signature: z.string().regex(SIGNATURE), secret: z.string().regex(SECRET) }).strict();
const relationshipBodySchema = z.object({ version: z.literal(2), relationshipId: z.string().regex(UUID), inviter: identitySchema, acceptor: identitySchema, invitationExpiresAt: z.number().int().safe() }).strict();
const acceptanceSchema = z.object({ body: relationshipBodySchema, acceptorSignature: z.string().regex(SIGNATURE) }).strict();
const certificateSchema = acceptanceSchema.extend({ inviterSignature: z.string().regex(SIGNATURE) }).strict();
const revocationSchema = z.object({ relationshipId: z.string().regex(UUID), signerNodeId: z.string().regex(UUID), signature: z.string().regex(SIGNATURE) }).strict();
function ensureTwinSchema(db) {
  ensureClusterIdentitySchema(db);
  ensureClusterSharingPolicySchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_twin_invitations(
    relationship_id TEXT PRIMARY KEY, inviter_node_id TEXT NOT NULL, body TEXT NOT NULL, signature TEXT NOT NULL,
    secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_acceptance TEXT NULL);
  CREATE TABLE IF NOT EXISTS cluster_v2_twin_relationships(
    relationship_id TEXT PRIMARY KEY, local_node_id TEXT NOT NULL, peer_node_id TEXT NOT NULL, body TEXT NOT NULL,
    acceptor_signature TEXT NOT NULL, inviter_signature TEXT NULL, status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')), revocation TEXT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS cluster_v2_twin_live_pair ON cluster_v2_twin_relationships(local_node_id,peer_node_id) WHERE status IN ('pending','active');`);
}
function parse(schema, value, message) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}
function assertNow(now) {
  if (!Number.isSafeInteger(now)) throw new Error("Twin timestamp is invalid");
}
function validateIdentity(identity) {
  let fingerprint;
  try {
    fingerprint = clusterPublicKeyFingerprint(identity.publicKey);
  } catch {
    throw new Error("Twin public identity is invalid");
  }
  if (fingerprint !== identity.fingerprint) throw new Error("Twin fingerprint does not match public key");
}
function invitationPayload(body) {
  return JSON.stringify([2, body.relationshipId, body.inviter.nodeId, body.inviter.publicKey, body.inviter.fingerprint, body.expiresAt, body.secretHash]);
}
function relationshipPayload(body) {
  return JSON.stringify([2, body.relationshipId, body.inviter.nodeId, body.inviter.publicKey, body.inviter.fingerprint, body.acceptor.nodeId, body.acceptor.publicKey, body.acceptor.fingerprint, body.invitationExpiresAt]);
}
function revocationPayload(value) {
  return JSON.stringify([value.relationshipId, value.signerNodeId]);
}
function transaction(db, action) {
  db.exec("SAVEPOINT cluster_v2_twin_write");
  try {
    const result = action();
    db.exec("RELEASE cluster_v2_twin_write");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO cluster_v2_twin_write; RELEASE cluster_v2_twin_write");
    throw error;
  }
}
function relationship(db, id) {
  return db.prepare("SELECT * FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(id);
}
function sameIdentity(left, right) {
  return left.nodeId === right.nodeId && left.publicKey === right.publicKey && left.fingerprint === right.fingerprint;
}
function localIdentity(db, nodeId, expected) {
  const local = getOrCreateClusterIdentity(db, nodeId);
  if (!sameIdentity(local, expected)) throw new Error("Local twin identity conflict");
  return local;
}
function createTwinInvitation(db, localNodeId, now = Date.now()) {
  assertNow(now);
  ensureTwinSchema(db);
  const inviter = getOrCreateClusterIdentity(db, localNodeId);
  const relationshipId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const body = { version: 2, relationshipId, inviter, expiresAt: now + 9e5, secretHash };
  if (!Number.isSafeInteger(body.expiresAt)) throw new Error("Twin timestamp is invalid");
  const signature = signClusterMessage(db, localNodeId, "twin-invitation", invitationPayload(body));
  db.prepare("INSERT INTO cluster_v2_twin_invitations VALUES (?,?,?,?,?,?,NULL)").run(relationshipId, localNodeId, JSON.stringify(body), signature, secretHash, body.expiresAt);
  return { body, signature, secret };
}
function verifiedInvitation(value, expectedFingerprint) {
  const invitation = parse(invitationSchema, value, "Twin invitation is invalid");
  validateIdentity(invitation.body.inviter);
  if (expectedFingerprint !== invitation.body.inviter.fingerprint) throw new Error("Twin fingerprint does not match expected fingerprint");
  if (!verifyClusterMessage(invitation.body.inviter.publicKey, "twin-invitation", invitationPayload(invitation.body), invitation.signature)) throw new Error("Twin invitation signature is invalid");
  const hash = createHash("sha256").update(invitation.secret).digest("hex");
  if (hash !== invitation.body.secretHash) throw new Error("Twin invitation secret is invalid");
  return invitation;
}
function prepareTwinAcceptance(db, localNodeId, value, expectedFingerprint, now = Date.now()) {
  assertNow(now);
  ensureTwinSchema(db);
  const invitation = verifiedInvitation(value, expectedFingerprint);
  const acceptor = getOrCreateClusterIdentity(db, localNodeId);
  if (acceptor.nodeId === invitation.body.inviter.nodeId) throw new Error("Twin participants must be distinct");
  const body = { version: 2, relationshipId: invitation.body.relationshipId, inviter: invitation.body.inviter, acceptor, invitationExpiresAt: invitation.body.expiresAt };
  const existing = relationship(db, body.relationshipId);
  if (existing) return existingAcceptance(existing, body, localNodeId);
  if (now > invitation.body.expiresAt) throw new Error("Twin invitation has expired");
  const acceptorSignature = signClusterMessage(db, localNodeId, "twin-relationship", relationshipPayload(body));
  return transaction(db, () => {
    pinClusterPublicKey(db, body.inviter.nodeId, body.inviter.publicKey);
    db.prepare("INSERT INTO cluster_v2_twin_relationships VALUES (?,?,?,?,?,NULL,'pending',NULL)").run(body.relationshipId, localNodeId, body.inviter.nodeId, JSON.stringify(body), acceptorSignature);
    return { body, acceptorSignature };
  });
}
function existingAcceptance(row, body, localNodeId) {
  if (row.status === "revoked") throw new Error("Twin relationship is revoked");
  if (row.local_node_id !== localNodeId || row.body !== JSON.stringify(body)) throw new Error("Twin relationship conflict");
  return { body: JSON.parse(row.body), acceptorSignature: row.acceptor_signature };
}
function verifiedAcceptance(value) {
  const acceptance = parse(acceptanceSchema, value, "Twin acceptance is invalid");
  validateIdentity(acceptance.body.inviter);
  validateIdentity(acceptance.body.acceptor);
  if (acceptance.body.inviter.nodeId === acceptance.body.acceptor.nodeId) throw new Error("Twin participants must be distinct");
  if (!verifyClusterMessage(acceptance.body.acceptor.publicKey, "twin-relationship", relationshipPayload(acceptance.body), acceptance.acceptorSignature)) throw new Error("Twin acceptance signature is invalid");
  return acceptance;
}
function invitationRow(db, id) {
  const row = db.prepare("SELECT inviter_node_id,body,signature,secret_hash,expires_at,consumed_acceptance FROM cluster_v2_twin_invitations WHERE relationship_id=?").get(id);
  if (!row) throw new Error("Unknown twin relationship");
  return row;
}
function hashesMatch(left, right) {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}
function confirmTwinAcceptance(db, localNodeId, value, secret, now = Date.now()) {
  assertNow(now);
  if (!SECRET.test(secret)) throw new Error("Twin invitation secret is invalid");
  ensureTwinSchema(db);
  const acceptance = verifiedAcceptance(value);
  if (localNodeId !== acceptance.body.inviter.nodeId) throw new Error("Local node is not the twin inviter");
  localIdentity(db, localNodeId, acceptance.body.inviter);
  const stored = invitationRow(db, acceptance.body.relationshipId);
  const storedBody = parse(invitationBodySchema, JSON.parse(stored.body), "Stored twin invitation is invalid");
  if (storedBody.relationshipId !== acceptance.body.relationshipId || stored.inviter_node_id !== localNodeId || !sameIdentity(storedBody.inviter, acceptance.body.inviter) || storedBody.expiresAt !== stored.expires_at || storedBody.expiresAt !== acceptance.body.invitationExpiresAt || storedBody.secretHash !== stored.secret_hash) throw new Error("Twin acceptance conflicts with invitation");
  if (!verifyClusterMessage(storedBody.inviter.publicKey, "twin-invitation", invitationPayload(storedBody), stored.signature)) throw new Error("Twin invitation signature is invalid");
  const suppliedHash = createHash("sha256").update(secret).digest("hex");
  if (!hashesMatch(stored.secret_hash, suppliedHash)) throw new Error("Twin invitation secret is invalid");
  const serialized = JSON.stringify(acceptance);
  if (stored.consumed_acceptance) return confirmedRetry(db, acceptance, stored.consumed_acceptance, serialized);
  if (now > stored.expires_at) throw new Error("Twin invitation has expired");
  return transaction(db, () => confirmFresh(db, localNodeId, acceptance, serialized));
}
function confirmedRetry(db, acceptance, consumed, serialized) {
  if (consumed !== serialized) throw new Error("Twin invitation has already been used");
  const row = relationship(db, acceptance.body.relationshipId);
  if (!row) throw new Error("Unknown twin relationship");
  if (row.status === "revoked") throw new Error("Twin relationship is revoked");
  if (row.body !== JSON.stringify(acceptance.body) || row.acceptor_signature !== acceptance.acceptorSignature || !row.inviter_signature) throw new Error("Twin relationship conflict");
  return { ...acceptance, inviterSignature: row.inviter_signature };
}
function confirmFresh(db, localNodeId, acceptance, serialized) {
  const existing = relationship(db, acceptance.body.relationshipId);
  if (existing?.status === "revoked") throw new Error("Twin relationship is revoked");
  if (existing) throw new Error("Twin relationship conflict");
  pinClusterPublicKey(db, acceptance.body.acceptor.nodeId, acceptance.body.acceptor.publicKey);
  const inviterSignature = signClusterMessage(db, localNodeId, "twin-relationship", relationshipPayload(acceptance.body));
  db.prepare("INSERT INTO cluster_v2_twin_relationships VALUES (?,?,?,?,?,?,'active',NULL)").run(acceptance.body.relationshipId, localNodeId, acceptance.body.acceptor.nodeId, JSON.stringify(acceptance.body), acceptance.acceptorSignature, inviterSignature);
  db.prepare("UPDATE cluster_v2_twin_invitations SET consumed_acceptance=? WHERE relationship_id=?").run(serialized, acceptance.body.relationshipId);
  setTrustedTwin(db, acceptance.body.inviter.nodeId, acceptance.body.acceptor.nodeId, true);
  return { ...acceptance, inviterSignature };
}
function verifiedCertificate(value) {
  const certificate = parse(certificateSchema, value, "Twin certificate is invalid");
  verifiedAcceptance({ body: certificate.body, acceptorSignature: certificate.acceptorSignature });
  if (!verifyClusterMessage(certificate.body.inviter.publicKey, "twin-relationship", relationshipPayload(certificate.body), certificate.inviterSignature)) throw new Error("Twin certificate signature is invalid");
  return certificate;
}
function verifyTwinCertificate(value) {
  return verifiedCertificate(value);
}
function storedTwinCertificate(db, relationshipId) {
  ensureTwinSchema(db);
  const row = relationship(db, relationshipId);
  if (!row || !row.inviter_signature) throw new Error("Unknown twin relationship");
  return verifiedCertificate({ body: JSON.parse(row.body), acceptorSignature: row.acceptor_signature, inviterSignature: row.inviter_signature });
}
function applyTwinCertificate(db, localNodeId, value) {
  ensureTwinSchema(db);
  const certificate = verifiedCertificate(value);
  const body = certificate.body;
  if (localNodeId !== body.inviter.nodeId && localNodeId !== body.acceptor.nodeId) throw new Error("Local node is not a twin participant");
  localIdentity(db, localNodeId, localNodeId === body.inviter.nodeId ? body.inviter : body.acceptor);
  transaction(db, () => applyVerifiedCertificate(db, localNodeId, certificate));
}
function applyVerifiedCertificate(db, localNodeId, certificate) {
  const body = certificate.body;
  const row = relationship(db, body.relationshipId);
  if (!row) throw new Error("Unknown twin relationship");
  if (row.status === "revoked") throw new Error("Twin relationship is revoked");
  if (row.body !== JSON.stringify(body) || row.acceptor_signature !== certificate.acceptorSignature) throw new Error("Twin relationship conflict");
  if (localNodeId === body.inviter.nodeId && (row.status !== "active" || row.inviter_signature !== certificate.inviterSignature)) throw new Error("Twin relationship conflict");
  if (row.status === "active" && row.inviter_signature === certificate.inviterSignature) return;
  const peer = localNodeId === body.inviter.nodeId ? body.acceptor : body.inviter;
  pinClusterPublicKey(db, peer.nodeId, peer.publicKey);
  db.prepare("UPDATE cluster_v2_twin_relationships SET inviter_signature=?,status='active' WHERE relationship_id=?").run(certificate.inviterSignature, body.relationshipId);
  setTrustedTwin(db, body.inviter.nodeId, body.acceptor.nodeId, true);
}
function participantKey(body, nodeId) {
  if (body.inviter.nodeId === nodeId) return body.inviter.publicKey;
  if (body.acceptor.nodeId === nodeId) return body.acceptor.publicKey;
  return void 0;
}
function applyVerifiedRevocation(db, localNodeId, revocation) {
  const row = relationship(db, revocation.relationshipId);
  if (!row) throw new Error("Unknown twin relationship");
  const body = parse(relationshipBodySchema, JSON.parse(row.body), "Stored twin relationship is invalid");
  if (localNodeId !== body.inviter.nodeId && localNodeId !== body.acceptor.nodeId) throw new Error("Local node is not a twin participant");
  const key = participantKey(body, revocation.signerNodeId);
  if (!key) throw new Error("Twin revocation signer is not a participant");
  const peerPin = revocation.signerNodeId === localNodeId ? key : pinnedClusterPublicKey(db, revocation.signerNodeId);
  if (peerPin !== key) throw new Error("Twin public key conflict");
  if (!verifyClusterMessage(key, "twin-revocation", revocationPayload(revocation), revocation.signature)) throw new Error("Twin revocation signature is invalid");
  transaction(db, () => revokeStored(db, row, revocation));
}
function revokeStored(db, row, revocation) {
  if (row.status !== "revoked") db.prepare("UPDATE cluster_v2_twin_relationships SET status='revoked',revocation=? WHERE relationship_id=?").run(JSON.stringify(revocation), row.relationship_id);
  const otherActive = db.prepare("SELECT 1 FROM cluster_v2_twin_relationships WHERE local_node_id=? AND peer_node_id=? AND status='active'").get(row.local_node_id, row.peer_node_id);
  if (!otherActive) setTrustedTwin(db, row.local_node_id, row.peer_node_id, false);
}
function revokeTwinRelationship(db, localNodeId, relationshipId) {
  ensureTwinSchema(db);
  if (!UUID.test(relationshipId) || !UUID.test(localNodeId)) throw new Error("Twin relationship identifier is invalid");
  const row = relationship(db, relationshipId);
  if (!row) throw new Error("Unknown twin relationship");
  const body = parse(relationshipBodySchema, JSON.parse(row.body), "Stored twin relationship is invalid");
  if (!participantKey(body, localNodeId) || row.local_node_id !== localNodeId) throw new Error("Local node is not a twin participant");
  if (row.status === "revoked" && row.revocation) {
    const stored = parse(revocationSchema, JSON.parse(row.revocation), "Stored twin revocation is invalid");
    if (stored.signerNodeId === localNodeId) return stored;
  }
  const unsigned = { relationshipId, signerNodeId: localNodeId };
  const signature = signClusterMessage(db, localNodeId, "twin-revocation", revocationPayload(unsigned));
  const revocation = { ...unsigned, signature };
  applyVerifiedRevocation(db, localNodeId, revocation);
  return revocation;
}
function applyTwinRevocation(db, localNodeId, value) {
  ensureTwinSchema(db);
  const revocation = parse(revocationSchema, value, "Twin revocation is invalid");
  applyVerifiedRevocation(db, localNodeId, revocation);
}
function listTwinRelationships(db, localNodeId) {
  ensureTwinSchema(db);
  if (!UUID.test(localNodeId)) throw new Error("Twin node ID is invalid");
  const rows = db.prepare("SELECT * FROM cluster_v2_twin_relationships WHERE local_node_id=? ORDER BY relationship_id").all(localNodeId);
  return rows.map((row) => {
    const body = parse(relationshipBodySchema, JSON.parse(row.body), "Stored twin relationship is invalid");
    const peer = body.inviter.nodeId === localNodeId ? body.acceptor : body.inviter;
    return { relationshipId: row.relationship_id, peer, status: row.status };
  });
}
export {
  applyTwinCertificate,
  applyTwinRevocation,
  confirmTwinAcceptance,
  createTwinInvitation,
  ensureTwinSchema,
  listTwinRelationships,
  prepareTwinAcceptance,
  revokeTwinRelationship,
  storedTwinCertificate,
  acceptanceSchema as twinAcceptanceSchema,
  certificateSchema as twinCertificateSchema,
  invitationSchema as twinInvitationSchema,
  revocationSchema as twinRevocationSchema,
  verifyTwinCertificate
};
