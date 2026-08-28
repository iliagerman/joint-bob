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

  // One listener loop wires every trigger, so the dialog behaves the same from any view.
  assert.match(app, /querySelectorAll\("\[data-recent-sessions-open\]"\)/);
  assert.match(app, /function openRecentSessionsDialog\(\)/);
  assert.match(app, /function renderRecentSessionsDialog\(\)/);
});

test("recent conversations are reachable from the conversations list and an open chat", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  // Mobile shows one panel at a time, so the projects header alone leaves the recents
  // dialog unreachable from the conversations list and from an open chat.
  for (const id of ["recentSessionsButton", "chatsRecentSessionsButton", "chatRecentSessionsButton"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-recent-sessions-open`), `${id} is missing the shared marker`);
  }
  assert.match(html, /id="chatsRecentSessionsButton"[^>]*data-testid="chats-recent-sessions-open-button"/);
  assert.match(html, /id="chatRecentSessionsButton"[^>]*data-testid="chat-recent-sessions-open-button"/);

  const chatsHeaderStart = html.indexOf('<section class="panel view-panel" id="chatsPanel"');
  const chatsHeaderEnd = html.indexOf("</header>", chatsHeaderStart);
  assert.ok(chatsHeaderStart >= 0, "Missing chatsPanel");
  assert.ok(
    html.slice(chatsHeaderStart, chatsHeaderEnd).includes('id="chatsRecentSessionsButton"'),
    "recents button is not in the conversations panel header",
  );

  const moreStart = html.indexOf('<div class="chat-more-actions">');
  const moreEnd = html.indexOf("</div>", moreStart);
  assert.ok(moreStart >= 0, "Missing chat-more-actions");
  assert.ok(
    html.slice(moreStart, moreEnd).includes('id="chatRecentSessionsButton"'),
    "recents button is not in the chat actions menu",
  );

  // The triggers stay declarative: no per-button listener may be re-introduced.
  assert.doesNotMatch(app, /elements\.recentSessionsButton\.addEventListener/);
});

test("recent conversations are recorded, pinnable, and reopenable", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /recentSessions: \[\]/);
  assert.match(app, /state\.recentSessions = preferences\.recentSessions \|\| \[\];/);
  assert.match(app, /function canonicalSessionPath\(sessionPath\)/);
  assert.match(app, /sessionPath\.replace\(\/\\\.sync-conflict-/);
  assert.match(app, /function rememberRecentSession\(session\)/);
  assert.match(app, /sessionPath: canonicalSessionPath\(session\.path\)/);
  assert.match(app, /canonicalSessionPath\(candidate\.sessionPath\) !== entry\.sessionPath/);
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

test("the recents dialog can be searched", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="recentSessionsSearchInput"[^>]*data-testid="recent-sessions-search-input"/);
  assert.match(app, /recentSessionsSearchInput: document\.querySelector\("#recentSessionsSearchInput"\)/);
  assert.match(app, /normalizedQuery\(elements\.recentSessionsSearchInput\.value \|\| ""\)/);
  assert.match(app, /elements\.recentSessionsSearchInput\.addEventListener\("input", \(\) => renderRecentSessionsDialog\(\)\)/);

  // A stale query must not survive a reopen.
  const start = app.indexOf("function openRecentSessionsDialog()");
  const end = app.indexOf("\n}", start);
  assert.ok(start >= 0, "Missing openRecentSessionsDialog");
  assert.match(app.slice(start, end), /elements\.recentSessionsSearchInput\.value = ""/);
});

test("the first ten recents are numbered and open with a digit key", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(app, /const RECENT_SESSION_SHORTCUT_LIMIT = 10;/);
  assert.match(app, /index\.dataset\.testid = "recent-session-index"/);
  assert.match(app, /recentSessionShortcuts\.push\(entry\)/);
  assert.match(app, /recentSessionShortcuts\.length === 10 \? "0" : String\(recentSessionShortcuts\.length\)/);
  assert.match(styles, /\.recent-sessions-list \.recent-session-index \{/);

  // The digit must reach the list, not the search field the user is typing in.
  const start = app.indexOf('elements.recentSessionsDialog.addEventListener("keydown"');
  const end = app.indexOf("\n});", start);
  assert.ok(start >= 0, "Missing recents dialog keydown handler");
  const handler = app.slice(start, end);
  assert.match(handler, /event\.target === elements\.recentSessionsSearchInput/);
  assert.match(handler, /event\.key === "0" \? 10 : Number\(event\.key\)/);
  assert.match(handler, /recentSessionShortcuts\[position - 1\]/);
  assert.match(handler, /openRecentSession\(entry\)/);

  // Focus starts on the list, so a digit is a shortcut rather than typed text.
  assert.match(app, /elements\.recentSessionsList\.focus\(\)/);
});

test("a global shortcut opens the recents dialog", async () => {
  const app = await readFile("public/app.js", "utf8");

  const start = app.indexOf('document.addEventListener("keydown"');
  const end = app.indexOf("\n});", start);
  assert.ok(start >= 0, "Missing global keydown handler");
  const handler = app.slice(start, end);
  assert.match(handler, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(handler, /\|\| event\.shiftKey\) return/);
  assert.doesNotMatch(handler, /!event\.shiftKey/);
  assert.match(handler, /event\.key\.toLowerCase\(\) !== "k"/);
  assert.match(handler, /openRecentSessionsDialog\(\)/);
});

test("the recents list leaves room for the focus ring", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  // The rows scroll inside the list, so a 2px outline offset needs padding or it is clipped.
  assert.match(styles, /\.recent-sessions-list \{[^}]*padding: 3px;/);
});
