import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("automation saves reject unavailable profiles, ignore forged creators, and preserve assignments", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-profile-api-"));
  let server;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const profile = await api<{ profile: { id: string; owner: string } }>(node, auth, "POST", "/provider-profiles", { label: "Synthetic", provider: "claude" });
    assert.equal(profile.status, 201);
    const providerProfileId = profile.body.profile.id;
    const base = { creatorAccountId: "forged-account", providerProfileId, name: "Test", target: { kind: "project", projectId: node.projects[0].id }, enabled: false };
    const invalid = await api(node, auth, "POST", "/webhooks", { ...base, providerProfileId: randomUUID() });
    assert.ok(invalid.status >= 400, "unknown node-local profile must not save");
    const hook = await api<{ webhook: { id: string; creatorAccountId: string; providerProfileId: string | null } }>(node, auth, "POST", "/webhooks", base);
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.equal(hook.body.webhook.creatorAccountId, profile.body.profile.owner);
    assert.equal(hook.body.webhook.providerProfileId, providerProfileId);
    const profiles = await api<{ profiles: Array<{ id: string }> }>(node, auth, "GET", "/webhooks/profiles");
    assert.ok(profiles.body.profiles.some(p => p.id === providerProfileId));
    const input = { creatorAccountId: "forged-account", providerProfileId, projectId: node.projects[0].id, name: "Profile schedule", prompt: "Never run", engine: "claude", sessionId: null, ownerNodeId: node.nodeId, enabled: false, schedule: { frequency: "daily", hour: 9, minute: 0, weekday: 1, timezone: "UTC" } };
    const command = (input: unknown) => ({ nodeId: node.nodeId, command: { action: "create", input } });
    assert.ok((await api(node, auth, "POST", "/cron", command({ ...input, providerProfileId: randomUUID() }))).status >= 400);
    const task = await api<{ task: { id: string; creatorAccountId: string; providerProfileId: string } }>(node, auth, "POST", "/cron", command(input));
    assert.equal(task.status, 200, JSON.stringify(task.body));
    assert.equal(task.body.task.creatorAccountId, profile.body.profile.owner);
    assert.equal(task.body.task.providerProfileId, providerProfileId);
    const cleared = await api<{ webhook: { creatorAccountId: string; providerProfileId: null } }>(node, auth, "PUT", `/webhooks/${hook.body.webhook.id}`, { ...base, providerProfileId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.webhook.creatorAccountId, profile.body.profile.owner);
    assert.equal(cleared.body.webhook.providerProfileId, null);
    // The same project remains visible, but its automations belong to a different user.
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      db.prepare("UPDATE webhooks SET creator_account_id=? WHERE id=?").run("different-creator", hook.body.webhook.id);
      db.prepare("UPDATE cron_tasks SET input=json_set(input, '$.creatorAccountId', ?) WHERE id=?").run("different-creator", task.body.task.id);
    } finally { db.close(); }
    const rewrittenHook = await api(node, auth, "PUT", `/webhooks/${hook.body.webhook.id}`, { ...base, context: "Unapproved work", providerProfileId: null });
    assert.equal(rewrittenHook.status, 404, "an editor must not cause work under the original creator's current profile");
    const rewrittenTask = await api(node, auth, "POST", "/cron", { nodeId: node.nodeId, command: { action: "update", id: task.body.task.id, input: { ...input, prompt: "Unapproved work", providerProfileId: null } } });
    assert.equal(rewrittenTask.status, 404, "inherited-profile schedule updates require the creator too");
  } finally { if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
