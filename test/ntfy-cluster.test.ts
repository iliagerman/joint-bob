import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, pairTwinNodes } from "./dev-nodes.js";

interface ServiceView { id: string; name: string; url: string; hasToken: boolean; isDefault: boolean; sharing?: { includeTwins: boolean; clusterIds: string[] } }

test("an ntfy service can be shared to a selected cluster", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ntfy-cluster-target-"));
  const environment = await seedDevEnvironment(root, 2);
  const [nodeA, nodeB] = environment.nodes;
  const servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  try {
    const [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Selected" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    const service = await api<{ service: ServiceView }>(nodeA, sessionA, "POST", "/ntfy/services", { name: "Selected", url: "https://ntfy.example", token: "selected-secret" });
    const shared = await api<{ results: Array<{ peerId: string; ok: boolean }> }>(nodeA, sessionA, "POST", `/ntfy/services/${service.body.service.id}/share`, { includeTwins: false, clusterIds: [clusterId] });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.results, [{ peerId: nodeB.nodeId, ok: true }]);
    const remote = await api<{ services: ServiceView[] }>(nodeB, sessionB, "GET", "/ntfy/services");
    assert.deepEqual(remote.body.services, [{ ...service.body.service, isDefault: true, sharing: { includeTwins: false, clusterIds: [], pendingNodes: 0 } }]);
  } finally {
    await Promise.all(servers.map((server) => stopDevNode(server)));
    await rm(root, { recursive: true, force: true });
  }
});

test("an ntfy service can be shared to paired nodes and a default can be selected", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ntfy-cluster-"));
  const environment = await seedDevEnvironment(root, 2);
  const [nodeA, nodeB] = environment.nodes;
  const servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  await pairTwinNodes(environment);
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

    const shared = await api<{ results: Array<{ peerId: string; ok: boolean }> }>(nodeA, sessionA, "POST", `/ntfy/services/${second.body.service.id}/share`, {});
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.results, [{ peerId: nodeB.nodeId, ok: true }]);
    const remote = await api<{ services: ServiceView[] }>(nodeB, sessionB, "GET", "/ntfy/services");
    assert.deepEqual(remote.body.services, [{ ...second.body.service, isDefault: true, sharing: { includeTwins: false, clusterIds: [], pendingNodes: 0 } }]);

    const bytes = await Promise.all(["node.db", "node.db-wal"].map(async (file) => {
      try { return await readFile(path.join(nodeB.dataDir, file)); } catch { return Buffer.alloc(0); }
    }));
    assert.ok(!Buffer.concat(bytes).includes("backup-secret"), "shared token stays encrypted at rest");
  } finally {
    await Promise.all(servers.map((server) => stopDevNode(server)));
    await rm(root, { recursive: true, force: true });
  }
});

test("a cluster share stays on while a member is offline and reaches it when it returns", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-ntfy-cluster-offline-"));
  const environment = await seedDevEnvironment(root, 2);
  const [nodeA, nodeB] = environment.nodes;
  const servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));
  try {
    const [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "Offline" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    await stopDevNode(servers[1]);

    const service = await api<{ service: ServiceView }>(nodeA, sessionA, "POST", "/ntfy/services", { name: "Later", url: "https://ntfy.later.example", token: "later-secret" });
    const shared = await api<{ sharing: unknown; results: Array<{ peerId: string; ok: boolean }> }>(nodeA, sessionA, "POST", `/ntfy/services/${service.body.service.id}/share`, { includeTwins: false, clusterIds: [clusterId] });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.sharing, { includeTwins: false, clusterIds: [clusterId], pendingNodes: 1 });
    assert.deepEqual(shared.body.results.map(({ peerId, ok }) => ({ peerId, ok })), [{ peerId: nodeB.nodeId, ok: false }]);
    const local = await api<{ services: ServiceView[] }>(nodeA, sessionA, "GET", "/ntfy/services");
    assert.deepEqual(local.body.services[0].sharing, { includeTwins: false, clusterIds: [clusterId], pendingNodes: 1 }, "the share is on even though delivery failed");

    servers[1] = await startDevNode(environment, nodeB);
    const sessionB2 = await signIn(environment, nodeB);
    const deadline = Date.now() + 90_000;
    let received: ServiceView[] = [];
    while (Date.now() < deadline) {
      received = (await api<{ services: ServiceView[] }>(nodeB, sessionB2, "GET", "/ntfy/services")).body.services;
      if (received.length) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    assert.deepEqual(received.map(({ id, name, url, hasToken }) => ({ id, name, url, hasToken })), [{ id: service.body.service.id, name: "Later", url: "https://ntfy.later.example", hasToken: true }]);
  } finally {
    await Promise.all(servers.map((server) => stopDevNode(server)));
    await rm(root, { recursive: true, force: true });
  }
});
