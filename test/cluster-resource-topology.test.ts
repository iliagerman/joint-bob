import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  applyMembershipSnapshot,
  createMembershipCluster,
  createMembershipInvitation,
  getMembershipSnapshot,
  prepareMembershipJoin,
  redeemMembershipInvitation,
  removeMembershipMember,
  type MembershipJoinRequest,
  type SignedMembershipSnapshot,
} from "../src/cluster-membership.js";
import { clusterPublicKeyFingerprint, pinnedClusterPublicKey } from "../src/cluster-identity.js";
import { peerEndpoint } from "../src/cluster-peer-endpoints.js";
import { listResourceShares } from "../src/cluster-sharing-policy.js";
import {
  acknowledgeResourcePolicyDelivery,
  applyResourcePolicy,
  getResourcePolicyState,
  listResourcePolicyDeliveries,
  queueResourcePolicyBootstrap,
  reconcileOwnedResourceTopology,
  registerLocalSharingResource,
  updateResourceSharing,
} from "../src/cluster-sharing.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const X = "10000000-0000-4000-8000-000000000001";
const REQUEST_B = "20000000-0000-4000-8000-000000000002";
const REQUEST_B_AGAIN = "20000000-0000-4000-8000-000000000003";
const nodes = {
  A: { nodeId: A, name: "Alpha", url: "https://alpha.example" },
  B: { nodeId: B, name: "Beta", url: "https://beta.example" },
  C: { nodeId: C, name: "Gamma", url: "https://gamma.example" },
};

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

function prepareJoin(
  manager: DatabaseSync,
  joining: DatabaseSync,
  requestId = REQUEST_B,
  now = 1_700_000_000_000,
): { request: MembershipJoinRequest; secret: string; invitationId: string } {
  const invitation = createMembershipInvitation(manager, A, A, X, 1, now);
  const request = prepareMembershipJoin(
    joining,
    nodes.B,
    invitation,
    clusterPublicKeyFingerprint(invitation.body.manager.publicKey),
    requestId,
    now,
  );
  return { request, secret: invitation.secret, invitationId: invitation.body.invitationId };
}

function join(manager: DatabaseSync, joining: DatabaseSync, requestId = REQUEST_B): SignedMembershipSnapshot {
  const prepared = prepareJoin(manager, joining, requestId);
  const snapshot = redeemMembershipInvitation(manager, A, prepared.request, prepared.secret, 1_700_000_000_000);
  applyMembershipSnapshot(joining, B, snapshot);
  return snapshot;
}

function projectDelivery(db: DatabaseSync, peer: string, operation: "upsert" | "unshare") {
  return listResourcePolicyDeliveries(db).find((delivery) =>
    delivery.peerId === peer
    && delivery.statement.body.kind === "project"
    && delivery.statement.body.resourceId === "p"
    && delivery.statement.body.operation === operation);
}

function deliverAndAcknowledge(owner: DatabaseSync, receiver: DatabaseSync, peer: string, kind: "project" | "secret"): void {
  const delivery = listResourcePolicyDeliveries(owner).find((item) =>
    item.peerId === peer && item.statement.body.kind === kind && item.statement.body.operation === "upsert");
  assert.ok(delivery, `expected initial ${kind} upsert for ${peer}`);
  applyResourcePolicy(receiver, peer, delivery.statement.body.ownerNodeId, delivery.statement);
  acknowledgeResourcePolicyDelivery(owner, delivery.operationId, peer);
}

