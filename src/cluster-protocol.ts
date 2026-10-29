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

// Every signed request used to delete expired nonces, look its own up and insert it: three
// statements and a commit per request. Expired ones now go once a minute, and one insert both
// checks and records the nonce; an expired row with the same nonce is taken over.
const NONCE_PRUNE_MS = 60_000;
const noncesPrunedAt = new WeakMap<DatabaseSync, number>();
function consumeNonce(db: DatabaseSync, senderNodeId: string, nonce: string, now: number): void {
  ensureClusterProtocolSchema(db);
  const prunedAt = noncesPrunedAt.get(db);
  if (prunedAt === undefined || now - prunedAt >= NONCE_PRUNE_MS || now < prunedAt) {
    db.prepare("DELETE FROM cluster_v2_request_nonces WHERE expires_at < ?").run(now);
    noncesPrunedAt.set(db, now);
  }
  const recorded = db.prepare(`INSERT INTO cluster_v2_request_nonces (sender_node_id, nonce, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(sender_node_id, nonce) DO UPDATE SET expires_at = excluded.expires_at WHERE cluster_v2_request_nonces.expires_at < ?`).run(senderNodeId, nonce, now + NONCE_TTL_MS, now);
  if (!Number(recorded.changes)) throw new ClusterProtocolError("Cluster request replayed");
}

// The last-seen time feeds a 90-second "online" test, and this process learns of each contact
// at once through peerContacted; writing it for every request only added a commit.
const SEEN_WRITE_MS = 5_000;
const seenWrittenAt = new WeakMap<DatabaseSync, Map<string, number>>();

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
  const seen = seenWrittenAt.get(db) ?? new Map<string, number>();
  seenWrittenAt.set(db, seen);
  const written = seen.get(envelope.senderNodeId);
  if (written === undefined || now - written >= SEEN_WRITE_MS || now < written) {
    recordSignedPeerSeen(db,envelope.senderNodeId,new Date(now).toISOString());
    seen.set(envelope.senderNodeId, now);
  }
  // A peer that was away and is now calling in is asked again without waiting out its backoff.
  peerContacted(envelope.senderNodeId, now);
  return envelope.senderNodeId;
}
