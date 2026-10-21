import assert from "node:assert/strict";
import test from "node:test";
import { simplifyTranscriptEntries } from "../src/pi-service.js";
import { toolTarget } from "../src/tool-target.js";

test("a read of a SKILL.md names the skill it loads", () => {
  assert.deepEqual(toolTarget("read", { path: "/home/u/.pi/skills/brainstorming/SKILL.md" }), { skill: "brainstorming" });
  assert.deepEqual(toolTarget("Read", { file_path: "/repo/skills/writing-plans/SKILL.md" }), { skill: "writing-plans" });
});

test("Claude's Skill tool names the skill it loads", () => {
  assert.deepEqual(toolTarget("Skill", { skill: "code-review" }), { skill: "code-review" });
});

test("other tool calls show the path, command or pattern on one short line", () => {
  assert.deepEqual(toolTarget("read", { path: "src/pi-service.ts" }), { target: "src/pi-service.ts" });
  assert.deepEqual(toolTarget("bash", { command: "npm   test\n  --  foo" }), { target: "npm test -- foo" });
  assert.equal(toolTarget("bash", { command: "x".repeat(400) })?.target?.length, 160);
});

test("a read of an ordinary file never counts as a skill", () => {
  assert.deepEqual(toolTarget("read", { path: "docs/SKILL-notes.md" }), { target: "docs/SKILL-notes.md" });
  assert.deepEqual(toolTarget("edit", { path: "skills/brainstorming/SKILL.md" }), { target: "skills/brainstorming/SKILL.md" });
});

test("calls without a readable subject carry no target", () => {
  assert.equal(toolTarget("bash", undefined), undefined);
  assert.equal(toolTarget("bash", ["npm", "test"]), undefined);
  assert.equal(toolTarget("bash", { command: "   " }), undefined);
});

test("replayed Pi history keeps the target of the call it answers", () => {
  const messages = simplifyTranscriptEntries([
    { type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/home/u/.pi/skills/brainstorming/SKILL.md" } }] } },
    { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "# Brainstorming" }] } },
  ]);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].toolTarget, { skill: "brainstorming" });
});
