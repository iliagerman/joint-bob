import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { listConversationRecords } from "../src/conversation-records.js";
import { server } from "../src/server/state.js";
import { acceptWebhookCall } from "../src/server/webhooks.js";
import { addProject } from "../src/store.js";
import { listTurnFailures } from "../src/turn-failures.js";
import { createWebhook, webhookDeliveries, webhookInputSchema } from "../src/webhooks.js";

// A machine whose agent has no model sign-in still accepts the call and lists a new
// conversation for it. The conversation used to open blank, with the reason only under
// Settings → Webhooks → Calls.
test("a webhook call whose agent cannot start leaves the reason in the new conversation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-delivery-"));
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  endpoint.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" } }));
    // What the chat socket answers when the agent's sign-in check fails before the turn starts.
    socket.on("message", () => socket.send(JSON.stringify({ type: "error", error: "Pi model authentication unavailable on this node" })));
  });
  try {
    const project = await addProject("Webhook delivery", path.join(root, "project"), { writeInstructions: false });
    const db = await clusterV2Database();
    const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Issues", target: { kind: "project", projectId: project.id, engine: "pi" } }));
    assert.equal(acceptWebhookCall(webhook, { method: "POST", headers: {}, query: "", body: '{"action":"opened"}' }), true);
    for (let attempt = 0; attempt < 200 && !webhookDeliveries(db, webhook.id).length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(webhookDeliveries(db, webhook.id).map(({ status, detail }) => [status, detail]), [["failed", "Pi model authentication unavailable on this node"]]);
    const records = await listConversationRecords(project.id);
    assert.equal(records.length, 1, "the call's conversation is listed");
    assert.deepEqual(listTurnFailures("pi", records[0].sessionId).map((failure) => failure.error), [
      'Webhook "Issues" could not start this conversation: Pi model authentication unavailable on this node',
    ]);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
