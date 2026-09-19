import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptSharingManagerTransfer,
  addSharingMember,
  commitSharingManagerTransfer,
  createSharingCluster,
  listResourceShares,
  prepareSharingManagerTransfer,
  removeSharingMember,
} from "../src/cluster-sharing-policy.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import {
  applyResourcePolicy,
  ensureResourceSharingSchema,
  getResourcePolicyState,
  listResourcePolicyDeliveries,
  registerLocalSharingResource,
  updateResourceSharing,
} from "../src/cluster-sharing.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const X = "10000000-0000-4000-8000-000000000001";
const Y = "10000000-0000-4000-8000-000000000002";
const TRANSFER = "30000000-0000-4000-8000-000000000001";

function database(nodeId: string): DatabaseSync {
  const value = new DatabaseSync(":memory:");
  value.exec("PRAGMA foreign_keys=ON");
  ensureResourceSharingSchema(value);
  getOrCreateClusterIdentity(value, nodeId);
  return value;
}

function createCluster(
  value: DatabaseSync,
  id: string,
  name: string,
  members: string[],
): void {
  createSharingCluster(value, { id, name }, A);
  for (const member of members) addSharingMember(value, id, A, member, 1);
}

function transferXAndRemoveA(value: DatabaseSync): void {
  prepareSharingManagerTransfer(value, X, A, C, 1, TRANSFER);
  acceptSharingManagerTransfer(value, X, C, TRANSFER);
  commitSharingManagerTransfer(value, X, A, TRANSFER);
  removeSharingMember(value, X, A, A);
}

test("duplicate policy replay still authenticates the transport sender", () => {
  const owner = database(A);
  const receiver = database(B);
  const outsider = database(D);
  try {
    createCluster(owner, X, "X", [B, C]);
    createCluster(receiver, X, "X", [B, C]);
    pinClusterPublicKey(receiver, A, getOrCreateClusterIdentity(owner, A).publicKey);
    pinClusterPublicKey(receiver, D, getOrCreateClusterIdentity(outsider, D).publicKey);

    registerLocalSharingResource(owner, A, { kind: "project", id: "p" });
    updateResourceSharing(owner, A, "project", "p", 1, [{ clusterId: X, projectId: null }]);
    const statement = listResourcePolicyDeliveries(owner).find(
      (item) => item.peerId === B && item.statement.body.generation === 2,
    )!.statement;
    applyResourcePolicy(receiver, B, A, statement);
    const stateBeforeReplay = getResourcePolicyState(receiver, "project", "p");
    const sharesBeforeReplay = listResourceShares(receiver, "project", "p");

    assert.throws(
      () => applyResourcePolicy(receiver, B, D, statement),
      /Unauthorized|context|sender|member/,
    );
    assert.deepEqual(getResourcePolicyState(receiver, "project", "p"), stateBeforeReplay);
    assert.deepEqual(listResourceShares(receiver, "project", "p"), sharesBeforeReplay);
  } finally {
    owner.close();
    receiver.close();
    outsider.close();
  }
});

test("departed-owner context does not poison an independent cluster policy update", () => {
  const owner = database(A);
  const receiver = database(B);
  try {
    for (const value of [owner, receiver]) {
      createCluster(value, X, "X", [B, C]);
      createCluster(value, Y, "Y", [B]);
    }
    pinClusterPublicKey(receiver, A, getOrCreateClusterIdentity(owner, A).publicKey);

    registerLocalSharingResource(owner, A, { kind: "project", id: "p" });
    updateResourceSharing(owner, A, "project", "p", 1, [
      { clusterId: X, projectId: null },
      { clusterId: Y, projectId: null },
    ]);
    const initial = listResourcePolicyDeliveries(owner).filter(
      (item) => item.peerId === B && item.statement.body.generation === 2,
    );
    applyResourcePolicy(receiver, B, A, initial.find((item) => item.statement.body.context.id === X)!.statement);
    applyResourcePolicy(receiver, B, A, initial.find((item) => item.statement.body.context.id === Y)!.statement);

    transferXAndRemoveA(owner);
    transferXAndRemoveA(receiver);

    const updated = updateResourceSharing(owner, A, "project", "p", 2, [
      { clusterId: Y, projectId: null },
    ]);
    const yStatement = listResourcePolicyDeliveries(owner).find(
      (item) => item.peerId === B
        && item.statement.body.generation === updated.generation
        && item.statement.body.context.id === Y,
    )!.statement;

    assert.doesNotThrow(() => applyResourcePolicy(receiver, B, A, yStatement));
    assert.deepEqual(listResourceShares(receiver, "project", "p"), [
      { clusterId: Y, projectId: null },
    ]);
    assert.equal(getResourcePolicyState(receiver, "project", "p").ownerNodeId, A);
  } finally {
    owner.close();
    receiver.close();
  }
});
