import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("projects and conversations can be pinned to the top of their list", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(app, /testid: "project-pin-button"/);
  assert.match(app, /testid: "session-pin-button"/);
  assert.match(app, /button\.dataset\.testid = testid;/);
  assert.match(app, /function isProjectPinned\(projectId\)/);
  assert.match(app, /function isSessionPinned\(session\)/);
  assert.match(app, /function togglePinnedProject\(projectId\)/);
  assert.match(app, /function togglePinnedSession\(session\)/);
  assert.match(app, /onToggle: \(\) => togglePinnedSession\(session\)/);

  // Pinned projects float inside their own type group, so the type grouping survives.
  assert.match(app, /function sortPinnedFirst\(/);
  assert.match(app, /savePreferencesInBackground\(\{ pinnedProjectIds/);
  assert.match(app, /savePreferencesInBackground\(\{ pinnedSessionPaths/);
  assert.doesNotMatch(app, /\.setItem\(/);

  assert.match(styles, /\.pin-button\.pinned/);

  // Pinning is a quick action on the row itself in both lists, so the inline text
  // marker is gone everywhere — the button is the indicator.
  assert.doesNotMatch(styles, /strong::after \{[^}]*content: "\u{1F4CC}"/u);
});

test("a pinned conversation survives the recency cap on the session list", async () => {
  const harnesses = await readFile("src/harnesses.ts", "utf8");

  // The cap keeps the list fast, but a pinned conversation must never fall off it.
  assert.match(harnesses, /pinnedSessionPaths/);
  assert.match(harnesses, /pinnedSessionIds/);
  assert.match(harnesses, /pinnedIds\.has\(`\$\{session\.harnessId\}:\$\{session\.id\}`\)/);
});

test("pinned ids and panel collapse round-trip through the preferences API", async () => {
  const [preferences, server] = await Promise.all([
    readFile("src/preferences.ts", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  for (const field of ["pinnedProjectIds", "pinnedSessionPaths", "projectsPanelCollapsed", "chatsPanelCollapsed"]) {
    assert.ok(preferences.includes(field), `preferences.ts is missing ${field}`);
    assert.ok(server.includes(field), `server.ts is missing ${field}`);
  }

  // Added with the same guarded ALTER TABLE recipe the other late columns use.
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN pinned_project_ids TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN pinned_session_paths TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN projects_panel_collapsed INTEGER NOT NULL DEFAULT 0/);
  assert.match(preferences, /ALTER TABLE user_preferences ADD COLUMN chats_panel_collapsed INTEGER NOT NULL DEFAULT 0/);
});

test("every conversation and project row carries the same pin quick action", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // Pinning is one tap on the row in both lists, and both build the identical button.
  assert.match(app, /function sessionPinToggle\(session\)/);
  assert.match(app, /function projectPinToggle\(project\)/);
  assert.equal(app.match(/row\.append\(button, pinToggle, menuButton\);/g)?.length, 2);
  // ...so neither overflow menu offers pinning any more.
  assert.doesNotMatch(app, /testid: "session-unpin-button"/);

  // Two permanent buttons need two permanent lanes in both lists.
  assert.match(styles, /\.session-list \.pin-button, \.project-list \.pin-button \{ right: 42px; \}/);
  assert.match(styles, /\.session-list \.session-card, \.project-list \.project-card \{ padding-right: 78px; \}/);

  // On phones both buttons grow to a real touch target, so the lanes widen with them.
  assert.match(styles, /\.session-list \.pin-button, \.project-list \.pin-button \{ min-height: 34px; min-width: 34px; width: 34px; right: 48px; \}/);
  assert.match(styles, /\.session-list \.session-card, \.project-list \.project-card \{ padding-right: 90px; \}/);
});
