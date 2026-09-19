import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptSharingManagerTransfer,
  addSharingMember as admitSharingMember,
  commitSharingManagerTransfer,
  createSharingCluster,
  ensureClusterSharingPolicySchema,
  getSharingCluster,
  isTrustedTwin,
  listResourceShares,
  listSharingClusterMembers,
  listSharingMemberships,
  mayReceiveResource,
  prepareSharingManagerTransfer,
  registerOwnedResource,
  removeSharingMember as departSharingMember,
  resourceClusterIds,
  resourceOwner,
  setAutoShareProjects,
  setResourceShares,
  setTrustedTwin,
  shareAllOwnedProjects,
  type SharedResourceKind,
} from "../src/cluster-sharing-policy.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const TWIN = "00000000-0000-4000-8000-000000000002";
const RECEIVER = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const CLUSTER_A = "10000000-0000-4000-8000-000000000001";
const CLUSTER_B = "10000000-0000-4000-8000-000000000002";
const SECRET = "20000000-0000-4000-8000-000000000001";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureClusterSharingPolicySchema(db);
  return db;
}

function cluster(db: DatabaseSync, id: string, creator = OWNER): void {
  createSharingCluster(db, { id, name: id === CLUSTER_A ? "Alpha" : "Beta" }, creator);
}

function project(db: DatabaseSync, id: string, owner = OWNER, local = owner): void {
  registerOwnedResource(db, { kind: "project", id, ownerNodeId: owner }, local);
}

let transferCounter = 1;
function addSharingMember(db: DatabaseSync, clusterId: string, nodeId: string): void {
  const state = getSharingCluster(db, clusterId);
  admitSharingMember(db, clusterId, state.managerNodeId!, nodeId, state.managerEpoch);
}
function removeSharingMember(db: DatabaseSync, clusterId: string, nodeId: string): void {
  let state = getSharingCluster(db, clusterId);
  const members = listSharingClusterMembers(db, clusterId);
  if (state.managerNodeId === nodeId && members.length > 1) {
    const successor = members.find((member) => member.nodeId !== nodeId)!;
    const transferId = `30000000-0000-4000-8000-${String(transferCounter++).padStart(12, "0")}`;
    prepareSharingManagerTransfer(db, clusterId, nodeId, successor.nodeId, state.managerEpoch, transferId);
    acceptSharingManagerTransfer(db, clusterId, successor.nodeId, transferId);
    commitSharingManagerTransfer(db, clusterId, nodeId, transferId);
    state = getSharingCluster(db, clusterId);
  }
  departSharingMember(db, clusterId, nodeId, nodeId);
}

test("schema, clusters, and independent memberships are idempotent where specified", () => {
  const db = database();
  try {
    ensureClusterSharingPolicySchema(db);
    cluster(db, CLUSTER_A);
    cluster(db, CLUSTER_B);
    addSharingMember(db, CLUSTER_A, RECEIVER);
    setAutoShareProjects(db, CLUSTER_A, RECEIVER, true);
    addSharingMember(db, CLUSTER_A, RECEIVER);
    assert.deepEqual(listSharingMemberships(db, RECEIVER), [{ clusterId: CLUSTER_A, nodeId: RECEIVER, autoShareProjects: true, joinSequence: 2 }]);
    project(db, "none");
    assert.deepEqual(listResourceShares(db, "project", "none"), []);
    assert.throws(() => createSharingCluster(db, { id: CLUSTER_A, name: "Again" }, OTHER), /cluster/i);
    assert.deepEqual(listSharingMemberships(db, OTHER), []);
  } finally { db.close(); }
});

