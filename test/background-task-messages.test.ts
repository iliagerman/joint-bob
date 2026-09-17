import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { internalTaskPrompt, isInternalTaskPrompt, visibleTaskMessages } from "../src/background-task-messages.js";
import { boundTranscriptMessages } from "../src/conversation-segments.js";
import type { ChatMessage } from "../src/types.js";

const message = (role: ChatMessage["role"], text: string, id = randomUUID()): ChatMessage => ({ id, role, text });

test("internal task turns are hidden until the next ordinary user turn", () => {
  const normal = message("user", "normal");
  const internal = message("user", internalTaskPrompt(randomUUID(), "inspect output"));
  const hiddenAssistant = message("assistant", "internal result");
  const next = message("user", "next normal");
  const visibleAssistant = message("assistant", "visible result");
  const input = [normal, internal, hiddenAssistant, next, visibleAssistant];
  const snapshot = [...input];
  const visible = visibleTaskMessages(input);
  assert.deepEqual(visible, [normal, next, visibleAssistant]);
  assert.equal(visible[0], normal);
  assert.deepEqual(input, snapshot, "input must not be mutated");
});

test("only the exact reserved UUID marker is internal", () => {
  const id = randomUUID();
  assert.equal(isInternalTaskPrompt(internalTaskPrompt(id, "body")), true);
  assert.equal(isInternalTaskPrompt(`[Joint Bob internal task completion nope]\nbody`), false);
  assert.equal(isInternalTaskPrompt(`quoted: [Joint Bob internal task completion ${id}]\nbody`), false);
  assert.equal(isInternalTaskPrompt("Background task ended with status completed. Report result to user"), false);
  assert.throws(() => internalTaskPrompt("not-a-uuid", "body"), /UUID/);
});

test("hidden internal turns are filtered before transcript bounds", () => {
  const first = message("user", "first ordinary", "first");
  const hidden = message("user", internalTaskPrompt(randomUUID(), "internal"), "internal");
  const messages: ChatMessage[] = [first, hidden];
  for (let index = 0; index < 600; index += 1) messages.push(message("assistant", `hidden ${index}`));
  const last = message("user", "last ordinary", "last");
  const response = message("assistant", "last response", "response");
  messages.push(last, response);
  const bounded = boundTranscriptMessages(messages);
  assert.deepEqual(bounded.map(({ id }) => id), ["first", "last", "response"]);
  assert.equal(JSON.stringify(bounded).includes("hidden"), false);
});
