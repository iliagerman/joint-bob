import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { listQueuedPrompts } from "../src/prompt-queue.js";

test("oldest queue schema migrates segment identity and stable FIFO without metadata columns", async () => {
  const local = await getClusterNode();
  await ensureConversationRecord("project", "claude", "segment", local.id, undefined, { conversationId: "logical", segmentIndex: 1 });
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try {
    db.exec(`CREATE TABLE conversation_prompt_queue (id INTEGER PRIMARY KEY, queue_key TEXT, prompt_text TEXT, display_text TEXT, created_at TEXT)`);
    for (let index = 1; index <= 30; index += 1) db.prepare("INSERT INTO conversation_prompt_queue VALUES (?, 'project:segment', ?, ?, '2026-01-01T00:00:00Z')").run(index, String(index), String(index));
    const prompts = listQueuedPrompts("project:logical");
    assert.deepEqual(prompts.map((prompt) => prompt.promptText), Array.from({ length: 30 }, (_, index) => String(index + 1)));
    assert.deepEqual(listQueuedPrompts("project:segment"), prompts);
    assert.equal(prompts[0].messageText, null);
    assert.deepEqual(prompts[0].attachmentPaths, []);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_prompt_queue'").get(), undefined);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM replication_outbox WHERE entity_type = 'conversation.queue'").get() as { n: number }).n, 30);
  } finally { db.close(); }
});
