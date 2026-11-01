import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWebhook, deleteWebhook, webhookInputSchema } from "../src/webhooks.js";
import { bindWebhookConversation, webhookMemoryAgentEnvironment, webhookMemoryAgentIdentity } from "../src/webhook-agent.js";
import { setWebhookMemoryEnabled } from "../src/webhook-memory.js";

const input = webhookInputSchema.parse({ name: "Issues", target: { kind: "project", projectId: "p1" } });

test("webhook capability refresh waits for another writer with and without a bound webhook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-contention-"));
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "test/fixtures/webhook-agent-contention.ts"], {
      env: { HOME: root, PATH: process.env.PATH, NODE_ENV: "test", PI_WEB_DATA_DIR: root },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deleting a webhook revokes agent memory tokens", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { webhook } = createWebhook(db, input);
    setWebhookMemoryEnabled(db, webhook.id, true);
    bindWebhookConversation(db, webhook.id, "p1", "conversation-a", "node-a");
    const environment = webhookMemoryAgentEnvironment(db, "p1", "conversation-a", "node-a");
    const [{ token }] = JSON.parse(environment.JOINT_BOB_WEBHOOK_MEMORY_TOKENS!);
    deleteWebhook(db, webhook.id);
    assert.equal(webhookMemoryAgentIdentity(db, token, "node-a"), undefined);
  } finally { db.close(); }
});

test("webhook memory agent tokens authorize only a bound conversation and enabled memory", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const { webhook } = createWebhook(db, input);
    setWebhookMemoryEnabled(db, webhook.id, true);
    bindWebhookConversation(db, webhook.id, "p1", "conversation-a", "node-a");
    const environment = webhookMemoryAgentEnvironment(db, "p1", "conversation-a", "node-a");
    const bindings = JSON.parse(environment.JOINT_BOB_WEBHOOK_MEMORY_TOKENS!);
    assert.equal(bindings.length, 1);
    assert.equal(webhookMemoryAgentIdentity(db, bindings[0].token, "node-a")?.webhookId, webhook.id);
    assert.equal(webhookMemoryAgentIdentity(db, bindings[0].token, "node-b"), undefined);
    assert.notEqual((db.prepare("SELECT token_hash FROM webhook_memory_agent_tokens").get() as { token_hash: string }).token_hash, bindings[0].token);
    assert.deepEqual(webhookMemoryAgentEnvironment(db, "p1", "conversation-b", "node-a"), {});
    setWebhookMemoryEnabled(db, webhook.id, false);
    assert.equal(webhookMemoryAgentIdentity(db, bindings[0].token, "node-a"), undefined);
  } finally { db.close(); }
});
