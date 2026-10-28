import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("workspace tag API manages tags and hides unknown workspaces", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-tags-api-"));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    const workspaces = await api<{ workspaces: Array<{ id: string }> }>(node, session, "GET", "/workspaces");
    const workspaceId = workspaces.body.workspaces[0].id;
    const report = await api<{ total: number; statistics: { executions: number } }>(node, session, "GET", `/workspaces/${workspaceId}/automation-executions`);
    assert.equal(report.status, 200);
    assert.equal(report.body.statistics.executions, 0);
    const created = await api<{ tag: { id: string; name: string } }>(node, session, "POST", `/workspaces/${workspaceId}/automation-tags`, { name: "  Nightly  " });
    assert.equal(created.status, 201);
    assert.equal(created.body.tag.name, "Nightly");
    const listed = await api<{ tags: Array<{ id: string }> }>(node, session, "GET", `/workspaces/${workspaceId}/automation-tags`);
    assert.deepEqual(listed.body.tags.map(tag => tag.id), [created.body.tag.id]);
    assert.equal((await api(node, session, "PATCH", `/workspaces/${workspaceId}/automation-tags/${created.body.tag.id}`, { name: "Daily" })).status, 200);
    const deleted = await fetch(`${node.url}/api/workspaces/${workspaceId}/automation-tags/${created.body.tag.id}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(deleted.status, 204);
    assert.equal((await api(node, session, "GET", "/workspaces/not-a-workspace/automation-tags")).status, 404);
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