test("validates API input and original ownership is immutable", () => {
  const db = database();
  try {
    assert.throws(() => createSharingCluster(db, { id: "bad", name: "x" }, OWNER), /UUID/i);
    assert.throws(() => createSharingCluster(db, { id: CLUSTER_A, name: " " }, OWNER), /name/i);
    assert.throws(() => registerOwnedResource(db, { kind: "bad" as SharedResourceKind, id: "x", ownerNodeId: OWNER }, OWNER), /kind/i);
    assert.throws(() => registerOwnedResource(db, { kind: "project", id: " ", ownerNodeId: OWNER }, OWNER), /resource/i);
    assert.throws(() => registerOwnedResource(db, { kind: "project", id: "x", ownerNodeId: "bad" }, OWNER), /UUID/i);
    project(db, "owned");
    assert.throws(() => project(db, "owned", OTHER), /owner/i);
    assert.equal(resourceOwner(db, "project", "owned"), OWNER);
    assert.throws(() => resourceOwner(db, "project", "missing"), /unknown/i);
  } finally { db.close(); }
});

test("resource IDs must be canonical and leave no state when rejected", () => {
  const db = database();
  try {
    for (const id of [" project", "project ", "pro\u0000ject", "pro\u001fject", "pro\u007fject"]) {
      assert.throws(
        () => registerOwnedResource(db, { kind: "project", id, ownerNodeId: OWNER }, OWNER),
        /trimmed|control/i,
      );
      assert.equal(db.prepare("SELECT 1 FROM sharing_resource_owners WHERE resource_id=?").get(id), undefined);
      assert.equal(db.prepare("SELECT 1 FROM sharing_resource_shares WHERE resource_id=?").get(id), undefined);
    }
  } finally { db.close(); }
});

test("auto-share applies only to newly registered local owned projects", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    setAutoShareProjects(db, CLUSTER_A, OWNER, true);
    project(db, "new");
    assert.deepEqual(listResourceShares(db, "project", "new"), [{ clusterId: CLUSTER_A, projectId: null }]);
    setAutoShareProjects(db, CLUSTER_A, OWNER, false);
    project(db, "later");
    setAutoShareProjects(db, CLUSTER_A, OWNER, true);
    assert.deepEqual(listResourceShares(db, "project", "later"), []);
    registerOwnedResource(db, { kind: "ticket", id: "ticket", ownerNodeId: OWNER, projectId: "later" }, OWNER);
    registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    registerOwnedResource(db, { kind: "project", id: "import", ownerNodeId: OTHER }, OWNER);
    assert.deepEqual(listResourceShares(db, "ticket", "ticket"), []);
    assert.deepEqual(listResourceShares(db, "secret", SECRET), []);
    assert.deepEqual(listResourceShares(db, "project", "import"), []);
    setResourceShares(db, OWNER, "project", "new", []);
    project(db, "new");
    assert.deepEqual(listResourceShares(db, "project", "new"), []);
  } finally { db.close(); }
});

test("share replacement is authorized, validated first, and cluster access is isolated", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    for (const id of [RECEIVER, OTHER]) addSharingMember(db, CLUSTER_A, id);
    addSharingMember(db, CLUSTER_B, OWNER); addSharingMember(db, CLUSTER_B, OTHER);
    project(db, "p");
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "project", "p"), true);
    assert.equal(mayReceiveResource(db, OTHER, "project", "p"), true);
    assert.throws(() => setResourceShares(db, RECEIVER, "project", "p", []), /authoriz/i);
    assert.throws(() => setResourceShares(db, OWNER, "project", "p", [
      { clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }, { clusterId: CLUSTER_B, projectId: null },
    ]), /duplicate/i);
    assert.deepEqual(listResourceShares(db, "project", "p"), [{ clusterId: CLUSTER_A, projectId: null }]);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_B, projectId: null }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "project", "p"), false);
    assert.equal(mayReceiveResource(db, OWNER, "project", "p"), true);
  } finally { db.close(); }
});

test("membership removal and unshare preserve unrelated clusters and do not revive shares", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    for (const id of [RECEIVER]) { addSharingMember(db, CLUSTER_A, id); addSharingMember(db, CLUSTER_B, id); }
    project(db, "p");
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }]);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_B, projectId: null }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "project", "p"), true);
    removeSharingMember(db, CLUSTER_B, RECEIVER);
    assert.equal(mayReceiveResource(db, RECEIVER, "project", "p"), false);
    addSharingMember(db, CLUSTER_B, RECEIVER);
    removeSharingMember(db, CLUSTER_B, OWNER);
    addSharingMember(db, CLUSTER_B, OWNER);
    assert.deepEqual(listResourceShares(db, "project", "p"), []);
  } finally { db.close(); }
});

