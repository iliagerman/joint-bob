import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WebSocketServer } from "ws";
import { getClusterNode } from "../src/cluster.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { cronStore } from "../src/cron.js";
import { queuedCronPrompt } from "../src/server/cron.js";
import { server } from "../src/server/state.js";

test("scheduled executor settles a cancelled queued prompt instead of waiting forever", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "claude", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report", prompt: "Report", engine: "claude", sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready" }));
    socket.once("message", raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.requestId, run.id);
      const queueId = randomUUID();
      socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId }));
      socket.send(JSON.stringify({ type: "queuedPromptCancelled", queueId }));
      // Close later so broken code reports a lost connection rather than the
      // cancellation, without leaving a thirty-second readiness timeout alive.
      const close = setTimeout(() => socket.close(), 100);
      socket.once("close", () => clearTimeout(close));
    });
  });
  try {
    await assert.rejects(queuedCronPrompt(task, run, sessionId), /Scheduled prompt was cancelled/);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});
