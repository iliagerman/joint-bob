import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("model dialog changes Pi thinking and Claude effort", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="modelDialogReasoning"/);
  assert.match(html, /id="reasoningLevelSelect"/);
  assert.match(html, /data-testid="chat-reasoning-select"/);
  assert.match(app, /availableThinkingLevels:\s*status\.availableThinkingLevels/);
  assert.match(app, /sendSocket\(\{ type: "setThinking", level:/);
  assert.match(app, /sendSocket\(\{ type: "setEffort", effort:/);
});

test("mobile chat controls use a fixed grid and More menu", async () => {
  const [html, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  const mobileStyles = /@media \(max-width: 1023px\)\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1];

  assert.match(html, /<details\b[^>]*id="chatMoreMenu"[^>]*>[\s\S]*?<summary\b[^>]*data-testid="chat-more-button"[^>]*>[\s\S]*?<\/summary>[\s\S]*?<\w+\b[^>]*class="[^"]*\bchat-more-actions\b[^"]*"[^>]*>[\s\S]*?<\/\w+>[\s\S]*?<\/details>/);
  assert.ok(mobileStyles, "mobile styles must define a max-width: 1023px section");
  assert.match(mobileStyles, /\.chat-toolbar[^\{]*\{[^}]*display:\s*grid[^}]*overflow(?:-x)?:\s*visible/);
  assert.doesNotMatch(styles, /\.chat-toolbar[^\{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v30";/);
});
