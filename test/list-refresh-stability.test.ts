import assert from "node:assert/strict";
import test from "node:test";
import { keepListScroll } from "../public/app/list-scroll.js";
import { appSource } from "./source.js";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

/** A list that loses its position on every rebuild, as Safari's does: 1800 becomes 1034. */
function rebuiltList(top: number) {
  return { scrollTop: top, rebuild() { this.scrollTop = Math.min(this.scrollTop, 1034); } };
}

test("a list rebuilt twice before the restore returns to where the reader left it", async () => {
  const list = rebuiltList(1800);
  // Selecting a project redraws the projects, then the conversations redraw them again.
  keepListScroll(list);
  list.rebuild();
  keepListScroll(list);
  list.rebuild();
  await Promise.resolve();
  assert.equal(list.scrollTop, 1800);

  // After the restore, the next refresh keeps the position the reader scrolled to since.
  list.scrollTop = 1500;
  keepListScroll(list);
  list.rebuild();
  await Promise.resolve();
  assert.equal(list.scrollTop, 1500);
});

test("the sidebar lists keep their scroll position across a background rebuild", async () => {
  const app = await appSource();

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
