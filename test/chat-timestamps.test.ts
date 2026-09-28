import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

function functionSource(app: string, name: string): string {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > start, `Missing end of ${name}`);
  return app.slice(start, end);
}

test("chat messages carry a wall-clock stamp: live ones the arrival time, replayed ones their recorded time", async () => {
  const app = await appSource();

  const stamp = functionSource(app, "messageTimestamp");
  assert.match(stamp, /document\.createElement\("time"\)/);
  assert.match(stamp, /message-time/);
  assert.match(stamp, /dateTime = /);
  assert.match(stamp, /dataset\.testid = "message-timestamp"/);

  const append = functionSource(app, "appendMessage");
  assert.match(append, /function appendMessage\(role, text, timestamp = true, attachments = \[\], read = false, attribution = undefined\)/);
  assert.match(append, /timestamp === true \? new Date\(\) : timestamp/);

  // The transcript passes each message's recorded time through to the bubble,
  // and a message the harness never stamped stays undated instead of being
  // labelled with the moment it was re-rendered.
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /new Date\(message\.timestamp\)/);
  assert.match(transcript, /Number\.isFinite/);

  // Every stamp includes both date and time in the browser's own locale and zone.
  const format = functionSource(app, "formatDateTime");
  assert.match(format, /toLocaleString/);
  assert.match(format, /year: "numeric"/);
  assert.match(format, /second: "2-digit"/);

  const started = functionSource(app, "appendConversationStart");
  assert.match(started, /conversation-started-at/);
  assert.match(started, /Started /);
});

test("user messages carry a delivery receipt that flips when the agent takes the turn", async () => {
  const app = await appSource();

  const receipt = functionSource(app, "messageReceipt");
  assert.match(receipt, /message-receipt/);
  const setState = functionSource(app, "setReceiptState");
  assert.match(setState, /dataset\.read = String\(read\)/);
  assert.match(setState, /"✓✓" : "✓"/);

  // A replayed user message sits in the agent's own transcript, so it renders
  // as already received.
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /role === "user"/);

  // The live flip: an agent turn starting consumes every sent message that is
  // not still queued, and a queued prompt flips the moment its turn starts.
  const mark = functionSource(app, "markUserMessagesRead");
  assert.match(mark, /:not\(\.queued\)/);
  assert.match(app, /payload\.type === "agent_start"[\s\S]{0,700}markUserMessagesRead\(\)/);
  const clearMark = functionSource(app, "clearQueuedMark");
  assert.match(clearMark, /setReceiptState\(/);
});

test("assistant messages the reader has not viewed carry an unread dot until they dwell at the bottom", async () => {
  const app = await appSource();

  assert.match(functionSource(app, "unreadDot"), /message-unread-dot/);

  // "Viewed" requires the tab visible and the reader at the bottom; only then
  // does the watermark advance and the dots clear.
  const viewed = functionSource(app, "markViewedIfCaughtUp");
  assert.match(viewed, /document\.hidden \|\| !chatAtBottom\(\)/);
  assert.match(viewed, /saveLastReadAt\(/);
  assert.match(viewed, /message-unread-dot/);

  // The per-conversation watermark lives in the account's server-side
  // preferences (shared across devices, no Web Storage) and cannot grow
  // without bound.
  assert.match(functionSource(app, "lastReadAt"), /state\.conversationLastRead/);
  const save = functionSource(app, "saveLastReadAt");
  assert.match(save, /READ_WATERMARKS_LIMIT/);
  assert.match(save, /savePreferencesInBackground\(\{ conversationLastRead: marks \}\)/);
});

test("receipts and unread dots ship their styles", async () => {
  const styles = await readFile("public/styles.css", "utf8");
  assert.match(styles, /\.message-meta \{[^}]*display: flex/);
  assert.match(styles, /\.message-receipt\[data-read="true"\] \{[^}]*var\(--accent\)/);
  assert.match(styles, /\.message-unread-dot \{[^}]*var\(--danger\)/);
});

test("durations are formatted once and reused everywhere", async () => {
  const app = await appSource();

  const format = functionSource(app, "formatDuration");
  assert.match(format, /toFixed\(1\)/);
  assert.match(format, /padStart\(2, "0"\)/);
  assert.match(format, /h /);
  assert.match(format, /seconds > 0 && seconds < 0\.05 \? 0\.1/);
});

test("a running tool shows its elapsed time and a finished one its total", async () => {
  const app = await appSource();

  assert.match(app, /function appendToolMessage\(toolName, toolCallId, startedAt = Date\.now\(\), recordedAt = startedAt\)/);
  assert.match(app, /bubble\._startedAt = startedAt/);
  assert.match(app, /summary\.append\(messageTimestamp\(new Date\(recordedAt\)\)\)/);
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /appendToolMessage\(message\.toolName \|\| "tool", `history-\$\{message\.id\}`, 0, recorded \|\| 0\)/);
  assert.match(transcript, /message\.durationMs/);

  const update = functionSource(app, "updateToolMessage");
  assert.match(update, /recordedDurationMs/);
  assert.match(update, /Date\.now\(\) - bubble\._startedAt/);
  // The status word still drives the styling hook, only the visible label gains the duration.
  assert.match(update, /bubble\.dataset\.status = isError \? "error" : status\.toLowerCase\(\)/);

  // Replayed live events use the server's start and finish stamps instead of
  // measuring until this browser happened to reconnect.
  assert.match(app, /const finishedAt = Date\.parse\(payload\.timestamp \|\| ""\)/);
  assert.match(app, /finishedAt - bubble\._startedAt/);

  // One shared ticker drives every live label instead of a timer per bubble.
  const tick = functionSource(app, "tickDurations");
  assert.match(tick, /state\.toolBubbles\.values\(\)/);
  assert.match(tick, /Running \$\{formatDuration/);
  assert.match(app, /clearInterval\(state\.durationTicker\)/);
});

test("the header timer restores and accumulates total conversation work", async () => {
  const [app, server, html] = await Promise.all([appSource(), serverSource(), readFile("public/index.html", "utf8")]);

  assert.match(html, /id="turnTimer"[^>]*data-testid="chat-turn-timer"/);
  assert.match(app, /turnTimer: document\.querySelector\("#turnTimer"\)/);

  const restore = functionSource(app, "restoreConversationTimer");
  assert.match(restore, /completedConversationDuration\(messages, activeTurnStartedAt\)/);
  const render = functionSource(app, "renderConversationTimer");
  assert.match(render, /state\.conversationDurationMs \+ running/);
  assert.match(render, /label\.textContent = "Total "/);
  assert.match(render, /replaceChildren\(label, formatDuration/);

  const finish = functionSource(app, "finishTurnTimer");
  assert.match(finish, /state\.conversationDurationMs \+= elapsed/);
  assert.match(finish, /took \$\{formatDuration/);
  assert.match(server, /turnStartedAt: shared\.turnStartedAt/);
});
