import assert from "node:assert/strict";
import test from "node:test";
import { scheduledReportMessages } from "../src/conversation-segments.js";
import { isScheduledPromptText, scheduledPromptText } from "../src/scheduled-prompt.js";
import type { ChatMessage } from "../src/types.js";

test("scheduled trigger prompts are recognisable in a saved transcript", () => {
  assert.equal(isScheduledPromptText(scheduledPromptText("Run the report")), true);
  assert.equal(isScheduledPromptText("Run the report"), false);
});

test("scheduled turns collapse to their final report", () => {
  const messages: ChatMessage[] = [
    { id: "prompt-1", role: "user", text: scheduledPromptText("Run the report") },
    { id: "draft-1", role: "assistant", text: "I will inspect the data." },
    { id: "tool-1", role: "toolCall", toolName: "read", text: "input.csv" },
    { id: "tool-2", role: "toolResult", toolName: "read", text: "rows" },
    { id: "report-1", role: "assistant", text: "First final report" },
    { id: "prompt-2", role: "user", text: scheduledPromptText("Run it again") },
    { id: "draft-2", role: "assistant", text: "Checking updates." },
    { id: "report-2", role: "assistant", text: "Second final report" },
  ];

  assert.deepEqual(scheduledReportMessages(messages), [messages[4], messages[7]]);
  assert.deepEqual(scheduledReportMessages(messages, false), [messages[4]], "an active turn must not expose its latest intermediate reply");
});

test("a person's own turn stays fully visible inside a scheduled conversation", () => {
  const messages: ChatMessage[] = [
    { id: "prompt-1", role: "user", text: scheduledPromptText("Check the mailbox") },
    { id: "tool-1", role: "toolCall", toolName: "gmail", text: "list" },
    { id: "report-1", role: "assistant", text: "Nothing new." },
    { id: "prompt-2", role: "user", text: "What did you find yesterday?" },
    { id: "tool-2", role: "toolResult", toolName: "read", text: "history" },
    { id: "reply-2", role: "assistant", text: "Two invoices." },
  ];

  assert.deepEqual(scheduledReportMessages(messages), [messages[2], messages[3], messages[4], messages[5]]);
  assert.deepEqual(
    scheduledReportMessages(messages, false),
    [messages[2], messages[3], messages[4], messages[5]],
    "a running human turn keeps its own message and streamed reply",
  );
});
