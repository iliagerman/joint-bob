import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Claude harness never sends assistantFinal, so the client must finalize on its own", async () => {
  const claudeService = await readFile("src/claude-service.ts", "utf8");

  // Claude only ever streams deltas; there is no completion event to flush on.
  assert.match(claudeService, /type: "textDelta", text/);
  assert.doesNotMatch(claudeService, /assistantFinal/);
});

test("a streaming assistant bubble is flushed to markdown whenever the stream leaves it", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function finalizeAssistantBubble\(\) \{[\s\S]*renderBubbleContent\(state\.assistantBubble, state\.assistantBubble\._raw, true\)[\s\S]*state\.assistantBubble = null;[\s\S]*\}/);

  // Every place the stream drops the current assistant bubble must flush it first.
  assert.match(app, /payload\.type === "userMessage"\) \{\s*finalizeAssistantBubble\(\);/);
  assert.match(app, /payload\.type === "toolStart"\) \{[\s\S]*finalizeAssistantBubble\(\);/);
  assert.match(app, /payload\.type === "agent_end"\) \{[\s\S]*finalizeAssistantBubble\(\);/);
  assert.match(app, /payload\.type === "assistantError"\) \{[\s\S]*finalizeAssistantBubble\(\);/);

  // The old bare drops are gone from those handlers.
  assert.doesNotMatch(app, /payload\.type === "userMessage"\) \{\s*appendMessage\("user", payload\.text\);\s*state\.assistantBubble = null;/);
  assert.doesNotMatch(app, /payload\.type === "toolStart"\) \{\s*clearThinkingBubble\(\);\s*state\.assistantBubble = null;/);
});
