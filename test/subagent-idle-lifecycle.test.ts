import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { agentRunDescriptor } from "../src/agent-run-monitor.js";
import { conversationWorkActive, recordConversationWork } from "../src/conversation-work.js";
import { subscribeSharedSession } from "../src/server/chat.js";
import { pushRuntimeLeaseSnapshots } from "../src/server/maintenance.js";
import { clearIdleTimer, handleSessionChange, scheduleIdleDispose } from "../src/server/realtime.js";
import { idleSessionTimeoutMs, sharedSessions, type SharedPiSession } from "../src/server/state.js";

test("Pi adapter persists launched child work before disposing its parent handle", () => {
  let listener: (event: unknown) => void = () => {};
  const session = {
    projectId: "pi-child-test", clients: new Set(), agentRuns: new Map(),
    handle: { session: { sessionId: "pi-adapter-parent", subscribe: (callback: typeof listener) => { listener = callback; return () => {}; } } },
  } as unknown as SharedPiSession;
  const unsubscribe = subscribeSharedSession(session);
  try {
    listener({ type: "tool_execution_end", toolCallId: "tool", toolName: "multi_agent_run", result: { content: [], details: {
      runId: "adapter-child", dashboardUrl: "http://127.0.0.1:1", tasks: [],
    } } });
    session.agentRuns.clear();
    assert.equal(conversationWorkActive("pi", "pi-adapter-parent"), true);
  } finally {
    unsubscribe();
    recordConversationWork({ engine: "pi", sessionId: "pi-adapter-parent", summary: { runId: "adapter-child", status: "cancelled", tasks: [] } });
  }
});

test("background maintenance observes child completion even without viewers or cluster peers", async () => {
  const server = createServer((_request, response) => response.end(JSON.stringify({ runs: [{ runId: "headless-child", status: "succeeded", tasks: [] }] })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const descriptor = agentRunDescriptor({ type: "tool_execution_end", toolName: "multi_agent_run", result: { details: {
      runId: "headless-child", dashboardUrl: `http://127.0.0.1:${address.port}`, tasks: [],
    } } });
    assert.ok(descriptor);
    recordConversationWork({ engine: "pi", sessionId: "headless-parent", descriptor, summary: descriptor.summary });
    assert.equal(conversationWorkActive("pi", "headless-parent"), true);
    await pushRuntimeLeaseSnapshots();
    assert.equal(conversationWorkActive("pi", "headless-parent"), false, "child completion must not depend on a viewer or paired peer polling");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

for (const status of ["queued", "running"] as const) {
  test(`transcript invalidation retains parent tracking for ${status} subagents`, () => {
    let disposed = false;
    const session = {
      projectId: "subagent-test", lastLocalEventAt: 0, clients: new Set(), turnInFlight: 0,
      handle: { session: { sessionId: "subagent-test", isStreaming: false, sessionFile: "/tmp/subagent-test.jsonl" }, dispose: () => { disposed = true; } },
      unsubscribe: () => {}, agentRuns: new Map([["run", { summary: { status, tasks: [] } }]]),
    } as unknown as SharedPiSession;
    sharedSessions.set("subagent-test", session);
    try {
      handleSessionChange("subagent-test", ["/tmp/subagent-test.jsonl"]);
      assert.equal(disposed, false, "file changes must not discard active subagent tracking");
      assert.equal(sharedSessions.get("subagent-test"), session);
    } finally {
      sharedSessions.delete("subagent-test");
    }
  });
  test(`idle parent retains ${status} subagents until they finish`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let disposed = false;
    const run = { summary: { status, tasks: [] } };
    const session = {
      clients: new Set(), idleTimer: null, turnInFlight: 0,
      handle: { session: { sessionId: "subagent-test", isStreaming: false }, dispose: () => { disposed = true; } },
      unsubscribe: () => {}, agentRuns: new Map([["run", run]]),
    } as unknown as SharedPiSession;
    sharedSessions.set("subagent-test", session);
    try {
      scheduleIdleDispose(session);
      t.mock.timers.tick(idleSessionTimeoutMs);
      assert.equal(disposed, false, "idle cleanup must not lose live subagent tracking");
      assert.equal(sharedSessions.get("subagent-test"), session);
      session.agentRuns.get("run")!.summary.status = "succeeded";
      t.mock.timers.tick(idleSessionTimeoutMs);
      assert.equal(disposed, true, "completed subagents must not retain parent forever");
    } finally {
      clearIdleTimer(session);
      sharedSessions.delete("subagent-test");
      t.mock.timers.reset();
    }
  });
}
