import { DatabaseSync } from "node:sqlite";
import { recordSignedPeerSeen } from './cluster-peer-endpoints.js';
import { pinnedClusterPublicKey, signClusterMessage } from "./cluster-identity.js";
import { CLUSTER_REQUEST_DOMAIN, ClusterProtocolError, createRequestEnvelope, encodeAuthorization, NONCE_TTL_MS, requestSignaturePayload, verifyRequest } from "./file-sync/signing.js";
import { peerContacted } from "./peer-presence.js";

// The envelope, header format and checks live in file-sync/signing.ts so the file sync worker signs alike.
export { ClusterProtocolError, type ClusterRequestEnvelope } from "./file-sync/signing.js";

export function ensureClusterProtocolSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_request_nonces (
    sender_node_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (sender_node_id, nonce)
  );
  CREATE INDEX IF NOT EXISTS cluster_v2_request_nonces_expiration ON cluster_v2_request_nonces(expires_at);`);
}

export function signClusterRequest(
  db: DatabaseSync,
  senderNodeId: string,
  recipientNodeId: string,
  method: string,
  target: string,
  rawBody: Buffer,
  now = Date.now(),
): string {
  const envelope = createRequestEnvelope(senderNodeId, recipientNodeId, method, target, rawBody, now);
  const signature = signClusterMessage(db, senderNodeId, CLUSTER_REQUEST_DOMAIN, requestSignaturePayload(envelope));
  return encodeAuthorization(envelope, signature);
}

function consumeNonce(db: DatabaseSync, senderNodeId: string, nonce: string, now: number): void {
  ensureClusterProtocolSchema(db);
  db.exec("SAVEPOINT cluster_v2_nonce");
  try {
    db.prepare("DELETE FROM cluster_v2_request_nonces WHERE expires_at < ?").run(now);
    const exists = db.prepare("SELECT 1 FROM cluster_v2_request_nonces WHERE sender_node_id = ? AND nonce = ?").get(senderNodeId, nonce);
    if (exists) throw new ClusterProtocolError("Cluster request replayed");
    db.prepare("INSERT INTO cluster_v2_request_nonces (sender_node_id, nonce, expires_at) VALUES (?, ?, ?)").run(senderNodeId, nonce, now + NONCE_TTL_MS);
    db.exec("RELEASE cluster_v2_nonce");
  } catch (error) {
    db.exec("ROLLBACK TO cluster_v2_nonce; RELEASE cluster_v2_nonce");
    throw error;
  }
}

export function verifyClusterRequest(
  db: DatabaseSync,
  recipientNodeId: string,
  method: string,
  target: string,
  rawBody: Buffer,
  authorization: string | undefined,
  now = Date.now(),
): string {
  const envelope = verifyRequest(recipientNodeId, method, target, rawBody, authorization, (sender) => pinnedClusterPublicKey(db, sender), now);
  consumeNonce(db, envelope.senderNodeId, envelope.nonce, now);
  recordSignedPeerSeen(db,envelope.senderNodeId,new Date(now).toISOString());
  // A peer that was away and is now calling in is asked again without waiting out its backoff.
  peerContacted(envelope.senderNodeId, now);
  return envelope.senderNodeId;
}
