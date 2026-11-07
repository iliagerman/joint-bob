import assert from "node:assert/strict";
import test from "node:test";
import type { BoardCard } from "../src/control-center/board.js";
import { bobContext } from "../src/control-center/bob-context.js";

const card = (overrides: Partial<BoardCard>): BoardCard => ({
  projectId: "p", projectName: "Joint Bob", conversationId: "c", sessionId: "c", path: "/c", title: "Mobile menu", column: "running",
  agentId: "claude", agentLabel: "Claude", agentModel: null, executionNodeId: null, updatedAt: null, turnRunning: true, backgroundRunning: false,
  summary: "Running the UI tests", autoRespondActive: false, startedBy: "you", ...overrides,
});
const facts = { localNodeId: "mac", machineName: (id: string) => ({ server: "Homeserver" })[id] ?? "another machine", jointBobSource: null };

test("Bob's context lists what is running, what waits for review and each project's recent work", () => {
  const text = bobContext(
    [card({ path: "/home/me/.pi/sessions/menu.jsonl", activity: "Bash · npm test" }), card({ title: "Review counter", column: "review", summary: null, startedBy: "bob", executionNodeId: "server" })],
    [{ id: "p", name: "Joint Bob", headlines: ["Mobile menu", "Review counter"] }, { id: "q", name: "Empty", headlines: [] }],
    facts,
  );
  // Where each conversation runs, whether it has a summary, and the transcript of one this machine runs, so Bob can look.
  assert.match(text, /\[Joint Bob\] Mobile menu \(running, Claude, runs on this machine\) — summary: Running the UI tests; now: Bash · npm test; transcript: \/home\/me\/\.pi\/sessions\/menu\.jsonl/);
  assert.match(text, /\[Joint Bob\] Review counter \(finished, waiting for review, Claude, runs on Homeserver, started by Bob\) — no summary on the board$/m);
  assert.match(text, /- Joint Bob: Mobile menu; Review counter/);
  assert.match(text, /- Empty: no recent conversations/);
});

test("with nothing running the context says so, and it is bounded", () => {
  assert.match(bobContext([], [], facts), /- none/);
  const many = Array.from({ length: 500 }, (_, index) => card({ title: `Conversation ${index} ${"x".repeat(60)}`, summary: "y".repeat(300) }));
  assert.ok(bobContext(many, [], facts).length <= 12_000);
});

test("when the person has Joint Bob's own source as a project, Bob is told where its docs and code are", () => {
  const text = bobContext([], [], { ...facts, jointBobSource: { name: "Joint Bob", path: "/home/me/joint_bob" } });
  assert.match(text, /Joint Bob's own source code and documentation: the project "Joint Bob" at \/home\/me\/joint_bob\. Its docs\/ folder explains each feature/);
  assert.doesNotMatch(bobContext([], [], facts), /own source code/);
});

test("what Bob's agent is shown starts with the person's message and the recent chat", async () => {
  const { bobMaterial } = await import("../src/control-center/bob-context.js");
  const material = bobMaterial({ message: "what is running in dak?", recentChat: ["hi", "Hello"], context: "Conversations running: …", contributed: "Topic: release-gate" });
  assert.ok(material.indexOf("what is running in dak?") < material.indexOf("Conversations running"), "the message comes before a long context");
  assert.match(material, /User: hi\nBob: Hello/);
  assert.match(material, /Topic: release-gate/);
  assert.equal(bobMaterial({ message: "x", recentChat: [], context: "", contributed: "" }), "The user's message (answer this):\nx");
});
