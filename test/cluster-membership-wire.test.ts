import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  applyMembershipSnapshot,
  createMembershipCluster,
  createMembershipInvitation,
  getMembershipSnapshot,
  listMembershipDeliveries,
  prepareMembershipJoin,
  redeemMembershipInvitation,
  removeMembershipMember,
  type MembershipEntry,
} from "../src/cluster-membership.js";
import { clusterPublicKeyFingerprint, getOrCreateClusterIdentity, pinnedClusterPublicKey, signClusterMessage } from "../src/cluster-identity.js";
import {
  createSharingCluster,
  listResourceShares,
  listSharingClusterMembers,
  mayReceiveResource,
  prepareSharingManagerTransfer,
  registerOwnedResource,
  setAutoShareProjects,
  setResourceShares,
} from "../src/cluster-sharing-policy.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const CLUSTER = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const REQUEST_C = "20000000-0000-4000-8000-000000000003";
const REQUEST_C_AGAIN = "20000000-0000-4000-8000-000000000004";
const REQUEST_B_AGAIN = "20000000-0000-4000-8000-000000000005";
const TRANSFER = "30000000-0000-4000-8000-000000000001";
const OTHER_CLUSTER = "10000000-0000-4000-8000-000000000002";
const local = (nodeId: string, name: string, port: number) => ({ nodeId, name, url: `http://127.0.0.1:${port}` });
const db = () => { const value = new DatabaseSync(":memory:"); value.exec("PRAGMA foreign_keys=ON"); return value; };

function join(manager: DatabaseSync, receiver: DatabaseSync, now = 1_700_000_000_000) {
  const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, now);
  const request = prepareMembershipJoin(receiver, local(B, "Beta", 4002), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST, now);
  return { invitation, request, snapshot: redeemMembershipInvitation(manager, A, request, invitation.secret, now) };
}

test("membership-only signed invitation joins and applies without leaking policy data", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const result = join(manager, receiver);
    applyMembershipSnapshot(receiver, B, result.snapshot);
    assert.deepEqual(listSharingClusterMembers(receiver, CLUSTER).map((entry) => [entry.nodeId, entry.joinSequence]), [[A, 1], [B, 2]]);
    assert.equal(JSON.stringify(result.invitation).includes("project"), false);
    assert.equal(/token|secret|grant|twin/i.test(JSON.stringify(result.snapshot)), false);
  } finally { manager.close(); receiver.close(); }
});

test("proof, secret, expiry, and consumed invitation rules are transactional", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
    const request = prepareMembershipJoin(receiver, local(B, "Beta", 4002), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST, 1000);
    assert.throws(() => redeemMembershipInvitation(manager, A, request, "x".repeat(43), 1000), /secret|invitation/i);
    assert.equal(listSharingClusterMembers(manager, CLUSTER).length, 1);
    assert.throws(() => redeemMembershipInvitation(manager, A, request, invitation.secret, invitation.body.expiresAt + 1), /expired/i);
    const snapshot = redeemMembershipInvitation(manager, A, request, invitation.secret, 1001);
    assert.deepEqual(redeemMembershipInvitation(manager, A, request, invitation.secret, invitation.body.expiresAt + 1), snapshot);
    assert.equal(listSharingClusterMembers(manager, CLUSTER)[1].joinSequence, 2);
  } finally { manager.close(); receiver.close(); }
});

test("snapshots require accepted cluster authority and preserve receiver preference", () => {
  const manager = db(), receiver = db(), stranger = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const { snapshot } = join(manager, receiver);
    assert.throws(() => applyMembershipSnapshot(stranger, C, snapshot), /pending|accepted|invitation/i);
    applyMembershipSnapshot(receiver, B, snapshot);
    setAutoShareProjects(receiver, CLUSTER, B, true);
    applyMembershipSnapshot(receiver, B, snapshot);
    assert.equal(listSharingClusterMembers(receiver, CLUSTER).find((entry) => entry.nodeId === B)?.autoShareProjects, true);
    const forged = structuredClone(snapshot); forged.body.managerEpoch = 2;
    assert.throws(() => applyMembershipSnapshot(receiver, B, forged), /signature|activation|conflict/i);
    assert.deepEqual(getMembershipSnapshot(receiver, CLUSTER), snapshot);
  } finally { manager.close(); receiver.close(); stranger.close(); }
});

