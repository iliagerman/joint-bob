import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { listConversationRecords } from "../src/conversation-records.js";
import { server } from "../src/server/state.js";
import { acceptWebhookCall } from "../src/server/webhooks.js";
import { addProject } from "../src/store.js";
import { conversationScopeId, getScopeSecretAccounts, saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { listTurnFailures } from "../src/turn-failures.js";
import { webhookConversationTitle } from "../src/webhook-title.js";
import { createWebhook, webhookDeliveries, webhookInputSchema } from "../src/webhooks.js";
import { saveWebhookResource } from "../src/webhook-resources.js";

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
    acceptWebhookCall(webhook, { method: "POST", headers: {}, query: "", body: '{"action":"opened"}' });
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

// A call's files travel with the prompt the way a browser sends pasted ones, so the agent sees
// images as images. What a chat message cannot carry is saved in the project and listed by path.
test("a webhook call's files reach the conversation as attachments, and the rest are saved in the project", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-attachments-"));
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const prompts: Array<{ message: string; images?: Array<{ name: string; mimeType: string; data: string }>; files?: Array<{ name: string; data: string }> }> = [];
  endpoint.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "low" } }));
    socket.on("message", (raw) => {
      const prompt = JSON.parse(raw.toString());
      prompts.push(prompt);
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: prompt.requestId, queueId: "queued-1" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "queued-1" }));
    });
  });
  try {
    const project = await addProject("Webhook attachments", path.join(root, "project"), { writeInstructions: false });
    const db = await clusterV2Database();
    const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Deals", target: { kind: "project", projectId: project.id, engine: "pi" }, attachments: true }));
    const resource = await saveWebhookResource(db, webhook.id, { kind: "file", name: "rates.csv", description: "Current price source", bytes: Buffer.from("static-only-data") });
    const shots = Array.from({ length: 5 }, (_, index) => ({ name: `shot-${index}.png`, mimeType: "image/png", data: Buffer.from(`png ${index}`) }));
    acceptWebhookCall(webhook, {
      method: "POST", headers: {}, query: "", body: "x".repeat(25_000),
      attachments: [...shots, { name: "spec.pdf", mimeType: "application/pdf", data: Buffer.from("pdf") }],
    });
    for (let attempt = 0; attempt < 200 && !webhookDeliveries(db, webhook.id).length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(webhookDeliveries(db, webhook.id).map(({ status, detail }) => [status, detail.replace(/[0-9a-f-]{36}/, "<id>")]), [["delivered", "Started conversation <id> with 6 files"]]);
    const [prompt] = prompts;
    assert.match(prompt.message, /Current price source/);
    assert.ok(prompt.message.includes(resource.path));
    assert.doesNotMatch(prompt.message, /static-only-data/);
    assert.deepEqual(prompt.images?.map(({ name, mimeType, data }) => [name, mimeType, Buffer.from(data, "base64").toString()]), shots.slice(0, 4).map(({ name, data }) => [name, "image/png", data.toString()]));
    assert.deepEqual(prompt.files?.map(({ name }) => name), ["spec.pdf", "webhook-payload.txt"], "a payload too long for the message travels whole as a file");
    assert.equal(Buffer.from(prompt.files![1].data, "base64").toString().length, 25_000);
    const saved = /- shot-4\.png: (\S+)/.exec(prompt.message)?.[1];
    assert.match(saved ?? "", /\/project\/\.joint-bob-attachments\/[^/]+-shot-4\.png$/, `the fifth image is saved in the project: ${prompt.message}`);
    assert.equal(await readFile(saved!, "utf8"), "png 4");
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

// Dropping queueSettings would silently use project defaults instead of the webhook choices.
test("webhook model and effort travel with the queued turn for new and existing conversations", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-model-"));
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const prompts: Array<{ message: string; queueSettings?: unknown }> = [];
  const templates: Array<string | undefined> = [];
  const attached: string[][] = [];
  let projectForTitles: string;
  endpoint.on("connection", async (socket, request) => {
    const sessionId = new URL(request.url!, "http://localhost").searchParams.get("sessionId")!;
    attached.push((await getScopeSecretAccounts("conversation", conversationScopeId("pi", sessionId))).accountIds);
    templates.push(webhookConversationTitle(projectForTitles, sessionId));
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "default-model" }, thinkingLevel: "low" } }));
    socket.on("message", (raw) => {
      const prompt = JSON.parse(raw.toString());
      prompts.push(prompt);
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: prompt.requestId, queueId: "q" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "q" }));
    });
  });
  try {
    const project = await addProject("Webhook models", path.join(root, "project"), { writeInstructions: false });
    projectForTitles = project.id;
    const db = await clusterV2Database();
    const selected = await saveSecretAccount({ label: "Webhook credential", provider: "custom", variables: [{ name: "WEBHOOK_TEST_KEY", kind: "value", value: "synthetic-webhook-key" }] });
    const existing = await saveSecretAccount({ label: "Existing credential", provider: "custom", variables: [{ name: "EXISTING_TEST_KEY", kind: "value", value: "synthetic-existing-key" }] });
    await setScopeSecretAccounts("conversation", conversationScopeId("pi", "existing"), [existing.id]);
    for (const kind of ["project", "conversation"] as const) {
      for (const settings of [
        { model: { provider: "anthropic", modelId: "selected-model" }, reasoning: "high" },
        { reasoning: "medium" },
        {},
      ]) {
        const { webhook } = createWebhook(db, webhookInputSchema.parse({ name: "Configured", titleTemplate: "pr-[PR_REVIEW]", secretAccountIds: [selected.id], target: { kind, projectId: project.id, engine: "pi", ...(kind === "conversation" ? { sessionId: "existing" } : {}) }, ...settings }));
        acceptWebhookCall(webhook, { method: "POST", headers: {}, query: "", body: "{}" });
        for (let attempt = 0; attempt < 200 && !webhookDeliveries(db, webhook.id).length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(webhookDeliveries(db, webhook.id)[0]?.status, "delivered");
      }
    }
    assert.deepEqual(attached, [
      [selected.id], [selected.id], [selected.id],
      [existing.id, selected.id].sort(), [existing.id, selected.id].sort(), [existing.id, selected.id].sort(),
    ], "secrets are attached before the socket opens, preserving existing conversation accounts");
    assert.deepEqual(templates, ["pr-[PR_REVIEW]", "pr-[PR_REVIEW]", "pr-[PR_REVIEW]", undefined, undefined, undefined]);
    for (const prompt of prompts.slice(0, 3)) assert.match(prompt.message, /JOINT_BOB_WEBHOOK_TITLE_CLI/);
    for (const prompt of prompts.slice(3)) assert.doesNotMatch(prompt.message, /JOINT_BOB_WEBHOOK_TITLE_CLI/);
    assert.deepEqual(prompts.map(prompt => prompt.queueSettings), [
      { harnessId: "pi", provider: "anthropic", modelId: "selected-model", reasoning: "high" },
      { harnessId: "pi", provider: "zai", modelId: "default-model", reasoning: "medium" },
      undefined,
      { harnessId: "pi", provider: "anthropic", modelId: "selected-model", reasoning: "high" },
      { harnessId: "pi", provider: "zai", modelId: "default-model", reasoning: "medium" },
      undefined,
    ]);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
