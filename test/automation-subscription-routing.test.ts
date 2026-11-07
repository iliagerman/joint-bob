import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { getClusterNode } from "../src/cluster.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { cronStore } from "../src/cron.js";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { runWithAutomationProfile } from "../src/server/automation-profile.js";
import { queuedCronPrompt } from "../src/server/cron.js";
import { server } from "../src/server/state.js";
import { acceptWebhookCall } from "../src/server/webhooks.js";
import { addProject } from "../src/store.js";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";

for (const source of ["schedule-new", "schedule-existing", "webhook-new", "webhook-existing"] as const) {
  for (const pinned of [false, true]) {
    test(`${source} carries its ${pinned ? "pinned profile" : "creator's inherited selection"} across the signed queue socket`, { timeout: 15_000 }, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), "automation-subscription-"));
      const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(endpoint, "listening");
      t.mock.method(server, "address", () => endpoint.address());
      const received: Array<{ assignment: unknown; sessionId: string; nodeSession: string | null }> = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      endpoint.on("connection", (socket, request) => {
        const url = new URL(request.url!, "http://127.0.0.1");
        received.push({ assignment: JSON.parse(url.searchParams.get("automationProfile")!), sessionId: url.searchParams.get("sessionId")!, nodeSession: url.searchParams.get("nodeSession") });
        socket.once("close", resolveClosed);
        socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "claude", id: "opus" }, thinkingLevel: "high" } }));
        socket.on("message", bytes => {
          const prompt = JSON.parse(bytes.toString());
          socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: prompt.requestId, queueId: "queued" }));
          socket.send(JSON.stringify({ type: "promptStarted", queueId: "queued" }));
          socket.send(JSON.stringify({ type: "promptCompleted", queueId: "queued" }));
        });
      });
      try {
        const project = await addProject("Routing fixture", path.join(root, "project"), { writeInstructions: false });
        const local = await getClusterNode(), sessionId = randomUUID(), creatorAccountId = "routing-creator";
        const providerProfileId = pinned ? createProviderProfile(creatorAccountId, { label: "Pinned fixture", provider: "claude" }).id : null;
        await ensureConversationRecord(project.id, "claude", sessionId, local.id);
        const existing = source.endsWith("existing");
        if (source.startsWith("schedule")) {
          const task = cronStore().create({ projectId: project.id, name: "Routing", prompt: "Fixture", engine: "claude", sessionId: existing ? sessionId : null,
            ownerNodeId: local.id, creatorAccountId, providerProfileId, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
          const run = cronStore().claim(task.id, local.id, task.nextRun)!;
          await runWithAutomationProfile(task, () => queuedCronPrompt(task, run, sessionId));
        } else {
          const target = existing ? { kind: "conversation", projectId: project.id, engine: "claude", sessionId } : { kind: "project", projectId: project.id, engine: "claude" };
          const { webhook } = createWebhook(await clusterV2Database(), webhookInputSchema.parse({ name: "Routing", target, creatorAccountId, providerProfileId, preserveFiles: true }));
          acceptWebhookCall(webhook, { method: "POST", headers: {}, query: "", body: "Fixture" });
        }
        await closed;
        assert.equal(received.length, 1);
        assert.deepEqual(received[0].assignment, { accountId: creatorAccountId, profileId: providerProfileId });
        assert.equal(received[0].nodeSession, "1");
        if (existing || source.startsWith("schedule")) assert.equal(received[0].sessionId, sessionId);
        else assert.notEqual(received[0].sessionId, sessionId);
      } finally {
        for (const socket of endpoint.clients) socket.terminate();
        await new Promise<void>(resolve => endpoint.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("an automatic compaction warning does not cancel an already queued schedule", { timeout: 15_000 }, async t => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  t.mock.method(server, "address", () => endpoint.address());
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "claude", id: "opus" }, thinkingLevel: "high" } }));
    socket.on("message", bytes => {
      const prompt = JSON.parse(bytes.toString());
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: prompt.requestId, queueId: "queued" }));
      socket.send(JSON.stringify({ type: "error", nonFatal: true, error: "Automatic compaction failed: summarization unavailable" }));
      socket.send(JSON.stringify({ type: "promptStarted", queueId: "queued" }));
      socket.send(JSON.stringify({ type: "promptCompleted", queueId: "queued" }));
    });
  });
  try {
    const local = await getClusterNode(), sessionId = randomUUID();
    await ensureConversationRecord("project", "claude", sessionId, local.id);
    const task = cronStore().create({ projectId: "project", name: "Warning", prompt: "Fixture", engine: "claude", sessionId,
      ownerNodeId: local.id, creatorAccountId: "creator", enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
    const run = cronStore().claim(task.id, local.id, task.nextRun)!;
    await queuedCronPrompt(task, run, sessionId);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
