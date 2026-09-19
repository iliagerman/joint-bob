import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acceptSharingManagerTransfer,
  addSharingMember,
  commitSharingManagerTransfer,
  createSharingCluster,
  ensureClusterSharingPolicySchema,
  getSharingCluster,
  listResourceShares,
  listSharingClusterMembers,
  listSharingMemberships,
  prepareSharingManagerTransfer,
  registerOwnedResource,
  removeSharingMember,
  setAutoShareProjects,
  setResourceShares,
  setTrustedTwin,
} from "../src/cluster-sharing-policy.js";

const C = "10000000-0000-4000-8000-000000000001";
const C2 = "10000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const D = "00000000-0000-4000-8000-000000000003";
const E = "00000000-0000-4000-8000-000000000004";
const F = "00000000-0000-4000-8000-000000000005";
const G = "00000000-0000-4000-8000-000000000006";
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";

function database(filename = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(filename); db.exec("PRAGMA foreign_keys=ON"); ensureClusterSharingPolicySchema(db); return db;
}
function create(db: DatabaseSync, id = C, creator = A): void { createSharingCluster(db, { id, name: "Cluster" }, creator); }
function admit(db: DatabaseSync, clusterId: string, manager: string, node: string, epoch = 1): void {
  addSharingMember(db, clusterId, manager, node, epoch);
}
function transfer(db: DatabaseSync, clusterId: string, from: string, to: string, epoch: number, id = randomUUID()): void {
  prepareSharingManagerTransfer(db, clusterId, from, to, epoch, id);
  acceptSharingManagerTransfer(db, clusterId, to, id);
  commitSharingManagerTransfer(db, clusterId, from, id);
}

test("creator state, immutable per-cluster ranks, cap, and idempotent retry", () => {
  const db = database(); try {
    create(db); create(db, C2, B);
    assert.deepEqual(getSharingCluster(db, C), { id: C, name: "Cluster", originalNodeId: A, managerNodeId: A, managerEpoch: 1, closed: false });
    for (const node of [B, D, E, F]) admit(db, C, A, node);
    admit(db, C2, B, D); admit(db, C2, B, A); admit(db, C2, B, E); admit(db, C2, B, F);
    assert.deepEqual(listSharingClusterMembers(db, C).map((m) => [m.nodeId, m.joinSequence]), [[A, 1], [B, 2], [D, 3], [E, 4], [F, 5]]);
    assert.deepEqual(listSharingMemberships(db, A).map((m) => [m.clusterId, m.joinSequence]), [[C, 1], [C2, 3]]);
    assert.throws(() => admit(db, C, A, G), /five|5/i);
    setAutoShareProjects(db, C, B, true); admit(db, C, A, B);
    assert.deepEqual(listSharingClusterMembers(db, C)[1], { clusterId: C, nodeId: B, autoShareProjects: true, joinSequence: 2 });
  } finally { db.close(); }
});

test("manager authority, sequence allocation, persistence, and rejoin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sharing-membership-")); const file = path.join(root, "policy.sqlite");
  const one = database(file); const two = new DatabaseSync(file); two.exec("PRAGMA foreign_keys=ON");
  try {
    create(one);
    assert.throws(() => admit(one, C, B, D), /manager authority/i);
    assert.throws(() => admit(one, C, A, D, 2), /manager authority/i);
    admit(one, C, A, B); admit(two, C, A, D);
    removeSharingMember(one, C, B, B); admit(two, C, A, B);
    assert.deepEqual(listSharingClusterMembers(two, C).map((m) => m.joinSequence), [1, 3, 4]);
  } finally { two.close(); one.close(); await rm(root, { recursive: true, force: true }); }
});

test("only older members remove younger members; self-leave is separate", () => {
  const db = database(); try {
    create(db); admit(db, C, A, B); admit(db, C, A, D); setTrustedTwin(db, A, D, true);
    transfer(db, C, A, B, 1, T1);
    assert.throws(() => removeSharingMember(db, C, B, A), /older member/i);
    assert.throws(() => removeSharingMember(db, C, D, A), /older member/i);
    assert.throws(() => removeSharingMember(db, C, G, D), /not a member/i);
    assert.throws(() => removeSharingMember(db, C, A, G), /not a member/i);
    removeSharingMember(db, C, A, D);
    removeSharingMember(db, C, A, A);
    assert.deepEqual(listSharingClusterMembers(db, C).map((m) => m.nodeId), [B]);
  } finally { db.close(); }
});

test("manager departure requires transfer and last departure closes forever", () => {
  const db = database(); try {
    create(db); admit(db, C, A, B);
    assert.throws(() => removeSharingMember(db, C, A, A), /transfer/i);
    assert.throws(() => removeSharingMember(db, C, B, A), /older member/i);
    transfer(db, C, A, B, 1, T1); removeSharingMember(db, C, A, A); removeSharingMember(db, C, B, B);
    assert.deepEqual(getSharingCluster(db, C), { id: C, name: "Cluster", originalNodeId: A, managerNodeId: null, managerEpoch: 2, closed: true });
    assert.throws(() => admit(db, C, B, D, 2), /closed/i);
  } finally { db.close(); }
});

