import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { clusterPrivateKey, ensureClusterIdentitySchema, getOrCreateClusterIdentity, pinClusterPublicKey, signClusterMessage, verifyClusterMessage } from "../src/cluster-identity.js";
import { ClusterProtocolError as LegacyProtocolError, ensureClusterProtocolSchema, signClusterRequest, verifyClusterRequest } from "../src/cluster-protocol.js";
import {
  CLUSTER_REQUEST_DOMAIN, ClusterProtocolError, createRequestEnvelope, encodeAuthorization, parseAuthorization, requestSignaturePayload,
  signMessage, signRequest, verifyMessage, verifyRequest,
} from "../src/file-sync/signing.js";

const SENDER = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = 1_700_000_000_000;
const TARGET = "/api/cluster/v2/files/index?projectId=p&kind=project&since=0&limit=5000";

function fixture(): { dir: string; sender: DatabaseSync; receiver: DatabaseSync; close(): void } {
  const dir = mkdtempSync(path.join(process.env.HOME!, "file-sync-signing-"));
  const sender = new DatabaseSync(path.join(dir, "sender.db"));
  const receiver = new DatabaseSync(path.join(dir, "receiver.db"));
  ensureClusterIdentitySchema(sender);
  ensureClusterIdentitySchema(receiver);
  ensureClusterProtocolSchema(receiver);
  return { dir, sender, receiver, close() { sender.close(); receiver.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a header from signing.ts verifies with verifyClusterRequest", () => {
  const f = fixture();
  try {
    const keys = generateKeyPairSync("ed25519");
    pinClusterPublicKey(f.receiver, SENDER, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
    const body = Buffer.from('{"projectId":"p","kind":"project","items":[]}');
    const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "POST", "/api/cluster/v2/files/fetch", body, NOW);
    assert.equal(verifyClusterRequest(f.receiver, RECIPIENT, "POST", "/api/cluster/v2/files/fetch", body, header, NOW), SENDER);
  } finally {
    f.close();
  }
});

test("a header from signClusterRequest verifies with signing.ts, PEM or KeyObject", () => {
  const f = fixture();
  try {
    const identity = getOrCreateClusterIdentity(f.sender, SENDER);
    const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "GET", TARGET, Buffer.alloc(0), NOW);
    const envelope = verifyRequest(RECIPIENT, "GET", TARGET, Buffer.alloc(0), header, (sender) => sender === SENDER ? identity.publicKey : undefined, NOW);
    assert.equal(envelope.senderNodeId, SENDER);
    assert.equal(envelope.target, TARGET);
    const keyObject = createPublicKey(identity.publicKey);
    assert.equal(verifyRequest(RECIPIENT, "GET", TARGET, Buffer.alloc(0), header, () => keyObject, NOW).nonce, envelope.nonce);
  } finally {
    f.close();
  }
});

test("signing.ts reproduces the cluster header byte for byte", () => {
  const f = fixture();
  try {
    getOrCreateClusterIdentity(f.sender, SENDER);
    const body = Buffer.from('{"a":1}');
    const header = signClusterRequest(f.sender, SENDER, RECIPIENT, "POST", "/items?x=1", body, NOW);
    const { envelope, signature } = parseAuthorization(header);
    // Ed25519 is deterministic: the same key over the same payload gives the same signature.
    const again = signMessage(clusterPrivateKey(f.sender, SENDER), CLUSTER_REQUEST_DOMAIN, requestSignaturePayload(envelope));
    assert.equal(again, signature);
    assert.equal(encodeAuthorization(envelope, again), header);
    assert.equal(signClusterMessage(f.sender, SENDER, "some-domain", "payload"), signMessage(clusterPrivateKey(f.sender, SENDER), "some-domain", "payload"));
  } finally {
    f.close();
  }
});

test("verifyRequest binds recipient, method, exact target and body", () => {
  const keys = generateKeyPairSync("ed25519");
  const body = Buffer.from('{"a":1}');
  const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "POST", "/x?y=1", body, NOW);
  const key = () => keys.publicKey;
  assert.equal(verifyRequest(RECIPIENT, "POST", "/x?y=1", body, header, key, NOW).senderNodeId, SENDER);
  const attempts: Array<[string, string, string, Buffer]> = [
    [OTHER, "POST", "/x?y=1", body], [RECIPIENT, "PUT", "/x?y=1", body],
    [RECIPIENT, "POST", "/x?y=2", body], [RECIPIENT, "POST", "/x?y=1", Buffer.from('{"a": 1}')],
  ];
  for (const [recipient, method, target, changed] of attempts) {
    assert.throws(() => verifyRequest(recipient, method, target, changed, header, key, NOW), (error: unknown) => error instanceof ClusterProtocolError && error.statusCode === 401 && error.message === "Invalid cluster request", `${recipient} ${method} ${target} ${changed} must fail`);
  }
});

