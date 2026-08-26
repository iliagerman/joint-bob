import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the projects header opens a recent conversations dialog", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="recentSessionsButton"[^>]*data-testid="recent-sessions-open-button"/);
  assert.match(html, /id="recentSessionsDialog" data-testid="recent-sessions-dialog"/);
  assert.match(html, /id="recentSessionsList"/);
  assert.match(html, /id="closeRecentSessionsButton"[^>]*data-testid="recent-sessions-close-button"/);

  // The button sits next to the settings gear in the projects panel header.
  const actionsStart = html.indexOf('<div class="project-actions">');
  const actionsEnd = html.indexOf("</div>", actionsStart);
  const actions = html.slice(actionsStart, actionsEnd);
  assert.ok(actions.includes('id="recentSessionsButton"'), "recents button is not in the header");
  assert.ok(
    actions.indexOf('id="recentSessionsButton"') < actions.indexOf('id="settingsButton"'),
    "recents button must sit before the settings button",
  );

  assert.match(app, /elements\.recentSessionsButton\.addEventListener/);
  assert.match(app, /function renderRecentSessionsDialog\(\)/);
});

test("recent conversations are recorded, pinnable, and reopenable", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /recentSessions: \[\]/);
  assert.match(app, /state\.recentSessions = preferences\.recentSessions \|\| \[\];/);
  assert.match(app, /function rememberRecentSession\(session\)/);
  assert.match(app, /async function openRecentSession\(entry\)/);
  assert.match(app, /savePreferencesInBackground\(\{ recentSessions: state\.recentSessions \}\)/);

  // Opening any listed conversation is what makes it recent.
  const start = app.indexOf("function openListedSession(session)");
  const end = app.indexOf("\n}", start);
  assert.ok(start >= 0, "Missing openListedSession");
  assert.match(app.slice(start, end), /rememberRecentSession\(session\)/);

  // Pinning reuses the existing conversation pin, so a pin set here shows in the chat list too.
  assert.match(app, /testid: "recent-session-pin-button"/);
  assert.match(app, /togglePinnedSession\(entry\.sessionPath\)/);
  assert.match(app, /sortPinnedFirst\(state\.recentSessions, \(entry\) => isSessionPinned\(entry\.sessionPath\)\)/);

  // Persistence goes through the preferences API, never Web Storage.
  assert.doesNotMatch(app, /\.setItem\(/);
});

test("recent conversations round-trip through the preferences API", async () => {
  const [preferences, server, styles] = await Promise.all([
    readFile("src/preferences.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.ok(preferences.includes("recentSessions"), "preferences.ts is missing recentSessions");
  assert.ok(server.includes("recentSessions"), "server.ts is missing recentSessions");
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN recent_sessions TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /export interface RecentSession/);

  // Four buttons now share the header, so they are smaller than the default icon button.
  assert.match(styles, /\.project-actions \.icon-button \{/);
  assert.match(styles, /\.recent-sessions-list/);
});
