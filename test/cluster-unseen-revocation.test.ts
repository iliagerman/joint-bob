import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getOrCreateClusterIdentity, pinClusterPublicKey, signClusterMessage } from "../src/cluster-identity.js";
import {
  addSharingMember,
  createSharingCluster,
  listResourceShares,
} from "../src/cluster-sharing-policy.js";
import {
  applyResourcePolicy,
  deleteSharedResource,
  ensureResourceSharingSchema,
  getResourcePolicyState,
  listResourcePolicyDeliveries,
  registerLocalSharingResource,
  updateResourceSharing,
  type PolicyBody,
  type SignedResourcePolicy,
} from "../src/cluster-sharing.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const X = "10000000-0000-4000-8000-000000000001";

function database(nodeId: string): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  value.exec("PRAGMA foreign_keys=ON");
  ensureResourceSharingSchema(value);
  getOrCreateClusterIdentity(value, nodeId);
  return value;
}

function installTopology(value: DatabaseSync): void {
  createSharingCluster(value, { id: X, name: "X" }, A);
  addSharingMember(value, X, A, B, 1);
}

function delivery(
  owner: DatabaseSync,
  operation: "upsert" | "unshare" | "delete",
  generation: number,
): SignedResourcePolicy {
  const queued = listResourcePolicyDeliveries(owner).find((item) =>
    item.peerId === B
    && item.statement.body.kind === "project"
    && item.statement.body.operation === operation
    && item.statement.body.generation === generation);
  assert.ok(queued, `missing ${operation} generation ${generation} delivery`);
  return queued.statement;
}

function assertProjectNotAdopted(receiver: DatabaseSync): void {
  const owners = receiver.prepare(
    "SELECT count(*) AS count FROM sharing_resource_owners WHERE kind='project' AND resource_id='p'",
  ).get() as { count: number };
  const policies = receiver.prepare(
    "SELECT count(*) AS count FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id='p'",
  ).get() as { count: number };
  assert.equal(owners.count, 0);
  assert.equal(policies.count, 0);
}

function setup(): { owner: DatabaseSync; receiver: DatabaseSync } {
  const owner = database(A);
  const receiver = database(B);
  installTopology(owner);
  installTopology(receiver);
  pinClusterPublicKey(receiver, A, getOrCreateClusterIdentity(owner, A).publicKey);
  return { owner, receiver };
}

test("unshare before initial delivery fences old upsert without adopting resource", () => {
  const { owner, receiver } = setup();
  try {
    registerLocalSharingResource(owner, A, { kind: "project", id: "p" });
    updateResourceSharing(owner, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    const oldUpsert = delivery(owner, "upsert", 2);

    updateResourceSharing(owner, A, "project", "p", 2, []);
    const unshare = delivery(owner, "unshare", 3);
    assert.doesNotThrow(() => applyResourcePolicy(receiver, B, A, unshare));
    assertProjectNotAdopted(receiver);
    assert.doesNotThrow(() => applyResourcePolicy(receiver, B, A, unshare));
    assert.throws(() => applyResourcePolicy(receiver, B, A, oldUpsert), /stale|revoked/i);

    updateResourceSharing(owner, A, "project", "p", 3, [{ clusterId: X, projectId: null }]);
    applyResourcePolicy(receiver, B, A, delivery(owner, "upsert", 4));
    assert.deepEqual(getResourcePolicyState(receiver, "project", "p"), {
      kind: "project", resourceId: "p", ownerNodeId: A, generation: 4, deleted: false,
    });
    assert.deepEqual(listResourceShares(receiver, "project", "p"), [{ clusterId: X, projectId: null }]);
  } finally {
    owner.close();
    receiver.close();
  }
});

test("unseen deletion does not reserve another owner's resource namespace", () => {
  const { owner, receiver } = setup();
  try {
    registerLocalSharingResource(owner, A, { kind: "project", id: "p" });
    updateResourceSharing(owner, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    deleteSharedResource(owner, A, "project", "p", 2);
    const deletion = delivery(owner, "delete", 3);
    applyResourcePolicy(receiver, B, A, deletion);

    const local = registerLocalSharingResource(receiver, B, { kind: "project", id: "p" });
    assert.equal(local.ownerNodeId, B);
    assert.equal(listResourcePolicyDeliveries(receiver).some((item) =>
      item.peerId === B || item.statement.body.ownerNodeId === A), false);

    assert.throws(() => applyResourcePolicy(receiver, B, A, deletion), /owner/i);
    assert.deepEqual(getResourcePolicyState(receiver, "project", "p"), {
      kind: "project", resourceId: "p", ownerNodeId: B, generation: 1, deleted: false,
    });
  } finally {
    owner.close();
    receiver.close();
  }
});

test("delete before initial delivery is terminal without claiming unknown resource ownership", () => {
  const { owner, receiver } = setup();
  try {
    registerLocalSharingResource(owner, A, { kind: "project", id: "p" });
    updateResourceSharing(owner, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    const oldUpsert = delivery(owner, "upsert", 2);

    deleteSharedResource(owner, A, "project", "p", 2);
    const deletion = delivery(owner, "delete", 3);
    assert.doesNotThrow(() => applyResourcePolicy(receiver, B, A, deletion));
    assertProjectNotAdopted(receiver);
    assert.doesNotThrow(() => applyResourcePolicy(receiver, B, A, deletion));
    assert.throws(() => applyResourcePolicy(receiver, B, A, oldUpsert), /deleted|stale|terminal/i);

    const body: PolicyBody = {
      ...oldUpsert.body,
      generation: 4,
      operationId: randomUUID(),
    };
    const forkedUpsert: SignedResourcePolicy = {
      body,
      signature: signClusterMessage(owner, A, "resource-policy", JSON.stringify(body)),
    };
    assert.throws(() => applyResourcePolicy(receiver, B, A, forkedUpsert), /deleted|terminal/i);
    assertProjectNotAdopted(receiver);
    assert.throws(() => applyResourcePolicy(receiver, B, C, deletion), /owner|revoke/i);
  } finally {
    owner.close();
    receiver.close();
  }
});
