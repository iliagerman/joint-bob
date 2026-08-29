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

test("every row menu item carries an icon", async () => {
  const app = await readFile("public/app.js", "utf8");

  for (const header of [
    "function projectMenuItems(project) {",
    "function sessionMenuItems(session, sessionActive) {",
  ]) {
    const body = functionBody(app, header);
    const icons = body.match(/icon: "/g)?.length ?? 0;
    const testids = body.match(/testid: "/g)?.length ?? 0;
    assert.ok(testids > 0, `${header} has no menu items`);
    assert.equal(icons, testids, `${header} has ${testids} items but only ${icons} icons`);
  }
});

test("the menu renders each icon as an inline svg before the label", async () => {
  const app = await readFile("public/app.js", "utf8");

  // The codebase never uses innerHTML, so icons are built as real SVG nodes.
  assert.match(app, /function menuIcon\(name\)/);
  assert.match(app, /document\.createElementNS\("http:\/\/www\.w3\.org\/2000\/svg", "svg"\)/);
  assert.doesNotMatch(app, /innerHTML/);
  // Icon first, label second, inside the menu button.
  assert.match(app, /entry\.append\(menuIcon\(item\.icon\), label\);/);
  // Decorative, so it stays out of the accessible name.
  assert.match(app, /svg\.setAttribute\("aria-hidden", "true"\)/);
});

test("every icon name a menu item asks for is defined", async () => {
  const app = await readFile("public/app.js", "utf8");

  const defined = functionBody(app, "const rowMenuIconPaths = {");
  for (const match of app.matchAll(/icon: "([a-z-]+)"/g)) {
    assert.ok(defined.includes(`${match[1]}:`), `rowMenuIconPaths is missing "${match[1]}"`);
  }
});

test("menu rows lay out as icon plus label", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.match(styles, /\.row-menu button \{[\s\S]*?display: flex;[\s\S]*?align-items: center;[\s\S]*?gap: 10px;/);
  assert.match(styles, /\.row-menu-icon \{[^}]*width: 16px;[^}]*height: 16px;[^}]*flex: none;/);
});
