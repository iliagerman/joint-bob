import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebhookWorkspace, setWebhookConversationWorkspace, webhookConversationWorkspace } from "../src/webhook-workspaces.js";

test("fresh webhook workspaces are unique and preserved workspaces are webhook-scoped", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-workspaces-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const first = await createWebhookWorkspace("11111111-1111-4111-8111-111111111111", false);
  const second = await createWebhookWorkspace("11111111-1111-4111-8111-111111111111", false);
  context.after(async () => { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); });
  assert.notEqual(first, second);
  const preservedA = await createWebhookWorkspace("11111111-1111-4111-8111-111111111111", true);
  const preservedB = await createWebhookWorkspace("22222222-2222-4222-8222-222222222222", true);
  assert.equal(await createWebhookWorkspace("11111111-1111-4111-8111-111111111111", true), preservedA);
  assert.notEqual(preservedA, preservedB);
});

test("workspace directory is bound to the created webhook conversation", () => {
  const db = new DatabaseSync(":memory:");
  try {
    setWebhookConversationWorkspace(db, "project", "pi", "session", "hook", "/tmp/private-workspace");
    assert.equal(webhookConversationWorkspace(db, "project", "pi", "session"), "/tmp/private-workspace");
    assert.equal(webhookConversationWorkspace(db, "project", "pi", "other"), undefined);
  } finally { db.close(); }
});
