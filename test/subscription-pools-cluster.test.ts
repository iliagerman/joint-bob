import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { addSharingMember, createSharingCluster, ensureClusterSharingPolicySchema, registerOwnedResource, removeSharingMember, setResourceShares } from "../src/cluster-sharing-policy.js";
import { applyClusterSubscriptionPoolEvent, assignedClusterPoolsForOwner, clearClusterSubscriptionPool, clusterPoolProfileAuthorized, ensureClusterSubscriptionPoolSchema, getClusterSubscriptionPool, resolveClusterSubscriptionPools, setClusterSubscriptionPool, type ClusterSubscriptionPoolManifest } from "../src/provider-profiles/pool-sharing.js";
import { ensureReplicationSchema } from "../src/replication.js";

const MANAGER = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const MEMBER = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const CLUSTER = "00000000-0000-4000-8000-000000000005";
const OTHER_CLUSTER = "00000000-0000-4000-8000-000000000006";
const PROJECT = "pool-shared-project";
const POOL_ONE = "00000000-0000-4000-8000-000000000008";
const POOL_TWO = "00000000-0000-4000-8000-000000000009";

const manifest = (poolId: string, label = "Primary"): ClusterSubscriptionPoolManifest => ({
  poolId,
  name: label,
  fallbackModels: { claude: "claude-sonnet-4" },
  members: [{ profileId: "00000000-0000-4000-8000-000000000007", provider: "claude" as const, label: "Claude", position: 0 }],
});

function setup(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureClusterSharingPolicySchema(db);
  ensureReplicationSchema(db);
  ensureClusterSubscriptionPoolSchema(db);
  createSharingCluster(db, { id: CLUSTER, name: "Primary" }, MANAGER);
  addSharingMember(db, CLUSTER, MANAGER, OWNER, 1);
  addSharingMember(db, CLUSTER, MANAGER, MEMBER, 1);
  registerOwnedResource(db, { kind: "project", id: PROJECT, ownerNodeId: OWNER }, OWNER);
  registerOwnedResource(db, { kind: "project", id: "private-project", ownerNodeId: OWNER }, OWNER);
  setResourceShares(db, OWNER, "project", PROJECT, [{ clusterId: CLUSTER, projectId: null }]);
  return db;
}

test("only the current cluster manager can assign or clear a pool owned by a member", () => {
  const db = setup();
  try {
    assert.throws(() => setClusterSubscriptionPool(db, MEMBER, CLUSTER, OWNER, manifest(POOL_ONE), 1), /manager|authority/i);
    assert.throws(() => setClusterSubscriptionPool(db, MANAGER, CLUSTER, OTHER, manifest(POOL_ONE), 1), /member/i);
    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    assert.throws(() => clearClusterSubscriptionPool(db, MEMBER, CLUSTER, OWNER, POOL_ONE, 1), /manager|authority/i);
    assert.throws(() => clearClusterSubscriptionPool(db, MANAGER, CLUSTER, OTHER, POOL_ONE, 1), /owner|assignment/i);
  } finally { db.close(); }
});

test("cluster assignment is visible only for a project shared through that cluster", () => {
  const db = setup();
  try {
    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    assert.deepEqual(resolveClusterSubscriptionPools(db, MEMBER, PROJECT).map(({ clusterId, poolOwnerNodeId, poolId }) => ({ clusterId, poolOwnerNodeId, poolId })), [
      { clusterId: CLUSTER, poolOwnerNodeId: OWNER, poolId: POOL_ONE },
    ]);
    assert.deepEqual(resolveClusterSubscriptionPools(db, OTHER, PROJECT), []);
    assert.deepEqual(resolveClusterSubscriptionPools(db, MEMBER, "private-project"), []);
  } finally { db.close(); }
});

test("pool manifests replicate as cluster-scoped metadata without credential fields", () => {
  const db = setup();
  try {
    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    const row = db.prepare("SELECT entity_type,payload FROM replication_outbox ORDER BY rowid DESC LIMIT 1").get() as { entity_type: string; payload: string };
    assert.equal(row.entity_type, "provider.poolAssignment");
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(payload.clusterId, CLUSTER);
    assert.equal(payload.poolOwnerNodeId, OWNER);
    assert.equal(JSON.stringify(payload).includes("refresh"), false);
    assert.equal(JSON.stringify(payload).includes("accessToken"), false);
    assert.equal(JSON.stringify(payload).includes("secret"), false);
  } finally { db.close(); }
});

