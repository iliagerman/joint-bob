import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { bindWebhookConversation, webhookMemoryAgentEnvironment } from "../src/webhook-agent.js";
import { readWebhookMemory, setWebhookMemoryEnabled } from "../src/webhook-memory.js";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";

let server: Server;
let origin: string;
let root: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-memory-agent-api-"));
  server = createServer((await import("../src/app.js")).createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const db = await clusterV2Database();
  const ownerNodeId = (await getClusterNode()).id;
  const projectId = randomUUID(), conversationId = randomUUID();
  const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Support lessons", target: { kind: "project", projectId } }));
  setWebhookMemoryEnabled(db, webhook.id, true);
  bindWebhookConversation(db, webhook.id, projectId, conversationId, ownerNodeId);
  const env = webhookMemoryAgentEnvironment(db, projectId, conversationId, ownerNodeId);
  const [{ token }] = JSON.parse(env.JOINT_BOB_WEBHOOK_MEMORY_TOKENS!);
  return { db, webhook, env, token: token as string, projectId, ownerNodeId };
}

async function post(token: string | undefined, body: unknown) {
  const response = await fetch(`${origin}/api/webhook-agent/memory`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function cli(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = await promisify(execFile)(process.execPath, ["bin/joint-bob-webhook.mjs", "memory", ...args], {
    env: { ...process.env, ...env, JOINT_BOB_WEBHOOK_MEMORY_URL: `${origin}/api/webhook-agent/memory` },
  });
  return JSON.parse(result.stdout);
}

test("webhook memory capabilities authorize HTTP without a browser login or CSRF cookie", async () => {
  const { webhook, token } = await fixture();
  assert.equal((await post(undefined, { action: "list" })).status, 401);
  assert.equal((await post("f".repeat(64), { action: "list" })).status, 401);
  assert.deepEqual(await post(token, { action: "list" }), { status: 200, body: [{ webhookId: webhook.id, name: "Support lessons" }] });
  const initial = await post(token, { action: "read" });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.content, "");
  const updated = await post(token, { action: "write", expectedRevision: initial.body.revision, content: "# Verified lesson\n" });
  assert.equal(updated.status, 200);
  assert.equal((await readWebhookMemory(webhook.id)).content, "# Verified lesson\n");
  assert.equal((await post(token, { action: "write", expectedRevision: initial.body.revision, content: "stale" })).status, 409);
});

test("CLI memory writes persist for the next conversation bound to the same webhook", async () => {
  const { db, webhook, env, projectId, ownerNodeId } = await fixture();
  assert.deepEqual(await cli(env, "list"), [{ webhookId: webhook.id, name: "Support lessons" }]);
  const initial = await cli(env, "read", webhook.id);
  const proposed = path.join(root, "lesson.md");
  await writeFile(proposed, "# Lessons\nVerify the customer environment before investigating.\n");
  const saved = await cli(env, "write", webhook.id, initial.revision, proposed);
  assert.notEqual(saved.revision, initial.revision);
  assert.equal((await readWebhookMemory(webhook.id)).content, "# Lessons\nVerify the customer environment before investigating.\n");
  const nextConversation = randomUUID();
  bindWebhookConversation(db, webhook.id, projectId, nextConversation, ownerNodeId);
  const nextEnv = webhookMemoryAgentEnvironment(db, projectId, nextConversation, ownerNodeId);
  assert.deepEqual(await cli(nextEnv, "read", webhook.id), saved);
});

test("memory capabilities cannot select another webhook or access settings and management routes", async () => {
  const { token } = await fixture();
  const other = await fixture();
  assert.equal((await post(token, { action: "read", webhookId: other.webhook.id })).status, 400);
  assert.equal((await post(token, { action: "write", webhookId: other.webhook.id, expectedRevision: "0".repeat(64), content: "wrong webhook" })).status, 400);
  assert.equal((await readWebhookMemory(other.webhook.id)).content, "");
  for (const endpoint of ["/api/settings", `/api/webhooks/${other.webhook.id}/memory`]) {
    const response = await fetch(`${origin}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
  }
});

test("disabled memory, expired tokens and removed bindings refuse agent access", async () => {
  const { db, webhook, token } = await fixture();
  assert.equal((await post(token, { action: "read" })).status, 200);
  setWebhookMemoryEnabled(db, webhook.id, false);
  assert.equal((await post(token, { action: "read" })).status, 401);
  setWebhookMemoryEnabled(db, webhook.id, true);
  db.prepare("UPDATE webhook_memory_agent_tokens SET expires_at=0 WHERE webhook_id=?").run(webhook.id);
  assert.equal((await post(token, { action: "read" })).status, 401);
  const removed = await fixture();
  db.prepare("DELETE FROM webhook_conversation_bindings WHERE webhook_id=?").run(removed.webhook.id);
  assert.equal((await post(removed.token, { action: "read" })).status, 401);
});
