import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

interface ServiceView { id: string; name: string; url: string; hasToken: boolean; isDefault: boolean }

test("an ntfy service can be shared to paired nodes and a default can be selected", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ntfy-cluster-"));
  const environment = await seedDevEnvironment(root, 2);
  const [nodeA, nodeB] = environment.nodes;
  const servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  try {
    const [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
    const first = await api<{ service: ServiceView }>(nodeA, sessionA, "POST", "/ntfy/services", { name: "Home", url: "https://ntfy.home.example", token: "home-secret" });
    const second = await api<{ service: ServiceView }>(nodeA, sessionA, "POST", "/ntfy/services", { name: "Backup", url: "https://ntfy.backup.example", token: "backup-secret" });
    assert.equal(first.body.service.isDefault, true, "the first service becomes the default");
    assert.equal(second.body.service.isDefault, false);

    const selected = await api(nodeA, sessionA, "PUT", `/ntfy/services/${second.body.service.id}/default`);
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    const local = await api<{ services: ServiceView[] }>(nodeA, sessionA, "GET", "/ntfy/services");
    assert.equal(local.body.services.find((service) => service.id === second.body.service.id)?.isDefault, true);

    const shared = await api<{ results: Array<{ peerId: string; ok: boolean }> }>(nodeA, sessionA, "POST", `/ntfy/services/${second.body.service.id}/share`);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.results, [{ peerId: nodeB.nodeId, ok: true }]);
    const remote = await api<{ services: ServiceView[] }>(nodeB, sessionB, "GET", "/ntfy/services");
    assert.deepEqual(remote.body.services, [{ ...second.body.service, isDefault: true }]);

    const bytes = await Promise.all(["node.db", "node.db-wal"].map(async (file) => {
      try { return await readFile(path.join(nodeB.dataDir, file)); } catch { return Buffer.alloc(0); }
    }));
    assert.ok(!Buffer.concat(bytes).includes("backup-secret"), "shared token stays encrypted at rest");
  } finally {
    await Promise.all(servers.map((server) => stopDevNode(server)));
    await rm(root, { recursive: true, force: true });
  }
});