test("a departed local node requires fresh consent before re-admission", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const admitted = join(manager, receiver).snapshot;
    applyMembershipSnapshot(receiver, B, admitted);
    const originalB: MembershipEntry = admitted.body.members.find((member) => member.nodeId === B)!;
    const departed = removeMembershipMember(manager, A, B, CLUSTER, B, 1);
    applyMembershipSnapshot(receiver, B, departed);
    setAutoShareProjects(receiver, CLUSTER, A, true);
    const managerPin = pinnedClusterPublicKey(receiver, A);
    const localPin = pinnedClusterPublicKey(receiver, B);

    const body = structuredClone(departed.body);
    body.revision += 1;
    body.members.push({ ...originalB, joinSequence: body.nextJoinSequence });
    body.nextJoinSequence += 1;
    const unauthorized = { body, signerNodeId: A, signature: signClusterMessage(manager, A, "membership-snapshot", JSON.stringify(body)) };
    assert.throws(() => applyMembershipSnapshot(receiver, B, unauthorized), /consent|pending|invitation|admission/i);
    assert.deepEqual(getMembershipSnapshot(receiver, CLUSTER), departed);
    assert.equal(listSharingClusterMembers(receiver, CLUSTER).some((member) => member.nodeId === B), false);
    assert.equal(listSharingClusterMembers(receiver, CLUSTER).find((member) => member.nodeId === A)?.autoShareProjects, true);
    assert.equal(pinnedClusterPublicKey(receiver, A), managerPin);
    assert.equal(pinnedClusterPublicKey(receiver, B), localPin);
    assert.equal((receiver.prepare("SELECT count(*) AS count FROM cluster_v2_membership_joins WHERE cluster_id=?").get(CLUSTER) as { count: number }).count, 0);

    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 2000);
    const request = prepareMembershipJoin(receiver, local(B, "Beta", 4002), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST_B_AGAIN, 2000);
    const rejoined = redeemMembershipInvitation(manager, A, request, invitation.secret, 2000);
    applyMembershipSnapshot(receiver, B, rejoined);
    assert.ok(listSharingClusterMembers(receiver, CLUSTER).find((member) => member.nodeId === B)!.joinSequence > originalB.joinSequence);
    assert.equal((receiver.prepare("SELECT count(*) AS count FROM cluster_v2_membership_joins WHERE cluster_id=?").get(CLUSTER) as { count: number }).count, 0);
    applyMembershipSnapshot(receiver, B, rejoined);
  } finally { manager.close(); receiver.close(); }
});

test("a skipped local departure and rejoin requires fresh consent", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const admitted = join(manager, receiver).snapshot;
    applyMembershipSnapshot(receiver, B, admitted);
    removeMembershipMember(manager, A, B, CLUSTER, B, 1);
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 2000);
    const member = { ...local(B, "Beta", 4002), publicKey: getOrCreateClusterIdentity(receiver, B).publicKey };
    const unsigned = { invitationId: invitation.body.invitationId, clusterId: CLUSTER, requestId: REQUEST_B_AGAIN, member };
    const request = { ...unsigned, signature: signClusterMessage(receiver, B, "membership-join", JSON.stringify(unsigned)) };
    const rejoined = redeemMembershipInvitation(manager, A, request, invitation.secret, 2000);

    assert.throws(() => applyMembershipSnapshot(receiver, B, rejoined), /consent|pending|invitation|admission/i);
    assert.deepEqual(getMembershipSnapshot(receiver, CLUSTER), admitted);
    assert.equal(listSharingClusterMembers(receiver, CLUSTER).find((entry) => entry.nodeId === B)?.joinSequence, 2);
  } finally { manager.close(); receiver.close(); }
});

