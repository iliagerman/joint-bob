import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

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
  assert.match(append, /function appendMessage\(role, text, timestamp = true, attachments = \[\], read = false\)/);
  assert.match(append, /timestamp === true \? new Date\(\) : timestamp/);

  // The transcript passes each message's recorded time through to the bubble,
  // and a message the harness never stamped stays undated instead of being
  // labelled with the moment it was re-rendered.
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /new Date\(message\.timestamp\)/);
  assert.match(transcript, /Number\.isFinite/);

  // Formatting goes through toLocale*, so the browser's own time zone and
  // locale decide what the reader sees, wherever they are.
  const format = functionSource(app, "formatMessageTime");
  assert.match(format, /toLocaleTimeString\(\[\], \{ hour: "2-digit", minute: "2-digit" \}\)/);
  assert.match(format, /toLocaleDateString/);
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
  assert.match(app, /payload\.type === "agent_start"[\s\S]{0,400}markUserMessagesRead\(\)/);
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
});

test("a running tool shows its elapsed time and a finished one its total", async () => {
  const app = await appSource();

  // Only live tool bubbles get a start time; replayed history passes 0 and stays undated.
  assert.match(app, /function appendToolMessage\(toolName, toolCallId, startedAt = Date\.now\(\)\)/);
  assert.match(app, /bubble\._startedAt = startedAt/);
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /appendToolMessage\(message\.toolName \|\| "tool", `history-\$\{message\.id\}`, 0\)/);

  const update = functionSource(app, "updateToolMessage");
  assert.match(update, /bubble\._startedAt/);
  assert.match(update, /formatDuration\(Date\.now\(\) - bubble\._startedAt\)/);
  // The status word still drives the styling hook, only the visible label gains the duration.
  assert.match(update, /bubble\.dataset\.status = isError \? "error" : status\.toLowerCase\(\)/);

  // One shared ticker drives every live label instead of a timer per bubble.
  const tick = functionSource(app, "tickDurations");
  assert.match(tick, /state\.toolBubbles\.values\(\)/);
  assert.match(tick, /Running \$\{formatDuration/);
  assert.match(app, /clearInterval\(state\.durationTicker\)/);
});

test("the turn timer counts up while the agent works and reports the total when it stops", async () => {
  const [app, html] = await Promise.all([appSource(), readFile("public/index.html", "utf8")]);

  assert.match(html, /id="turnTimer"[^>]*data-testid="chat-turn-timer"/);
  assert.match(app, /turnTimer: document\.querySelector\("#turnTimer"\)/);

  const tick = functionSource(app, "tickDurations");
  assert.match(tick, /elements\.turnTimer\.textContent = `Working \$\{formatDuration\(Date\.now\(\) - state\.lastTurnStartedAt\)\}`/);

  // agent_start begins the count; agent_end stamps the finished turn's total.
  const agentStart = app.slice(app.indexOf('payload.type === "agent_start"'));
  assert.match(agentStart.slice(0, 400), /startDurationTicker\(\)/);
  const finish = functionSource(app, "finishTurnTimer");
  assert.match(finish, /took \$\{formatDuration/);
  assert.match(finish, /message-time/);
});
