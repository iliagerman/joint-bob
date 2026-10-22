import assert from "node:assert/strict";
import test from "node:test";
import { listTurnFailures, recordTurnFailure, withTurnFailures } from "../src/turn-failures.js";
import type { ChatMessage } from "../src/types.js";

test("turn failures persist per conversation and read back oldest first", () => {
  const sessionId = `failure-${Date.now()}`;
  assert.deepEqual(listTurnFailures("kiro", sessionId), []);
  recordTurnFailure("kiro", sessionId, "Bedrock rejected the request", "2026-09-19T13:36:33.000Z");
  recordTurnFailure("kiro", sessionId, "Second failure", "2026-09-19T13:40:00.000Z");
  recordTurnFailure("kiro", `${sessionId}-other`, "Unrelated", "2026-09-19T13:41:00.000Z");
  assert.deepEqual(listTurnFailures("kiro", sessionId), [
    { failedAt: "2026-09-19T13:36:33.000Z", error: "Bedrock rejected the request" },
    { failedAt: "2026-09-19T13:40:00.000Z", error: "Second failure" },
  ]);
  assert.deepEqual(listTurnFailures("claude", sessionId), []);
});

/** The budget guard records its stop and the stopped turn then fails with the same reason. */
test("the same failure reported twice within a minute is recorded once", () => {
  const sessionId = `failure-dup-${Date.now()}`;
  recordTurnFailure("claude", sessionId, "Stopped: budget used up", "2026-09-19T13:36:33.000Z");
  recordTurnFailure("claude", sessionId, "Stopped: budget used up", "2026-09-19T13:36:34.000Z");
  recordTurnFailure("claude", sessionId, "Stopped: budget used up", "2026-09-19T13:50:00.000Z");
  assert.deepEqual(listTurnFailures("claude", sessionId).map(({ failedAt }) => failedAt), ["2026-09-19T13:36:33.000Z", "2026-09-19T13:50:00.000Z"]);
});

test("failures interleave into the transcript by time and render as error messages", () => {
  const messages: ChatMessage[] = [
    { id: "1", role: "user", text: "hello", timestamp: "2026-09-19T13:30:00.000Z" },
    { id: "2", role: "assistant", text: "working", timestamp: "2026-09-19T13:31:00.000Z" },
    { id: "3", role: "toolResult", toolName: "read", text: "png bytes", timestamp: "2026-09-19T13:36:30.000Z" },
    { id: "4", role: "user", text: "are you there?", timestamp: "2026-09-19T14:00:00.000Z" },
  ];
  const merged = withTurnFailures(messages, [
    { failedAt: "2026-09-19T13:36:33.000Z", error: "Bedrock rejected the request" },
    { failedAt: "2026-09-19T15:00:00.000Z", error: "Later failure" },
  ]);
  assert.deepEqual(merged.map((message) => `${message.role}:${message.text}`), [
    "user:hello", "assistant:working", "toolResult:png bytes", "error:Bedrock rejected the request", "user:are you there?", "error:Later failure",
  ]);
  assert.equal(merged[3].timestamp, "2026-09-19T13:36:33.000Z");
  assert.notEqual(merged[3].id, merged[5].id);
});

test("failures append after undated messages", () => {
  const messages: ChatMessage[] = [{ id: "1", role: "user", text: "hello" }, { id: "2", role: "assistant", text: "hi" }];
  const merged = withTurnFailures(messages, [{ failedAt: "2026-09-19T13:36:33.000Z", error: "boom" }]);
  assert.deepEqual(merged.map((message) => message.role), ["user", "assistant", "error"]);
  assert.deepEqual(withTurnFailures(messages, []), messages);
});
