import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function functionSource(app: string, name: string): string {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > start, `Missing end of ${name}`);
  return app.slice(start, end);
}

test("live chat messages carry the clock time they arrived", async () => {
  const app = await readFile("public/app.js", "utf8");

  const stamp = functionSource(app, "messageTimestamp");
  assert.match(stamp, /document\.createElement\("time"\)/);
  assert.match(stamp, /message-time/);
  assert.match(stamp, /dateTime = /);
  assert.match(stamp, /data-testid|dataset\.testid = "message-timestamp"/);

  const append = functionSource(app, "appendMessage");
  assert.match(append, /function appendMessage\(role, text, timestamped = true\)/);
  assert.match(append, /timestamped && \(role === "user" \|\| role === "assistant"\)/);

  // A replayed transcript has no recorded times, so it must not be stamped with "now".
  const transcript = functionSource(app, "appendTranscript");
  assert.match(transcript, /appendMessage\(message\.role === "user" \? "user" : "assistant", message\.text, false\)/);
});

test("durations are formatted once and reused everywhere", async () => {
  const app = await readFile("public/app.js", "utf8");

  const format = functionSource(app, "formatDuration");
  assert.match(format, /toFixed\(1\)/);
  assert.match(format, /padStart\(2, "0"\)/);
  assert.match(format, /h /);
});

test("a running tool shows its elapsed time and a finished one its total", async () => {
  const app = await readFile("public/app.js", "utf8");

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
  const [app, html] = await Promise.all([readFile("public/app.js", "utf8"), readFile("public/index.html", "utf8")]);

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
