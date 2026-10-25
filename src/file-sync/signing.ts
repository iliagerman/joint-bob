import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/* Signed cluster requests without a database: the caller supplies the private key (sending) or the
   sender's pinned public key (receiving) and does its own nonce bookkeeping. cluster-protocol.ts and
   cluster-identity.ts build on these, so the worker's direct listener and the main server accept and
   produce exactly the same Authorization headers. */

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

export const CLUSTER_REQUEST_DOMAIN = "http-request";
export const AUTHORIZATION_SCHEME = "JointBobV2";
/** A request is accepted within this distance of the receiver's clock. */
export const REQUEST_CLOCK_SKEW_MS = 60_000;
/** How long a consumed nonce must be remembered: longer than the whole acceptance window. */
export const NONCE_TTL_MS = 120_000;

const PREFIX = `${AUTHORIZATION_SCHEME} `;
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
  target: z.string().max(8192).refine(validRequestTarget),
  bodyHash: z.string().regex(HASH_PATTERN),
  timestamp: z.number().int().safe(),
  nonce: z.string().regex(NONCE_PATTERN),
}).strict();
const headerSchema = z.object({ envelope: envelopeSchema, signature: z.string().regex(SIGNATURE_PATTERN) }).strict();

function invalid(): ClusterProtocolError {
  return new ClusterProtocolError("Invalid cluster request");
}

export function validRequestTarget(target: string): boolean {
  return target.startsWith("/") && !target.startsWith("//") && !target.includes("\\") && !target.includes("#") && !/[\x00-\x1f\x7f]/.test(target);
}

function validateRequestFields(senderNodeId: string, recipientNodeId: string, method: string, target: string, now: number): void {
  if (!UUID_PATTERN.test(senderNodeId) || !UUID_PATTERN.test(recipientNodeId)) throw invalid();
  if (!METHODS.has(method) || !validRequestTarget(target) || target.length > 8192) throw invalid();
  if (!Number.isSafeInteger(now)) throw invalid();
}

export function requestBodyHash(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function requestSignaturePayload(envelope: ClusterRequestEnvelope): string {
  return JSON.stringify([
    envelope.version, envelope.senderNodeId, envelope.recipientNodeId, envelope.method,
    envelope.target, envelope.bodyHash, envelope.timestamp, envelope.nonce,
  ]);
}

function assertDomain(domain: string): void {
  if (!domain.trim() || domain.length > 80 || /[\x00-\x1f\x7f]/.test(domain)) throw new Error("Cluster signature domain is invalid");
}

function signedBytes(domain: string, payload: string): Buffer {
  assertDomain(domain);
  return Buffer.from(JSON.stringify(["joint-bob-v2", domain, payload]), "utf8");
}

/** The SPKI PEM of an Ed25519 public key; throws for anything else (private keys included). */
export function canonicalPublicKey(publicKey: string): string {
  if (/PRIVATE KEY/.test(publicKey)) throw new Error("Cluster public key must be an Ed25519 public key");
  let key;
  try { key = createPublicKey(publicKey); } catch { throw new Error("Cluster public key is invalid"); }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Cluster public key must be Ed25519");
  return key.export({ type: "spki", format: "pem" }).toString();
}

/** Domain-separated Ed25519 signature (base64url) over `payload`. */
export function signMessage(privateKey: KeyObject, domain: string, payload: string): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("Cluster signing key must be an Ed25519 private key");
  return sign(null, signedBytes(domain, payload), privateKey).toString("base64url");
}

/** Fails closed: any malformed key, signature or domain is just `false`. */
export function verifyMessage(publicKey: string | KeyObject, domain: string, payload: string, signature: string): boolean {
  try {
    if (!SIGNATURE_PATTERN.test(signature)) return false;
    const decoded = Buffer.from(signature, "base64url");
    if (decoded.length !== 64 || decoded.toString("base64url") !== signature) return false;
    const key = typeof publicKey === "string" ? createPublicKey(canonicalPublicKey(publicKey)) : publicKey;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, signedBytes(domain, payload), key, decoded);
  } catch {
    return false;
  }
}

export function createRequestEnvelope(
  senderNodeId: string,
  recipientNodeId: string,
  method: string,
  target: string,
  rawBody: Buffer,
  now = Date.now(),
): ClusterRequestEnvelope {
  validateRequestFields(senderNodeId, recipientNodeId, method, target, now);
  return {
    version: 2,
    senderNodeId,
    recipientNodeId,
    method,
    target,
    bodyHash: requestBodyHash(rawBody),
    timestamp: now,
    nonce: randomBytes(24).toString("base64url"),
  };
}

export function encodeAuthorization(envelope: ClusterRequestEnvelope, signature: string): string {
  return `${PREFIX}${Buffer.from(JSON.stringify({ envelope, signature }), "utf8").toString("base64url")}`;
}

export function parseAuthorization(authorization: string | undefined): { envelope: ClusterRequestEnvelope; signature: string } {
  if (!authorization || authorization.length > 32768 || !authorization.startsWith(PREFIX)) throw invalid();
  const encoded = authorization.slice(PREFIX.length);
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

/** The Authorization header value for one request. Sign right before sending: receivers allow ±60 s. */
export function signRequest(
  privateKey: KeyObject,
  senderNodeId: string,
  recipientNodeId: string,
  method: string,
  target: string,
  rawBody: Buffer,
  now = Date.now(),
): string {
  const envelope = createRequestEnvelope(senderNodeId, recipientNodeId, method, target, rawBody, now);
  return encodeAuthorization(envelope, signMessage(privateKey, CLUSTER_REQUEST_DOMAIN, requestSignaturePayload(envelope)));
}

/** Checks everything but replay; throws ClusterProtocolError. The caller must then consume
    `envelope.nonce` for `envelope.senderNodeId` (remember it for NONCE_TTL_MS) before acting. */
export function verifyRequest(
  recipientNodeId: string,
  method: string,
  target: string,
  rawBody: Buffer,
  authorization: string | undefined,
  publicKeyFor: (senderNodeId: string) => string | KeyObject | undefined,
  now = Date.now(),
): ClusterRequestEnvelope {
  if (!UUID_PATTERN.test(recipientNodeId) || !METHODS.has(method) || !validRequestTarget(target) || target.length > 8192 || !Number.isSafeInteger(now)) throw invalid();
  const { envelope, signature } = parseAuthorization(authorization);
  if (envelope.recipientNodeId !== recipientNodeId || envelope.method !== method || envelope.target !== target) throw invalid();
  if (envelope.bodyHash !== requestBodyHash(rawBody) || Math.abs(now - envelope.timestamp) > REQUEST_CLOCK_SKEW_MS) throw invalid();
  const publicKey = publicKeyFor(envelope.senderNodeId);
  if (!publicKey || !verifyMessage(publicKey, CLUSTER_REQUEST_DOMAIN, requestSignaturePayload(envelope), signature)) throw invalid();
  return envelope;
}
