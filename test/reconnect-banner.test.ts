import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a dropped socket shows an animated connecting banner instead of a Cannot connect block", async () => {
  const [html, css, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  // A single reusable banner lives outside the message list, so it can never
  // stack up once per reconnect attempt the way the empty-state block did.
  assert.match(html, /id="reconnectBanner"[^>]*data-testid="chat-reconnect-banner"/);
  assert.match(html, /class="reconnect-dots"/);
  assert.doesNotMatch(app, /showChatEmptyState\("Cannot connect"/);

  assert.match(app, /function setConnecting\(/);
  assert.match(app, /socket\.addEventListener\("open"[\s\S]*setConnecting\(false\)/);
  assert.match(app, /socket\.addEventListener\("close"[\s\S]*setConnecting\(true, "Connecting…"\)/);
  assert.match(app, /function resumeConnection[\s\S]*setConnecting\(true, "Connecting…"\)/);
  // One retry per 1.5s must not mean one toast per 1.5s.
  assert.doesNotMatch(app, /toast\("WebSocket connection failed"\)/);

  assert.match(css, /\.reconnect-banner \{/);
  assert.match(css, /@keyframes reconnect-dot/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*reconnect-dots/);
});

test("the connection pill reads Connecting while the socket is down", async () => {
  const [app, css] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.doesNotMatch(app, /setStatus\("Reconnecting…"/);
  assert.match(app, /setStatus\("Connecting…", false, true\)/);
  assert.match(app, /function setStatus\(text, live = false, connecting = false\)/);
  assert.match(css, /\.status-pill\.connecting/);
});

test("the service worker cache is bumped so installed clients pick up the new shell", async () => {
  const sw = await readFile("public/sw.js", "utf8");
  const version = Number(/joint-bob-v(\d+)/.exec(sw)?.[1]);
  assert.ok(version >= 2, `expected the Joint Bob app shell cache at v2 or later, got v${version}`);
});
