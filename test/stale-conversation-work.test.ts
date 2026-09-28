import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("background work that went quiet with no agent process left stops counting as running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stale-conversation-work-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = root;
  try {
    const { conversationWorkActive, failStaleConversationWork, listConversationWork, recordConversationWork } = await import("../src/conversation-work.js");
    const running = (runId: string) => ({ runId, status: "running" as const, tasks: [{ name: "Background task", role: "worker", status: "running" as const }] });
    recordConversationWork({ engine: "claude", sessionId: "quiet", summary: running("quiet-run") });
    recordConversationWork({ engine: "claude", sessionId: "alive", summary: running("alive-run") });
    recordConversationWork({ engine: "pi", sessionId: "watched", summary: running("watched-run"), descriptor: { runId: "watched-run", stateUrl: "http://127.0.0.1:1/api/state", summary: running("watched-run") } });
    const staleMs = 15 * 60_000;

    assert.deepEqual(failStaleConversationWork(() => false, staleMs), [], "fresh work is left alone");
    const later = Date.now() + staleMs + 1_000;
    const cleared = failStaleConversationWork((_engine, sessionId) => sessionId === "alive", staleMs, later);
    assert.deepEqual(cleared, [{ engine: "claude", sessionId: "quiet" }]);
    assert.equal(conversationWorkActive("claude", "quiet"), false);
    assert.equal(conversationWorkActive("claude", "alive"), true, "a live agent process keeps its work");
    assert.equal(conversationWorkActive("pi", "watched"), true, "a dashboard-backed run is judged by its dashboard");
    assert.match(listConversationWork("claude", "quiet")[0].summary.tasks[0].error ?? "", /went quiet/);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
