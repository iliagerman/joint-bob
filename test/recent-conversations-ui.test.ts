import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

test("the projects header opens a recent conversations dialog", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
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
  assert.match(app, /function openRecentSessions\(\)/);
  assert.match(app, /function renderRecentSessionsDialog\(\)/);
});

test("recent conversations are reachable from the conversations list and an open chat", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
    readFile("public/styles.css", "utf8"),
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

  const toolbarStart = html.indexOf('<div class="chat-toolbar panel-toolbar" id="chatToolbar">');
  const toolbarEnd = html.indexOf('\n        <div class="messages-wrap"', toolbarStart);
  assert.ok(toolbarStart >= 0 && toolbarEnd >= 0, "Missing chat toolbar");
  const toolbar = html.slice(toolbarStart, toolbarEnd);
  const modeStart = toolbar.indexOf('id="chatModeControl"');
  const recentsStart = toolbar.indexOf('id="chatRecentSessionsButton"');
  const moreStart = toolbar.indexOf('id="chatMoreMenu"');
  assert.ok(modeStart >= 0, "Missing chat Mode control");
  assert.ok(recentsStart > modeStart, "recents button must follow the Mode control");
  assert.ok(moreStart > recentsStart, "recents button must precede the More menu");
  assert.doesNotMatch(toolbar.slice(toolbar.indexOf('<div class="chat-more-actions">')), /id="chatRecentSessionsButton"/);

  // On larger screens Projects is the only visible recents location.
  assert.match(styles, /#chatsRecentSessionsButton, #chatRecentSessionsButton \{ display: none; \}/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*?#chatsRecentSessionsButton, #chatRecentSessionsButton \{ display: none !important; \}/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?#chatsRecentSessionsButton \{ display: inline-grid; \}[\s\S]*?#chatRecentSessionsButton \{ display: inline-flex; \}/);

  // The triggers stay declarative: no per-button listener may be re-introduced.
  assert.doesNotMatch(app, /elements\.recentSessionsButton\.addEventListener/);
});

