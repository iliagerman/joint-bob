import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

test("webhooks can be created and transferred to a shared relay without exposing unrelated projects", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-relay-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "owner"), 1), b = await seedDevEnvironment(path.join(root, "relay"), 1);
    const owner = a.nodes[0], relay = b.nodes[0];
    const log = path.join(root, "engine.log");
    for (const environment of [a, b]) children.push(await startDevNode(environment, environment.nodes[0], { JOINT_BOB_TEST_ENGINE_LOG: log }));
    const sa = await signIn(a, owner), sb = await signIn(b, relay);
    const serving = await fetch(`${relay.url}/api/relay/serving`, { method: "PUT", headers: { Cookie: sb.cookie, "X-CSRF-Token": sb.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, origin: `http://localhost:${relay.port}`, environment: "Webhook relay", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" }) });
    assert.equal(serving.status, 204);
    const token = await api<{ link: string }>(relay, sb, "POST", "/relay/serving/tokens", { label: "Webhook owner" });
    assert.equal((await api(owner, sa, "POST", "/relays", { link: token.body.link })).status, 201);
    await eventually(async () => {
      const destinations = await api<{ relays: Array<{ id: string }> }>(owner, sa, "GET", "/workspace-sharing/destinations");
      assert.ok(destinations.body.relays.some(item => item.id === relay.nodeId));
    });
    const workspace = await api<{ workspace: { id: string } }>(owner, sa, "PUT", "/workspaces", { label: "Shared webhook work", sharing: { clusterIds: [], nodeIds: [], relayIds: [relay.nodeId] } });
    assert.equal(workspace.status, 200);
    const project = await api<{ project: { id: string } }>(owner, sa, "POST", "/projects", { name: "Webhook project", type: workspace.body.workspace.id });
    const projectId = project.body.project.id;
    await eventually(async () => {
      const projects = await api<{ projects: Array<{ id: string }> }>(relay, sb, "GET", "/projects?syncStatus=false");
      assert.ok(projects.body.projects.some(item => item.id === projectId));
    });
    const settings = await api<Record<string, unknown>>(relay, sb, "GET", "/settings");
    assert.equal((await api(relay, sb, "PUT", "/settings", { ...settings.body, runnerAccess: { otherNodes: true } })).status, 200);
    const owners = await api<{ owners: Array<{ id: string; twin?: boolean }> }>(owner, sa, "GET", `/webhooks/owners?projectId=${projectId}`);
    assert.ok(owners.body.owners.some(item => item.id === relay.nodeId && item.twin === false), JSON.stringify(owners.body));
    const hidden = await api<{ owners: Array<{ id: string }> }>(owner, sa, "GET", `/webhooks/owners?projectId=${owner.projects[0].id}`);
    assert.ok(!hidden.body.owners.some(item => item.id === relay.nodeId));
    const input = { name: "Shared relay hook", enabled: false, target: { kind: "project", projectId } };
    const created = await api<{ webhook: { id: string }; secret: string }>(owner, sa, "POST", `/webhooks?nodeId=${relay.nodeId}`, input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const privateSecret = await api<{ account: { id: string } }>(relay, sb, "POST", "/secrets/accounts", { label: "Private secret", provider: "custom", variables: [{ name: "PRIVATE_FIXTURE", kind: "value", value: "synthetic-private-value" }] });
    assert.equal(privateSecret.status, 201);
    const options = await api<{ secretAccounts: Array<{ id: string }> }>(owner, sa, "GET", `/webhooks/options?nodeId=${relay.nodeId}`);
    assert.equal(options.status, 200);
    assert.ok(!options.body.secretAccounts.some(account => account.id === privateSecret.body.account.id));
    assert.equal((await api(owner, sa, "POST", `/webhooks?nodeId=${relay.nodeId}`, { ...input, secretAccountIds: [privateSecret.body.account.id] })).status, 403);
    const privateHook = await api<{ webhook: { id: string } }>(relay, sb, "POST", "/webhooks", { ...input, name: "Private hook", target: { kind: "project", projectId: relay.projects[0].id } });
    assert.equal(privateHook.status, 201);
    const listed = await api<{ webhooks: Array<{ id: string }> }>(owner, sa, "GET", `/webhooks?nodeId=${relay.nodeId}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.webhooks.map(hook => hook.id), [created.body.webhook.id]);
    const projects = await api<{ projects: Array<{ id: string }> }>(owner, sa, "GET", `/webhooks/projects?nodeId=${relay.nodeId}`);
    assert.deepEqual(projects.body.projects.map(item => item.id), [projectId]);
    for (const command of [
      { action: "deliveries", id: privateHook.body.webhook.id },
      { action: "memory-read", id: privateHook.body.webhook.id },
      { action: "resource-list", id: privateHook.body.webhook.id },
      { action: "delete", id: privateHook.body.webhook.id },
      { action: "update", id: privateHook.body.webhook.id, input },
      { action: "create", input: { ...input, target: { kind: "project", projectId: relay.projects[0].id } } },
    ]) {
      const denied = await signedNodeRequest(a, owner, relay, "POST", "/api/cluster/v2/webhooks", command);
      assert.equal(denied.status, 403, JSON.stringify(command));
    }
    assert.equal((await api(relay, sb, "PUT", "/settings", { ...settings.body, runnerAccess: { otherNodes: false } })).status, 200);
    assert.equal((await api(owner, sa, "POST", `/webhooks?nodeId=${relay.nodeId}`, input)).status, 403, "relay owners must opt in to remote execution");
    assert.equal((await api(relay, sb, "PUT", "/settings", { ...settings.body, runnerAccess: { otherNodes: true } })).status, 200);
    const privateSource = await api<{ webhook: { id: string } }>(owner, sa, "POST", "/webhooks", { ...input, enabled: true, target: { kind: "project", projectId: owner.projects[0].id } });
    assert.equal((await api(owner, sa, "POST", `/webhooks/${privateSource.body.webhook.id}/transfer`, { nodeId: relay.nodeId })).status, 403);
    const unchanged = await api<{ webhooks: Array<{ id: string; enabled: boolean }> }>(owner, sa, "GET", "/webhooks");
    assert.equal(unchanged.body.webhooks.find(hook => hook.id === privateSource.body.webhook.id)?.enabled, true, "an unauthorized transfer must not pause its source");
    const profile = await api<{ profile: { id: string } }>(relay, sb, "POST", "/provider-profiles", { provider: "claude", label: "Synthetic webhook execution" });
    assert.equal(profile.status, 201);
    const execution = { ...input, enabled: true, target: { kind: "project", projectId, engine: "claude" }, providerProfileId: profile.body.profile.id };
    assert.equal((await api(owner, sa, "PUT", `/webhooks/${created.body.webhook.id}?nodeId=${relay.nodeId}`, execution)).status, 403, "a shared project does not grant a private profile");
    assert.equal((await api(relay, sb, "PUT", `/provider-profiles/${profile.body.profile.id}/sharing`, { shared: true })).status, 200);
    const credentialDirectory = path.join(relay.dataDir, "provider-profile-auth", profile.body.profile.id);
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(path.join(credentialDirectory, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 86_400_000 } }));
    assert.equal((await api(owner, sa, "PUT", `/webhooks/${created.body.webhook.id}?nodeId=${relay.nodeId}`, execution)).status, 200);
    assert.equal((await fetch(`${relay.url}/hooks/${created.body.secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Run on the relay" }) })).status, 202);
    await eventually(async () => assert.ok((await readFile(log, "utf8")).includes(`claude:${relay.nodeId}`), "the relay runs the webhook conversation"));
    const local = await api<{ webhook: { id: string } }>(owner, sa, "POST", "/webhooks", input);
    assert.equal(local.status, 201);
    const moved = await api<{ webhook: { id: string }; secret: string }>(owner, sa, "POST", `/webhooks/${local.body.webhook.id}/transfer`, { nodeId: relay.nodeId });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.webhook.id, local.body.webhook.id);
    assert.ok(moved.body.secret);
    const source = await api<{ webhooks: Array<{ id: string }> }>(owner, sa, "GET", "/webhooks");
    assert.ok(!source.body.webhooks.some(hook => hook.id === local.body.webhook.id));
    assert.equal((await api(owner, sa, "PUT", `/workspaces/${workspace.body.workspace.id}/sharing`, { clusterIds: [], nodeIds: [], relayIds: [] })).status, 200);
    await eventually(async () => {
      const denied = await signedNodeRequest(a, owner, relay, "POST", "/api/cluster/v2/webhooks", { action: "list" });
      assert.ok([401, 403].includes(denied.status));
    });
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