test("verified admission atomically bootstraps existing owner selections", () => {
  const manager = memoryDb(), receiver = memoryDb();
  try {
    createMembershipCluster(manager, nodes.A, { id: X, name: "X" });
    registerLocalSharingResource(manager, A, { kind: "project", id: "p" });
    const selected = updateResourceSharing(manager, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    assert.equal(listResourcePolicyDeliveries(manager).length, 0);

    join(manager, receiver);

    const delivery = projectDelivery(manager, B, "upsert");
    assert.ok(delivery, "joining B must receive A's already-selected project without another policy mutation");
    assert.equal(getResourcePolicyState(manager, "project", "p").generation, selected.generation,
      "a new recipient must not advance the owner's policy generation");
    assert.equal(delivery.statement.body.generation, selected.generation);
    assert.deepEqual(delivery.statement.body.context, {
      kind: "cluster", id: X, ownerJoinSequence: 1, recipientJoinSequence: 2,
    });
    applyResourcePolicy(receiver, B, A, delivery.statement);
    assert.deepEqual(getResourcePolicyState(receiver, "project", "p"), {
      kind: "project", resourceId: "p", ownerNodeId: A, generation: selected.generation, deleted: false,
    });
  } finally { manager.close(); receiver.close(); }
});

test("verified departure replaces queued positives with an owner revocation", () => {
  const manager = memoryDb(), receiver = memoryDb();
  try {
    createMembershipCluster(manager, nodes.A, { id: X, name: "X" });
    const admitted = join(manager, receiver);
    registerLocalSharingResource(manager, A, { kind: "project", id: "p" });
    const selected = updateResourceSharing(manager, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    deliverAndAcknowledge(manager, receiver, B, "project");
    queueResourcePolicyBootstrap(manager, A, "project", "p");
    assert.equal(projectDelivery(manager, B, "upsert")?.statement.body.generation, selected.generation);

    const departed = removeMembershipMember(manager, A, A, X, B, 1);

    assert.equal(projectDelivery(manager, B, "upsert"), undefined, "departure must cancel the queued old-admission positive");
    const revocation = projectDelivery(manager, B, "unshare");
    assert.ok(revocation, "departure must queue an original-owner-signed unshare");
    assert.ok(revocation.statement.body.generation > selected.generation);
    assert.deepEqual(revocation.statement.body.context, {
      kind: "cluster", id: X, ownerJoinSequence: 1, recipientJoinSequence: 2,
    });
    const reconciledGeneration = getResourcePolicyState(manager, "project", "p").generation;
    reconcileOwnedResourceTopology(manager, A, X);
    assert.equal(getResourcePolicyState(manager, "project", "p").generation, reconciledGeneration);
    assert.equal(projectDelivery(manager, B, "unshare")?.operationId, revocation.operationId,
      "re-applying departure reconciliation must not queue a new revocation");
    applyMembershipSnapshot(receiver, B, departed);
    applyMembershipSnapshot(receiver, B, departed);
    applyResourcePolicy(receiver, B, A, revocation.statement);
    assert.deepEqual(listResourceShares(receiver, "project", "p"), []);
    assert.deepEqual(peerEndpoint(receiver, "cluster", X, A), { nodeId: A, name: "Alpha", url: nodes.A.url });
    assert.equal(getResourcePolicyState(receiver, "project", "p").ownerNodeId, A);
    assert.equal(admitted.body.members.length, 2);
  } finally { manager.close(); receiver.close(); }
});

test("departed original owner revokes its own project and scoped secret without manager forgery or rejoin restoration", () => {
  const manager = memoryDb(), owner = memoryDb();
  try {
    createMembershipCluster(manager, nodes.A, { id: X, name: "X" });
    join(manager, owner);
    registerLocalSharingResource(owner, B, { kind: "project", id: "p" });
    updateResourceSharing(owner, B, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    registerLocalSharingResource(owner, B, { kind: "secret", id: "s" });
    updateResourceSharing(owner, B, "secret", "s", 1, [{ clusterId: X, projectId: "p" }]);
    deliverAndAcknowledge(owner, manager, A, "project");
    deliverAndAcknowledge(owner, manager, A, "secret");
    assert.deepEqual(listResourceShares(manager, "project", "p"), [{ clusterId: X, projectId: null }]);
    assert.deepEqual(listResourceShares(manager, "secret", "s"), [{ clusterId: X, projectId: "p" }]);

    const departed = removeMembershipMember(manager, A, A, X, B, 1);
    applyMembershipSnapshot(owner, B, departed);

    const cleanup = listResourcePolicyDeliveries(owner).filter((item) => item.peerId === A);
    assert.deepEqual(cleanup.map((item) => [item.statement.body.kind, item.statement.body.operation]).sort(), [
      ["project", "unshare"], ["secret", "unshare"],
    ]);
    assert.deepEqual(listResourceShares(owner, "project", "p"), []);
    assert.deepEqual(listResourceShares(owner, "secret", "s"), []);
    assert.equal(listResourcePolicyDeliveries(manager).some((item) => item.statement.body.ownerNodeId === B), false);
    for (const delivery of cleanup) applyResourcePolicy(manager, A, B, delivery.statement);
    assert.deepEqual(listResourceShares(manager, "project", "p"), []);
    assert.deepEqual(listResourceShares(manager, "secret", "s"), []);

    const rejoined = join(manager, owner, REQUEST_B_AGAIN);
    assert.ok(rejoined.body.members.find((member) => member.nodeId === B)!.joinSequence > 2);
    assert.equal(rejoined.body.managerNodeId, A);
    assert.deepEqual(listResourceShares(owner, "project", "p"), []);
    assert.deepEqual(listResourceShares(owner, "secret", "s"), []);
    assert.equal(listResourcePolicyDeliveries(owner).some((item) => item.statement.body.operation === "upsert"), false);
  } finally { manager.close(); owner.close(); }
});

test("admission and resource bootstrap roll back together and the same join retries", () => {
  const manager = memoryDb(), receiver = memoryDb();
  try {
    createMembershipCluster(manager, nodes.A, { id: X, name: "X" });
    registerLocalSharingResource(manager, A, { kind: "project", id: "p" });
    updateResourceSharing(manager, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    const prepared = prepareJoin(manager, receiver);
    const beforeSnapshot = getMembershipSnapshot(manager, X);
    const beforeInvitation = manager.prepare(`SELECT request_id,member_id,request,redemption
      FROM cluster_v2_membership_invitations WHERE invitation_id=?`).get(prepared.invitationId);
    const beforeOutbox = listResourcePolicyDeliveries(manager);
    manager.exec(`CREATE TRIGGER fail_resource_bootstrap BEFORE INSERT ON cluster_v2_resource_deliveries
      BEGIN SELECT RAISE(ABORT, 'synthetic resource bootstrap failure'); END`);

    assert.throws(
      () => redeemMembershipInvitation(manager, A, prepared.request, prepared.secret, 1_700_000_000_000),
      /synthetic resource bootstrap failure/,
    );
    assert.deepEqual(getMembershipSnapshot(manager, X), beforeSnapshot);
    assert.equal(manager.prepare("SELECT count(*) count FROM sharing_memberships WHERE cluster_id=?").get(X)?.count, 1);
    assert.deepEqual(manager.prepare(`SELECT request_id,member_id,request,redemption
      FROM cluster_v2_membership_invitations WHERE invitation_id=?`).get(prepared.invitationId), beforeInvitation);
    assert.deepEqual(listResourcePolicyDeliveries(manager), beforeOutbox);
    assert.equal(pinnedClusterPublicKey(manager, B), undefined);

    manager.exec("DROP TRIGGER fail_resource_bootstrap");
    const admitted = redeemMembershipInvitation(manager, A, prepared.request, prepared.secret, 1_700_000_000_000);
    assert.equal(admitted.body.members.filter((member) => member.nodeId === B).length, 1);
    const bootstraps = listResourcePolicyDeliveries(manager).filter((item) =>
      item.peerId === B && item.statement.body.resourceId === "p" && item.statement.body.operation === "upsert");
    assert.equal(bootstraps.length, 1);
    assert.equal(bootstraps[0].statement.body.generation, 2);
  } finally { manager.close(); receiver.close(); }
});
