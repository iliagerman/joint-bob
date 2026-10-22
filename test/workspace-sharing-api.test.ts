import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { addSharingMember } from "../src/cluster-sharing-policy.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("workspace creation shares existing and future projects without changing other workspace selections", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-sharing-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const env = await seedDevEnvironment(root, 1), node = env.nodes[0];
    children.push(await startDevNode(env, node));
    const session = await signIn(env, node);
    const cluster = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "Workspace recipients" });
    assert.equal(cluster.status, 201);
    const clusterId = cluster.body.snapshot.body.clusterId;
    const created = await api<{ workspace: { id: string } }>(node, session, "PUT", "/workspaces", { label: "Shared clients", sharing: { clusterIds: [clusterId], nodeIds: [], relayIds: [] } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.workspace.id;
    const sharing = await api<{ clusterIds: string[] }>(node, session, "GET", `/workspaces/${id}/sharing`);
    assert.equal(sharing.status, 200, "workspace sharing must be readable after creation");
    assert.deepEqual(sharing.body.clusterIds, [clusterId]);
    const directory = path.join(root, "future"); await mkdir(directory);
    const project = await api<{ project: { id: string } }>(node, session, "POST", "/projects", { name: "Future client", type: id, path: directory, synced: false });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const policy = await api<{ shares: Array<{ clusterId: string }> }>(node, session, "GET", `/sharing/project/${project.body.project.id}`);
    assert.deepEqual(policy.body.shares.map((share) => share.clusterId), [clusterId]);
    const peerId = randomUUID();
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { addSharingMember(db, clusterId, node.nodeId, peerId, 1); } finally { db.close(); }
    assert.equal((await api(node, session, "PUT", `/workspaces/${id}/sharing`, { clusterIds: [], nodeIds: [peerId], relayIds: [] })).status, 200);
    const legacy = await api(node, session, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [], workspaceIds: [id], confirmOwnedData: true });
    assert.equal(legacy.status, 200, "existing cluster editor can upgrade a node-scoped workspace share");
    assert.deepEqual((await api<{shares: Array<{clusterId: string;nodeIds?: string[]}>}>(node, session, "GET", `/sharing/project/${project.body.project.id}`)).body.shares, [{ clusterId, projectId: null }]);
    const revoked = await api(node, session, "PUT", `/workspaces/${id}/sharing`, { clusterIds: [], nodeIds: [], relayIds: [] });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.deepEqual((await api<{ shares: unknown[] }>(node, session, "GET", `/sharing/project/${project.body.project.id}`)).body.shares, []);
    assert.equal((await api(node, session, "GET", `/projects/${project.body.project.id}`)).status, 200, "revoking sharing must preserve projects");
    const bad = await api(node, session, "PUT", "/workspaces", { label: "Invalid share", sharing: { clusterIds: ["00000000-0000-4000-8000-000000000001"], nodeIds: [], relayIds: [] } });
    assert.equal(bad.status, 403, "unknown recipients must be rejected before creating a workspace");
    const workspaces = await api<{ workspaces: Array<{ id: string }> }>(node, session, "GET", "/workspaces");
    assert.ok(!workspaces.body.workspaces.some((workspace) => workspace.id === "invalid-share"));
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
