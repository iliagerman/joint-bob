import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getOrCreateClusterIdentity, pinnedClusterPublicKey, signClusterMessage } from "../src/cluster-identity.js";
import { isTrustedTwin, listSharingMemberships, mayReceiveResource, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import {
  applyTwinCertificate, applyTwinRevocation, confirmTwinAcceptance, createTwinInvitation,
  ensureTwinSchema, listTwinRelationships, prepareTwinAcceptance, revokeTwinRelationship,
  type TwinAcceptance, type TwinCertificate,
} from "../src/cluster-twins.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const NOW = 1_700_000_000_000;

function fixture(fileBacked = false) {
  const dir = mkdtempSync(path.join(process.env.HOME!, "cluster-twins-"));
  const paths = ["a.db", "b.db", "c.db"].map((name) => path.join(dir, name));
  const dbs = paths.map((name) => new DatabaseSync(fileBacked ? name : ":memory:"));
  for (const db of dbs) ensureTwinSchema(db);
  getOrCreateClusterIdentity(dbs[0], A); getOrCreateClusterIdentity(dbs[1], B); getOrCreateClusterIdentity(dbs[2], C);
  return { dir, paths, dbs };
}
function close(f: ReturnType<typeof fixture>) { for (const db of f.dbs) db.close(); rmSync(f.dir, { recursive: true, force: true }); }
function pair(a: DatabaseSync, b: DatabaseSync, now = NOW): TwinCertificate {
  const invitation = createTwinInvitation(a, A, now);
  const acceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, now);
  const certificate = confirmTwinAcceptance(a, A, acceptance, invitation.secret, now);
  applyTwinCertificate(b, B, certificate);
  return certificate;
}

test("bilateral acceptance is durable, retryable, and activates direct trust only after certificate apply", () => {
  const f = fixture(); const [a, b] = f.dbs;
  try {
    const invitation = createTwinInvitation(a, A, NOW);
    const acceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    assert.equal(isTrustedTwin(a, A, B), false); assert.equal(isTrustedTwin(b, A, B), false);
    assert.deepEqual(prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW + 1_000_000), acceptance);
    const certificate = confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW);
    assert.deepEqual(confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW + 1_000_000), certificate);
    assert.equal(isTrustedTwin(a, A, B), true); assert.equal(isTrustedTwin(b, A, B), false);
    applyTwinCertificate(b, B, certificate); applyTwinCertificate(b, B, certificate);
    assert.equal(isTrustedTwin(b, A, B), true);
    assert.deepEqual(listTwinRelationships(a, A).map((r) => r.status), ["active"]);
    assert.deepEqual(listTwinRelationships(b, B).map((r) => r.status), ["active"]);
  } finally { close(f); }
});

test("certificate activation cannot resurrect a concurrently revoked relationship", () => {
  const f = fixture(true); const [, b] = f.dbs; const secondB = new DatabaseSync(f.paths[1]);
  const originalExec = b.exec.bind(b); let intercepted = false;
  try {
    ensureTwinSchema(secondB);
    const invitation = createTwinInvitation(f.dbs[0], A, NOW);
    const acceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    const certificate = confirmTwinAcceptance(f.dbs[0], A, acceptance, invitation.secret, NOW);
    b.exec = ((sql: string) => {
      if (!intercepted && sql === "SAVEPOINT cluster_v2_twin_write") {
        intercepted = true;
        revokeTwinRelationship(secondB, B, certificate.body.relationshipId);
      }
      return originalExec(sql);
    }) as typeof b.exec;
    assert.throws(() => applyTwinCertificate(b, B, certificate), /revoked/i);
    assert.equal(listTwinRelationships(b, B)[0]?.status, "revoked");
    assert.equal(isTrustedTwin(b, A, B), false);
  } finally {
    b.exec = originalExec;
    secondB.close();
    close(f);
  }
});

