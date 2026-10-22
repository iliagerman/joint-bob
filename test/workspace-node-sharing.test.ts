import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { addSharingMember, createSharingCluster, listResourceShares, mayReceiveResource } from "../src/cluster-sharing-policy.js";
import { ensureResourceSharingSchema, listResourcePolicyDeliveries, registerLocalSharingResource, updateResourceSharing } from "../src/cluster-sharing.js";

test("a node-restricted project grant never authorizes or delivers to other cluster members", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureResourceSharingSchema(db);
    const owner = randomUUID(), recipient = randomUUID(), stranger = randomUUID(), clusterId = randomUUID();
    getOrCreateClusterIdentity(db, owner);
    createSharingCluster(db, { id: clusterId, name: "Recipients" }, owner);
    addSharingMember(db, clusterId, owner, recipient, 1);
    addSharingMember(db, clusterId, owner, stranger, 1);
    registerLocalSharingResource(db, owner, { kind: "project", id: "client" });
    updateResourceSharing(db, owner, "project", "client", 1, [{ clusterId, projectId: null, nodeIds: [recipient] }]);
    assert.equal(mayReceiveResource(db, recipient, "project", "client"), true);
    assert.equal(mayReceiveResource(db, stranger, "project", "client"), false, "sharing with one node must not authorize the whole cluster");
    assert.deepEqual(listResourceShares(db, "project", "client"), [{ clusterId, projectId: null, nodeIds: [recipient] }]);
    assert.deepEqual(listResourcePolicyDeliveries(db).map((delivery) => delivery.peerId), [recipient]);
  } finally { db.close(); }
});
