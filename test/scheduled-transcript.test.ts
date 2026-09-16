import assert from "node:assert/strict";
import test from "node:test";
import { scheduledReportMessages } from "../src/conversation-segments.js";
import type { ChatMessage } from "../src/types.js";

test("scheduled conversation transcripts contain only the final report from each turn", () => {
  const messages: ChatMessage[] = [
    { id: "prompt-1", role: "user", text: "Run the report" },
    { id: "draft-1", role: "assistant", text: "I will inspect the data." },
    { id: "tool-1", role: "toolCall", toolName: "read", text: "input.csv" },
    { id: "tool-2", role: "toolResult", toolName: "read", text: "rows" },
    { id: "report-1", role: "assistant", text: "First final report" },
    { id: "prompt-2", role: "user", text: "Run it again" },
    { id: "draft-2", role: "assistant", text: "Checking updates." },
    { id: "report-2", role: "assistant", text: "Second final report" },
  ];

  assert.deepEqual(scheduledReportMessages(messages), [messages[4], messages[7]]);
  assert.deepEqual(scheduledReportMessages(messages, false), [messages[4]], "an active turn must not expose its latest intermediate reply");
});
