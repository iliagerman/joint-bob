import assert from "node:assert/strict";
import test from "node:test";

test("short side-chat context stays verbatim without summary calls", async () => {
  const { prepareChatContext } = await import("../src/conversation-chat-context.js");
  const result = await prepareChatContext("exact transcript and history", "why?", async () => { throw new Error("must not summarize"); });
  assert.equal(result.compacted, false);
  assert.match(result.prompt, /exact transcript and history/);
  assert.match(result.prompt, /why\?/);
});

test("long Unicode tool output is summarized in bounded chunks, not silently discarded", async () => {
  const { prepareChatContext, CHAT_PROMPT_BYTES } = await import("../src/conversation-chat-context.js");
  const original = "opening decision\n" + "שלום 🐈 evidence ".repeat(18_000) + "\nLATEST STATE";
  const consumed: string[] = [];
  const result = await prepareChatContext(original, "what remains?", async (chunk) => {
    consumed.push(chunk);
    assert.ok(Buffer.byteLength(chunk) < CHAT_PROMPT_BYTES);
    assert.ok(!chunk.includes("\uFFFD"), "UTF-8 boundaries are preserved");
    return "Earlier decisions and evidence were summarized.";
  });
  assert.equal(result.compacted, true);
  assert.ok(Buffer.byteLength(result.prompt) <= CHAT_PROMPT_BYTES);
  assert.match(result.prompt, /LATEST STATE/);
  assert.match(result.prompt, /what remains\?/);
  assert.match(result.prompt, /summarized/i);
  assert.ok(consumed.join("").startsWith("opening decision"));
  const tail = original.slice(consumed.join("").length);
  assert.ok(result.prompt.includes(tail), "every original character is either summarized or kept verbatim");
});

test("only explicit context-limit failures qualify for a smaller-context retry", async () => {
  const { isChatContextLimit } = await import("../src/conversation-chat-context.js");
  for (const message of ["Prompt is too long", "context_length_exceeded", "maximum context length exceeded"]) assert.equal(isChatContextLimit(new Error(message)), true);
  for (const message of ["Unauthorized", "timeout", "Review timed out", "rate limit exceeded"]) assert.equal(isChatContextLimit(new Error(message)), false);
});

test("a failed or non-shrinking summary never silently drops the conversation", async () => {
  const { prepareChatContext } = await import("../src/conversation-chat-context.js");
  await assert.rejects(prepareChatContext("x".repeat(200_000), "why?", async () => { throw new Error("model unavailable"); }), /model unavailable/);
  await assert.rejects(prepareChatContext("x".repeat(200_000), "why?", async (chunk) => chunk), /did not reduce/);
});
