import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("every board menu icon is defined in the shared icon set", async () => {
  const [app, board] = await Promise.all([
    appSource(),
    readFile("public/board.js", "utf8"),
  ]);

  const defined = functionBody(app, "const rowMenuIconPaths = {");
  const items = functionBody(board, "function taskMenuItems(task, handlers) {");
  for (const match of items.matchAll(/icon: "([a-z-]+)"/g)) {
    assert.ok(defined.includes(`${match[1]}:`), `rowMenuIconPaths is missing "${match[1]}"`);
  }
  assert.match(app, /onMenu: \(anchor, items, task\) => openRowMenu\(anchor, items,/);

  // The card's own icon buttons draw from the board's icon set.
  const cardIcons = functionBody(board, "const cardIconPaths = {");
  for (const match of functionBody(board, "function taskCardActions(task, handlers) {").matchAll(/icon: "([a-z-]+)"/g)) {
    assert.ok(cardIcons.includes(`${match[1]}:`), `cardIconPaths is missing "${match[1]}"`);
  }
});

