import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the send button is a coloured send icon", async () => {
  const [html, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  const send = /<button class="send"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

  assert.match(send, /data-testid="chat-send-button"/);
  assert.match(send, /aria-label="Send"/);
  assert.match(send, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(send, /↑/);
  assert.match(styles, /\.send \{[^}]*background: var\(--accent\);[^}]*\}/);
  assert.match(styles, /\.send svg \{[^}]*width: 20px;[^}]*\}/);
});

test("a global menu reaches settings from every page and names the node and release", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // It lives inside .shell so the boot overlay hides it along with the rest of the app.
  const shell = html.slice(html.indexOf('<div class="shell">'), html.indexOf('<nav class="mobile-nav"'));
  assert.ok(shell.includes('id="appMenu"'), "the app menu must sit inside the shell");
  assert.match(html, /<details class="app-menu" id="appMenu">/);
  assert.match(html, /data-testid="app-menu-button"/);
  assert.match(html, /aria-label="App menu"/);
  assert.match(html, /id="appMenuNode"[^>]*data-testid="app-menu-node"/);
  assert.match(html, /id="appMenuVersion"[^>]*data-testid="app-menu-version"/);
  assert.match(html, /id="appMenuSettingsButton"[^>]*data-testid="app-menu-settings-button"/);

  assert.match(app, /api\("\/api\/cluster\/node"\)/);
  assert.match(app, /api\("\/api\/health"\)/);
  assert.match(app, /function loadAppMenuDetails\(\)/);
  assert.match(app, /elements\.appMenuSettingsButton\.addEventListener\("click"[\s\S]*openSettings\(\)/);

  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?\.app-menu \{[^}]*display: block;/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?padding: 10px 52px 10px 12px;/);
  // The bottom bar already reaches both, so the header drops them on mobile.
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*?#settingsButton, #openBoardButton \{ display: none; \}/);
});

test("the bottom bar puts Current beside Chats and Board on the far right", async () => {
  const html = await readFile("public/index.html", "utf8");
  const nav = html.slice(html.indexOf('<nav class="mobile-nav"'), html.indexOf("</nav>"));
  const order = [...nav.matchAll(/id="(nav[A-Za-z]+Button)"/g)].map((match) => match[1]);

  assert.deepEqual(order, [
    "navProjectsButton",
    "navSessionsButton",
    "navChatButton",
    "navReviewsButton",
    "navBoardButton",
  ]);
  assert.match(nav, /data-testid="nav-chat-button"[\s\S]*?<\/span>Current<\/button>/);
});

test("the chat header shows a traffic light, an icon Stop, and the project name", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(styles, /\.status-pill \{[^}]*border-radius: 999px;[^}]*background: var\(--danger\);[^}]*\}/);
  assert.match(styles, /\.status-pill\.live \{[^}]*background: var\(--live\);/);
  assert.match(styles, /\.status-pill\.connecting \{[^}]*background: var\(--amber\);/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?\.status-pill\.live, \.status-pill\.connecting \{ animation: none; \}/);
  assert.match(app, /elements\.connectionStatus\.title = text;/);

  const abort = /<button[^>]*id="abortButton"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  assert.match(abort, /class="ghost icon-button danger"/);
  assert.match(abort, /aria-label="Stop"/);
  assert.match(abort, /<svg[^>]*aria-hidden="true"/);

  assert.match(styles, /\.chat-project-name \{[^}]*display: block;/);

  const updateStart = app.indexOf("function updateStatus(status)");
  const updateBody = app.slice(updateStart, app.indexOf("\n}", updateStart));
  assert.ok(updateStart >= 0, "Missing updateStatus");
  // state.activeModelLabel still needs status.model.label, but no header line
  // renders the provider/model text any more.
  assert.doesNotMatch(updateBody, /const model = status\.model/);
});

test("the copy button sits outside the message bubble", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(app, /bubble\.after\(actions\);/);
  assert.doesNotMatch(app, /bubble\.append\(actions\);/);
  assert.match(styles, /\.message\.assistant \+ \.message-actions \{/);

  // The bubble must already be in the list before its sibling actions are inserted.
  const appendStart = app.indexOf("function appendMessage(");
  const appendBody = app.slice(appendStart, app.indexOf("\n}", appendStart));
  assert.ok(
    appendBody.indexOf("elements.messages.insertBefore(bubble") < appendBody.indexOf("appendCopyButton(bubble)"),
    "appendMessage must insert the bubble before appending its actions",
  );
});