test("transfer requires prepare, successor consent, and atomic commit", () => {
  const db = database(); try {
    create(db); admit(db, C, A, B); admit(db, C, A, D);
    assert.throws(() => prepareSharingManagerTransfer(db, C, B, D, 1, T1), /manager authority/i);
    assert.throws(() => prepareSharingManagerTransfer(db, C, A, A, 1, T1), /distinct/i);
    const prepared = prepareSharingManagerTransfer(db, C, A, B, 1, T1);
    assert.equal(prepared.status, "prepared"); assert.equal(getSharingCluster(db, C).managerNodeId, A);
    assert.throws(() => prepareSharingManagerTransfer(db, C, A, D, 1, T2), /concurrent|UNIQUE/i);
    assert.throws(() => acceptSharingManagerTransfer(db, C, D, T1), /successor/i);
    assert.throws(() => commitSharingManagerTransfer(db, C, A, T1), /accepted/i);
    assert.equal(acceptSharingManagerTransfer(db, C, B, T1).status, "accepted");
    assert.equal(getSharingCluster(db, C).managerNodeId, A);
    assert.equal(commitSharingManagerTransfer(db, C, A, T1).status, "committed");
    assert.deepEqual([getSharingCluster(db, C).managerNodeId, getSharingCluster(db, C).managerEpoch], [B, 2]);
    assert.deepEqual(listSharingClusterMembers(db, C).map((m) => m.joinSequence), [1, 2, 3]);
    assert.throws(() => admit(db, C, A, E, 1), /manager authority/i);
    assert.throws(() => admit(db, C, A, E, 2), /manager authority/i);
    admit(db, C, B, E, 2);
    assert.equal(commitSharingManagerTransfer(db, C, A, T1).status, "committed");
    assert.throws(() => prepareSharingManagerTransfer(db, C, B, D, 2, T1), /reuse/i);
  } finally { db.close(); }
});

test("pending transfers survive reload, block membership changes, and never auto-activate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sharing-transfer-")); const file = path.join(root, "policy.sqlite");
  let db = database(file);
  try {
    create(db); admit(db, C, A, B); prepareSharingManagerTransfer(db, C, A, B, 1, T1); db.close(); db = database(file);
    assert.equal(getSharingCluster(db, C).managerNodeId, A);
    assert.throws(() => admit(db, C, A, D), /pending transfer/i);
    assert.throws(() => removeSharingMember(db, C, B, B), /pending transfer/i);
    acceptSharingManagerTransfer(db, C, B, T1); db.close(); db = database(file);
    commitSharingManagerTransfer(db, C, A, T1); transfer(db, C, B, A, 2, T2);
    commitSharingManagerTransfer(db, C, A, T1);
    assert.deepEqual([getSharingCluster(db, C).managerNodeId, getSharingCluster(db, C).managerEpoch], [A, 3]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("caller rollback covers topology changes and successful departure cleans shares", () => {
  const db = database(); try {
    db.exec("BEGIN"); create(db); db.exec("ROLLBACK"); assert.throws(() => getSharingCluster(db, C), /unknown/i);
    create(db); db.exec("BEGIN"); admit(db, C, A, B); db.exec("ROLLBACK"); assert.equal(listSharingClusterMembers(db, C).length, 1);
    admit(db, C, A, B); registerOwnedResource(db, { kind: "project", id: "p", ownerNodeId: B }, B);
    registerOwnedResource(db, { kind: "secret", id: "s", ownerNodeId: A }, A);
    setResourceShares(db, B, "project", "p", [{ clusterId: C, projectId: null }]);
    setResourceShares(db, A, "secret", "s", [{ clusterId: C, projectId: "p" }]);
    db.exec("BEGIN"); removeSharingMember(db, C, B, B); db.exec("ROLLBACK"); assert.equal(listSharingClusterMembers(db, C).length, 2);
    removeSharingMember(db, C, B, B); assert.deepEqual(listResourceShares(db, "project", "p"), []); assert.deepEqual(listResourceShares(db, "secret", "s"), []);
    admit(db, C, A, B); prepareSharingManagerTransfer(db, C, A, B, 1, T1); acceptSharingManagerTransfer(db, C, B, T1);
    db.exec("BEGIN"); commitSharingManagerTransfer(db, C, A, T1); db.exec("ROLLBACK"); assert.deepEqual([getSharingCluster(db, C).managerNodeId, getSharingCluster(db, C).managerEpoch], [A, 1]);
  } finally { db.close(); }
});
