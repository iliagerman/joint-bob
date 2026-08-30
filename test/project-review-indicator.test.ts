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
