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

test("a project row menu finds its button again after the rows are rebuilt", async () => {
  const app = await readFile("public/app.js", "utf8");
  const row = functionBody(app, "function projectRow(project) {");

  // renderProjects replaces every row about once a second while an agent streams,
  // so the button the menu was opened from is gone; the id on the row is how the
  // menu finds the fresh one instead of closing itself.
  assert.match(row, /row\.dataset\.projectId = project\.id;/);
  assert.match(row, /openRowMenu\(menuButton, projectMenuItems\(project\), `\[data-project-id="\$\{CSS\.escape\(project\.id\)\}"\] \[data-testid="project-menu-button"\]`\)/);
});

test("a conversation row menu finds its button again after the rows are rebuilt", async () => {
  const app = await readFile("public/app.js", "utf8");
  const render = functionBody(app, "function renderSessions() {");

  assert.match(render, /row\.dataset\.sessionPath = session\.path;/);
  assert.match(render, /openRowMenu\(menuButton, sessionMenuItems\(session, sessionActive\), `\[data-session-path="\$\{CSS\.escape\(session\.path\)\}"\] \[data-testid="session-menu-button"\]`\)/);
});

test("the sidebar lists keep their scroll position across a background rebuild", async () => {
  const app = await readFile("public/app.js", "utf8");
  const keep = functionBody(app, "function keepListScroll(container) {");

  assert.match(keep, /const top = container\.scrollTop;/);
  assert.match(keep, /queueMicrotask\(\(\) => \{\s*container\.scrollTop = top;/);

  // The scroll has to be restored before the menu is re-placed, or the menu is
  // measured against rows that are about to move.
  for (const header of ["function renderProjects() {", "function renderSessions() {"]) {
    const body = functionBody(app, header);
    assert.ok(
      body.indexOf("keepListScroll(") < body.indexOf("queueMicrotask(refreshRowMenuAnchor)"),
      `${header} re-places the row menu before it restores the scroll`,
    );
    assert.ok(
      body.indexOf("keepListScroll(") < body.indexOf(".replaceChildren()"),
      `${header} empties the list before it reads the scroll position`,
    );
  }
});

test("the chat dropdowns are only rebuilt when their options change", async () => {
  const app = await readFile("public/app.js", "utf8");
  const sync = functionBody(app, "function syncSelectOptions(select, options) {");
  const render = functionBody(app, "function renderChatSessionControls() {");

  // Replacing the options of an open <select> closes it, and a running agent
  // refreshes these controls about once a second.
  assert.match(sync, /select\.dataset\.optionsSignature === signature\) return;/);
  assert.match(sync, /select\.dataset\.optionsSignature = signature;/);
  assert.match(render, /syncSelectOptions\(elements\.chatNodeSelect,/);
  assert.match(render, /syncSelectOptions\(elements\.chatHarnessSelect,/);
  assert.doesNotMatch(render, /elements\.chat(Node|Harness)Select\.replaceChildren\(\)/);
});
