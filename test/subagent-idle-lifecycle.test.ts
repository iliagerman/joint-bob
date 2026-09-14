import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { agentRunDescriptor } from "../src/agent-run-monitor.js";
import { conversationWorkActive, recordConversationWork } from "../src/conversation-work.js";
import { pushRuntimeLeaseSnapshots } from "../src/server/maintenance.js";
import {
  harnessSessionKey,
  harnessSessions,
  refreshHarnessTranscripts,
  sendHarnessStatus,
} from "../src/server/harness-sessions.js";
import { idleSessionTimeoutMs } from "../src/server/state.js";
import { nativePiSessionFixture } from "./native-pi-session-fixture.js";

test("Pi adapter persists launched child work before disposing its parent handle", () => {
  const fixture = nativePiSessionFixture({ id: "pi-adapter-parent" });
  try {
    fixture.emitRaw({ type: "tool_execution_end", toolCallId: "tool", toolName: "multi_agent_run", result: { content: [], details: {
      runId: "adapter-child", dashboardUrl: "http://127.0.0.1:1", tasks: [],
    } } });
    fixture.session.dispose();
    assert.equal(conversationWorkActive("pi", "pi-adapter-parent"), true);
  } finally {
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
    const id = `subagent-transcript-${status}`;
    let disposed = false;
    const fixture = nativePiSessionFixture({ id, projectId: "subagent-test", file: `/tmp/${id}.jsonl`, dispose: () => { disposed = true; } });
    const key = harnessSessionKey("subagent-test", "pi", id);
    recordConversationWork({ engine: "pi", sessionId: id, summary: { runId: `run-${status}`, status, tasks: [] } });
    harnessSessions.set(key, fixture.shared);
    try {
      refreshHarnessTranscripts("subagent-test", [`/tmp/${id}.jsonl`]);
      assert.equal(disposed, false, "file changes must not discard active subagent tracking");
      assert.equal(harnessSessions.get(key), fixture.shared);
    } finally {
      recordConversationWork({ engine: "pi", sessionId: id, summary: { runId: `run-${status}`, status: "cancelled", tasks: [] } });
      harnessSessions.delete(key);
    }
  });

  test(`idle parent retains ${status} subagents until they finish`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const id = `subagent-idle-${status}`;
    const dispose = t.mock.fn();
    const fixture = nativePiSessionFixture({ id, projectId: "subagent-test", dispose });
    const key = harnessSessionKey("subagent-test", "pi", id);
    const runId = `idle-run-${status}`;
    recordConversationWork({ engine: "pi", sessionId: id, summary: { runId, status, tasks: [] } });
    harnessSessions.set(key, fixture.shared);
    try {
      sendHarnessStatus(fixture.shared);
      t.mock.timers.tick(idleSessionTimeoutMs);
      assert.equal(dispose.mock.callCount(), 0, "idle cleanup must not lose live subagent tracking");
      assert.equal(harnessSessions.get(key), fixture.shared);
      recordConversationWork({ engine: "pi", sessionId: id, summary: { runId, status: "succeeded", tasks: [] } });
      t.mock.timers.tick(idleSessionTimeoutMs);
      assert.equal(dispose.mock.callCount(), 1, "completed subagents must not retain parent forever");
    } finally {
      if (fixture.shared.idleTimer) clearTimeout(fixture.shared.idleTimer);
      recordConversationWork({ engine: "pi", sessionId: id, summary: { runId, status: "cancelled", tasks: [] } });
      harnessSessions.delete(key);
      t.mock.timers.reset();
    }
  });
}
