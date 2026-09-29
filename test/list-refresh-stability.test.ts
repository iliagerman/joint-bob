import assert from "node:assert/strict";
import test from "node:test";
import { appSource } from "./source.js";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("the sidebar lists keep their scroll position across a background rebuild", async () => {
  const app = await appSource();
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
  const app = await appSource();
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
