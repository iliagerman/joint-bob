import assert from "node:assert/strict";
import test from "node:test";
import { completedConversationDuration, formatDuration } from "../public/app/chat-time.js";

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

test("conversation duration adds completed turns instead of using time since the page opened", () => {
  const messages = [
    { role: "user", timestamp: at(0) },
    { role: "assistant", timestamp: at(5) },
    { role: "user", timestamp: at(20) },
    { role: "toolResult", timestamp: at(22) },
    { role: "assistant", timestamp: at(25) },
  ];

  assert.equal(completedConversationDuration(messages), 10_000);
  assert.equal(completedConversationDuration(messages, Date.parse(at(20))), 5_000, "the running turn is added by the live timer, not counted twice");
  assert.equal(completedConversationDuration(messages.slice(0, 2), Date.parse(at(20))), 5_000, "a running preflight does not discard the previous completed turn");
});

test("conversation duration ignores missing and invalid transcript times", () => {
  assert.equal(completedConversationDuration([
    { role: "user", timestamp: at(0) },
    { role: "toolResult" },
    { role: "assistant", timestamp: "invalid" },
  ]), 0);
});

test("duration formatting keeps useful precision without rounding sub-second work to zero", () => {
  assert.equal(formatDuration(49), "0.1s");
  assert.equal(formatDuration(1_049), "1.0s");
  assert.equal(formatDuration(68_000), "1m 08s");
});
