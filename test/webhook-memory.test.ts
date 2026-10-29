import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";
import { readWebhookMemory, setWebhookMemoryEnabled, writeWebhookMemory } from "../src/webhook-memory.js";

const input = webhookInputSchema.parse({ name: "Issues", target: { kind: "project", projectId: "p1" } });

test("webhook memory persists, hashes actual bytes and survives disable and re-enable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-memory-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const empty = await readWebhookMemory(webhook.id, { root });
    await setWebhookMemoryEnabled(db, webhook.id, true);
    const saved = await writeWebhookMemory(db, webhook.id, empty.revision, "# Verified lesson\n", { root });
    assert.equal((await readWebhookMemory(webhook.id, { root })).content, "# Verified lesson\n");
    await setWebhookMemoryEnabled(db, webhook.id, false);
    assert.equal((await readWebhookMemory(webhook.id, { root })).revision, saved.revision);
    await setWebhookMemoryEnabled(db, webhook.id, true);
    assert.equal((await readWebhookMemory(webhook.id, { root })).content, "# Verified lesson\n");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent webhook memory writes reject the stale revision without losing the winning edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-memory-conflict-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const initial = await readWebhookMemory(webhook.id, { root });
    const writes = await Promise.allSettled([
      writeWebhookMemory(db, webhook.id, initial.revision, "first\n", { root }),
      writeWebhookMemory(db, webhook.id, initial.revision, "second\n", { root }),
    ]);
    assert.equal(writes.filter(write => write.status === "fulfilled").length, 1);
    const rejected = writes.find(write => write.status === "rejected");
    assert.match(String(rejected && "reason" in rejected ? rejected.reason : ""), /changed since you read/i);
    assert.ok(["first\n", "second\n"].includes((await readWebhookMemory(webhook.id, { root })).content));
    await assert.rejects(writeWebhookMemory(db, webhook.id, initial.revision, "stale\n", { root }), /changed since you read/i);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("webhook memory enforces UTF-8 byte limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-memory-limit-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const initial = await readWebhookMemory(webhook.id, { root });
    await assert.rejects(writeWebhookMemory(db, webhook.id, initial.revision, "x".repeat(200_001), { root }), /200,000 bytes/i);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