test("invalid, expired, consumed, unsolicited, tampered, swapped, and self pairing grant nothing", () => {
  const f = fixture(); const [a, b, c] = f.dbs;
  try {
    const invitation = createTwinInvitation(a, A, NOW);
    assert.throws(() => prepareTwinAcceptance(b, B, invitation, "0".repeat(64), NOW), /fingerprint/i);
    assert.throws(() => prepareTwinAcceptance(b, B, { ...invitation, secret: "A".repeat(43) }, invitation.body.inviter.fingerprint, NOW), /secret/i);
    assert.throws(() => prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW + 900_001), /expired/i);
    const acceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    const certificate = confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW);
    const forged: TwinCertificate = { ...certificate, inviterSignature: "A".repeat(86) };
    assert.throws(() => applyTwinCertificate(c, C, certificate), /participant/i);
    assert.throws(() => applyTwinCertificate(b, B, forged), /signature/i);
    assert.throws(() => applyTwinCertificate(c, C, certificate), /participant/i);
    const unsolicited = { ...certificate, body: { ...certificate.body, acceptor: getOrCreateClusterIdentity(c, C) } };
    assert.throws(() => applyTwinCertificate(c, C, unsolicited), /signature|unknown relationship/i);
    const selfInvitation = createTwinInvitation(a, A, NOW);
    assert.throws(() => prepareTwinAcceptance(a, A, selfInvitation, selfInvitation.body.inviter.fingerprint, NOW), /distinct|self/i);
    const otherAcceptance = prepareTwinAcceptance(c, C, createTwinInvitation(a, A, NOW), getOrCreateClusterIdentity(a, A).fingerprint, NOW);
    assert.throws(() => confirmTwinAcceptance(a, A, otherAcceptance, invitation.secret, NOW), /unknown|secret/i);
    assert.equal(pinnedClusterPublicKey(a, C), undefined); assert.equal(isTrustedTwin(a, A, C), false);
  } finally { close(f); }
});

test("a consumed invitation cannot be reused by another acceptor", () => {
  const f = fixture(); const [a, b, c] = f.dbs;
  try {
    const invitation = createTwinInvitation(a, A, NOW);
    const bAcceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    const cAcceptance = prepareTwinAcceptance(c, C, invitation, invitation.body.inviter.fingerprint, NOW);
    confirmTwinAcceptance(a, A, bAcceptance, invitation.secret, NOW);
    assert.throws(() => confirmTwinAcceptance(a, A, cAcceptance, invitation.secret, NOW), /already been used/i);
    assert.equal(pinnedClusterPublicKey(a, C), undefined);
    assert.equal(isTrustedTwin(a, A, C), false);
  } finally { close(f); }
});

test("a valid unsolicited certificate cannot activate without persisted local consent", () => {
  const f = fixture(); const [a, b] = f.dbs;
  try {
    const invitation = createTwinInvitation(a, A, NOW);
    const acceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    const certificate = confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW);
    b.prepare("DELETE FROM cluster_v2_twin_relationships WHERE relationship_id=?").run(certificate.body.relationshipId);
    assert.throws(() => applyTwinCertificate(b, B, certificate), /Unknown twin relationship/);
    assert.equal(isTrustedTwin(b, A, B), false);
  } finally { close(f); }
});

test("third-party and tampered revocations cannot revoke active trust", () => {
  const f = fixture(); const [a, b, c] = f.dbs;
  try {
    const certificate = pair(a, b);
    const relationshipId = certificate.body.relationshipId;
    const thirdParty = {
      relationshipId,
      signerNodeId: C,
      signature: signClusterMessage(c, C, "twin-revocation", JSON.stringify([relationshipId, C])),
    };
    assert.throws(() => applyTwinRevocation(a, A, thirdParty), /not a participant/i);
    const valid = revokeTwinRelationship(b, B, relationshipId);
    const replacement = valid.signature[0] === "A" ? "B" : "A";
    assert.throws(() => applyTwinRevocation(a, A, { ...valid, signature: replacement + valid.signature.slice(1) }), /signature/i);
    assert.equal(listTwinRelationships(a, A)[0]?.status, "active");
    assert.equal(isTrustedTwin(a, A, B), true);
    assert.equal(isTrustedTwin(b, A, B), false);
  } finally { close(f); }
});

