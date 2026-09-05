import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the toolbar owns one Pi Thinking or Claude Effort control", async () => {
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

  assert.match(toolbar, /<label class="chat-control chat-mode-control" id="chatModeControl" for="reasoningLevelSelect" hidden>/);
  assert.match(toolbar, /<span id="chatModeLabel">Thinking<\/span>[\s\S]*id="reasoningLevelSelect" class="chat-toolbar-control" aria-labelledby="chatModeLabel" data-testid="chat-reasoning-select"/);
  assert.doesNotMatch(dialog, /reasoningLevelSelect|modelDialogReasoning/);
  for (const id of ["chatNodeSelect", "chatHarnessSelect", "modelButton", "reasoningLevelSelect"]) {
    assert.match(toolbar, new RegExp(`<(?:select|button)(?=[^>]*id="${id}")(?=[^>]*class="[^"]*chat-toolbar-control)[^>]*>`));
  }
  assert.ok(toolbar.indexOf('id="chatRecentSessionsButton"') > toolbar.indexOf('id="chatModeControl"'));
  assert.ok(toolbar.indexOf('id="chatMoreMenu"') > toolbar.indexOf('id="chatRecentSessionsButton"'));

  assert.match(app, /chatModeLabel: document\.querySelector\("#chatModeLabel"\)/);
  assert.match(app, /function renderReasoningOptions\(\)[\s\S]*chatModeLabel\.textContent = state\.engine === "claude" \? "Effort" : "Thinking"[\s\S]*reasoningLevelSelect\.replaceChildren\(\)/);
  assert.doesNotMatch(app, /mobileReasoningLevelSelect|modelDialogReasoning|modelButtonMode/);
  assert.match(app, /function changeReasoningLevel\(event\)[\s\S]*event\.currentTarget\.value[\s\S]*setEffort[\s\S]*setThinking/);
  assert.equal([...app.matchAll(/elements\.reasoningLevelSelect\.addEventListener\("change", changeReasoningLevel\)/g)].length, 1);
});

test("model buttons are name-only and mobile controls use fixed toolbar rows", async () => {
  const [html, app, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  const titleMetaStart = html.indexOf('<div class="chat-title-meta">');
  const titleMetaEnd = html.indexOf("</div>", titleMetaStart);
  const syncStart = app.indexOf("function syncModelButton()");
  const syncEnd = app.indexOf("\n}", syncStart);

  assert.ok(titleMetaStart >= 0, "Missing chat title meta");
  assert.match(html.slice(titleMetaStart, titleMetaEnd), /id="chatProjectName"[^>]*data-testid="chat-project-name"/);
  assert.match(html, /<details\b[^>]*id="chatMoreMenu"[^>]*>[\s\S]*?<summary\b[^>]*data-testid="chat-more-button"/);
  assert.match(html, /id="modelButtonName">Model<\/span><\/button>/);
  assert.doesNotMatch(html, /modelButtonMode/);
  assert.ok(syncStart >= 0, "Missing syncModelButton");
  assert.doesNotMatch(app.slice(syncStart, syncEnd), /thinkingLevel|claudeEffort/);

  assert.match(styles, /#chatsRecentSessionsButton, #chatRecentSessionsButton \{ display: none; \}/);
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*?#chatsRecentSessionsButton, #chatRecentSessionsButton \{ display: none !important; \}/);
  assert.doesNotMatch(styles, /@media \(min-width: 1024px\)[\s\S]*?#chatModeControl\s*\{\s*display: none !important;/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?#chatsRecentSessionsButton \{ display: inline-grid; \}[\s\S]*?#chatRecentSessionsButton \{ display: inline-flex; \}/);

  // The mobile recents button is a flex box, so it needs explicit centring for its icon.
  const recentsRule = /\.chat-recents-button, \.chat-more > summary \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(recentsRule, /align-items: center;/);
  assert.match(recentsRule, /justify-content: center;/);
  assert.match(styles, /\.chat-model-control\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/);
  assert.match(styles, /\.chat-mode-control\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/);
  assert.match(styles, /\.chat-recents-button\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*2;/);
  assert.doesNotMatch(styles, /\.model-button-mode/);
  assert.doesNotMatch(styles, /\.chat-toolbar[^\{]*\{[^}]*overflow-x:\s*auto/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v112";/);
});

test("the status light and Stop sit on the chat header's meta row", async () => {
  const [html, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  const metaStart = html.indexOf('<div class="chat-title-meta">');
  const metaEnd = html.indexOf("</div>\n            </div>", metaStart);
  assert.ok(metaStart >= 0 && metaEnd >= 0, "Missing chat title meta row");
  const meta = html.slice(metaStart, metaEnd);

  assert.match(meta, /<div class="chat-actions">[\s\S]*id="connectionStatus"[\s\S]*id="abortButton"/);
  assert.ok(meta.indexOf('id="taskBacklinkButton"') < meta.indexOf('class="chat-actions"'));

  assert.match(styles, /\.chat-title-meta \{[^}]*align-items: center;/);
  assert.match(styles, /\.chat-actions \{[^}]*margin-left: auto;/);
  // The node/thinking/message-count line is gone; the status pill carries state.
  assert.doesNotMatch(html, /miniStatus/);
  assert.doesNotMatch(styles, /\.mini-status/);
});