test("consumed invitation retry always requires its secret", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
    const request = prepareMembershipJoin(receiver, local(B, "Beta", 4002), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST, 1000);
    const snapshot = redeemMembershipInvitation(manager, A, request, invitation.secret, 1001);
    const queued = listMembershipDeliveries(manager);
    assert.throws(() => redeemMembershipInvitation(manager, A, request, "x".repeat(43), 1002), /secret/i);
    assert.deepEqual(getMembershipSnapshot(manager, CLUSTER), snapshot);
    assert.deepEqual(listMembershipDeliveries(manager), queued);
    assert.deepEqual(redeemMembershipInvitation(manager, A, request, invitation.secret, invitation.body.expiresAt + 1), snapshot);
  } finally { manager.close(); receiver.close(); }
});

test("initial signed snapshot cannot silently choose another manager", () => {
  const manager = db(), receiver = db(), participant = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    const invitationB = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
    const requestB = prepareMembershipJoin(receiver, local(B, "Beta", 4002), invitationB, clusterPublicKeyFingerprint(invitationB.body.manager.publicKey), REQUEST, 1000);
    redeemMembershipInvitation(manager, A, requestB, invitationB.secret, 1000);
    const invitationC = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
    const requestC = prepareMembershipJoin(participant, local(C, "Gamma", 4003), invitationC, clusterPublicKeyFingerprint(invitationC.body.manager.publicKey), REQUEST_C, 1000);
    const current = redeemMembershipInvitation(manager, A, requestC, invitationC.secret, 1000);
    const body = structuredClone(current.body);
    body.managerNodeId = C;
    const mutated = { body, signerNodeId: A, signature: signClusterMessage(manager, A, "membership-snapshot", JSON.stringify(body)) };
    assert.throws(() => applyMembershipSnapshot(receiver, B, mutated), /activation|manager|authority/i);
    assert.throws(() => getMembershipSnapshot(receiver, CLUSTER), /unknown/i);
  } finally { manager.close(); receiver.close(); participant.close(); }
});

function setupResourceProjection(manager: DatabaseSync, receiver: DatabaseSync, participant: DatabaseSync) {
  createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
  const joinedB = join(manager, receiver);
  applyMembershipSnapshot(receiver, B, joinedB.snapshot);
  const invitationC = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
  const requestC = prepareMembershipJoin(participant, local(C, "Gamma", 4003), invitationC, clusterPublicKeyFingerprint(invitationC.body.manager.publicKey), REQUEST_C, 1000);
  const joinedC = redeemMembershipInvitation(manager, A, requestC, invitationC.secret, 1000);
  applyMembershipSnapshot(receiver, B, joinedC);
  applyMembershipSnapshot(participant, C, joinedC);
  registerOwnedResource(receiver, { kind: "project", id: "c-project", ownerNodeId: C }, B);
  registerOwnedResource(receiver, { kind: "secret", id: "b-secret", ownerNodeId: B }, B);
  setResourceShares(receiver, C, "project", "c-project", [{ clusterId: CLUSTER, projectId: null }]);
  setResourceShares(receiver, B, "secret", "b-secret", [{ clusterId: CLUSTER, projectId: "c-project" }]);
  return joinedC.body.members.find((member) => member.nodeId === C)!.joinSequence;
}

test("skipped departure and rejoin purges old-admission resource grants", () => {
  const manager = db(), receiver = db(), participant = db();
  try {
    const oldRank = setupResourceProjection(manager, receiver, participant);
    createSharingCluster(receiver, { id: OTHER_CLUSTER, name: "Other" }, B);
    registerOwnedResource(receiver, { kind: "project", id: "unrelated", ownerNodeId: B }, B);
    setResourceShares(receiver, B, "project", "unrelated", [{ clusterId: OTHER_CLUSTER, projectId: null }]);
    setAutoShareProjects(receiver, CLUSTER, B, true);
    const removed = removeMembershipMember(manager, A, A, CLUSTER, C, 1);
    applyMembershipSnapshot(participant, C, removed);
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 2000);
    const request = prepareMembershipJoin(participant, local(C, "Gamma", 4003), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST_C_AGAIN, 2000);
    const rejoined = redeemMembershipInvitation(manager, A, request, invitation.secret, 2000);
    applyMembershipSnapshot(receiver, B, rejoined);
    const members = listSharingClusterMembers(receiver, CLUSTER);
    assert.ok(members.find((member) => member.nodeId === C)!.joinSequence > oldRank);
    assert.deepEqual(listResourceShares(receiver, "project", "c-project"), []);
    assert.deepEqual(listResourceShares(receiver, "secret", "b-secret"), []);
    assert.equal(mayReceiveResource(receiver, B, "project", "c-project"), false);
    assert.deepEqual(listResourceShares(receiver, "project", "unrelated"), [{ clusterId: OTHER_CLUSTER, projectId: null }]);
    assert.equal(members.find((member) => member.nodeId === B)!.autoShareProjects, true);
    assert.equal(members.find((member) => member.nodeId === C)!.autoShareProjects, false);
  } finally { manager.close(); receiver.close(); participant.close(); }
});

