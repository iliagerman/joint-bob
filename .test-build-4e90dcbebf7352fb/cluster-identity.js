import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { decryptSecretValue, encryptSecretValue } from "./secrets.js";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
function ensureClusterIdentitySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    node_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cluster_v2_public_keys (
    node_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL
  );`);
}
function assertNodeId(nodeId) {
  if (!UUID_PATTERN.test(nodeId)) throw new Error("Cluster node ID must be a UUID");
}
function assertDomain(domain) {
  if (!domain.trim() || domain.length > 80 || /[\x00-\x1f\x7f]/.test(domain)) throw new Error("Cluster signature domain is invalid");
}
function canonicalPublicKey(publicKey) {
  if (/PRIVATE KEY/.test(publicKey)) throw new Error("Cluster public key must be an Ed25519 public key");
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new Error("Cluster public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Cluster public key must be Ed25519");
  return key.export({ type: "spki", format: "pem" }).toString();
}
function signedBytes(domain, payload) {
  assertDomain(domain);
  return Buffer.from(JSON.stringify(["joint-bob-v2", domain, payload]), "utf8");
}
function clusterPublicKeyFingerprint(publicKey) {
  const canonical = canonicalPublicKey(publicKey);
  const key = createPublicKey(canonical);
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}
function publicIdentity(row) {
  const publicKey = canonicalPublicKey(row.public_key);
  return { nodeId: row.node_id, publicKey, fingerprint: clusterPublicKeyFingerprint(publicKey) };
}
function getOrCreateClusterIdentity(db, nodeId) {
  assertNodeId(nodeId);
  ensureClusterIdentitySchema(db);
  db.exec("SAVEPOINT cluster_v2_identity_create");
  try {
    const existing = db.prepare("SELECT node_id, public_key, private_key_encrypted FROM cluster_v2_identity WHERE singleton = 1").get();
    if (existing) {
      if (existing.node_id !== nodeId) throw new Error("Local cluster identity cannot be replaced");
      const identity2 = publicIdentity(existing);
      db.exec("RELEASE cluster_v2_identity_create");
      return identity2;
    }
    const generated = generateKeyPairSync("ed25519");
    const publicKey = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKey = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    db.prepare("INSERT INTO cluster_v2_identity (singleton, node_id, public_key, private_key_encrypted) VALUES (1, ?, ?, ?)").run(nodeId, publicKey, encryptSecretValue(privateKey));
    const identity = { nodeId, publicKey, fingerprint: clusterPublicKeyFingerprint(publicKey) };
    db.exec("RELEASE cluster_v2_identity_create");
    return identity;
  } catch (error) {
    db.exec("ROLLBACK TO cluster_v2_identity_create; RELEASE cluster_v2_identity_create");
    throw error;
  }
}
function pinClusterPublicKey(db, nodeId, publicKey) {
  assertNodeId(nodeId);
  const canonical = canonicalPublicKey(publicKey);
  ensureClusterIdentitySchema(db);
  db.exec("SAVEPOINT cluster_v2_pin");
  try {
    const row = db.prepare("SELECT public_key FROM cluster_v2_public_keys WHERE node_id = ?").get(nodeId);
    if (row && canonicalPublicKey(row.public_key) !== canonical) throw new Error("Cluster public key cannot be replaced");
    if (!row) db.prepare("INSERT INTO cluster_v2_public_keys (node_id, public_key) VALUES (?, ?)").run(nodeId, canonical);
    db.exec("RELEASE cluster_v2_pin");
  } catch (error) {
    db.exec("ROLLBACK TO cluster_v2_pin; RELEASE cluster_v2_pin");
    throw error;
  }
}
function pinnedClusterPublicKey(db, nodeId) {
  assertNodeId(nodeId);
  ensureClusterIdentitySchema(db);
  const row = db.prepare("SELECT public_key FROM cluster_v2_public_keys WHERE node_id = ?").get(nodeId);
  return row?.public_key;
}
function signClusterMessage(db, nodeId, domain, payload) {
  assertNodeId(nodeId);
  const row = db.prepare("SELECT node_id, private_key_encrypted FROM cluster_v2_identity WHERE singleton = 1").get();
  if (!row || row.node_id !== nodeId) throw new Error("Local cluster identity does not match node ID");
  const privateKey = createPrivateKey(decryptSecretValue(row.private_key_encrypted));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Stored cluster private key is invalid");
  return sign(null, signedBytes(domain, payload), privateKey).toString("base64url");
}
function verifyClusterMessage(publicKey, domain, payload, signature) {
  try {
    if (!SIGNATURE_PATTERN.test(signature)) return false;
    const decoded = Buffer.from(signature, "base64url");
    if (decoded.length !== 64 || decoded.toString("base64url") !== signature) return false;
    const key = createPublicKey(canonicalPublicKey(publicKey));
    return verify(null, signedBytes(domain, payload), key, decoded);
  } catch {
    return false;
  }
}
export {
  clusterPublicKeyFingerprint,
  ensureClusterIdentitySchema,
  getOrCreateClusterIdentity,
  pinClusterPublicKey,
  pinnedClusterPublicKey,
  signClusterMessage,
  verifyClusterMessage
};
