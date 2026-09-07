import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource, serverSource } from "./source.js";

test("canvas is a recursive multi-page view over exact existing conversations", async () => {
  const [html, app, canvas, layout, styles, server, preferences] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
    readFile("public/canvas.js", "utf8"),
    readFile("public/canvas-layout.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    serverSource(),
    readFile("src/preferences.ts", "utf8"),
  ]);

  // The shell carries a page strip beside the canvas controls.
  assert.match(html, /id="canvasRoot"[^>]*data-testid="canvas-root"/);
  assert.match(html, /id="canvasPageTabs"[^>]*role="tablist"[^>]*data-testid="canvas-page-tabs"/);
  assert.match(html, /id="canvasPageAddButton"[^>]*data-testid="canvas-page-add-button"/);
  assert.match(html, /id="canvasPageDeleteButton"[^>]*data-testid="canvas-page-delete-button"/);
  assert.match(html, /id="canvasPageMoveLeftButton"/);
  assert.match(html, /id="canvasPageMoveRightButton"/);
  for (const value of ["right", "left", "below", "above"]) assert.match(html, new RegExp(`<option value="${value}"(?: selected)?>`));
  // The leader commands are documented in Settings now, beside every other shortcut.
  assert.match(html, /id="settingsPanel-shortcuts"[\s\S]*split to the right of this conversation/);
  assert.match(html, /<kbd>C<\/kbd> &mdash; new page/);
  assert.match(html, /<kbd>N<\/kbd> or <kbd>P<\/kbd> &mdash; next or previous page/);

  // Layout operations are pure recursive tree transforms over pages.
  assert.match(layout, /export function canvasPageGeometry/);
  assert.match(layout, /export function setCanvasSplitRatio/);
  assert.match(layout, /export function canvasPageForPane/);
  assert.match(layout, /export function canvasPaneNeighbor/);
  assert.match(layout, /export function createCanvasPage/);
  assert.match(layout, /export function moveCanvasPage/);
  assert.match(layout, /CANVAS_MAX_PAGES = 9/);
  assert.match(layout, /CANVAS_MAX_SPLIT_DEPTH = 8/);

  // Every iframe carries the exact conversation and execution-node identity.
  assert.match(canvas, /url\.searchParams\.set\("canvasPane", "1"\)/);
  assert.match(canvas, /url\.searchParams\.set\("projectId", pane\.projectId\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionPath", session\.path\)/);
  assert.match(canvas, /url\.searchParams\.set\("sessionId", session\.id\)/);
  assert.match(canvas, /if \(session\.executionNodeId\) url\.searchParams\.set\("nodeId", session\.executionNodeId\)/);
  assert.doesNotMatch(canvas, /localStorage|sessionStorage|transferSession|cloneSession|new-session/);

  // Panes and separators are permanent direct root children; layout changes are
  // style-only, and the row-grid model is gone from the controller.
  assert.match(canvas, /root\.append\(element\)/);
  assert.match(canvas, /const headerSlot = element\.children\[0\] \|\| null;/);
  assert.match(canvas, /if \(!body\.isConnected \|\| body\.parentElement !== element\) element\.append\(body\)/);
  assert.match(canvas, /node\.element\.style\.gridRow = `\$\{gridLine\(box\.top\)\} \/ \$\{gridLine\(box\.bottom\)\}`;/);
  assert.doesNotMatch(canvas, /layout\.rows|setCanvasRow|clearCanvasRow|rowSeparator|boundaryStrip|canvas-row-resize/);
  assert.doesNotMatch(canvas, /function deactivate[\s\S]{0,200}replaceChildren/);

  // Split handles drag with a live preview and commit once, clamped by the layout.
  assert.match(canvas, /dataset\.testid = "canvas-split-handle"/);
  assert.match(canvas, /previewLayout = setCanvasSplitRatio\(layout, splitId, ratioFor\(event, drag\.box\)\);/);
  assert.match(canvas, /setPointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(canvas, /box\.ratio \+ \(\["ArrowRight", "ArrowDown"\]\.includes\(event\.key\) \? \.05 : -\.05\)/);

  // Pages answer their controls, and page state is per page, not global.
  assert.match(canvas, /commit\(createCanvasPage\(layout\)\)/);
  assert.match(canvas, /commit\(moveCanvasPage\(layout, layout\.activePageId, "left"\)\)/);
  assert.match(canvas, /commit\(removeCanvasPage\(layout, page\.id\)\)/);
  assert.match(canvas, /let next = setCanvasPageFilter\(layout, projectFilter\.value\);/);
  assert.match(canvas, /const owner = canvasPageForPane\(layout, paneId\);/);

  // The fine grid carries recursive geometry; separators straddle boundary lines.
  assert.match(styles, /\.canvas-root \{[\s\S]*?grid-template-columns: repeat\(1000, minmax\(0, 1fr\)\);[\s\S]*?overflow: hidden;/);
  assert.match(styles, /\.canvas-resize-row \{[\s\S]*?cursor: col-resize;/);
  assert.match(styles, /\.canvas-resize-column \{[\s\S]*?cursor: row-resize;/);
  assert.match(styles, /\.canvas-page-strip \{/);
  assert.doesNotMatch(styles, /\.canvas-row-resize/);
  assert.match(styles, /\.canvas-root\.canvas-focused \.canvas-pane:not\(\.focused\) \{ display: none; \}/);

  // A pane swallows the keystroke, so it forwards only the keys the canvas claims.
  assert.match(app, /type: "canvasShortcut", code: event\.code/);
  assert.match(app, /type: "canvasLeaderShortcut", code: event\.code/);
  assert.match(app, /event\.data\?\.type === "canvasShortcutBindings"/);
  assert.match(app, /event\.data\?\.type === "canvasFocusComposer"/);
  assert.match(canvas, /publishBindings\(\)/);

  // The node bounds every stored tree and re-validates version 6 layouts it reads back.
  assert.match(server, /function canvasLayoutExceedsLimits\(value: unknown\): boolean/);
  assert.match(preferences, /function validStoredCanvasLayout/);
  assert.match(preferences, /version: 6/);
  assert.match(server, /request\.path === "\/" && request\.query\.canvasPane === "1" \? "SAMEORIGIN" : "DENY"/);

  // Keyboard bindings live with the account, not the node.
  assert.match(canvas, /`\/api\/canvas\/shortcuts\/\$\{encodeURIComponent\(binding\)\}`/);
  assert.match(server, /app\.put\("\/api\/canvas\/shortcuts\/:binding"/);
  assert.match(server, /app\.delete\("\/api\/canvas\/shortcuts\/:binding"/);
});

test("canvas panes and boot restore follow switched conversations to their newest segment", async () => {
  const [canvas, selection] = await Promise.all([
    readFile("public/canvas.js", "utf8"),
    readFile("public/app/project-selection.js", "utf8"),
  ]);

  // A conversation that switched harness lists only its newest segment; panes
  // saved against an older segment still resolve to the same conversation.
  assert.match(canvas, /function sessionMatchesPane\(candidate, pane\)/);
  assert.match(canvas, /candidate\.segments\?\.some\(\(segment\) => segment\.sessionId === pane\.sessionId/);
  assert.match(canvas, /url\.searchParams\.set\("sessionId", session\.id\)/);
  assert.match(selection, /session\.segments\?\.some\(\(segment\) => segment\.path === state\.activeSessionPath\)/);
  assert.match(selection, /session\.segments\?\.some\(\(segment\) => segment\.sessionId === state\.activeSessionId\)/);
});

test("the canvas shell ships in the service worker cache", async () => {
  const worker = await readFile("public/sw.js", "utf8");
  assert.match(worker, /const CACHE_NAME = "joint-bob-v137"/);
  assert.match(worker, /"\/canvas\.js"/);
  assert.match(worker, /"\/canvas-layout\.js"/);
});
