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

test("a project row shows how many conversations there need review", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function pendingReviewCountForProject\(projectId\)/);
  const row = functionBody(app, "function projectRow(project) {");
  assert.match(row, /pendingReviewCountForProject\(project\.id\)/);
  assert.match(row, /data-testid = "project-review-badge"|dataset\.testid = "project-review-badge"/);
  // The badge names the count for screen readers, not just a bare number.
  assert.match(row, /setAttribute\("aria-label", `\$\{reviewCount\} conversation/);
});

test("the badge refreshes with the cross-project review snapshot", async () => {
  const app = await readFile("public/app.js", "utf8");

  // The inbox is the only source that spans every project, so the project list
  // has to re-render whenever that snapshot changes.
  const refresh = functionBody(app, "async function refreshPendingReviews() {");
  assert.match(refresh, /renderProjects\(\);/);
});

test("the badge is visible against every project row state", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.project-review-badge \{/);
  assert.match(styles, /\.project-review-badge \{[^}]*var\(--amber\)/);
});

test("the open project's badge follows its own conversations, not the slow snapshot", async () => {
  const app = await readFile("public/app.js", "utf8");

  // The inbox snapshot refreshes once a minute; the open project's conversations are live,
  // so a conversation that just finished must show on its project row straight away.
  const count = functionBody(app, "function pendingReviewCountForProject(projectId) {");
  assert.match(count, /state\.activeProjectId/);
  assert.match(count, /reviewableSessions\(\)\.length/);
  // A project switch empties the list before the new one loads; the badge must not flash to zero.
  assert.match(count, /state\.sessionsLoading/);

  // Re-rendering the conversations is what refreshes those badges.
  const render = functionBody(app, "function renderSessions() {");
  assert.match(render, /renderProjects\(\);/);
});

test("the inbox badge counts the open project live too", async () => {
  const app = await readFile("public/app.js", "utf8");

  const total = functionBody(app, "function pendingReviewCount() {");
  assert.match(total, /pendingReviewCountForProject\(/);
});

test("a collapsed project group still shows that something inside needs review", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  const group = functionBody(app, "function projectGroupElement(group) {");
  assert.match(group, /pendingReviewCountForProject\(project\.id\)/);
  assert.match(group, /dataset\.testid = "project-group-review-badge"/);
  assert.match(group, /setAttribute\("aria-label", `\$\{groupReviewCount\} conversation/);

  assert.match(styles, /\.project-group-review-badge \{[^}]*var\(--amber\)/);
  // Open groups show each project's own badge, so the summary must not double up.
  assert.match(styles, /\.project-group\[open\][^{]*\.project-group-review-badge \{ display: none; \}/);
});
