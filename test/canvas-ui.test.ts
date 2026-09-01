import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("canvas is a desktop view over the exact existing conversations", async () => {
  const [html, app, canvas, styles, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/canvas.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  // Surfaces and controls, with no dedicated exit action.
  assert.match(html, /id="openCanvasButton"[\s\S]*?data-testid="projects-open-canvas-button"/);
  // The launch button is a global control below the project search, with an icon.
  assert.match(html, /project-search-row[\s\S]{0,900}canvas-launch-row[\s\S]*?id="openCanvasButton"[\s\S]*?<svg[\s\S]*?<rect x="3\.5" y="3\.5"/);
  assert.match(html, /id="canvasPanel"/);
  assert.match(html, /id="canvasRoot"[^>]*data-testid="canvas-root"/);
  assert.match(html, /id="canvasConversationDialog"/);
  assert.match(html, /id="canvasProjectSelect"/);
  assert.match(html, /id="canvasSessionSearch"/);
  assert.match(html, /id="canvasSplitPosition"/);
  assert.doesNotMatch(html, /Exit Canvas|Close Canvas/);

  // Desktop-only: shown in the wide layout, hidden on narrow viewports.
  assert.match(styles, /@media \(min-width: 1024px\)[\s\S]*body\.view-canvas #canvasPanel \{ display: flex; \}/);
  assert.match(styles, /@media \(max-width: 1023px\) \{\n  \.collapse-button \{ display: none; \}/);
  assert.match(styles, /#settingsButton, #openBoardButton, #openCanvasButton, #canvasPanel \{ display: none; \}/);
  // The launch row sits under the search and carries the accent treatment.
  assert.match(styles, /\.canvas-launch \{[\s\S]*?color-mix\(in srgb, var\(--accent\) 12%, var\(--panel\)\)/);
  // A lone pane or split fills the whole canvas, not half of it.
  assert.match(styles, /\.canvas-root > \.canvas-pane,\n\.canvas-root > \.canvas-split,\n\.canvas-root > \.canvas-empty \{ flex: 1; min-width: 0; min-height: 0; \}/);
  assert.match(styles, /body\.canvas-pane-mode #chatPanel \{ display: flex !important;/);

  // The pane frame reuses the normal chat lifecycle and never writes preferences.
  assert.match(app, /canvasPaneMode: bootParams\.get\("canvasPane"\) === "1"/);
  assert.match(app, /initialSessionId: bootParams\.get\("sessionId"\)/);
  assert.match(app, /initialNodeId: bootParams\.get\("nodeId"\)/);
  assert.match(app, /if \(state\.canvasPaneMode\) return;/);
  assert.match(app, /canvasController\?\.setLayout/);
  assert.match(app, /view === "canvas" && matchMedia\("\(max-width: 1023px\)"\)\.matches/);
  assert.match(app, /state\.canvasController\?\.activate\(\)/);

  // Every pane iframe points at one existing session with its full identity.
  assert.match(canvas, /const body = await api\(`\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/sessions`\)/);
  assert.match(canvas, /url\.searchParams\.set\("canvasPane", "1"\)/);
  assert.match(canvas, /url\.searchParams\.set\("projectId", pane\.projectId\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionPath", session\.path\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionId", session\.id\)/);
  assert.match(canvas, /if \(session\.executionNodeId\) url\.searchParams\.set\("nodeId", session\.executionNodeId\)/);
  assert.doesNotMatch(canvas, /localStorage|sessionStorage|transferSession|cloneSession|new-session/);

  // The picker can also open a pane on a conversation that does not exist yet: the
  // canvas mints the identity, the pane document creates it on its own node.
  assert.match(canvas, /`canvas-start-conversation-\$\{harness\.id\}`/);
  assert.match(canvas, /sessionPath: `draft:\$\{harness\.id\}:\$\{sessionId\}`/);
  assert.match(app, /if \(state\.canvasPaneMode && state\.activeSessionPath\?\.startsWith\("draft:"\)\)/);
  assert.match(app, /addOptimisticSession\(state\.activeSessionId, harness\.newSessionPath, title, null\)/);

  // Long conversation titles are trimmed in the picker instead of overflowing it.
  assert.match(styles, /\.canvas-session-option strong, \.canvas-session-option span \{[^}]*text-overflow: ellipsis;/);

  // Resizing is accessible and drag commits only the clamped ratio.
  assert.match(canvas, /setPointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /setAttribute\("role", "separator"\)/);
  assert.match(canvas, /aria-valuenow/);
  assert.match(canvas, /searchInput\.addEventListener\("input", renderPickerOptions\)/);

  // Frames survive layout changes: panes are keyed and reused, resize and focus
  // never rerender the tree, and deactivation keeps the hidden frames alive.
  assert.match(canvas, /const paneNodes = new Map\(\)/);
  assert.match(canvas, /commit\(setCanvasSplitRatio\(layout, split\.id, dragRatio\)\);[\s\S]*?applySplitStyle\(grid, split, dragRatio\);/);
  assert.doesNotMatch(canvas, /function deactivate[\s\S]{0,200}replaceChildren/);
  // Header refreshes replace only the header child; the frame body stays attached.
  assert.match(canvas, /element\.firstElementChild\.replaceWith\(header\)/);
  assert.match(canvas, /if \(!body\.isConnected \|\| body\.parentElement !== element\) element\.append\(body\)/);
  assert.match(styles, /\.canvas-root\.canvas-focused \.canvas-split \{ display: contents; \}/);

  // Preference writes are serialized so rapid resizes persist newest-last, and
  // pane frames skip the parent shell's background polling and discovery.
  assert.match(app, /state\.canvasLayoutSave = \(state\.canvasLayoutSave \?\? Promise\.resolve\(\)\)/);
  assert.match(app, /if \(state\.authenticated && !state\.canvasPaneMode\) startProjectSyncPolling\(\)/);

  // A pathologically nested layout is rejected before recursive schema parsing.
  assert.match(server, /function canvasLayoutExceedsLimits\(value: unknown\): boolean/);

  // Only the pane document may be framed, and only by its same-origin parent.
  assert.match(server, /request\.path === "\/" && request\.query\.canvasPane === "1" \? "SAMEORIGIN" : "DENY"/);
});

test("the canvas shell ships in the service worker cache", async () => {
  const worker = await readFile("public/sw.js", "utf8");
  assert.match(worker, /const CACHE_NAME = "joint-bob-v81"/);
  assert.match(worker, /"\/canvas\.js"/);
  assert.match(worker, /"\/canvas-layout\.js"/);
});
