import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("desktop and mobile Mode controls change Pi thinking and Claude effort", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  const toolbarStart = html.indexOf('<div class="chat-toolbar panel-toolbar" id="chatToolbar">');
  const toolbarEnd = html.indexOf('\n        <section class="messages"', toolbarStart);
  const dialogStart = html.indexOf('<dialog id="modelDialog"');
  const dialogEnd = html.indexOf("</dialog>", dialogStart);
  assert.ok(toolbarStart >= 0 && toolbarEnd >= 0, "Missing chat toolbar");
  assert.ok(dialogStart >= 0 && dialogEnd >= 0, "Missing model dialog");
  const toolbar = html.slice(toolbarStart, toolbarEnd);
  const dialog = html.slice(dialogStart, dialogEnd);

  assert.match(dialog, /id="modelDialogReasoning"[\s\S]*id="modelDialogReasoningLabel"[\s\S]*id="reasoningLevelSelect"/);
  assert.match(dialog, /data-testid="chat-reasoning-select"/);
  assert.match(toolbar, /<label class="chat-control chat-mode-control" id="chatModeControl" for="mobileReasoningLevelSelect" hidden>/);
  assert.match(toolbar, /<span>Mode<\/span>[\s\S]*id="mobileReasoningLevelSelect"/);
  assert.match(toolbar, /data-testid="chat-mobile-reasoning-select"/);
  for (const id of ["chatNodeSelect", "chatHarnessSelect", "modelButton", "mobileReasoningLevelSelect"]) {
    assert.match(toolbar, new RegExp(`<(?:select|button)(?=[^>]*id="${id}")(?=[^>]*class="[^"]*chat-toolbar-control)[^>]*>`));
  }
  assert.doesNotMatch(toolbar, /id="mobileReasoningLevelSelect"[^>]*class="[^"]*effort-select/);
  assert.match(dialog, /id="reasoningLevelSelect" class="effort-select"/);
  assert.ok(toolbar.indexOf('id="chatRecentSessionsButton"') > toolbar.indexOf('id="chatModeControl"'));
  assert.ok(toolbar.indexOf('id="chatMoreMenu"') > toolbar.indexOf('id="chatRecentSessionsButton"'));
  assert.match(app, /function populateReasoningSelect\(select\)/);
  assert.match(app, /populateReasoningSelect\(elements\.reasoningLevelSelect\)/);
  assert.match(app, /populateReasoningSelect\(elements\.mobileReasoningLevelSelect\)/);
  assert.match(app, /function changeReasoningLevel\(event\)[\s\S]*event\.currentTarget\.value[\s\S]*setEffort[\s\S]*setThinking/);
  assert.match(app, /elements\.reasoningLevelSelect\.addEventListener\("change", changeReasoningLevel\)/);
  assert.match(app, /elements\.mobileReasoningLevelSelect\.addEventListener\("change", changeReasoningLevel\)/);
  assert.equal([...app.matchAll(/elements\.(reasoningLevelSelect|mobileReasoningLevelSelect)\.addEventListener\("change", changeReasoningLevel\)/g)].length, 2);
  assert.doesNotMatch(app, /elements\.reasoningLevelSelect\.addEventListener\("change", \(\) =>/);
});

test("mobile chat controls use fixed toolbar rows", async () => {
  const [html, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  const titleMetaStart = html.indexOf('<div class="chat-title-meta">');
  const titleMetaEnd = html.indexOf("</div>", titleMetaStart);

  assert.ok(titleMetaStart >= 0, "Missing chat title meta");
  assert.match(html.slice(titleMetaStart, titleMetaEnd), /id="chatProjectName"[^>]*data-testid="chat-project-name"/);
  assert.match(html, /<details\b[^>]*id="chatMoreMenu"[^>]*>[\s\S]*?<summary\b[^>]*data-testid="chat-more-button"/);
  assert.match(styles, /#chatsRecentSessionsButton, #chatRecentSessionsButton \{ display: none; \}/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*?#chatsRecentSessionsButton, #chatRecentSessionsButton, #chatModeControl \{ display: none !important; \}/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?#chatsRecentSessionsButton \{ display: inline-grid; \}[\s\S]*?#chatRecentSessionsButton \{ display: inline-flex; \}/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.chat-more\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1;/);
  assert.match(styles, /\.chat-model-control\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/);
  assert.match(styles, /\.chat-mode-control\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/);
  assert.match(styles, /\.chat-recents-button\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*2;/);
  assert.match(styles, /\.chat-project-name\s*\{\s*display: none;/);
  assert.match(styles, /\.model-button-mode\s*\{ flex: 0 0 auto; \}/);
  assert.match(styles, /\.model-button-mode\s*\{ display: none; \}/);
  assert.match(html, /id="modelButtonName"[\s\S]*id="modelButtonMode"/);
  assert.doesNotMatch(styles, /\.chat-toolbar[^\{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v47";/);
});
