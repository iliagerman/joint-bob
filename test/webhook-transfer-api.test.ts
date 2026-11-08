import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAutomationExecution } from "../src/automation-executions.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import type { Webhook } from "../src/webhooks.js";

test("webhook transfer preserves settings, resources, memory and calls on the chosen machine", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-transfer-"));
  const servers: ChildProcess[] = [];
  try {
    const env = await seedDevEnvironment(root, 2);
    const [a, b] = env.nodes;
    for (const node of env.nodes) servers.push(await startDevNode(env, node));
    const auth = await signIn(env, a);
    await pairTwinNodes(env);
    const created = await api<{ webhook: Webhook; secret: string }>(a, auth, "POST", "/webhooks", { name: "Move me", target: { kind: "project", projectId: a.projects[0].id }, context: "Keep these instructions", senders: { fields: ["sender"], allowed: [] } });
    assert.equal(created.status, 201);
    const id = created.body.webhook.id;
    const url = `/webhooks/${id}`;
    assert.equal((await api(a, auth, "POST", `${url}/transfer`, { nodeId: randomUUID() })).status, 403);
    const database = new DatabaseSync(path.join(a.dataDir, "node.db"));
    const runId = randomUUID();
    try {
      database.exec("PRAGMA busy_timeout=5000");
      createAutomationExecution(database, { id: runId, sourceKind: "webhook", sourceId: id, sourceName: "Move me", workspaceId: null, projectId: a.projects[0].id, ownerNodeId: a.nodeId, engine: "pi", requestId: runId, sessionId: null, tags: [], status: "running", error: null, acceptedAt: new Date().toISOString(), startedAt: null, finishedAt: null });
      assert.equal((await api(a, auth, "POST", `${url}/transfer`, { nodeId: b.nodeId })).status, 409, "running webhook cannot move");
      assert.equal(database.prepare("SELECT enabled FROM webhooks WHERE id=?").get(id)!.enabled, 1, "rejected transfer leaves source enabled");
      database.prepare("DELETE FROM automation_executions WHERE id=?").run(runId);
    } finally { database.close(); }
    const resource = await api(a, auth, "POST", `${url}/resources`, { kind: "file", name: "rules.txt", description: "Rules", data: Buffer.from("keep me").toString("base64") });
    assert.equal(resource.status, 201);
    const skill = await api(a, auth, "POST", `${url}/skills`, { action: "upload", files: [{ relativePath: "SKILL.md", data: Buffer.from("---\nname: move-test\ndescription: Transfer fixture\n---\nKeep this skill\n").toString("base64") }] });
    assert.equal(skill.status, 201);
    const memory = await api<{ revision: string }>(a, auth, "GET", `${url}/memory`);
    assert.equal((await api(a, auth, "PUT", `${url}/memory`, { content: "Remember this", expectedRevision: memory.body.revision })).status, 200);
    assert.equal((await fetch(`${a.url}/hooks/${created.body.secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{}' })).status, 202);
    assert.equal((await api(a, auth, "POST", `${url}/transfer`, { nodeId: a.nodeId })).status, 400);
    const moved = await api<{ webhook: Webhook; secret: string; bases: Array<{ base: string }> }>(a, auth, "POST", `${url}/transfer`, { nodeId: b.nodeId });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.webhook.id, id);
    assert.equal(moved.body.webhook.context, "Keep these instructions");
    assert.ok(moved.body.bases.some(base => base.base === `${b.url}/hooks`));
    assert.equal((await fetch(`${a.url}/hooks/${created.body.secret}`, { method: "POST" })).status, 404);
    const local = await api<{ webhooks: Webhook[] }>(a, auth, "GET", "/webhooks");
    assert.equal(local.body.webhooks.length, 0);
    const suffix = `?nodeId=${b.nodeId}`;
    const resources = await api<{ resources: Array<{ id: string }> }>(a, auth, "GET", `${url}/resources${suffix}`);
    assert.equal(resources.body.resources.length, 1);
    const file = await api<{ data: string }>(a, auth, "GET", `${url}/resources/${resources.body.resources[0].id}/download${suffix}`);
    assert.equal(Buffer.from(file.body.data, "base64").toString(), "keep me");
    assert.equal((await api<{ content: string }>(a, auth, "GET", `${url}/memory${suffix}`)).body.content, "Remember this");
    assert.equal((await api<{ skills: unknown[] }>(a, auth, "GET", `${url}/skills${suffix}`)).body.skills.length, 1);
    assert.equal((await api<{ deliveries: unknown[] }>(a, auth, "GET", `${url}/deliveries${suffix}`)).body.deliveries.length, 1);
    const back = await api(a, auth, "POST", `${url}/transfer${suffix}`, { nodeId: a.nodeId });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    await stopDevNode(servers[1]);
    const failed = await api(a, auth, "POST", `${url}/transfer`, { nodeId: b.nodeId });
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    const paused = await api<{ webhooks: Webhook[] }>(a, auth, "GET", "/webhooks");
    assert.equal(paused.body.webhooks[0].id, id, "failed transfer retains the source");
    assert.equal(paused.body.webhooks[0].enabled, false, "uncertain transfer stays paused");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
