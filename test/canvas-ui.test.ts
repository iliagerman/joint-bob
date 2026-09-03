import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canvas is a desktop row view over exact existing conversations", async () => {
  const [html, app, canvas, styles, server, preferences] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/canvas.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("src/preferences.ts", "utf8"),
  ]);

  // Global launcher sits on its own full-width row under the search + add-project row.
  assert.match(html, /project-search-row[\s\S]{0,900}project-create-button[\s\S]{0,40}<\/div>\s*<div class="project-canvas-row">\s*<button class="canvas-launch" id="openCanvasButton"[\s\S]*?<svg[\s\S]*?<rect x="3\.5" y="3\.5"/);
  assert.match(styles, /\.project-canvas-row \.canvas-launch \{ width: 100%; \}/);
  assert.doesNotMatch(html, /canvas-launch-row/);
  assert.match(styles, /\.canvas-launch \{[\s\S]*?flex: none;[\s\S]*?min-height: 40px;[\s\S]*?padding: 0 12px;/);
  assert.match(html, /id="canvasPanel"/);
  assert.match(html, /id="canvasRoot"[^>]*data-testid="canvas-root"/);
  assert.match(html, /id="canvasConversationDialog"/);
  assert.match(html, /id="canvasProjectSelect"/);
  assert.match(html, /id="canvasSessionSearch"/);
  assert.match(html, /id="canvasSplitPosition"/);
  assert.doesNotMatch(html, /Exit Canvas|Close Canvas/);

  // Desktop-only: shown in the wide layout, absent from narrow navigation.
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*body\.view-canvas #canvasPanel \{ display: flex; \}/);
  assert.match(styles, /@media \(max-width: 1023px\) \{\n  \.collapse-button \{ display: none; \}/);
  assert.match(styles, /#settingsButton, #openBoardButton, #openCanvasButton, \.project-canvas-row, #canvasPanel \{ display: none; \}/);
  assert.match(styles, /body\.canvas-pane-mode #chatPanel \{ display: flex !important;/);

  // The pane frame reuses normal chat lifecycle and skips shell background work.
  assert.match(app, /canvasPaneMode: bootParams\.get\("canvasPane"\) === "1"/);
  assert.match(app, /initialSessionId: bootParams\.get\("sessionId"\)/);
  assert.match(app, /initialNodeId: bootParams\.get\("nodeId"\)/);
  assert.match(app, /if \(state\.canvasPaneMode\) return;/);
  assert.match(app, /view === "canvas" && matchMedia\("\(max-width: 1023px\)"\)\.matches/);
  assert.match(app, /if \(state\.authenticated && !state\.canvasPaneMode\) startProjectSyncPolling\(\)/);

  // Every iframe carries the exact conversation and execution-node identity.
  assert.match(canvas, /url\.searchParams\.set\("canvasPane", "1"\)/);
  assert.match(canvas, /url\.searchParams\.set\("projectId", pane\.projectId\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionPath", session\.path\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionId", pane\.sessionId\)/);
  assert.match(canvas, /if \(session\.executionNodeId\) url\.searchParams\.set\("nodeId", session\.executionNodeId\)/);
  assert.doesNotMatch(canvas, /localStorage|sessionStorage|transferSession|cloneSession|new-session/);

  // Dragged row heights are pinned, so the canvas scrolls instead of squashing them.
  assert.match(styles, /\.canvas-root \{[\s\S]*?display: grid;[\s\S]*?overflow: auto;/);
  assert.match(canvas, /row\.height \? `\$\{row\.height\}px` : `minmax\(\$\{CANVAS_MIN_ROW_HEIGHT\}px, 1fr\)`/);
  assert.match(canvas, /for \(const direction of \["left", "right", "up", "down"\]\)/);
  assert.match(canvas, /moveCanvasPane\(layout, pane\.id, direction\)/);
  assert.doesNotMatch(canvas, /canvas-split|setCanvasSplitRatio|swapCanvasPanes/);

  // Panes are permanent direct root children. Layout changes are style-only.
  assert.match(canvas, /root\.append\(element\)/);
  assert.match(canvas, /element\.style\.gridRow/);
  assert.match(canvas, /element\.style\.gridColumn/);
  assert.match(canvas, /const headerSlot = element\.children\.length > 1 \? element\.children\[1\] : null;/);
  assert.match(canvas, /if \(!body\.isConnected \|\| body\.parentElement !== element\) element\.append\(body\)/);
  assert.doesNotMatch(canvas, /function deactivate[\s\S]{0,200}replaceChildren/);
  assert.match(styles, /\.canvas-root\.canvas-focused \.canvas-pane:not\(\.focused\) \{ display: none; \}/);

  // Organize rebuilds the grid; keyboard bindings live with the account, not the node.
  assert.match(html, /id="canvasOrganizeButton"[^>]*data-testid="canvas-organize-button"/);
  assert.match(html, /id="canvasShortcutBar"[^>]*data-testid="canvas-shortcut-bar"/);
  assert.match(html, /id="canvasShortcutDialog"[^>]*data-testid="canvas-shortcut-dialog"/);
  assert.match(canvas, /commit\(organizeCanvasLayout\(layout\)\)/);
  assert.match(canvas, /`\/api\/canvas\/shortcuts\/\$\{encodeURIComponent\(binding\)\}`/);
  assert.match(canvas, /class="canvas-shortcut-badge"|canvas-shortcut-badge/);
  assert.match(styles, /\.canvas-shortcut-bar \{/);
  assert.match(styles, /\.canvas-pane\.canvas-revealed \{/);
  // A pane swallows the keystroke, so it forwards only the keys the canvas claims.
  assert.match(app, /type: "canvasShortcut", code: event\.code/);
  assert.match(app, /event\.data\?\.type === "canvasShortcutBindings"/);
  assert.match(app, /event\.data\?\.type === "canvasFocusComposer"/);
  assert.match(canvas, /publishBindings\(\)/);
  assert.match(server, /app\.put\("\/api\/canvas\/shortcuts\/:binding"/);
  assert.match(server, /app\.delete\("\/api\/canvas\/shortcuts\/:binding"/);

  // Picker remains readable and can start a brand-new pane conversation.
  assert.match(styles, /#canvasConversationDialog \.dialog-card \{ width: min\(720px/);
  // Rows keep their full height: a flex column with flex:none options, and block
  // option layout so the subtitle's -webkit-box line clamp survives.
  assert.match(styles, /\.canvas-session-options \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(styles, /\.canvas-session-option \{[\s\S]*?display: block;[\s\S]*?flex: none;/);
  assert.match(styles, /\.canvas-session-option strong \{[\s\S]*?display: block;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(styles, /\.canvas-session-option span \{[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(canvas, /`canvas-start-conversation-\$\{harness\.id\}`/);
  assert.match(canvas, /sessionPath: `draft:\$\{harness\.id\}:\$\{sessionId\}`/);

  // Width and height handles work with pointer or keyboard and persist their geometry.
  assert.match(canvas, /setPointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /setCanvasRowBoundary/);
  assert.match(canvas, /setCanvasRowHeight/);
  assert.match(styles, /\.canvas-resize \{[\s\S]*?cursor: col-resize;/);
  assert.match(styles, /\.canvas-row-resize \{[\s\S]*?cursor: row-resize;/);
  assert.match(preferences, /weights: number\[\]/);
  assert.match(preferences, /height: number \| null/);
  assert.match(app, /state\.canvasLayoutSave = \(state\.canvasLayoutSave \?\? Promise\.resolve\(\)\)/);

  // Narrow assistant turns still give fenced code the conversation width.
  assert.match(styles, /\.message\.assistant \{[^}]*width: 100%;[^}]*max-width: 100%;/);

  // Malformed deep legacy layouts are bounded; only pane documents may frame.
  assert.match(server, /function canvasLayoutExceedsLimits\(value: unknown\): boolean/);
  assert.match(server, /request\.path === "\/" && request\.query\.canvasPane === "1" \? "SAMEORIGIN" : "DENY"/);
});

test("the canvas shell ships in the service worker cache", async () => {
  const worker = await readFile("public/sw.js", "utf8");
  assert.match(worker, /const CACHE_NAME = "joint-bob-v103"/);
  assert.match(worker, /"\/canvas\.js"/);
  assert.match(worker, /"\/canvas-layout\.js"/);
});