test("revocation is permanent across reopen while a fresh relationship reconnects", () => {
  const f = fixture(true); let [a, b] = f.dbs;
  try {
    const oldCertificate = pair(a, b);
    const revocation = revokeTwinRelationship(b, B, oldCertificate.body.relationshipId);
    applyTwinRevocation(a, A, revocation); applyTwinRevocation(a, A, revocation);
    assert.equal(isTrustedTwin(a, A, B), false); assert.equal(isTrustedTwin(b, A, B), false);
    assert.throws(() => applyTwinCertificate(b, B, oldCertificate), /revoked/i);
    a.close(); b.close();
    a = f.dbs[0] = new DatabaseSync(f.paths[0]); b = f.dbs[1] = new DatabaseSync(f.paths[1]);
    ensureTwinSchema(a); ensureTwinSchema(b);
    assert.throws(() => applyTwinCertificate(b, B, oldCertificate), /revoked/i);
    const fresh = pair(a, b, NOW + 2_000_000);
    assert.notEqual(fresh.body.relationshipId, oldCertificate.body.relationshipId);
    applyTwinRevocation(a, A, revocation);
    assert.equal(isTrustedTwin(a, A, B), true, "old revocation must not disconnect a newer active relationship");
  } finally { close(f); }
});

test("pairing grants private receive access but no resharing, transitive access, or membership", () => {
  const f = fixture(); const [a, b] = f.dbs;
  try {
    pair(a, b);
    registerOwnedResource(a, { kind: "project", id: "private", ownerNodeId: A }, A);
    registerOwnedResource(a, { kind: "secret", id: "private-secret", ownerNodeId: A }, A);
    assert.equal(mayReceiveResource(a, B, "project", "private"), true);
    assert.equal(mayReceiveResource(a, B, "secret", "private-secret"), true);
    assert.throws(() => setResourceShares(a, B, "project", "private", []), /authoriz/i);
    assert.deepEqual(listSharingMemberships(a, A), []); assert.deepEqual(listSharingMemberships(a, B), []);
    assert.equal(mayReceiveResource(a, C, "project", "private"), false);
  } finally { close(f); }
});

test("caller rollback and conflicting pins leave lifecycle changes atomic", () => {
  const f = fixture(); const [a, b, c] = f.dbs;
  try {
    const invitation = createTwinInvitation(a, A, NOW);
    b.exec("BEGIN");
    prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    b.exec("ROLLBACK");
    assert.equal(pinnedClusterPublicKey(b, A), undefined); assert.deepEqual(listTwinRelationships(b, B), []);
    const acceptance: TwinAcceptance = prepareTwinAcceptance(b, B, invitation, invitation.body.inviter.fingerprint, NOW);
    a.exec("BEGIN"); confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW); a.exec("ROLLBACK");
    assert.equal(isTrustedTwin(a, A, B), false);
    const wrong = getOrCreateClusterIdentity(c, C);
    a.prepare("INSERT INTO cluster_v2_public_keys(node_id,public_key) VALUES (?,?)").run(B, wrong.publicKey);
    assert.throws(() => confirmTwinAcceptance(a, A, acceptance, invitation.secret, NOW), /replaced|conflict/i);
    const row = a.prepare("SELECT consumed_acceptance FROM cluster_v2_twin_invitations WHERE relationship_id=?").get(invitation.body.relationshipId) as { consumed_acceptance: string | null };
    assert.equal(row.consumed_acceptance, null); assert.equal(isTrustedTwin(a, A, B), false);
  } finally { close(f); }
});