test("observed departure permanently removes dependent scoped secrets", () => {
  const manager = db(), receiver = db(), participant = db();
  try {
    setupResourceProjection(manager, receiver, participant);
    const removed = removeMembershipMember(manager, A, A, CLUSTER, C, 1);
    applyMembershipSnapshot(receiver, B, removed);
    applyMembershipSnapshot(participant, C, removed);
    assert.deepEqual(listResourceShares(receiver, "project", "c-project"), []);
    assert.deepEqual(listResourceShares(receiver, "secret", "b-secret"), []);
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 2000);
    const request = prepareMembershipJoin(participant, local(C, "Gamma", 4003), invitation, clusterPublicKeyFingerprint(invitation.body.manager.publicKey), REQUEST_C_AGAIN, 2000);
    const rejoined = redeemMembershipInvitation(manager, A, request, invitation.secret, 2000);
    applyMembershipSnapshot(receiver, B, rejoined);
    setResourceShares(receiver, C, "project", "c-project", [{ clusterId: CLUSTER, projectId: null }]);
    assert.deepEqual(listResourceShares(receiver, "secret", "b-secret"), []);
  } finally { manager.close(); receiver.close(); participant.close(); }
});

test("pending transfer blocks fresh invitation consumption by current member", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    join(manager, receiver);
    const invitation = createMembershipInvitation(manager, A, A, CLUSTER, 1, 1000);
    const member = { ...local(B, "Beta", 4002), publicKey: getOrCreateClusterIdentity(receiver, B).publicKey };
    const unsigned = { invitationId: invitation.body.invitationId, clusterId: CLUSTER, requestId: REQUEST_C, member };
    const request = { ...unsigned, signature: signClusterMessage(receiver, B, "membership-join", JSON.stringify(unsigned)) };
    prepareSharingManagerTransfer(manager, CLUSTER, A, B, 1, TRANSFER);
    const revision = getMembershipSnapshot(manager, CLUSTER).body.revision;
    const queued = listMembershipDeliveries(manager);
    assert.throws(() => redeemMembershipInvitation(manager, A, request, invitation.secret, 1000), /pending transfer/i);
    assert.equal(getMembershipSnapshot(manager, CLUSTER).body.revision, revision);
    assert.deepEqual(listMembershipDeliveries(manager), queued);
    const row = manager.prepare("SELECT request_id FROM cluster_v2_membership_invitations WHERE invitation_id=?").get(invitation.body.invitationId) as { request_id: string | null };
    assert.equal(row.request_id, null);
  } finally { manager.close(); receiver.close(); }
});

test("removal publishes tombstone and queues the removed endpoint", () => {
  const manager = db(), receiver = db();
  try {
    createMembershipCluster(manager, local(A, "Alpha", 4001), { id: CLUSTER, name: "Team" });
    join(manager, receiver);
    const removed = removeMembershipMember(manager, A, A, CLUSTER, B, 1);
    assert.deepEqual(removed.body.departures, [{ nodeId: B, joinSequence: 2 }]);
    assert.ok(listMembershipDeliveries(manager).some((delivery) => delivery.peerId === B && delivery.revision === 3));
  } finally { manager.close(); receiver.close(); }
});