test("recent conversations are recorded, pinnable, and reopenable", async () => {
  const app = await appSource();

  assert.match(app, /recentSessions: \[\]/);
  assert.match(app, /state\.recentSessions = recents\.recentSessions \|\| \[\];/);
  assert.match(app, /async function loadRecentSessions\(\)/);
  assert.match(app, /api\("\/api\/recents"/);
  assert.match(app, /function canonicalSessionPath\(sessionPath\)/);
  assert.match(app, /sessionPath\.replace\(\/\\\.sync-conflict-/);
  assert.match(app, /function rememberRecentSession\(session\)/);
  assert.match(app, /sessionPath: canonicalSessionPath\(session\.path\)/);
  assert.match(app, /recentSessionKey\(candidate\) !== recentSessionKey\(entry\)/);
  assert.match(app, /async function openRecentSession\(entry\)/);
  assert.match(app, /method: "PUT"/);
  assert.match(app, /method: "DELETE"/);

  // Existing and newly created conversations both become recent when opened.
  const start = app.indexOf("function openListedSession(session)");
  const end = app.indexOf("\n}", start);
  assert.ok(start >= 0, "Missing openListedSession");
  assert.match(app.slice(start, end), /rememberRecentSession\(session\)/);
  const optimistic = app.slice(app.indexOf("function addOptimisticSession("));
  assert.match(optimistic.slice(0, optimistic.indexOf("\n}")), /rememberRecentSession\(session\)/);

  // Pinning reuses the stable conversation identity, so a pin set here shows in the chat list and on other nodes.
  assert.match(app, /testid: "recent-session-pin-button"/);
  assert.match(app, /togglePinnedSession\(entry\)/);
  assert.match(app, /sortPinnedFirst\(byActivity, isSessionPinned\)/);
  assert.match(app, /sessionId: session\.id/);

  // Persistence goes through the preferences API, never Web Storage.
  assert.doesNotMatch(app, /\.setItem\(/);
});

test("both WebSocket message handlers reload replicated recents", async () => {
  const app = await appSource();
  const activeStart = app.indexOf("function handleSocketPayload(payload, scrollOnReady = false)");
  const watchStart = app.indexOf("function ensureWatchSocket()");
  assert.ok(activeStart >= 0, "Missing active-chat socket handler");
  assert.ok(watchStart >= 0, "Missing watch socket handler");
  // Both handlers use the shared INVALIDATION_HANDLERS table for recentsChanged.
  assert.match(app, /const INVALIDATION_HANDLERS = \{[\s\S]*?recentsChanged:/);
  assert.match(app.slice(activeStart, app.indexOf("\nfunction scheduleAgentRunPoll", activeStart)), /if \(handleInvalidation\(payload\)\) return;/);
  assert.match(app.slice(watchStart, watchStart + 3000), /handleInvalidation\(JSON\.parse\(event\.data\)\);/);
});

test("legacy recents remain in preferences while active recents use their own API", async () => {
  const [preferences, server, styles] = await Promise.all([
    readFile("src/preferences.ts", "utf8"),
    serverSource(),
    readFile("public/styles.css", "utf8"),
  ]);

  // The preferences API no longer carries recentSessions; they are in the replicated recents table.
  assert.ok(preferences.includes("readLegacyRecentSessions"), "preferences.ts is missing readLegacyRecentSessions");
  assert.ok(server.includes("/api/recents"), "server.ts is missing the recents API");
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN recent_sessions TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /export interface RecentSession/);

  // Four buttons now share the header, so they are smaller than the default icon button.
  assert.match(styles, /\.project-actions \.icon-button \{/);
  assert.match(styles, /\.recent-sessions-list/);
});

test("the recents dialog can be searched", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
  ]);

  assert.match(html, /id="recentSessionsSearchInput"[^>]*data-testid="recent-sessions-search-input"/);
  assert.match(app, /recentSessionsSearchInput: document\.querySelector\("#recentSessionsSearchInput"\)/);
  assert.match(app, /normalizedQuery\(elements\.recentSessionsSearchInput\.value \|\| ""\)/);
  assert.match(app, /elements\.recentSessionsSearchInput\.addEventListener\("input", \(\) => renderRecentSessionsDialog\(\)\)/);

  // A stale query must not survive a reopen.
  const start = app.indexOf("function openRecentSessions()");
  const end = app.indexOf("\n}", start);
  assert.ok(start >= 0, "Missing openRecentSessions");
  assert.match(app.slice(start, end), /elements\.recentSessionsSearchInput\.value = ""/);
});

test("the first ten recents are numbered and open with a digit key", async () => {
  const [app, styles] = await Promise.all([
    appSource(),
    readFile("public/styles.css", "utf8"),
  ]);

  // The rule itself lives in the shared list-shortcuts module; the recents list
  // installs its rows into it and draws the same chip as every other list.
  assert.match(app, /import \{ attachDigitShortcuts, LIST_SHORTCUT_LIMIT, shortcutIndexBadge \} from "\.\/list-shortcuts\.js";/);
  assert.match(app, /recentSessionShortcuts\.push\(entry\)/);
  assert.match(app, /shortcutIndexBadge\("recent-session-index", recentSessionShortcuts\.length\)/);
  assert.match(styles, /\.recent-sessions-list \.session-card \{[^}]*padding-left: 38px;/);
  assert.match(styles, /\.list-shortcut-index \{/);

  // The digit must reach the list, not the search field the user is typing in,
  // and a digit opens that row through the dialog's own open path.
  assert.match(app, /attachDigitShortcuts\(elements\.recentSessionsDialog, \(\) => recentSessionShortcuts, \(entry\) => openRecentSession\(entry\)\.catch\(\(error\) => toast\(error\.message\)\)\)/);

  // Search is ready for typing as soon as the dialog opens.
  assert.match(app, /elements\.recentSessionsSearchInput\.focus\(\)/);
});

test("a global shortcut opens the recents dialog", async () => {
  const app = await appSource();

  // The app has more than one document-level keydown handler now, so this finds the
  // one that owns the recents chord rather than whichever comes first in the bundle.
  const start = app.lastIndexOf('document.addEventListener("keydown"', app.indexOf("openRecentSessions();"));
  const end = app.indexOf("\n});", start);
  assert.ok(start >= 0, "Missing global keydown handler");
  const handler = app.slice(start, end);
  assert.match(handler, /chordMatches\(chord, event\)/);
  assert.match(handler, /openRecentSessions\(\)/);
});

test("the recents list leaves room for the focus ring", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  // The rows scroll inside the list, so a 2px outline offset needs padding or it is clipped.
  assert.match(styles, /\.recent-sessions-list \{[^}]*padding: 3px;/);
});

test("every recent conversations button draws the same clock icon", async () => {
  const html = await readFile("public/index.html", "utf8");

  // The chat toolbar icon is the reference; the panel headers must not drift from it.
  const iconPaths = (id: string): string[] => {
    const start = html.indexOf(`id="${id}"`);
    assert.ok(start >= 0, `${id} is missing`);
    const button = html.slice(start, html.indexOf("</button>", start));
    return [...button.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1]);
  };

  const reference = iconPaths("chatRecentSessionsButton");
  assert.equal(reference.length, 3, "the reference icon should be three paths");
  for (const id of ["recentSessionsButton", "chatsRecentSessionsButton"]) {
    assert.deepEqual(iconPaths(id), reference, `${id} draws a different recents icon`);
  }
});

test("the recents dialog shows one row per conversation, dated by its latest message", async () => {
  const app = await appSource();

  // Resuming on another node copies the transcript under a different project dir, so the
  // file name is the conversation's identity — the full path is not.
  assert.match(app, /function recentSessionKey\(entry\)/);
  assert.match(app, /function mergeRecentSessions\(entries\)/);

  // Writing a recent replaces every stored copy of the same conversation.
  const remember = app.slice(app.indexOf("function rememberRecentSession(session)"));
  assert.match(remember.slice(0, remember.indexOf("\n}")), /recentSessionKey\(candidate\) !== recentSessionKey\(entry\)/);

  // Forgetting drops the whole group, so a stale copy cannot resurface.
  const forget = app.slice(app.indexOf("function forgetRecentSession(entry)"));
  assert.match(forget.slice(0, forget.indexOf("\n}")), /recentSessionKey\(candidate\) !== recentSessionKey\(entry\)/);

  // The row is sorted and dated by the newest activity across the merged copies.
  const render = app.slice(app.indexOf("function renderRecentSessionsDialog()"));
  assert.match(render.slice(0, render.indexOf("\n}\n")), /mergeRecentSessions\(state\.recentSessions\)/);
  assert.match(app, /const byActivity = \[\.\.\.mergeRecentSessions\(state\.recentSessions\)\]\.sort\(/);

  // Listing and opening match copies too, so a merged row still resolves to a live session.
  const apply = app.slice(app.indexOf("function applyRecentSessionActivity(sessionsByProject)"));
  assert.match(apply.slice(0, apply.indexOf("\n}")), /sessionRecentKey\(candidate\) === recentSessionKey\(entry\)/);
  const open = app.slice(app.indexOf("async function openRecentSession(entry)"));
  assert.match(open.slice(0, open.indexOf("\n}")), /sessionRecentKey\(candidate\) === recentSessionKey\(entry\)/);
});