test("trusted twins retain receive access but cannot change project or secret shares", () => {
  const db = database();
  try {
    assert.throws(() => setTrustedTwin(db, OWNER, OWNER, true), /self/i);
    setTrustedTwin(db, OWNER, TWIN, true); setTrustedTwin(db, TWIN, OTHER, true);
    assert.equal(isTrustedTwin(db, TWIN, OWNER), true);
    assert.equal(isTrustedTwin(db, OWNER, OTHER), false);
    project(db, "p"); project(db, "third", OTHER, OWNER);
    registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    assert.equal(mayReceiveResource(db, TWIN, "project", "p"), true);
    assert.throws(() => setResourceShares(db, OWNER, "project", "third", []), /authoriz/i);
    cluster(db, CLUSTER_A); addSharingMember(db, CLUSTER_A, TWIN);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]);
    setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: null }]);
    for (const [kind, id] of [["project", "p"], ["secret", SECRET]] as const) {
      assert.throws(() => setResourceShares(db, TWIN, kind, id, []), /authoriz/i);
      assert.throws(() => setResourceShares(db, TWIN, kind, id, [{ clusterId: CLUSTER_A, projectId: null }]), /authoriz/i);
      assert.deepEqual(listResourceShares(db, kind, id), [{ clusterId: CLUSTER_A, projectId: null }]);
    }
    setTrustedTwin(db, OWNER, TWIN, false); setTrustedTwin(db, OWNER, TWIN, false);
    assert.equal(resourceOwner(db, "project", "p"), OWNER);
    assert.equal(mayReceiveResource(db, TWIN, "project", "p"), true, "cluster share remains active");
    removeSharingMember(db, CLUSTER_A, TWIN);
    assert.equal(mayReceiveResource(db, TWIN, "project", "p"), false);
  } finally { db.close(); }
});

test("bulk project sharing is additive, idempotent, and excludes every other owner", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A);
    setTrustedTwin(db, OWNER, TWIN, true);
    project(db, "own"); project(db, "twin", TWIN, OWNER); project(db, "received", OTHER, OWNER);
    assert.equal(shareAllOwnedProjects(db, CLUSTER_A, OWNER), 1);
    addSharingMember(db, CLUSTER_A, TWIN);
    assert.equal(shareAllOwnedProjects(db, CLUSTER_A, OWNER), 0);
    removeSharingMember(db, CLUSTER_A, TWIN); addSharingMember(db, CLUSTER_A, TWIN);
    assert.equal(shareAllOwnedProjects(db, CLUSTER_A, OWNER), 0);
    assert.deepEqual(listSharingMemberships(db, OWNER), [{ clusterId: CLUSTER_A, nodeId: OWNER, autoShareProjects: false, joinSequence: 1 }]);
    assert.deepEqual(listResourceShares(db, "project", "twin"), []);
    assert.deepEqual(listResourceShares(db, "project", "received"), []);
  } finally { db.close(); }
});

test("project-scoped secrets require the same active cluster and are cleaned on project unshare", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    for (const id of [RECEIVER]) { addSharingMember(db, CLUSTER_A, id); addSharingMember(db, CLUSTER_B, id); }
    project(db, "p"); registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]);
    setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: "p" }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "secret", SECRET), false);
    assert.equal(mayReceiveResource(db, RECEIVER, "secret", SECRET, "wrong"), false);
    assert.equal(mayReceiveResource(db, RECEIVER, "secret", SECRET, "p"), true);
    assert.equal(mayReceiveResource(db, RECEIVER, "project", "p"), true);
    assert.throws(() => setResourceShares(db, OWNER, "secret", SECRET, [
      { clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_A, projectId: "p" },
    ]), /redundant|ambiguous/i);
    assert.throws(() => setResourceShares(db, OWNER, "secret", SECRET, [
      { clusterId: CLUSTER_A, projectId: "p" }, { clusterId: CLUSTER_A, projectId: "p" },
    ]), /duplicate/i);
    assert.throws(() => setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_B, projectId: "p" }]), /project/i);
    setResourceShares(db, OWNER, "project", "p", []);
    assert.deepEqual(listResourceShares(db, "secret", SECRET), []);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "secret", SECRET, "p"), false);
    setTrustedTwin(db, OWNER, TWIN, true);
    assert.equal(mayReceiveResource(db, TWIN, "secret", SECRET), true);
  } finally { db.close(); }
});

