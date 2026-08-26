import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appendLiveEvent, claudeRunIdFromSessionPath } from "../src/claude-service.ts";

test("claude run id comes from the session path, not the summary id", () => {
  assert.equal(claudeRunIdFromSessionPath("claude:new"), null);
  assert.equal(claudeRunIdFromSessionPath("claude:/home/me/.claude/projects/proj/2f8c.jsonl"), "2f8c");
  // A conversation-list summary id must resolve to the same bare run id the
  // live-run registry is keyed on.
  assert.equal(claudeRunIdFromSessionPath("claude:2f8c.jsonl"), "2f8c");
});

test("live event buffer preserves order and merges consecutive deltas", () => {
  const buffer = [];
  appendLiveEvent(buffer, { type: "agent_start" });
  appendLiveEvent(buffer, { type: "textDelta", text: "Hel" });
  appendLiveEvent(buffer, { type: "textDelta", text: "lo" });
  appendLiveEvent(buffer, { type: "toolStart", toolCallId: "t1", toolName: "Bash" });
  appendLiveEvent(buffer, { type: "textDelta", text: " world" });
  appendLiveEvent(buffer, { type: "thinkingDelta", text: "a" });
  appendLiveEvent(buffer, { type: "thinkingDelta", text: "b" });
  appendLiveEvent(buffer, { type: "toolEnd", toolCallId: "t1", toolName: "Bash", text: "ok" });

  assert.deepEqual(buffer, [
    { type: "agent_start" },
    { type: "textDelta", text: "Hello" },
    { type: "toolStart", toolCallId: "t1", toolName: "Bash" },
    { type: "textDelta", text: " world" },
    { type: "thinkingDelta", text: "ab" },
    { type: "toolEnd", toolCallId: "t1", toolName: "Bash", text: "ok" },
  ]);
});

test("live event buffer does not alias the caller payload", () => {
  const buffer = [];
  const payload = { type: "textDelta", text: "a" };
  appendLiveEvent(buffer, payload);
  appendLiveEvent(buffer, { type: "textDelta", text: "b" });
  assert.equal(payload.text, "a");
  assert.equal(buffer[0].text, "ab");
});

test("server reattaches a dropped socket to the in-flight claude turn", async () => {
  const server = await readFile("src/server.ts", "utf8");

  // The live-run key is derived from the path, never from the summary id.
  assert.match(server, /claudeRunIdFromSessionPath\(requestedSessionPath\)/);
  assert.doesNotMatch(server, /requestedClaudeId = requestedSessionId/);

  // In-flight turn events are buffered and replayed on reattach.
  assert.match(server, /liveEvents: Record<string, unknown>\[\];/);
  assert.match(server, /appendLiveEvent\(connection\.claude\.liveEvents, payload\)/);
  assert.match(server, /for \(const event of connection\.claude\.liveEvents\) send\(socket, event\);/);

  // A new conversation is re-keyed as soon as Claude reports its real id.
  assert.match(server, /const adoptSessionId = \(sessionId: string\): void =>/);
});

test("chat status wording follows the active engine", async () => {
  const app = await readFile("public/app.js", "utf8");
  assert.doesNotMatch(app, /"Pi is working"/);
  assert.doesNotMatch(app, /`Pi error: \$\{payload\.error\}`/);
  assert.match(app, /is working/);
});
