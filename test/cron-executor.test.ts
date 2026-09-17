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

test("scheduled executor queues its model and reasoning with the prompt so a busy conversation never fails", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
  const startupTimer = {} as NodeJS.Timeout;
  let startupTimerActive = true, expireStartupTimer = () => undefined;
  context.mock.method(globalThis, "setTimeout", ((callback: () => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === 30_000) {
      expireStartupTimer = () => { if (startupTimerActive) callback(...args); };
      return startupTimer;
    }
    return nativeSetTimeout(callback, milliseconds, ...args);
  }) as typeof setTimeout);
  context.mock.method(globalThis, "clearTimeout", ((timer: NodeJS.Timeout) => {
    if (timer === startupTimer) startupTimerActive = false;
    else nativeClearTimeout(timer);
  }) as typeof clearTimeout);
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "pi", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report", prompt: "Report", engine: "pi", model: { provider: "zai", modelId: "glm-5.3-flash", reasoning: "low" }, sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  const requests: unknown[] = [];
  endpoint.on("connection", socket => {
    // A conversation already mid-turn: the executor must never send a bare
    // setModel here, because configuring a live session throws "session is busy".
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "zai", id: "glm-5.3-flash" }, thinkingLevel: "high", isStreaming: true } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (request.type === "prompt") {
        const queueId = randomUUID();
        socket.send(JSON.stringify({ type: "userMessage", queued: true, requestId: run.id, queueId }));
        nativeSetTimeout(() => {
          expireStartupTimer();
          socket.send(JSON.stringify({ type: "promptStarted", queueId }));
          socket.send(JSON.stringify({ type: "promptCompleted", queueId }));
        }, 50);
      }
    });
  });
  try {
    await queuedCronPrompt(task, run, sessionId);
    assert.deepEqual(requests, [
      { type: "prompt", message: "[Joint Bob scheduled task]\nReport", requestId: run.id, queueSettings: { harnessId: "pi", provider: "zai", modelId: "glm-5.3-flash", reasoning: "low" } },
    ]);
  } finally {
    for (const socket of endpoint.clients) socket.terminate();
    await new Promise<void>(resolve => endpoint.close(() => resolve()));
  }
});

test("scheduled executor applies reasoning to the default model and settles cancellation", async (context) => {
  const endpoint = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(endpoint, "listening");
  context.mock.method(server, "address", () => endpoint.address());
  const node = await getClusterNode(), sessionId = randomUUID();
  await ensureConversationRecord("project", "claude", sessionId, node.id);
  const task = cronStore().create({ projectId: "project", name: "Report", prompt: "Report", engine: "claude", reasoning: "high", sessionId, ownerNodeId: node.id, enabled: true, schedule: { frequency: "hourly", hour: 0, minute: 0, weekday: 0, timezone: "UTC" } });
  const run = cronStore().claim(task.id, node.id, task.nextRun)!;
  endpoint.on("connection", socket => {
    socket.send(JSON.stringify({ type: "ready", status: { model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "low" } }));
    socket.on("message", raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.type, "prompt");
      assert.deepEqual(request.queueSettings, { harnessId: "claude", provider: "anthropic", modelId: "claude-opus-5", reasoning: "high" });
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
