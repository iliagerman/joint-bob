import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../src/cluster-identity.js";
import { addSharingMember, createSharingCluster } from "../src/cluster-sharing-policy.js";
import { ensureResourceSharingSchema, listResourcePolicyDeliveries, registerLocalSharingResource, updateResourceSharing } from "../src/cluster-sharing.js";
import { settingsDatabase } from "../src/settings-store.js";
import { applyProjectMetadata, getProject, listProjects } from "../src/store.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const clusterId = "10000000-0000-4000-8000-000000000001";

test("metadata receipt prevents a writer from invalidating its read snapshot and releases its lock", async (context) => {
  await listProjects();
  const localId = (await getClusterNode()).id;
  const receiver = settingsDatabase();
  const owner = new DatabaseSync(":memory:");
  const competing = new DatabaseSync(path.join(process.env.PI_WEB_DATA_DIR!, "node.db"));
  competing.exec("PRAGMA busy_timeout=0; CREATE TABLE contention_probe(value INTEGER); INSERT INTO contention_probe VALUES(0)");
  try {
    for (const db of [owner, receiver]) {
      ensureResourceSharingSchema(db);
      createSharingCluster(db, { id: clusterId, name: "Fixture" }, ownerId);
      addSharingMember(db, clusterId, ownerId, localId, 1);
    }
    pinClusterPublicKey(receiver, ownerId, getOrCreateClusterIdentity(owner, ownerId).publicKey);
    registerLocalSharingResource(owner, ownerId, { kind: "project", id: "shared-project" });
    updateResourceSharing(owner, ownerId, "project", "shared-project", 1, [{ clusterId, projectId: null }]);
    const { statement } = listResourcePolicyDeliveries(owner)[0];
    const envelope = { statement, revision: 1, metadata: {
      name: "Original", color: null, workspace: { id: "shared-workspace", label: "Shared workspace" },
      createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    } };
    await applyProjectMetadata(localId, ownerId, envelope, process.env.PI_WEB_DATA_DIR!);

    let attempted = false;
    let blocked = false;
    const prepare = DatabaseSync.prototype.prepare;
    const interception = context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (!attempted && sql.startsWith("SELECT workspace_id FROM cluster_v2_shared_workspaces")) {
        attempted = true;
        // Commit through a real second connection after the recipient has read its policy.
        try { competing.exec("UPDATE contention_probe SET value=value+1"); }
        catch (error) { assert.equal((error as { errcode: number }).errcode, 5); blocked = true; }
      }
      return prepare.call(this, sql);
    });
    const updated = { ...envelope, revision: 2, metadata: { ...envelope.metadata, name: "Updated" } };
    try { await applyProjectMetadata(localId, ownerId, updated, process.env.PI_WEB_DATA_DIR!); }
    finally { interception.mock.restore(); }
    assert.equal(attempted, true, "exercise the interleaving before the workspace write");
    assert.equal(blocked, true, "metadata must own the write lock before reading");
    assert.equal((await getProject("shared-project"))?.name, "Updated");
    competing.exec("UPDATE contention_probe SET value=value+1");
    assert.equal(competing.prepare("SELECT value FROM contention_probe").get()!.value, 1);

    receiver.exec(`CREATE TRIGGER reject_receipt BEFORE UPDATE ON cluster_v2_project_metadata_receipts
      BEGIN SELECT RAISE(ABORT,'fixture receipt rejected'); END`);
    await assert.rejects(applyProjectMetadata(localId, ownerId, {
      ...updated, revision: 3, metadata: { ...updated.metadata, name: "Must roll back" },
    }, process.env.PI_WEB_DATA_DIR!), /fixture receipt rejected/);
    competing.exec("BEGIN IMMEDIATE; ROLLBACK");
    assert.equal((await getProject("shared-project"))?.name, "Updated", "the project write before the failed receipt must roll back");
    assert.equal(receiver.prepare("SELECT revision FROM cluster_v2_project_metadata_versions WHERE project_id=?").get("shared-project")!.revision, 2);
  } finally { owner.close(); competing.close(); }
});
