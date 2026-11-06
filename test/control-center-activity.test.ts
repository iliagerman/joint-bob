import assert from "node:assert/strict";
import test from "node:test";
import { currentActivity } from "../src/control-center/activity.js";

test("a running card says what the turn is doing now: its tool and what it runs on, the last line it wrote, or that it is thinking", () => {
  assert.equal(currentActivity([]), null, "nothing yet");
  assert.equal(currentActivity([{ type: "thinkingDelta", text: "hmm" }]), "Thinking…");
  assert.equal(currentActivity([{ type: "textDelta", text: "I'll look at the menu.\n\n**Next** I run the `tests`." }]), "Next I run the tests.", "the last line, without Markdown");
  const tool = { type: "toolStart", toolCallId: "t1", toolName: "Bash", toolTarget: { target: "npm test -- test/menu.test.ts" } };
  assert.equal(currentActivity([{ type: "textDelta", text: "Running the tests." }, tool]), "Bash · npm test -- test/menu.test.ts");
  assert.equal(currentActivity([tool, { type: "toolEnd", toolCallId: "t1" }]), "Bash · npm test -- test/menu.test.ts", "the step it just ran, until it does the next thing");
  assert.equal(currentActivity([{ type: "toolStart", toolCallId: "t2", toolName: "Skill", toolTarget: { skill: "push-code" } }]), "Skill · skill push-code");
  assert.equal(currentActivity([{ type: "toolStart", toolCallId: "t3", toolName: "TodoWrite" }]), "Running TodoWrite");
  const long = currentActivity([{ type: "textDelta", text: "x".repeat(400) }])!;
  assert.equal(long.length, 140);
  assert.ok(long.endsWith("…"));
});
