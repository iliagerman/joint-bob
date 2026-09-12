import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { agentRunDescriptor } from "../src/agent-run-monitor.js";
import { applyConversationWork, conversationWorkActive, recordConversationWork, refreshConversationWork } from "../src/conversation-work.js";
import type { SessionSummary } from "../src/types.js";
import { syncConversationReviewStates } from "../src/conversation-reviews.js";

test("running descendants propagate across harnesses before review, without mutating catalog rows", () => {
  const row = (id: string, harnessId: string, parentSessionPath?: string, running = false): SessionSummary =>
    ({ id, path: id, title: id, harnessId, agentId: harnessId, agentLabel: harnessId, parentSessionPath, running });
  const input = [row("root", "pi"), row("child", "claude", "root"), { ...row("leaf", "future", "child", true), readOnly: true }, row("unrelated", "pi")];
  assert.deepEqual(applyConversationWork(input).map((session) => session.running), [true, true, true, false]);
  assert.equal(input[0].running, false);
  input[2].running = false;
  assert.deepEqual(applyConversationWork(input).map((session) => session.running), [false, false, false, false]);
});

test("dashboard tracking survives handle loss and observer failure until explicit child completion", async () => {
  let available = true;
  let status = "running";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = available ? 200 : 503;
    response.end(JSON.stringify({ runs: [{ runId: "durable-child", status, tasks: [] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const descriptor = agentRunDescriptor({ type: "tool_execution_end", toolName: "multi_agent_run", result: { details: { runId: "durable-child", dashboardUrl: `http://127.0.0.1:${address.port}`, tasks: [] } } });
    assert.ok(descriptor);
    recordConversationWork({ engine: "future", sessionId: "durable-parent", summary: descriptor.summary, descriptor });
    const reloaded = await import(`../src/conversation-work.ts?restart=${Date.now()}`);
    assert.equal(reloaded.conversationWorkActive("future", "durable-parent"), true, "new module instance recovers persisted child activity");
    available = false;
    await refreshConversationWork();
    assert.equal(conversationWorkActive("future", "durable-parent"), true);
    available = true;
    status = "succeeded";
    requests = 0;
    await Promise.all([refreshConversationWork(), refreshConversationWork()]);
    assert.equal(requests, 1, "viewer and maintenance polls share one observation rather than racing stale snapshots");
    assert.equal(conversationWorkActive("future", "durable-parent"), false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const engine of ["pi", "claude", "future-harness"]) {
  test(`${engine}: parent completion cannot trigger review before all children finish`, t => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const sessionId = `work-${engine}`;
    const session = { path: sessionId, engine, sessionId, running: false };
    const observe = () => syncConversationReviewStates("work-user", "work-user", engine, [session]).get(sessionId);
    observe();
    const child = (runId: string, status: "queued" | "running" | "succeeded" | "failed" | "cancelled") => {
      // Child events happen after the initial reviewed watermark, not in its millisecond.
      t.mock.timers.tick(1);
      recordConversationWork({ engine, sessionId, summary: { runId, status, tasks: [] } });
    };
    child("one", "running");
    child("two", "queued");
    assert.equal(observe(), "running", "finished parent must remain running while its children work");
    child("one", "succeeded");
    assert.equal(observe(), "running", "queued children also block review");
    child("two", "failed");
    assert.equal(observe(), "needs_review");
    child("three", "running");
    assert.equal(observe(), "running");
    child("three", "cancelled");
    assert.equal(observe(), "needs_review");
  });
}
