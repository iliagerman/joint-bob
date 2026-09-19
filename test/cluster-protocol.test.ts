import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  clusterPublicKeyFingerprint,
  ensureClusterIdentitySchema,
  getOrCreateClusterIdentity,
  pinClusterPublicKey,
  pinnedClusterPublicKey,
  signClusterMessage,
  verifyClusterMessage,
} from "../src/cluster-identity.js";
import {
  ensureClusterProtocolSchema,
  signClusterRequest,
  verifyClusterRequest,
  type ClusterRequestEnvelope,
} from "../src/cluster-protocol.js";

const SENDER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = 1_700_000_000_000;

type HeaderValue = { envelope: ClusterRequestEnvelope; signature: string };

function fixture(): { dir: string; sender: DatabaseSync; receiver: DatabaseSync; senderPath: string; receiverPath: string } {
  const dir = mkdtempSync(path.join(process.env.HOME!, "cluster-protocol-"));
  const senderPath = path.join(dir, "sender.db");
  const receiverPath = path.join(dir, "receiver.db");
  const sender = new DatabaseSync(senderPath);
  const receiver = new DatabaseSync(receiverPath);
  ensureClusterIdentitySchema(sender);
  ensureClusterIdentitySchema(receiver);
  ensureClusterProtocolSchema(receiver);
  return { dir, sender, receiver, senderPath, receiverPath };
}

function decode(header: string): HeaderValue {
  return JSON.parse(Buffer.from(header.slice("JointBobV2 ".length), "base64url").toString("utf8")) as HeaderValue;
}

function payload(envelope: ClusterRequestEnvelope): string {
  return JSON.stringify([envelope.version, envelope.senderNodeId, envelope.recipientNodeId, envelope.method, envelope.target, envelope.bodyHash, envelope.timestamp, envelope.nonce]);
}

function signedHeader(db: DatabaseSync, envelope: ClusterRequestEnvelope): string {
  const signature = signClusterMessage(db, envelope.senderNodeId, "http-request", payload(envelope));
  return `JointBobV2 ${Buffer.from(JSON.stringify({ envelope, signature }), "utf8").toString("base64url")}`;
}

function pair(sender: DatabaseSync, receiver: DatabaseSync): void {
  const identity = getOrCreateClusterIdentity(sender, SENDER);
  pinClusterPublicKey(receiver, SENDER, identity.publicKey);
}

