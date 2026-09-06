import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, arrangeCanvasLayout, canvasPageGeometry, canvasPaneNeighbor, createCanvasPage,
  emptyCanvasLayout, listCanvasPagePanes, listCanvasPanes, moveCanvasPage, moveCanvasPane,
  normalizeCanvasLayout, removeCanvasPane, removeCanvasPage, selectCanvasPage, setCanvasPageFilter,
  setCanvasSplitRatio,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id) => ({ kind: "pane", id, projectId: "project", sessionId, sessionPath: `/tmp/${sessionId}.jsonl`, executionNodeId: null });

test("nested geometry is local and removing collapses its parent", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("a"));
  layout = addCanvasPane(layout, pane("b"), "a", "right");
  layout = addCanvasPane(layout, pane("c"), "b", "below");
  const boxes = canvasPageGeometry(layout).panes;
  assert.equal(boxes.get("a").top, 0);
  assert.equal(boxes.get("a").bottom, 1);
  assert.equal(boxes.get("b").right, 1);
  assert.equal(boxes.get("c").left, .5);
  layout = removeCanvasPane(layout, "c");
  assert.equal(canvasPageGeometry(layout).splits.size, 1);
});

test("split ratios clamp and geometric moves swap pane positions, ids follow their conversations", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("a"));
  layout = addCanvasPane(layout, pane("b"), "a", "right");
  const split = [...canvasPageGeometry(layout).splits.keys()][0];
  layout = setCanvasSplitRatio(layout, split, 99);
  assert.equal(canvasPageGeometry(layout).splits.get(split).ratio, .85);
  assert.equal(canvasPaneNeighbor(layout, "a", "right"), "b");
  layout = moveCanvasPane(layout, "a", "right");
  assert.deepEqual(listCanvasPagePanes(layout).map((item) => item.id), ["b", "a"],
    "the moving pane keeps its id and takes the other slot");
  assert.equal(listCanvasPagePanes(layout).find((item) => item.id === "a").sessionId, "a");
});

test("pages create, select, move, delete, and filter independently", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("a"));
  layout = createCanvasPage(layout);
  const second = layout.activePageId;
  layout = addCanvasPane(layout, pane("b", "b"));
  layout = setCanvasPageFilter(layout, "project");
  assert.equal(listCanvasPagePanes(layout).length, 1);
  layout = moveCanvasPage(layout, second, "left");
  assert.equal(layout.pages[0].id, second);
  layout = removeCanvasPage(layout, second);
  assert.equal(listCanvasPanes(layout)[0].id, "a");
  assert.equal(selectCanvasPage(layout, layout.activePageId).version, 6);
});

test("duplicate conversations and page limits are rejected", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("a"));
  assert.throws(() => addCanvasPane(layout, pane("b", "a")), /already on the canvas/);
  for (let index = 0; index < 8; index += 1) layout = createCanvasPage(layout);
  assert.throws(() => createCanvasPage(layout), /at most nine/);
});

test("v1 roots and weighted v5 rows migrate to v6", () => {
  const root = { kind: "split", id: "split", axis: "row", ratio: .3, first: pane("a"), second: pane("b") };
  assert.equal(normalizeCanvasLayout({ version: 1, root, focusedPaneId: "a" }).pages[0].root.ratio, .3);
  const layout = normalizeCanvasLayout({ version: 5, rows: [{ panes: [pane("a"), pane("b")], weights: [.25, .75] }], focusedPaneId: null });
  assert.equal(layout.pages[0].root.ratio, .25);
});

test("legacy layouts that break the v6 limits spread over pages of eight", () => {
  // Ten stacked rows would nest eleven splits deep; the migration must still land
  // inside the depth limit.
  const rowsOf = (count, perRow = 1) => Array.from({ length: count }, (_, index) =>
    ({ panes: Array.from({ length: perRow }, (_, slot) => pane(`pane-${index}-${slot}`)) }));
  const tenRows = normalizeCanvasLayout({ version: 5, rows: rowsOf(10), focusedPaneId: "pane-9-0" });
  assert.equal(tenRows.pages.length, 2, "ten single-pane rows become two pages");
  assert.equal(tenRows.pages[0].root.kind, "split");
  assert.equal(tenRows.pages[0].focusedPaneId, null, "focus on a later page's pane does not stay on page one");
  assert.equal(tenRows.pages[1].focusedPaneId, "pane-9-0", "focus follows its pane onto its own page");

  const eighteen = normalizeCanvasLayout({ version: 5, rows: rowsOf(3, 6), focusedPaneId: "pane-0-0" });
  assert.equal(eighteen.pages.length, 3);
  assert.deepEqual(eighteen.pages.map((page) => listCanvasPagePanes(eighteen, page.id).length), [8, 8, 2]);
  assert.equal(eighteen.pages[0].focusedPaneId, "pane-0-0", "focus survives when its pane is on page one");
  assert.deepEqual(listCanvasPanes(eighteen).slice(0, 3).map((item) => item.id),
    ["pane-0-0", "pane-0-1", "pane-0-2"], "reading order survives the spread");

  const oversize = normalizeCanvasLayout({ version: 5, rows: rowsOf(10, 8), focusedPaneId: "pane-9-7" });
  assert.equal(oversize.pages.length, 9, "the canvas holds at most nine pages");
  assert.equal(listCanvasPanes(oversize).length, 72, "overflow panes are dropped, conversations are not");
  assert.equal(oversize.pages.every((page) => listCanvasPagePanes(oversize, page.id).length <= 8), true);
});

test("arrange affects only the active page", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("a"));
  layout = addCanvasPane(layout, pane("b"), "a");
  layout = createCanvasPage(layout);
  const second = layout.activePageId;
  layout = addCanvasPane(layout, pane("c"));
  layout = selectCanvasPage(layout, layout.pages.find((page) => page.id !== second).id);
  layout = arrangeCanvasLayout(layout, ["b", "a"]);
  assert.deepEqual(listCanvasPagePanes(layout, second).map((item) => item.id), ["c"]);
});
