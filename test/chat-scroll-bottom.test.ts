import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("transcript growth never changes the current scroll position", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.doesNotMatch(app, /stickyScroll|stickToBottom|releaseStickyScroll/);
  assert.doesNotMatch(app, /messages\.addEventListener\("scroll"/);
  assert.doesNotMatch(app, /messages\.addEventListener\("wheel"/);
  assert.doesNotMatch(app, /messages\.addEventListener\("touch/);

  const scrollAssignments = app.match(/elements\.messages\.scrollTop\s*=/g) || [];
  assert.equal(scrollAssignments.length, 1);
});

test("opening a conversation scrolls to the newest message after rendering", async () => {
  const app = await readFile("public/app.js", "utf8");
  const openSessionStart = app.indexOf("function openSession(");
  const handlerStart = app.indexOf("function handleSocketPayload(");
  const openSession = app.slice(openSessionStart, handlerStart);
  const handler = app.slice(handlerStart, app.indexOf("\nfunction scheduleAgentRunPoll", handlerStart));

  assert.match(openSession, /handleSocketPayload\(JSON\.parse\(event\.data\), !preserveChat\)/);
  assert.match(handler, /function handleSocketPayload\(payload, scrollOnReady = false\)/);
  assert.match(handler, /appendTranscript\(payload\.messages\);[\s\S]*if \(scrollOnReady\) requestAnimationFrame\(scrollConversationToBottom\);/);
});
