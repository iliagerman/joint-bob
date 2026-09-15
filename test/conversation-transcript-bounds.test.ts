import assert from "node:assert/strict";
import test from "node:test";
import { boundTranscriptMessages } from "../src/conversation-segments.js";

test("large conversation chains send a bounded recent transcript to the browser", () => {
  const messages = Array.from({ length: 600 }, (_, index) => ({
    id: String(index),
    role: index % 3 === 0 ? "toolResult" : "assistant",
    toolName: index % 3 === 0 ? "bash" : undefined,
    text: `${index}:` + "x".repeat(index === 200 ? 3_000_000 : 5_000),
    segment: index < 300 ? 0 : 1,
  }));

  const bounded = boundTranscriptMessages(messages);
  assert.ok(bounded.length <= 501, `expected at most 500 messages plus notice, got ${bounded.length}`);
  assert.ok(JSON.stringify(bounded).length < 2_500_000, "browser payload must stay below the memory-kill range");
  assert.equal(bounded[0].role, "toolResult");
  assert.equal(bounded[0].toolName, "Transcript trimmed");
  assert.match(bounded[0].text, /earlier messages omitted/);
  assert.equal(bounded.at(-1)?.id, "599", "newest message must survive trimming");
  assert.ok(bounded.every((message) => message.text.length <= 20_100), "single tool results must be trimmed before transport");
});
