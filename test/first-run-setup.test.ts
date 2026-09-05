import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("first-run form shows only username and owner-selected password", async () => {
  const [html, script, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /id="loginPasswordLabel"/);
  assert.match(script, /elements\.loginPasswordLabel\.hidden = state\.setupRequired/);
  assert.match(script, /elements\.loginPasswordInput\.required = !state\.setupRequired/);
  assert.match(script, /applyAuthStatus\(\{ authenticated: true, setupRequired: false, \.\.\.response \}\)/);
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