test("cluster provenance is sorted, active, scoped, and excludes twin-only access", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_B); cluster(db, CLUSTER_A);
    addSharingMember(db, CLUSTER_A, RECEIVER); addSharingMember(db, CLUSTER_B, RECEIVER);
    project(db, "p");
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_B, projectId: null }, { clusterId: CLUSTER_A, projectId: null }]);
    assert.deepEqual(resourceClusterIds(db, RECEIVER, "project", "p"), [CLUSTER_A, CLUSTER_B]);
    setTrustedTwin(db, OWNER, TWIN, true);
    assert.deepEqual(resourceClusterIds(db, TWIN, "project", "p"), []);
    removeSharingMember(db, CLUSTER_A, RECEIVER);
    assert.deepEqual(resourceClusterIds(db, RECEIVER, "project", "p"), [CLUSTER_B]);
  } finally { db.close(); }
});

test("register and auto-shares participate in caller transactions", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); setAutoShareProjects(db, CLUSTER_A, OWNER, true);
    db.exec("BEGIN");
    project(db, "rolled-back");
    db.exec("ROLLBACK");
    assert.throws(() => resourceOwner(db, "project", "rolled-back"), /unknown/i);
  } finally { db.close(); }
});

test("auto-share targets every enabled cluster without restoring removed shares", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    setAutoShareProjects(db, CLUSTER_A, OWNER, true); setAutoShareProjects(db, CLUSTER_B, OWNER, true);
    project(db, "both");
    assert.deepEqual(listResourceShares(db, "project", "both"), [
      { clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null },
    ]);
    setResourceShares(db, OWNER, "project", "both", [{ clusterId: CLUSTER_B, projectId: null }]);
    project(db, "both");
    assert.deepEqual(listResourceShares(db, "project", "both"), [{ clusterId: CLUSTER_B, projectId: null }]);
  } finally { db.close(); }
});

test("bulk sharing is immediately idempotent and preserves other clusters", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B); project(db, "p");
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_B, projectId: null }]);
    assert.equal(shareAllOwnedProjects(db, CLUSTER_A, OWNER), 1);
    assert.equal(shareAllOwnedProjects(db, CLUSTER_A, OWNER), 0);
    assert.deepEqual(listResourceShares(db, "project", "p"), [
      { clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null },
    ]);
  } finally { db.close(); }
});

test("share authorization requires actor and original owner membership atomically", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B); project(db, "p");
    addSharingMember(db, CLUSTER_A, OTHER);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_B, projectId: null }]);
    removeSharingMember(db, CLUSTER_A, OWNER);
    assert.throws(() => setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]), /member/i);
    setTrustedTwin(db, OWNER, TWIN, true);
    assert.throws(() => setResourceShares(db, TWIN, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]), /authoriz/i);
    addSharingMember(db, CLUSTER_A, TWIN);
    assert.throws(() => setResourceShares(db, TWIN, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }]), /authoriz/i);
    assert.deepEqual(listResourceShares(db, "project", "p"), [{ clusterId: CLUSTER_B, projectId: null }]);
  } finally { db.close(); }
});

test("share scopes reject non-secrets and unknown projects", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); project(db, "p");
    registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    assert.throws(() => setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: "p" }]), /only secrets/i);
    assert.throws(() => setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: "missing" }]), /project/i);
  } finally { db.close(); }
});