test("verifyRequest accepts exactly ±60 s of clock skew", () => {
  const keys = generateKeyPairSync("ed25519");
  for (const timestamp of [NOW - 60_000, NOW + 60_000]) {
    const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "GET", "/t", Buffer.alloc(0), timestamp);
    assert.equal(verifyRequest(RECIPIENT, "GET", "/t", Buffer.alloc(0), header, () => keys.publicKey, NOW).timestamp, timestamp);
  }
  for (const timestamp of [NOW - 60_001, NOW + 60_001]) {
    const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "GET", "/t", Buffer.alloc(0), timestamp);
    assert.throws(() => verifyRequest(RECIPIENT, "GET", "/t", Buffer.alloc(0), header, () => keys.publicKey, NOW), ClusterProtocolError, `timestamp ${timestamp - NOW} must fail`);
  }
});

test("verifyRequest fails closed on unknown senders, other keys and malformed headers", () => {
  const keys = generateKeyPairSync("ed25519");
  const stranger = generateKeyPairSync("ed25519");
  const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "GET", "/", Buffer.alloc(0), NOW);
  assert.throws(() => verifyRequest(RECIPIENT, "GET", "/", Buffer.alloc(0), header, () => undefined, NOW), ClusterProtocolError, "no pinned key");
  assert.throws(() => verifyRequest(RECIPIENT, "GET", "/", Buffer.alloc(0), header, () => stranger.publicKey, NOW), ClusterProtocolError, "another node's key");
  assert.throws(() => verifyRequest(RECIPIENT, "GET", "/", Buffer.alloc(0), header, () => keys.privateKey, NOW), ClusterProtocolError, "a private key is not a pinned public key");
  for (const bad of [undefined, "", "Bearer x", "JointBobV2 ***", "JointBobV2 e30", `${header}=`, `JointBobV2 ${"A".repeat(40_000)}`]) {
    assert.throws(() => verifyRequest(RECIPIENT, "GET", "/", Buffer.alloc(0), bad, () => keys.publicKey, NOW), ClusterProtocolError, String(bad).slice(0, 40));
  }
});

test("verifyRequest leaves replay protection to the caller", () => {
  const keys = generateKeyPairSync("ed25519");
  const header = signRequest(keys.privateKey, SENDER, RECIPIENT, "GET", "/r", Buffer.alloc(0), NOW);
  const first = verifyRequest(RECIPIENT, "GET", "/r", Buffer.alloc(0), header, () => keys.publicKey, NOW);
  const second = verifyRequest(RECIPIENT, "GET", "/r", Buffer.alloc(0), header, () => keys.publicKey, NOW);
  assert.equal(second.nonce, first.nonce, "the same nonce verifies twice; the direct listener must consume it");
  assert.match(first.nonce, /^[A-Za-z0-9_-]{32}$/);
});

test("createRequestEnvelope validates its fields like the cluster signer", () => {
  for (const [sender, target] of [["not-a-uuid", "/"], [SENDER, "relative"], [SENDER, "//host/x"], [SENDER, "/a#b"], [SENDER, "/a\\b"], [SENDER, "/a\nb"]]) {
    assert.throws(() => createRequestEnvelope(sender, RECIPIENT, "GET", target, Buffer.alloc(0), NOW), ClusterProtocolError, `${sender} ${JSON.stringify(target)}`);
  }
  assert.throws(() => createRequestEnvelope(SENDER, RECIPIENT, "TRACE", "/", Buffer.alloc(0), NOW), ClusterProtocolError);
  assert.throws(() => createRequestEnvelope(SENDER, RECIPIENT, "GET", "/", Buffer.alloc(0), 1.5), ClusterProtocolError);
});

test("cluster-protocol re-exports the same error class", () => {
  assert.equal(LegacyProtocolError, ClusterProtocolError);
});

test("message signatures are domain-separated and fail closed on bad keys", () => {
  const keys = generateKeyPairSync("ed25519");
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = signMessage(keys.privateKey, "domain-a", "payload");
  assert.equal(verifyMessage(pem, "domain-a", "payload", signature), true);
  assert.equal(verifyMessage(keys.publicKey, "domain-a", "payload", signature), true);
  assert.equal(verifyClusterMessage(pem, "domain-a", "payload", signature), true, "cluster-identity must accept a signing.ts signature");
  assert.equal(verifyMessage(pem, "domain-b", "payload", signature), false);
  assert.equal(verifyMessage(pem, "domain-a", "payload2", signature), false);
  assert.equal(verifyMessage(pem, "domain-a", "payload", `${signature}=`), false);
  assert.equal(verifyMessage(keys.privateKey, "domain-a", "payload", signature), false);
  assert.equal(verifyMessage(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "domain-a", "payload", signature), false);
  assert.equal(verifyMessage("not a key", "domain-a", "payload", signature), false);
  assert.equal(verifyMessage(pem, "", "payload", signature), false);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signMessage(rsa.privateKey, "domain-a", "payload"), /Ed25519/);
  assert.throws(() => signMessage(keys.privateKey, "bad\ndomain", "payload"), /domain is invalid/);
});
