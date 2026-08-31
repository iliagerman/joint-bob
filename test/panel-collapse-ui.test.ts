import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("both side panels collapse to a rail that can always be re-expanded", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // A collapse control in each panel bar, and a rail that carries the way back.
  assert.match(html, /data-testid="projects-panel-collapse-button"/);
  assert.match(html, /data-testid="chats-panel-collapse-button"/);
  assert.match(html, /data-testid="projects-panel-expand-button"/);
  assert.match(html, /data-testid="chats-panel-expand-button"/);
  assert.match(html, /class="panel-rail"/);

  // Collapsing is driven by body classes over grid custom properties, so the
  // mobile single-panel layout is untouched.
  assert.match(styles, /--col-projects/);
  assert.match(styles, /--col-chats/);
  assert.match(styles, /grid-template-columns: var\(--col-projects\) var\(--col-chats\) minmax\(0, 1fr\);/);
  // The width override must land on `.shell` itself: `.shell` declares the
  // custom properties, so a body-level override is shadowed by that own
  // declaration and the panel never actually narrows.
  assert.match(styles, /body\.projects-collapsed \.shell \{ --col-projects: 46px; \}/);
  assert.match(styles, /body\.chats-collapsed \.shell \{ --col-chats: 46px; \}/);
  assert.match(styles, /\.panel-rail \{/);
  // The base rule must not hide the control: it sits after the desktop media
  // query with the same specificity, so a `display: none` there wins everywhere.
  assert.match(styles, /\n\.collapse-button \{/);
  // Chevrons are drawn as SVG so they sit centred in the button box, and the
  // control carries a visible outline instead of a bare low-contrast glyph.
  assert.match(styles, /\.collapse-button \{[^}]*border-color: var\(--line\)/);
  assert.doesNotMatch(html, /collapse-button[^>]*>\u2039</);
  assert.doesNotMatch(html, /panel-expand-button"[^>]*>\u203a</);
  assert.match(styles, /@media \(max-width: 1023px\) \{\n  \.collapse-button \{ display: none; \}/);

  assert.match(app, /function setPanelCollapsed\(panel, collapsed\)/);
  assert.match(app, /projectsPanelCollapsed/);
  assert.match(app, /chatsPanelCollapsed/);
  // Collapse state lives on the server with every other preference.
  assert.match(app, /savePreferencesInBackground\(\{ projectsPanelCollapsed/);
  assert.match(app, /savePreferencesInBackground\(\{ chatsPanelCollapsed/);
  assert.doesNotMatch(app, /\.setItem\(/);
});
