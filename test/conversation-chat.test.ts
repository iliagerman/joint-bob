import assert from "node:assert/strict";
import { test } from "node:test";

test("side chat preserves full context, pending prompts and tool output", async () => {
  const { conversationChatPrompt } = await import("../src/conversation-chat.js");
  const long = "x".repeat(130_000);
  const prompt = conversationChatPrompt([
    { role: "user", text: long }, { role: "toolResult", text: "tool evidence" },
    { role: "user", text: "pending source question" },
  ], [{ role: "user", text: "previous side question" }, { role: "assistant", text: "previous answer" }], "why?");
  assert.ok(prompt.includes(long));
  for (const text of ["tool evidence", "pending source question", "previous side question", "previous answer", "why?", "read-only"]) assert.ok(prompt.includes(text));
});

test("history is durable, isolated by user/project/conversation, and only explicitly cleared", async () => {
  const { chatState, saveChatState, clearChatHistory } = await import("../src/conversation-chat.js");
  const scope = { userId: "alice", projectId: "p", conversationId: "c" };
  const state = chatState(scope);
  state.messages.push({ role: "user", text: "question" }, { role: "assistant", text: "answer" });
  state.model = { harnessId: "pi", provider: "openai", modelId: "test" };
  state.queue.push({ id: "waiting-question", question: "follow-up", model: state.model });
  saveChatState(scope, state);
  assert.deepEqual(chatState(scope), state);
  assert.equal(chatState({ ...scope, userId: "bob" }).messages.length, 0);
  assert.equal(chatState({ ...scope, projectId: "other" }).messages.length, 0);
  assert.equal(chatState({ ...scope, conversationId: "other" }).messages.length, 0);
  clearChatHistory(scope);
  assert.deepEqual(chatState(scope).messages, []);
  assert.deepEqual(chatState(scope).queue, []);
  assert.deepEqual(chatState(scope).model, state.model);
});
