import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("recents are ordered by the conversation's own activity, not by when it was opened", async () => {
  const app = await appSource();

  assert.match(app, /function recentSessionActivityAt\(entry\)/);
  const render = functionBody(app, "function renderRecentSessionsDialog() {");
  assert.match(render, /recentSessionActivityAt\(right\)[\s\S]*?localeCompare[\s\S]*?recentSessionActivityAt\(left\)/);
  // The row's own timestamp shows that same activity time.
  assert.match(render, /formatDate\(recentSessionActivityAt\(entry\)\)/);
  assert.ok(!render.includes("formatDate(entry.openedAt)"), "the row still shows the open time");
});

test("an opened conversation records its latest activity, and the list keeps it fresh", async () => {
  const app = await appSource();

  const remember = functionBody(app, "function rememberRecentSession(session) {");
  assert.match(remember, /updatedAt: session\.updatedAt \?\? session\.createdAt \?\? null/);

  // Conversations move on while the recents dialog is closed, so the stored time
  // is refreshed from every session-list render.
  assert.match(app, /function syncRecentSessionActivity\(\)/);
  const apply = functionBody(app, "function applyRecentSessionActivity(sessionsByProject) {");
  assert.match(apply, /sessions\.find/);
  assert.match(apply, /const changedEntries = \[\];/);
  assert.match(apply, /changedEntries\.push\(changed\)/);
  assert.match(apply, /for \(const entry of changedEntries\) saveRecentSessionInBackground\(entry\)/);
  assert.doesNotMatch(apply, /for \(const entry of state\.recentSessions\) saveRecentSessionInBackground\(entry\)/);
  const renderSessions = functionBody(app, "function renderSessions() {");
  assert.match(renderSessions, /syncRecentSessionActivity\(\);/);
});

test("opening the recents dialog refreshes activity for every project it lists", async () => {
  const app = await appSource();

  // Only the active project's conversations are in memory, so the other projects are asked directly.
  const refresh = functionBody(app, "async function refreshRecentSessionActivity() {");
  assert.match(refresh, /state\.recentSessions\.map\(\(entry\) => entry\.projectId\)/);
  assert.match(refresh, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/sessions/);
  assert.match(refresh, /applyRecentSessionActivity/);
  assert.match(refresh, /renderRecentSessionsDialog\(\)/);

  const open = functionBody(app, "function openRecentSessionsDialog() {");
  assert.match(open, /refreshRecentSessionActivity\(\)/);
});

test("the recents preference carries the conversation's activity time", async () => {
  const preferences = await readFile("src/preferences.ts", "utf8");
  const server = await serverSource();

  assert.match(preferences, /interface RecentSession \{[\s\S]*?updatedAt: string \| null;/);
  // Recents moved to the replicated table; the preferences schema no longer carries them.
  assert.match(server, /export const userPreferencesSchema = z\.object\(\{[\s\S]*?\}?\)\.strict\(\)/);
  assert.doesNotMatch(server, /recentSessions: z\.array/);
});
