import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { pinnedClusterPublicKey, signClusterMessage, verifyClusterMessage } from "./cluster-identity.js";

export class ClusterProtocolError extends Error { readonly statusCode = 401; }

export interface ClusterRequestEnvelope {
  version: 2;
  senderNodeId: string;
  recipientNodeId: string;
  method: string;
  target: string;
  bodyHash: string;
  timestamp: number;
  nonce: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const envelopeSchema = z.object({
  version: z.literal(2),
  senderNodeId: z.string().regex(UUID_PATTERN),
  recipientNodeId: z.string().regex(UUID_PATTERN),
  method: z.string().refine((value) => METHODS.has(value)),
  target: z.string().max(8192).refine(validTarget),
  bodyHash: z.string().regex(HASH_PATTERN),
  timestamp: z.number().int().safe(),
  nonce: z.string().regex(NONCE_PATTERN),
}).strict();
const headerSchema = z.object({ envelope: envelopeSchema, signature: z.string().regex(SIGNATURE_PATTERN) }).strict();

export function ensureClusterProtocolSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_request_nonces (
    sender_node_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (sender_node_id, nonce)
  );
  CREATE INDEX IF NOT EXISTS cluster_v2_request_nonces_expiration ON cluster_v2_request_nonces(expires_at);`);
}

function invalid(): ClusterProtocolError {
  return new ClusterProtocolError("Invalid cluster request");
}

function validTarget(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//") && !target.includes("\\") && !target.includes("#") && !/[\x00-\x1f\x7f]/.test(target);
}

function validateRequestFields(senderNodeId: string, recipientNodeId: string, method: string, target: string, now: number): void {
  if (!UUID_PATTERN.test(senderNodeId) || !UUID_PATTERN.test(recipientNodeId)) throw invalid();
  if (!METHODS.has(method) || !validTarget(target) || target.length > 8192) throw invalid();
  if (!Number.isSafeInteger(now)) throw invalid();
}

function bodyHash(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

function signaturePayload(envelope: ClusterRequestEnvelope): string {
  return JSON.stringify([
    envelope.version, envelope.senderNodeId, envelope.recipientNodeId, envelope.method,
    envelope.target, envelope.bodyHash, envelope.timestamp, envelope.nonce,
  ]);
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
  validateRequestFields(senderNodeId, recipientNodeId, method, target, now);
  const envelope: ClusterRequestEnvelope = {
    version: 2,
    senderNodeId,
    recipientNodeId,
    method,
    target,
    bodyHash: bodyHash(rawBody),
    timestamp: now,
    nonce: randomBytes(24).toString("base64url"),
  };
  const signature = signClusterMessage(db, senderNodeId, "http-request", signaturePayload(envelope));
  return `JointBobV2 ${Buffer.from(JSON.stringify({ envelope, signature }), "utf8").toString("base64url")}`;
}

function parseAuthorization(authorization: string | undefined): { envelope: ClusterRequestEnvelope; signature: string } {
  if (!authorization || authorization.length > 32768 || !authorization.startsWith("JointBobV2 ")) throw invalid();
  const encoded = authorization.slice("JointBobV2 ".length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw invalid();
  let decoded: Buffer;
  try { decoded = Buffer.from(encoded, "base64url"); } catch { throw invalid(); }
  if (decoded.toString("base64url") !== encoded) throw invalid();
  let value: unknown;
  try { value = JSON.parse(decoded.toString("utf8")); } catch { throw invalid(); }
  const result = headerSchema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}

function consumeNonce(db: DatabaseSync, senderNodeId: string, nonce: string, now: number): void {
  ensureClusterProtocolSchema(db);
  db.exec("SAVEPOINT cluster_v2_nonce");
  try {
    db.prepare("DELETE FROM cluster_v2_request_nonces WHERE expires_at < ?").run(now);
    const exists = db.prepare("SELECT 1 FROM cluster_v2_request_nonces WHERE sender_node_id = ? AND nonce = ?").get(senderNodeId, nonce);
    if (exists) throw new ClusterProtocolError("Cluster request replayed");
    db.prepare("INSERT INTO cluster_v2_request_nonces (sender_node_id, nonce, expires_at) VALUES (?, ?, ?)").run(senderNodeId, nonce, now + 120_000);
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
  if (!UUID_PATTERN.test(recipientNodeId) || !METHODS.has(method) || !validTarget(target) || target.length > 8192 || !Number.isSafeInteger(now)) throw invalid();
  const { envelope, signature } = parseAuthorization(authorization);
  if (envelope.recipientNodeId !== recipientNodeId || envelope.method !== method || envelope.target !== target) throw invalid();
  if (envelope.bodyHash !== bodyHash(rawBody) || Math.abs(now - envelope.timestamp) > 60_000) throw invalid();
  const publicKey = pinnedClusterPublicKey(db, envelope.senderNodeId);
  if (!publicKey || !verifyClusterMessage(publicKey, "http-request", signaturePayload(envelope), signature)) throw invalid();
  consumeNonce(db, envelope.senderNodeId, envelope.nonce, now);
  return envelope.senderNodeId;
}
