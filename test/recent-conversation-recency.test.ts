import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("recents are ordered by the conversation's own activity, not by when it was opened", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function recentSessionActivityAt\(entry\)/);
  const render = functionBody(app, "function renderRecentSessionsDialog() {");
  assert.match(render, /recentSessionActivityAt\(right\)[\s\S]*?localeCompare[\s\S]*?recentSessionActivityAt\(left\)/);
  // The row's own timestamp shows that same activity time.
  assert.match(render, /formatDate\(recentSessionActivityAt\(entry\)\)/);
  assert.ok(!render.includes("formatDate(entry.openedAt)"), "the row still shows the open time");
});

test("an opened conversation records its latest activity, and the list keeps it fresh", async () => {
  const app = await readFile("public/app.js", "utf8");

  const remember = functionBody(app, "function rememberRecentSession(session) {");
  assert.match(remember, /updatedAt: session\.updatedAt \?\? session\.createdAt \?\? null/);

  // Conversations move on while the recents dialog is closed, so the stored time
  // is refreshed from every session-list render.
  assert.match(app, /function syncRecentSessionActivity\(\)/);
  const apply = functionBody(app, "function applyRecentSessionActivity(sessionsByProject) {");
  assert.match(apply, /sessions\.find/);
  const renderSessions = functionBody(app, "function renderSessions() {");
  assert.match(renderSessions, /syncRecentSessionActivity\(\);/);
});

test("opening the recents dialog refreshes activity for every project it lists", async () => {
  const app = await readFile("public/app.js", "utf8");

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
  const server = await readFile("src/server.ts", "utf8");

  assert.match(preferences, /interface RecentSession \{[\s\S]*?updatedAt: string \| null;/);
  // Without a schema field the activity time is stripped on save and the list falls back to the open time.
  assert.match(server, /recentSessions: z\.array\(z\.object\(\{[\s\S]*?updatedAt: z\.string\(\)\.max\(40\)\.nullable\(\)\.default\(null\)/);
});