test("cluster-wide secrets require membership in the matching cluster", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B); addSharingMember(db, CLUSTER_A, RECEIVER); addSharingMember(db, CLUSTER_B, OTHER);
    registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: null }]);
    assert.equal(mayReceiveResource(db, RECEIVER, "secret", SECRET), true);
    assert.equal(mayReceiveResource(db, OTHER, "secret", SECRET), false);
  } finally { db.close(); }
});

test("removing a project owner permanently clears dependent secret scopes only in that cluster", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B); addSharingMember(db, CLUSTER_A, OTHER); addSharingMember(db, CLUSTER_B, OTHER);
    project(db, "p"); registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OTHER }, OTHER);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }]);
    setResourceShares(db, OTHER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: "p" }, { clusterId: CLUSTER_B, projectId: "p" }]);
    removeSharingMember(db, CLUSTER_A, OWNER); addSharingMember(db, CLUSTER_A, OWNER);
    setResourceShares(db, OWNER, "project", "p", [{ clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }]);
    assert.deepEqual(listResourceShares(db, "secret", SECRET), [{ clusterId: CLUSTER_B, projectId: "p" }]);
  } finally { db.close(); }
});

test("multiple valid secret scopes yield one provenance and survive one project removal", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); addSharingMember(db, CLUSTER_A, RECEIVER);
    project(db, "p1"); project(db, "p2"); registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    setResourceShares(db, OWNER, "project", "p1", [{ clusterId: CLUSTER_A, projectId: null }]);
    setResourceShares(db, OWNER, "project", "p2", [{ clusterId: CLUSTER_A, projectId: null }]);
    setResourceShares(db, OWNER, "secret", SECRET, [{ clusterId: CLUSTER_A, projectId: "p1" }, { clusterId: CLUSTER_A, projectId: "p2" }]);
    assert.deepEqual(resourceClusterIds(db, RECEIVER, "secret", SECRET), [CLUSTER_A]);
    setResourceShares(db, OWNER, "project", "p1", []);
    assert.deepEqual(listResourceShares(db, "secret", SECRET), [{ clusterId: CLUSTER_A, projectId: "p2" }]);
    assert.deepEqual(resourceClusterIds(db, RECEIVER, "secret", SECRET), [CLUSTER_A]);
  } finally { db.close(); }
});

test("tickets inherit their immutable parent project's complete policy", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); cluster(db, CLUSTER_B);
    addSharingMember(db, CLUSTER_A, RECEIVER); addSharingMember(db, CLUSTER_B, RECEIVER);
    project(db, "parent");
    registerOwnedResource(db, { kind: "ticket", id: "before", ownerNodeId: OWNER, projectId: "parent" }, OWNER);
    setResourceShares(db, OWNER, "project", "parent", [{ clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }]);
    registerOwnedResource(db, { kind: "ticket", id: "after", ownerNodeId: OWNER, projectId: "parent" }, OWNER);
    for (const id of ["before", "after"]) {
      assert.equal(resourceOwner(db, "ticket", id), OWNER);
      assert.deepEqual(listResourceShares(db, "ticket", id), [{ clusterId: CLUSTER_A, projectId: null }, { clusterId: CLUSTER_B, projectId: null }]);
      assert.deepEqual(resourceClusterIds(db, RECEIVER, "ticket", id), [CLUSTER_A, CLUSTER_B]);
      assert.equal(mayReceiveResource(db, RECEIVER, "ticket", id), true);
    }
    setTrustedTwin(db, OWNER, TWIN, true); setTrustedTwin(db, RECEIVER, OTHER, true);
    assert.equal(mayReceiveResource(db, TWIN, "ticket", "before"), true);
    assert.equal(mayReceiveResource(db, OTHER, "ticket", "before"), false);
    setResourceShares(db, OWNER, "project", "parent", [{ clusterId: CLUSTER_B, projectId: null }]);
    for (const id of ["before", "after"]) assert.deepEqual(resourceClusterIds(db, RECEIVER, "ticket", id), [CLUSTER_B]);
    setResourceShares(db, OWNER, "project", "parent", []);
    for (const id of ["before", "after"]) assert.equal(mayReceiveResource(db, RECEIVER, "ticket", id), false);
  } finally { db.close(); }
});

