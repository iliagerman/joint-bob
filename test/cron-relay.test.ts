import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
import type { CronTask } from "../src/cron.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

test("a workspace relay hosts and runs schedules, transfers ownership, and rejects private or revoked projects", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cron-relay-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const ownerEnvironment = await seedDevEnvironment(path.join(root, "owner"), 1);
    const relayEnvironment = await seedDevEnvironment(path.join(root, "relay"), 1);
    const owner = ownerEnvironment.nodes[0], relay = relayEnvironment.nodes[0];
    const log = path.join(root, "engine.log");
    for (const environment of [ownerEnvironment, relayEnvironment]) children.push(await startDevNode(environment, environment.nodes[0], { JOINT_BOB_TEST_ENGINE_LOG: log }));
    const ownerAuth = await signIn(ownerEnvironment, owner), relayAuth = await signIn(relayEnvironment, relay);
    const serving = await fetch(`${relay.url}/api/relay/serving`, {
      method: "PUT", headers: { Cookie: relayAuth.cookie, "X-CSRF-Token": relayAuth.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, origin: `http://localhost:${relay.port}`, environment: "Schedule relay", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" }),
    });
    assert.equal(serving.status, 204);
    const invitation = await api<{ link: string }>(relay, relayAuth, "POST", "/relay/serving/tokens", { label: "Schedule owner" });
    assert.equal(invitation.status, 201);
    assert.equal((await api(owner, ownerAuth, "POST", "/relays", { link: invitation.body.link })).status, 201);
    await eventually(async () => {
      const destinations = await api<{ relays: Array<{ id: string }> }>(owner, ownerAuth, "GET", "/workspace-sharing/destinations");
      assert.ok(destinations.body.relays.some(item => item.id === relay.nodeId));
    });
    const workspace = await api<{ workspace: { id: string } }>(owner, ownerAuth, "PUT", "/workspaces", { label: "Scheduled relay work", sharing: { clusterIds: [], nodeIds: [], relayIds: [relay.nodeId] } });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const project = await api<{ project: { id: string } }>(owner, ownerAuth, "POST", "/projects", { name: "Scheduled relay project", type: workspace.body.workspace.id });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = project.body.project.id;
    await eventually(async () => {
      const inventory = await api<{ projects: Array<{ id: string }> }>(relay, relayAuth, "GET", "/projects?syncStatus=false");
      assert.ok(inventory.body.projects.some(item => item.id === projectId));
    });
    for (const [node, auth] of [[relay, relayAuth], [owner, ownerAuth]] as const) {
      const settings = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
      assert.equal((await api(node, auth, "PUT", "/settings", { ...settings.body, runnerAccess: { otherNodes: true } })).status, 200);
    }
    await eventually(async () => {
      const result = await api<{ nodes: Array<{ id: string; online: boolean; mapped: boolean; runner: boolean }> }>(owner, ownerAuth, "GET", `/projects/${projectId}/session-nodes`);
      assert.ok(result.body.nodes.some(node => node.id === relay.nodeId && node.online && node.mapped && node.runner), JSON.stringify(result.body));
    });
    const profile = await api<{ profile: { id: string } }>(relay, relayAuth, "POST", "/provider-profiles", { provider: "claude", label: "Synthetic scheduled execution" });
    assert.equal(profile.status, 201);
    const credentialDirectory = path.join(relay.dataDir, "provider-profile-auth", profile.body.profile.id);
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(path.join(credentialDirectory, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 86_400_000 } }));
    assert.equal((await api(relay, relayAuth, "PUT", `/provider-profiles/${profile.body.profile.id}/sharing`, { shared: true })).status, 200);
    const command = (nodeId: string, value: unknown) => api<{ task: CronTask; error?: string }>(owner, ownerAuth, "POST", "/cron", { nodeId, command: value });
    const input = { projectId, name: "Relay report", prompt: "Report", engine: "claude", sessionId: null, ownerNodeId: relay.nodeId, enabled: false, schedule: { frequency: "hourly", hour: 9, minute: (new Date().getUTCMinutes() + 30) % 60, weekday: 1, timezone: "UTC" } };
    const created = await command(relay.nodeId, { action: "create", input: { ...input, providerProfileId: profile.body.profile.id } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.task.ownerNodeId, relay.nodeId);
    const id = created.body.task.id;
    const relaySettings = await api<Record<string, unknown>>(relay, relayAuth, "GET", "/settings");
    assert.equal((await api(relay, relayAuth, "PUT", "/settings", { ...relaySettings.body, runnerAccess: { otherNodes: false } })).status, 200);
    const disabledRun = await signedNodeRequest(ownerEnvironment, owner, relay, "POST", "/api/cluster/v2/runtime/cron", { action: "run", id, projectId });
    assert.equal(disabledRun.status, 403, "turning off remote runs must also block Run now on existing schedules");
    assert.equal((await api(relay, relayAuth, "PUT", "/settings", { ...relaySettings.body, runnerAccess: { otherNodes: true } })).status, 200);
    const run = await command(relay.nodeId, { action: "run", id, projectId });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await eventually(async () => {
      const listed = await api<{ tasks: CronTask[] }>(owner, ownerAuth, "GET", `/projects/${projectId}/cron`);
      assert.equal(listed.body.tasks.find(task => task.id === id)?.lastRun?.status, "succeeded", JSON.stringify(listed.body));
    });
    assert.ok((await readFile(log, "utf8")).includes(`claude:${relay.nodeId}`), "the relay executes the scheduled agent, not the requesting node");
    const moved = await command(relay.nodeId, { action: "update", id, input: { ...input, ownerNodeId: owner.nodeId } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.task.ownerNodeId, owner.nodeId);
    const returned = await command(owner.nodeId, { action: "update", id, input });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    const privateProject = relay.projects[0].id;
    const denied = await signedNodeRequest(ownerEnvironment, owner, relay, "POST", "/api/cluster/v2/runtime/cron", { action: "list", projectId: privateProject });
    assert.equal(denied.status, 403);
    assert.equal((await api(owner, ownerAuth, "PUT", `/workspaces/${workspace.body.workspace.id}/sharing`, { clusterIds: [], nodeIds: [], relayIds: [] })).status, 200);
    await eventually(async () => {
      const reply = await signedNodeRequest(ownerEnvironment, owner, relay, "POST", "/api/cluster/v2/runtime/cron", { action: "run", id, projectId });
      assert.ok([401, 403].includes(reply.status), `revocation stops remote management of a stored schedule: ${reply.status}`);
    });
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