test("replication rejects non-manager, stale-epoch, and stale-revision manifests", () => {
  const source = setup();
  const receiver = setup();
  try {
    const first = setClusterSubscriptionPool(source, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    const event = source.prepare("SELECT event_id,origin_node_id,entity_type,entity_key,operation,payload,created_at FROM replication_outbox ORDER BY rowid DESC LIMIT 1").get() as Record<string, string>;
    const replicationEvent = { id: event.event_id, originNodeId: event.origin_node_id, entityType: event.entity_type, entityKey: event.entity_key, operation: event.operation, payload: JSON.parse(event.payload), createdAt: event.created_at };
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, { ...replicationEvent, originNodeId: OTHER }), false);
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, { ...replicationEvent, payload: { ...(replicationEvent.payload as object), managerEpoch: 2 } }), false);
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, replicationEvent), true);
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, replicationEvent), true);
    const second = setClusterSubscriptionPool(source, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE, "Renamed"), 1);
    assert.ok(second.revision > first.revision);
    const latest = source.prepare("SELECT event_id,origin_node_id,entity_type,entity_key,operation,payload,created_at FROM replication_outbox ORDER BY rowid DESC LIMIT 1").get() as Record<string, string>;
    const latestEvent = { id: latest.event_id, originNodeId: latest.origin_node_id, entityType: latest.entity_type, entityKey: latest.entity_key, operation: latest.operation, payload: JSON.parse(latest.payload), createdAt: latest.created_at };
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, replicationEvent), true);
    assert.equal(applyClusterSubscriptionPoolEvent(receiver, latestEvent), true);
    assert.equal(getClusterSubscriptionPool(receiver, CLUSTER)?.revision, second.revision);
  } finally { source.close(); receiver.close(); }
});

test("clearing a pool writes a tombstone and removing a cluster member revokes its resolution", () => {
  const db = setup();
  try {
    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    const cleared = clearClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, POOL_ONE, 1);
    assert.equal(cleared.deleted, true);
    assert.equal(getClusterSubscriptionPool(db, CLUSTER), undefined);
    assert.deepEqual(resolveClusterSubscriptionPools(db, MEMBER, PROJECT), []);

    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_TWO), 1);
    const profileId = manifest(POOL_TWO).members[0].profileId;
    assert.equal(clusterPoolProfileAuthorized(db, CLUSTER, OWNER, MEMBER, POOL_TWO, profileId), true);
    removeSharingMember(db, CLUSTER, MANAGER, MEMBER);
    assert.equal(clusterPoolProfileAuthorized(db, CLUSTER, OWNER, MEMBER, POOL_TWO, profileId), false);
    assert.deepEqual(resolveClusterSubscriptionPools(db, MEMBER, PROJECT), []);
    removeSharingMember(db, CLUSTER, MANAGER, OWNER);
    assert.equal(assignedClusterPoolsForOwner(db, OWNER, POOL_TWO).length, 0);
  } finally { db.close(); }
});

test("different cluster assignments remain distinguishable for conflict rejection by callers", () => {
  const db = setup();
  try {
    createSharingCluster(db, { id: OTHER_CLUSTER, name: "Second" }, MANAGER);
    addSharingMember(db, OTHER_CLUSTER, MANAGER, MEMBER, 1);
    addSharingMember(db, OTHER_CLUSTER, MANAGER, OWNER, 1);
    setResourceShares(db, OWNER, "project", PROJECT, [{ clusterId: CLUSTER, projectId: null }, { clusterId: OTHER_CLUSTER, projectId: null }]);
    setClusterSubscriptionPool(db, MANAGER, CLUSTER, OWNER, manifest(POOL_ONE), 1);
    setClusterSubscriptionPool(db, MANAGER, OTHER_CLUSTER, OWNER, manifest(POOL_TWO), 1);
    assert.deepEqual(resolveClusterSubscriptionPools(db, MEMBER, PROJECT).map(({ poolId }) => poolId).sort(), [POOL_ONE, POOL_TWO]);
  } finally { db.close(); }
});
