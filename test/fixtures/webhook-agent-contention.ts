import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { resolveDataDirectory } from "../../src/data-directory.js";
import { bindWebhookConversation, ensureWebhookAgentSchema, webhookMemoryAgentEnvironmentForConversation, webhookMemoryAgentIdentity } from "../../src/webhook-agent.js";
import { setWebhookMemoryEnabled } from "../../src/webhook-memory.js";
import { createWebhook, webhookInputSchema } from "../../src/webhooks.js";

// No test/setup.mjs here: it adds a busy timeout to every connection and hid this bug.
const file = path.join(resolveDataDirectory(), "node.db");
const db = new DatabaseSync(file);
assert.equal(db.prepare("PRAGMA busy_timeout").get()!.timeout, 0);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE cluster_node(singleton INTEGER PRIMARY KEY,id TEXT); INSERT INTO cluster_node VALUES(1,'node-a')");
ensureWebhookAgentSchema(db);
const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Fixture", target: { kind: "project", projectId: "p1" } }));
setWebhookMemoryEnabled(db, webhook.id, true);
bindWebhookConversation(db, webhook.id, "p1", "bound", "node-a");

async function refreshWhileWriting(conversationId: string): Promise<NodeJS.ProcessEnv> {
  const state = new Int32Array(new SharedArrayBuffer(4));
  const writer = new Worker(`
    const { DatabaseSync } = require("node:sqlite");
    const { workerData } = require("node:worker_threads");
    const state = new Int32Array(workerData.state);
    const db = new DatabaseSync(workerData.file);
    db.exec("BEGIN IMMEDIATE");
    Atomics.store(state,0,1); Atomics.notify(state,0);
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 250);
  `, { eval: true, execArgv: [], workerData: { file, state: state.buffer } });
  const exited = once(writer, "exit");
  try {
    while (Atomics.load(state, 0) === 0) assert.notEqual(Atomics.wait(state, 0, 0, 5_000), "timed-out", "writer did not acquire the lock");
    return webhookMemoryAgentEnvironmentForConversation("p1", conversationId);
  } finally { await exited; }
}

try {
  assert.deepEqual(await refreshWhileWriting("unbound"), {});
  const environment = await refreshWhileWriting("bound");
  const [{ token }] = JSON.parse(environment.JOINT_BOB_WEBHOOK_MEMORY_TOKENS!);
  assert.equal(webhookMemoryAgentIdentity(db, token, "node-a")?.webhookId, webhook.id);
} finally { db.close(); }
