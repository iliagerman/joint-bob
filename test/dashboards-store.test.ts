import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function freshStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-store-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  return import(`../src/dashboards/store.js?store=${randomUUID()}`) as Promise<typeof import("../src/dashboards/store.js")>;
}

const conversation = { kind: "conversation", id: "c1", projectId: "p1" } as const;

test("a saved own dashboard becomes the entity's active dashboard when none is active", async () => {
  const store = await freshStore();
  const first = store.createDashboard({ entity: conversation, ownerNodeId: "node-a", accountId: "acct" });
  assert.equal(first.active, false, "nothing to show before the first save");
  assert.equal(first.definitionDigest, null);
  store.recordSavedDefinition(first.id, { title: "Bugs", refreshMethod: "script", digest: "d1" });
  assert.equal(store.getDashboard(first.id)?.active, true);
  assert.equal(store.getDashboard(first.id)?.approvedDigest, "d1", "a node's own definition needs no approval");

  const second = store.createDashboard({ entity: conversation, ownerNodeId: "node-a", accountId: "acct" });
  store.recordSavedDefinition(second.id, { title: "Errors", refreshMethod: "ai", digest: "d2" });
  assert.equal(store.getDashboard(second.id)?.active, false, "a second dashboard does not replace the active one");
  store.activateDashboard(second.id);
  assert.deepEqual(store.listDashboards(conversation).filter((d) => d.active).map((d) => d.id), [second.id], "only one is active per entity");
});

test("a received dashboard runs only after its current definition is approved", async () => {
  const store = await freshStore();
  const id = randomUUID();
  store.upsertReceivedDashboard({ id, entity: conversation, ownerNodeId: "node-b", accountId: null, title: "Shared", refreshMethod: "script", digest: "r1" });
  const received = store.getDashboard(id)!;
  assert.equal(received.origin, "received");
  assert.equal(received.active, false, "a received dashboard arrives inactive");
  assert.throws(() => store.activateDashboard(id), /not approved/);
  assert.throws(() => store.approveDashboard(id, "stale"), /changed/, "approval is bound to the definition the user saw");
  store.approveDashboard(id, "r1");
  store.activateDashboard(id);
  assert.equal(store.getDashboard(id)?.active, true);
});

test("an owner change clears approval and the node falls back to its own dashboard", async () => {
  const store = await freshStore();
  const own = store.createDashboard({ entity: conversation, ownerNodeId: "node-a", accountId: "acct" });
  store.recordSavedDefinition(own.id, { title: "Mine", refreshMethod: "script", digest: "o1" });
  const id = randomUUID();
  store.upsertReceivedDashboard({ id, entity: conversation, ownerNodeId: "node-b", accountId: null, title: "Shared", refreshMethod: "script", digest: "r1" });
  store.approveDashboard(id, "r1");
  store.activateDashboard(id);
  assert.equal(store.getDashboard(own.id)?.active, false);

  store.upsertReceivedDashboard({ id, entity: conversation, ownerNodeId: "node-b", accountId: null, title: "Shared", refreshMethod: "script", digest: "r2" });
  const updated = store.getDashboard(id)!;
  assert.equal(updated.approvedDigest, null);
  assert.equal(updated.active, false);
  assert.equal(store.getDashboard(own.id)?.active, true, "the node keeps using its own dashboard");

  store.upsertReceivedDashboard({ id, entity: conversation, ownerNodeId: "node-b", accountId: null, title: "Renamed", refreshMethod: "script", digest: "r2" });
  assert.equal(store.getDashboard(id)?.title, "Renamed", "an unchanged definition keeps its record");
});

test("deleting the active dashboard activates the node's own remaining one", async () => {
  const store = await freshStore();
  const a = store.createDashboard({ entity: { kind: "project", id: "p1" }, ownerNodeId: "n", accountId: "acct" });
  store.recordSavedDefinition(a.id, { title: "A", refreshMethod: "script", digest: "a" });
  const b = store.createDashboard({ entity: { kind: "project", id: "p1" }, ownerNodeId: "n", accountId: "acct" });
  store.recordSavedDefinition(b.id, { title: "B", refreshMethod: "script", digest: "b" });
  store.activateDashboard(b.id);
  store.deleteDashboard(b.id);
  assert.equal(store.getDashboard(b.id), undefined);
  assert.equal(store.getDashboard(a.id)?.active, true);
});

test("refresh results and entity removal", async () => {
  const store = await freshStore();
  assert.throws(() => store.createDashboard({ entity: { kind: "workspace", id: "w1" }, ownerNodeId: "n", accountId: "acct" }), /workspace's projects/);
  const a = store.createDashboard({ entity: { kind: "workspace", id: "w1" }, hostProjectId: "p9", ownerNodeId: "n", accountId: "acct" });
  assert.equal(a.hostProjectId, "p9", "a workspace dashboard runs in its chosen project");
  assert.equal(store.createDashboard({ entity: conversation, ownerNodeId: "n", accountId: "acct" }).hostProjectId, "p1");
  store.recordRefresh(a.id, { at: "2026-10-24T09:00:00.000Z", ok: false, error: "boom" });
  assert.deepEqual(store.getDashboard(a.id)?.lastRefresh, { at: "2026-10-24T09:00:00.000Z", ok: false, error: "boom" });
  const other = store.createDashboard({ entity: { kind: "workspace", id: "w2" }, hostProjectId: "p9", ownerNodeId: "n", accountId: "acct" });
  assert.deepEqual(store.removeEntityDashboards({ kind: "workspace", id: "w1" }), [a.id]);
  assert.equal(store.getDashboard(a.id), undefined);
  assert.ok(store.getDashboard(other.id));
  assert.deepEqual(store.listAllDashboards().filter((d) => d.entity.kind === "workspace").map((d) => d.id), [other.id]);
});
