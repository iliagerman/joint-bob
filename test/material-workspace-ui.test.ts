import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace exposes a responsive professional visual system", async () => {
  const [html, app, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(html, /name="theme-color" content="#f2f2f0"/);
  assert.match(styles, /--accent:\s*#0e8a74/);
  assert.match(styles, /--surface:\s*#ffffff/);
  assert.match(styles, /:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*--col-projects: clamp\(274px, 18vw, 320px\);[\s\S]*--col-chats: clamp\(300px, 20vw, 356px\);[\s\S]*grid-template-columns: var\(--col-projects\) var\(--col-chats\) minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*\.list-row:is\(:hover, :focus-within\)[\s\S]*\.row-action-button[^{]*\{[^}]*opacity:\s*1/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.mobile-nav[^{]*\{[^}]*bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
  assert.match(styles, /\.mobile-nav button[^{]*\{[^}]*min-height:\s*48px/);
  assert.match(app, /transferButton\.className = "ghost icon-button row-action-button transfer-button"/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.project-list \.list-row:not\(\.active\) \.row-action-button[^{]*\{[^}]*display:\s*none/);
  assert.match(app, /isDark \? "#0d0e10" : "#f2f2f0"/);
  assert.match(serviceWorker, /joint-bob-v\d+/);
});
