// src/cluster.ts holds only this node's identity. Membership, twins, and peer
// endpoints live in the signed cluster layer and have their own tests.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

type ClusterModule = typeof import("../src/cluster.js");

async function withClusterStore(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-cluster-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    await run(dataDir);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** A fresh module instance, as a restarted server would load it. */
async function freshCluster(tag: string): Promise<ClusterModule> {
  return await import(new URL(`../src/cluster.ts?${tag}=${Date.now()}-${Math.random()}`, import.meta.url).href) as ClusterModule;
}

function tableNames(dataDir: string): string[] {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

test("a new node creates one stable identity in SQLite and survives a restart", async () => {
  await withClusterStore(async (dataDir) => {
    const node = await (await freshCluster("create")).getClusterNode();
    assert.match(node.id, /^[0-9a-f-]{36}$/);
    assert.equal(node.name, os.hostname());

    assert.deepEqual(await (await freshCluster("restart")).getClusterNode(), node, "a restart keeps the same identity");
    await assert.rejects(access(path.join(dataDir, "cluster.json")), "identity is never written back to cluster.json");
  });
});

test("updating the node name and URL persists, normalises the URL, and ignores a no-op", async () => {
  await withClusterStore(async () => {
    const cluster = await freshCluster("update");
    const before = await cluster.getClusterNode();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await cluster.updateClusterNode("Mac", "https://mac.tailnet.ts.net/");
    assert.equal(updated.id, before.id, "renaming keeps the node identity");
    assert.equal(updated.name, "Mac");
    assert.equal(updated.url, "https://mac.tailnet.ts.net");
    assert.ok(updated.updatedAt > before.updatedAt);

    const unchanged = await cluster.updateClusterNode("Mac", "https://mac.tailnet.ts.net");
    assert.equal(unchanged.updatedAt, updated.updatedAt, "an identical update does not touch the row");
    assert.deepEqual(await (await freshCluster("update-restart")).getClusterNode(), updated);
  });
});

test("an install that predates SQLite keeps the identity from cluster.json", async () => {
  await withClusterStore(async (dataDir) => {
    const legacy = {
      id: "c8fc321e-bd7a-42ae-bbec-12b2c2c56afd", name: "Homeserver", url: "https://home.tailnet.ts.net",
      createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-02-01T00:00:00.000Z",
    };
    await writeFile(path.join(dataDir, "cluster.json"), JSON.stringify({ node: legacy, peers: [{ id: "legacy-peer", token: "legacy-token" }] }));

    assert.deepEqual(await (await freshCluster("legacy")).getClusterNode(), legacy);
    // Once imported, SQLite owns the identity: a later cluster.json edit is not re-read.
    await writeFile(path.join(dataDir, "cluster.json"), JSON.stringify({ node: { ...legacy, id: "00000000-0000-4000-8000-000000000000" } }));
    assert.deepEqual(await (await freshCluster("legacy-restart")).getClusterNode(), legacy);
  });
});

test("starting drops the retired bearer-token cluster tables and keeps the node identity", async () => {
  await withClusterStore(async (dataDir) => {
    const retired = [
      "cluster_invitations", "cluster_machine_credentials", "cluster_member_tombstones", "cluster_membership_deliveries",
      "cluster_membership_state", "cluster_peers", "cluster_project_grants", "cluster_secret_migrations", "cluster_v2_mode",
    ];
    await mkdir(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("CREATE TABLE cluster_node (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO cluster_node VALUES (1, ?, ?, ?, ?, ?)").run("9d7c2c8e-5d2e-4f55-9f55-7f1c8f1e2a11", "Kept", "https://kept.tailnet.ts.net", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    for (const table of retired) db.exec(`CREATE TABLE ${table} (id TEXT)`);
    db.exec(`CREATE TRIGGER cluster_v2_no_legacy_peer_insert BEFORE INSERT ON cluster_peers BEGIN SELECT RAISE(ABORT, 'retired'); END;
      CREATE TRIGGER cluster_v2_no_legacy_peer_update BEFORE UPDATE ON cluster_peers BEGIN SELECT RAISE(ABORT, 'retired'); END;`);
    db.close();

    const node = await (await freshCluster("retired")).getClusterNode();
    assert.equal(node.id, "9d7c2c8e-5d2e-4f55-9f55-7f1c8f1e2a11");
    assert.equal(node.name, "Kept");
    const remaining = tableNames(dataDir);
    for (const table of [...retired, "cluster_v2_no_legacy_peer_insert", "cluster_v2_no_legacy_peer_update"]) {
      assert.equal(remaining.includes(table), false, `${table} must be dropped`);
    }
    assert.ok(remaining.includes("cluster_node"));
  });
});
