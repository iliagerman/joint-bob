import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ensureConversationRecord, getConversationRecord, setWebhookConversationHistory, ensureConversationRecordSchema, applyConversationRecordEvent } from "../src/conversation-records.js";
import { ensureReplicationSchema } from "../src/replication.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { getClusterNode } from "../src/cluster.js";
import { bindWebhookConversation, ensureWebhookAgentSchema } from "../src/webhook-agent.js";
import { createWebhook, recordWebhookDelivery, updateWebhook, webhookInputSchema } from "../src/webhooks.js";
import { updateWebhookHistory } from "../src/server/webhook-history.js";

test("webhook history visibility persists and replicates independently of transcript discovery", async () => {
  const projectId = randomUUID(), sessionId = randomUUID(), owner = randomUUID(), webhookId = randomUUID();
  await ensureConversationRecord(projectId, "pi", sessionId, owner);
  setWebhookConversationHistory(await clusterV2Database(), projectId, sessionId, webhookId, true, owner);
  const record = (await getConversationRecord(projectId, "pi", sessionId))!;
  assert.equal(record.webhookHistory?.hidden, true);
  const db = new DatabaseSync(":memory:");
  ensureConversationRecordSchema(db);
  ensureReplicationSchema(db);
  const event = (value: typeof record) => ({ id: randomUUID(), originNodeId: owner, entityType: "conversation.record", entityKey: `${projectId}:pi:${sessionId}`, operation: "upsert" as const, payload: { projectId, engine: "pi", sessionId, record: value, updatedAt: value.updatedAt, originNodeId: owner }, createdAt: value.updatedAt });
  applyConversationRecordEvent(db, event(record));
  const newer = { ...record, updatedAt: "2099-01-01T00:00:00.000Z" };
  delete newer.webhookHistory;
  applyConversationRecordEvent(db, event(newer));
  assert.equal(JSON.parse((db.prepare("SELECT webhook_history FROM conversation_records").get() as { webhook_history: string }).webhook_history).hidden, true);
  setWebhookConversationHistory(await clusterV2Database(), projectId, sessionId, webhookId, false, owner);
  const shown = (await getConversationRecord(projectId, "pi", sessionId))!;
  applyConversationRecordEvent(db, event(shown));
  assert.equal(JSON.parse((db.prepare("SELECT webhook_history FROM conversation_records").get() as { webhook_history: string }).webhook_history).hidden, false);
  db.close();
});

test("legacy bindings use creation evidence rather than the webhook's current target", () => {
  const db = new DatabaseSync(":memory:");
  const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Retargeted", target: { kind: "conversation", projectId: "project", sessionId: "appended", engine: "pi" } }));
  db.exec("CREATE TABLE webhook_conversation_bindings(webhook_id TEXT,project_id TEXT,conversation_id TEXT,owner_node_id TEXT,PRIMARY KEY(webhook_id,project_id,conversation_id))");
  for (const id of ["created", "appended"]) db.prepare("INSERT INTO webhook_conversation_bindings VALUES(?,?,?,?)").run(webhook.id, "project", id, "owner");
  recordWebhookDelivery(db, webhook.id, "delivered", "Started conversation created");
  recordWebhookDelivery(db, webhook.id, "delivered", "Added to the conversation");
  ensureWebhookAgentSchema(db);
  assert.deepEqual(db.prepare("SELECT conversation_id,created_conversation FROM webhook_conversation_bindings ORDER BY conversation_id").all().map(row => ({ ...row })), [
    { conversation_id: "appended", created_conversation: 0 }, { conversation_id: "created", created_conversation: 1 },
  ]);
  db.close();
});

test("hiding old runs does not hide conversations the webhook only appended to", async () => {
  const db = await clusterV2Database(), owner = (await getClusterNode()).id;
  const projectId = randomUUID(), created = randomUUID(), appended = randomUUID();
  const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Errors", target: { kind: "project", projectId }, hideFromHistory: true }));
  for (const id of [created, appended]) await ensureConversationRecord(projectId, "pi", id, owner);
  bindWebhookConversation(db, webhook.id, projectId, created, owner, true);
  bindWebhookConversation(db, webhook.id, projectId, appended, owner);
  await updateWebhookHistory(webhook);
  assert.equal((await getConversationRecord(projectId, "pi", created))?.webhookHistory?.hidden, true);
  assert.equal((await getConversationRecord(projectId, "pi", appended))?.webhookHistory, undefined);
  const shown = updateWebhook(db, webhook.id, webhookInputSchema.parse({ name: webhook.name, target: webhook.target, hideFromHistory: false }));
  await updateWebhookHistory(shown);
  assert.equal((await getConversationRecord(projectId, "pi", created))?.webhookHistory?.hidden, false);
});