test("identity remains stable, encrypted, and cannot be replaced", () => {
  const f = fixture();
  try {
    const first = getOrCreateClusterIdentity(f.sender, SENDER);
    f.sender.close();
    f.sender = new DatabaseSync(f.senderPath);
    const second = getOrCreateClusterIdentity(f.sender, SENDER);
    assert.deepEqual(second, first, "local identity must be stable after database reopen");
    assert.equal(first.fingerprint, clusterPublicKeyFingerprint(first.publicKey), "fingerprint must identify the canonical public key");
    assert.throws(() => getOrCreateClusterIdentity(f.sender, OTHER), /Local cluster identity cannot be replaced/, "another node ID must not replace local identity");
    const stored = f.sender.prepare("SELECT private_key_encrypted FROM cluster_v2_identity").get() as { private_key_encrypted: string };
    assert.equal(stored.private_key_encrypted.includes("PRIVATE KEY"), false, "private key must be encrypted at rest");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("corrupt persisted public identity reports its validation error without replacement", () => {
  const f = fixture();
  try {
    getOrCreateClusterIdentity(f.sender, SENDER);
    f.sender.prepare("UPDATE cluster_v2_identity SET public_key = ? WHERE singleton = 1").run("invalid key");

    assert.throws(() => getOrCreateClusterIdentity(f.sender, SENDER), /Cluster public key is invalid/);
    const stored = f.sender.prepare("SELECT public_key FROM cluster_v2_identity WHERE singleton = 1").get() as { public_key: string };
    assert.equal(stored.public_key, "invalid key", "corrupt identity must not be replaced");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("public key pins are canonical, immutable, and Ed25519-only", () => {
  const f = fixture();
  try {
    const key = getOrCreateClusterIdentity(f.sender, SENDER).publicKey;
    pinClusterPublicKey(f.receiver, SENDER, key);
    pinClusterPublicKey(f.receiver, SENDER, key);
    assert.equal(pinnedClusterPublicKey(f.receiver, SENDER), key, "idempotent pin must retain canonical key");
    const replacementDb = new DatabaseSync(":memory:");
    const replacement = getOrCreateClusterIdentity(replacementDb, OTHER).publicKey;
    replacementDb.close();
    assert.throws(() => pinClusterPublicKey(f.receiver, SENDER, replacement), /Cluster public key cannot be replaced/, "a pin must be immutable");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.throws(() => pinClusterPublicKey(f.receiver, OTHER, rsa), /Ed25519/, "non-Ed25519 pins must be rejected");
    assert.throws(() => pinClusterPublicKey(f.receiver, OTHER, "not a key"), /public key/i, "malformed pins must be rejected");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("message signatures reject malformed signatures and keys", () => {
  const f = fixture();
  try {
    const identity = getOrCreateClusterIdentity(f.sender, SENDER);
    const signature = signClusterMessage(f.sender, SENDER, "test-domain", "payload");
    assert.equal(verifyClusterMessage(identity.publicKey, "test-domain", "payload", signature), true, "valid signature must verify");
    assert.equal(verifyClusterMessage(identity.publicKey, "test-domain", "changed", signature), false, "payload tampering must fail");
    assert.equal(verifyClusterMessage(identity.publicKey, "test-domain", "payload", `${signature}=`), false, "noncanonical signature must fail");
    assert.equal(verifyClusterMessage("bad key", "test-domain", "payload", signature), false, "malformed untrusted key must fail closed");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("request signature binds recipient, method, exact target, and raw body", () => {
  const f = fixture();
  try {
    pair(f.sender, f.receiver);
    const body = Buffer.from('{"a":1}');
    const valid = signClusterRequest(f.sender, SENDER, RECIPIENT, "POST", "/items?x=1", body, NOW);
    assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "POST", "/items?x=1", body, valid, NOW), SENDER, "valid bound request must authenticate sender");
    const attempts: Array<[string, string, string, Buffer]> = [
      [OTHER, "POST", "/items?x=1", body], [RECIPIENT, "PUT", "/items?x=1", body],
      [RECIPIENT, "POST", "/items?x=2", body], [RECIPIENT, "POST", "/items?x=1", Buffer.from('{"a": 1}')],
    ];
    for (const [recipient, method, target, changedBody] of attempts) {
      const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "POST", "/items?x=1", body, NOW);
      assert.throws(() => verifyClusterRequest(f.receiver, recipient, method, target, changedBody, header, NOW), /Invalid cluster request/, "each request component and exact JSON bytes must be bound");
    }
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("untrusted authorization forms and unknown pins fail closed", () => {
  const f = fixture();
  try {
    getOrCreateClusterIdentity(f.sender, SENDER);
    const valid = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", "/", Buffer.alloc(0), NOW);
    for (const header of [undefined, "Bearer token", "JointBobV2 ***", "JointBobV2 e30", valid]) {
      assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/", Buffer.alloc(0), header, NOW), /Invalid cluster request/, "missing, bearer, malformed, and unknown-pin authorization must fail");
    }
    pair(f.sender, f.receiver);
    const decoded = decode(valid);
    const badVersion = signedHeader(f.sender, { ...decoded.envelope, version: 3 as 2 });
    assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/", Buffer.alloc(0), badVersion, NOW), /Invalid cluster request/, "unsupported protocol version must fail");
    const invalidSignature = `JointBobV2 ${Buffer.from(JSON.stringify({ ...decoded, signature: "A".repeat(86) }), "utf8").toString("base64url")}`;
    assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/", Buffer.alloc(0), invalidSignature, NOW), /Invalid cluster request/, "invalid signature must fail");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("timestamp window accepts boundaries and rejects older or future requests", () => {
  const f = fixture();
  try {
    pair(f.sender, f.receiver);
    for (const timestamp of [NOW - 60_000, NOW + 60_000]) {
      const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", "/time", Buffer.alloc(0), timestamp);
      assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/time", Buffer.alloc(0), header, NOW), SENDER, "60-second timestamp boundary must be accepted");
    }
    for (const timestamp of [NOW - 60_001, NOW + 60_001]) {
      const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", "/time", Buffer.alloc(0), timestamp);
      assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/time", Buffer.alloc(0), header, NOW), /Invalid cluster request/, "timestamp beyond either boundary must fail");
    }
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});

test("nonce replay persists, invalid signatures do not consume, and senders are isolated", () => {
  const f = fixture();
  try {
    pair(f.sender, f.receiver);
    const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", "/replay", Buffer.alloc(0), NOW);
    const decoded = decode(header);
    const bad = `JointBobV2 ${Buffer.from(JSON.stringify({ ...decoded, signature: "A".repeat(86) }), "utf8").toString("base64url")}`;
    assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/replay", Buffer.alloc(0), bad, NOW), /Invalid cluster request/, "invalid signature must not consume nonce");
    assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/replay", Buffer.alloc(0), header, NOW), SENDER, "genuine request must remain usable");
    f.receiver.close(); f.receiver = new DatabaseSync(f.receiverPath);
    assert.throws(() => verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/replay", Buffer.alloc(0), header, NOW + 1), /Cluster request replayed/, "replay must remain rejected after reopen");

    const otherDb = new DatabaseSync(path.join(f.dir, "other.db"));
    const otherIdentity = getOrCreateClusterIdentity(otherDb, OTHER);
    pinClusterPublicKey(f.receiver, OTHER, otherIdentity.publicKey);
    const otherEnvelope = { ...decoded.envelope, senderNodeId: OTHER };
    const otherHeader = signedHeader(otherDb, otherEnvelope);
    assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/replay", Buffer.alloc(0), otherHeader, NOW + 1), OTHER, "different senders may use the same nonce");
    otherDb.close();

    const later = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", "/later", Buffer.alloc(0), NOW + 119_999);
    assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "GET", "/later", Buffer.alloc(0), later, NOW + 119_999), SENDER, "cleanup request must authenticate");
    const retained = f.receiver.prepare("SELECT 1 FROM cluster_v2_request_nonces WHERE sender_node_id = ? AND nonce = ?").get(SENDER, decoded.envelope.nonce);
    assert.notEqual(retained, undefined, "cleanup must not remove unexpired consumed nonce");
  } finally {
    f.sender.close(); f.receiver.close(); rmSync(f.dir, { recursive: true, force: true });
  }
});
