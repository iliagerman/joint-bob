import assert from "node:assert/strict";
import test from "node:test";

import { appendLiveEvent, claudeRunIdFromSessionPath } from "../src/claude-service.ts";
import { appSource, serverSource } from "./source.js";

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

test("server reattaches a dropped socket through the shared harness lifecycle", async () => {
  const server = await serverSource();

  // Shared sessions are keyed by project, harness, and stable runtime ID.
  assert.match(server, /return JSON\.stringify\(\[projectId, engine, sessionId\]\);/);
  assert.match(server, /liveEvents: HarnessEvent\[\];/);

  // In-flight turn events are buffered and replayed on reattach.
  assert.match(server, /appendEvent\(shared\.liveEvents, event\)/);
  assert.match(server, /for \(const event of shared\.liveEvents\) send\(options\.socket, event\);/);

  // A runtime cannot silently adopt an ID different from the requested stable ID.
  assert.match(server, /if \(session\.id !== options\.sessionId\) throw new Error\(`Harness returned unexpected session ID: \$\{session\.id\}`\);/);
});

test("chat status wording follows the active engine", async () => {
  const app = await appSource();
  assert.doesNotMatch(app, /"Pi is working"/);
  assert.doesNotMatch(app, /`Pi error: \$\{payload\.error\}`/);
  assert.match(app, /is working/);
});
