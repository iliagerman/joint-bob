import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
import type { Webhook } from "../src/webhooks.js";

test("webhooks have one chosen twin owner, route management there, and never fall back", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-twins-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
    const authA = await signIn(environment, a);
    const authB = await signIn(environment, b);
    const input = { name: "Twin hook", target: { kind: "project", projectId: a.projects[0].id, engine: "pi" }, attachments: true, senders: { fields: ["sender"], allowed: [] } };
    const suffix = `?nodeId=${b.nodeId}`;
    const owners = () => api<{ owners: Array<{ id: string }> }>(a, authA, "GET", "/webhooks/owners");
    assert.equal((await owners()).status, 200, "webhook owner choices are available");
    assert.deepEqual((await owners()).body.owners.map(owner => owner.id), [a.nodeId]);
    assert.equal((await api(a, authA, "POST", `/webhooks${suffix}`, input)).status, 403, "unpaired nodes cannot own a remote webhook");
    const relationship = await pairTwinNodes(environment);
    assert.deepEqual(new Set((await owners()).body.owners.map(owner => owner.id)), new Set([a.nodeId, b.nodeId]));
    assert.equal((await api(a, authA, "GET", "/webhooks?nodeId=bad-id")).status, 400);
    assert.equal((await api(a, authA, "GET", `/webhooks?nodeId=${randomUUID()}`)).status, 403);
    const projects = await api<{ projects: Array<{ id: string }> }>(a, authA, "GET", `/webhooks/projects${suffix}`);
    assert.equal(projects.status, 200);
    assert.ok(projects.body.projects.some(project => project.id === input.target.projectId));
    assert.equal((await api(a, authA, "GET", `/webhooks/projects/${input.target.projectId}/sessions${suffix}`)).status, 200);
    assert.equal((await api(a, authA, "POST", `/webhooks${suffix}`, { ...input, target: { kind: "project", projectId: "missing" } })).status, 404);

    const created = await api<{ webhook: Webhook; secret: string; bases: Array<{ base: string }> }>(a, authA, "POST", `/webhooks${suffix}`, input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { webhook, secret } = created.body;
    assert.ok(created.body.bases.some(base => base.base === `${b.url}/hooks`), "addresses come from the owner, not the laptop");
    const local = () => api<{ webhooks: Webhook[] }>(a, authA, "GET", "/webhooks");
    const remote = () => api<{ webhooks: Webhook[] }>(b, authB, "GET", "/webhooks");
    assert.deepEqual((await local()).body.webhooks, [], "no local copy");
    assert.deepEqual((await remote()).body.webhooks.map(hook => hook.id), [webhook.id]);
    const listed = await api<{ webhooks: Webhook[] }>(a, authA, "GET", `/webhooks${suffix}`);
    assert.equal(listed.body.webhooks[0].id, webhook.id);
    const call = (url: string, token = secret) => fetch(`${url}/hooks/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"sender":"unknown"}' });
    assert.equal((await call(a.url)).status, 404, "the laptop never accepts the owner's secret");
    assert.equal((await call(b.url)).status, 202);
    const calls = await api<{ deliveries: Array<{ status: string }> }>(a, authA, "GET", `/webhooks/${webhook.id}/deliveries${suffix}`);
    assert.equal(calls.body.deliveries[0].status, "refused", "history is read from the owner");
    assert.equal((await api(a, authA, "PUT", `/webhooks/${webhook.id}${suffix}`, { ...input, senders: null })).status, 200);
    assert.equal((await call(b.url)).status, 202);
    let executed = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      executed = await readFile(path.join(root, "engine.log"), "utf8").catch(() => "");
      if (executed.trim()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(executed.trim().split("\n"), [`pi:${b.nodeId}`], "the call executes exactly once, on the owner");
    assert.deepEqual((await local()).body.webhooks, [], "delivery still does not replicate the webhook");
    assert.equal((await api(a, authA, "PUT", `/webhooks/${webhook.id}${suffix}`, { ...input, enabled: false })).status, 200);
    assert.equal((await remote()).body.webhooks[0].enabled, false);
    const regenerated = await api<{ secret: string; bases: Array<{ base: string }> }>(a, authA, "POST", `/webhooks/${webhook.id}/regenerate${suffix}`, {});
    assert.equal(regenerated.status, 200);
    assert.notEqual(regenerated.body.secret, secret);
    assert.equal((await call(b.url)).status, 404);
    assert.equal((await call(b.url, regenerated.body.secret)).status, 403, "the replacement stays disabled");
    const removed = await fetch(`${a.url}/api/webhooks/${webhook.id}${suffix}`, { method: "DELETE", headers: { Cookie: authA.cookie, "x-csrf-token": authA.csrfToken } });
    assert.equal(removed.status, 204);
    assert.deepEqual((await remote()).body.webhooks, []);

    await stopDevNode(servers[1]);
    assert.equal((await api(a, authA, "POST", `/webhooks${suffix}`, input)).status, 503, "offline owner fails without local creation");
    assert.deepEqual((await local()).body.webhooks, []);
    servers[1] = await startDevNode(environment, b, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
    assert.equal((await api(a, authA, "DELETE", `/twins/${relationship}`)).status, 200);
    assert.equal((await api(a, authA, "POST", `/webhooks${suffix}`, input)).status, 403, "revoked twins cannot receive creations");
    const forbidden = await signedNodeRequest(environment, b, a, "POST", "/api/cluster/v2/webhooks", { action: "create", input });
    assert.equal(forbidden.status, 403, "receiver also checks twin trust, not just the signature");
    assert.deepEqual((await owners()).body.owners.map(owner => owner.id), [a.nodeId]);
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