test("ticket registration validates and preserves owner and parent atomically", () => {
  const db = database();
  try {
    project(db, "parent"); project(db, "other-owner", OTHER, OWNER);
    for (const projectId of [" missing", "missing"]) {
      assert.throws(() => registerOwnedResource(db, { kind: "ticket", id: "bad", ownerNodeId: OWNER, projectId }, OWNER), /resource|unknown/i);
      assert.equal(db.prepare("SELECT 1 FROM sharing_resource_owners WHERE kind='ticket' AND resource_id='bad'").get(), undefined);
    }
    assert.throws(() => registerOwnedResource(db, { kind: "ticket", id: "bad", ownerNodeId: OWNER, projectId: "other-owner" }, OWNER), /owner/i);
    registerOwnedResource(db, { kind: "ticket", id: "stable", ownerNodeId: OWNER, projectId: "parent" }, OWNER);
    registerOwnedResource(db, { kind: "ticket", id: "stable", ownerNodeId: OWNER, projectId: "parent" }, OWNER);
    assert.throws(() => registerOwnedResource(db, { kind: "ticket", id: "stable", ownerNodeId: OWNER, projectId: "other-owner" }, OWNER), /owner|parent/i);
    assert.equal(db.prepare("SELECT project_id FROM sharing_resource_owners WHERE kind='ticket' AND resource_id='stable'").get()!.project_id, "parent");
  } finally { db.close(); }
});

test("ticket shares cannot be written independently", () => {
  const db = database();
  try {
    cluster(db, CLUSTER_A); project(db, "parent");
    registerOwnedResource(db, { kind: "ticket", id: "ticket", ownerNodeId: OWNER, projectId: "parent" }, OWNER);
    for (const shares of [[], [{ clusterId: CLUSTER_A, projectId: null }]]) {
      assert.throws(() => setResourceShares(db, OWNER, "ticket", "ticket", shares), /inherited from its project/i);
    }
    assert.deepEqual(listResourceShares(db, "ticket", "ticket"), []);
    setResourceShares(db, OWNER, "project", "parent", [{ clusterId: CLUSTER_A, projectId: null }]);
    assert.deepEqual(listResourceShares(db, "ticket", "ticket"), [{ clusterId: CLUSTER_A, projectId: null }]);
  } finally { db.close(); }
});

test("private projects have owner access without provenance and unknown projects throw", () => {
  const db = database();
  try {
    project(db, "private");
    assert.deepEqual(resourceClusterIds(db, OWNER, "project", "private"), []);
    assert.equal(mayReceiveResource(db, OWNER, "project", "private"), true);
    assert.throws(() => mayReceiveResource(db, OWNER, "project", "missing"), /unknown/i);
  } finally { db.close(); }
});

test("twin access is direct and disappears on disconnect without changing private resources", () => {
  const db = database();
  try {
    project(db, "private"); registerOwnedResource(db, { kind: "secret", id: SECRET, ownerNodeId: OWNER }, OWNER);
    setTrustedTwin(db, OWNER, TWIN, true); setTrustedTwin(db, TWIN, OTHER, true);
    assert.equal(mayReceiveResource(db, TWIN, "project", "private"), true);
    assert.equal(mayReceiveResource(db, TWIN, "secret", SECRET), true);
    assert.equal(mayReceiveResource(db, OTHER, "project", "private"), false);
    assert.equal(mayReceiveResource(db, OTHER, "secret", SECRET), false);
    setTrustedTwin(db, OWNER, TWIN, false);
    assert.equal(mayReceiveResource(db, TWIN, "project", "private"), false);
    assert.equal(mayReceiveResource(db, TWIN, "secret", SECRET), false);
    assert.equal(mayReceiveResource(db, OWNER, "project", "private"), true);
    assert.deepEqual(listResourceShares(db, "project", "private"), []);
  } finally { db.close(); }
});
