import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The chat pane follows the conversation while the reader is at the bottom and
// releases the moment they scroll away. The follow decision lives in exactly
// one scroll listener; growth pins through the one coalesced requestPinChat,
// and re-renders either pin (following) or restore the reader's position.
// The behavioural proof is test/ui/ui-chat-follow-scroll.test.ts; these
// assertions guard the wiring that keeps that behaviour single-sourced.
test("chat follow-scroll wiring is single-sourced", async () => {
  const app = await readFile("public/app.js", "utf8");

  const scrollListeners = app.match(/elements\.messages\.addEventListener\("scroll"/g) || [];
  assert.equal(scrollListeners.length, 1, "exactly one scroll listener drives follow mode");

  // Wheel and touch listeners are unnecessary: the scroll event alone sees every
  // user-driven scroll, and extra listeners would double-fire the decision.
  assert.doesNotMatch(app, /messages\.addEventListener\("wheel"/);
  assert.doesNotMatch(app, /messages\.addEventListener\("touch/);

  const pinRequests = app.match(/requestPinChat\(\)/g) || [];
  assert.ok(pinRequests.length >= 4, "append, render, and re-render paths all request a pin");

  // Direct scrollTop writes are confined to the pin helper, the restore
  // helper, and the command-autocomplete list. Nothing else may move the pane.
  const pinStart = app.indexOf("function pinChatToBottom");
  const pinBody = app.slice(pinStart, app.indexOf("}", app.indexOf("{", pinStart) + 1));
  assert.match(pinBody, /lastPinScrollTop = Math\.max\(0, box\.scrollHeight - box\.clientHeight\)/);
  assert.match(pinBody, /box\.scrollTop = box\.scrollHeight;/);
  const restoreStart = app.indexOf("function restoreChatScrollTop");
  const restoreBody = app.slice(restoreStart, app.indexOf("}", app.indexOf("{", restoreStart) + 1));
  assert.match(restoreBody, /scrollTop = Math\.max\(0, Math\.min\(top, box\.scrollHeight - box\.clientHeight\)\)/);
  const otherScrollTops = app.match(/\.scrollTop\s*=/g) || [];
  assert.equal(otherScrollTops.length, 3, "pin, restore, and the command-autocomplete list are the only scrollTop writes");
});

test("transcript growth pins only while the reader is following", async () => {
  const app = await readFile("public/app.js", "utf8");

  const pinStart = app.indexOf("function requestPinChat");
  assert.ok(pinStart > -1, "requestPinChat exists");
  const pinBody = app.slice(pinStart, app.indexOf("}", app.indexOf("{", pinStart)));
  assert.match(pinBody, /state\.followChat/, "the pin checks follow state when it runs");

  assert.match(app, /function chatAtBottom/, "at-bottom detection exists");
  assert.match(app, /state\.followChat = chatAtBottom\(\);/, "the scroll listener updates follow state from the scroll position");
});

test("re-rendered transcripts either pin or restore the reader's position", async () => {
  const app = await readFile("public/app.js", "utf8");

  const handlerStart = app.indexOf("function handleSocketPayload(");
  const handler = app.slice(handlerStart, app.indexOf("\nfunction scheduleAgentRunPoll", handlerStart));

  // The ready payload: fresh opens pin; reconnects keep following or restore.
  assert.match(handler, /rerenderChatTranscript\(payload\.messages\)/);
  assert.match(handler, /scrollOnReady \|\| state\.followChat/);
  assert.match(handler, /restoreChatScrollTop\(resumeFromTop\)/);

  // The messages payload (a transcript synchronized from another node) must not
  // drop the reader at the top of the conversation.
  const messagesBranch = handler.slice(handler.indexOf('payload.type === "messages"'));
  assert.match(messagesBranch, /rerenderChatTranscript\(payload\.messages\)/);
  assert.match(messagesBranch, /restoreChatScrollTop\(resumeFromTop\)/);

  // The re-render itself must not be read as a scroll-away.
  assert.match(app, /let rerenderingChat = false;/);
  assert.match(app, /if \(rerenderingChat\) return;/);

  // The ticket dialog's conversation tab re-pins on show: pins were no-ops
  // while the chat sat on a hidden tab.
  const tabStart = app.indexOf("function setTaskDialogTab");
  const tabBody = app.slice(tabStart, app.indexOf("\nfunction openEditTaskDialog", tabStart));
  assert.match(tabBody, /if \(tab === "conversation"\) requestPinChat\(\);/);
});
