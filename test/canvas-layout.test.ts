import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, canonicalSessionPath, canvasPaneMoves, CANVAS_MAX_ROW_HEIGHT, CANVAS_MIN_PANE_WIDTH,
  CANVAS_MIN_ROW_HEIGHT, emptyCanvasLayout, listCanvasPanes, migrateCanvasLayout, moveCanvasPane,
  normalizeCanvasLayout, organizeCanvasLayout, removeCanvasPane, replaceCanvasPane, setCanvasPaneWidth,
  setCanvasRowHeight, toggleCanvasFocus,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});
const rowTotal = (row) => row.weights.reduce((sum, weight) => sum + weight, 0);

test("canvas layout operations build rows and remove empty rows", () => {
  const first = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.equal(first.version, 3);
  assert.equal(listCanvasPanes(first).length, 1);
  assert.deepEqual(first.rows[0].panes.map((item) => item.id), ["one"]);
  // A fresh row has no pinned height: it shares the canvas until the user drags it.
  assert.equal(first.rows[0].height, null);
  assert.deepEqual(first.rows[0].weights, [1]);
  assert.equal(canvasPaneMoves(first, "one").down, false);

  const beside = addCanvasPane(first, pane("two"), "one", "row");
  assert.deepEqual(beside.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"]]);
  assert.deepEqual(beside.rows[0].weights, [0.5, 0.5]);

  const below = addCanvasPane(beside, pane("three"), "one", "column");
  assert.deepEqual(below.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);

  const removed = removeCanvasPane(removeCanvasPane(below, "one"), "two");
  assert.deepEqual(removed.rows.map((row) => row.panes.map((item) => item.id)), [["three"]]);
});

test("a pane owns its own width, so shrinking one leaves the row unfilled", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");

  const narrow = setCanvasPaneWidth(layout, layout.rows[0].id, 1, 0.2);
  assert.deepEqual(narrow.rows[0].weights, [0.5, 0.2]);
  assert.equal(Math.round(rowTotal(narrow.rows[0]) * 1000) / 1000, 0.7);

  // A pane can never be narrower than the floor, nor overflow past the row's end.
  const floored = setCanvasPaneWidth(narrow, narrow.rows[0].id, 1, 0.001);
  assert.equal(floored.rows[0].weights[1], CANVAS_MIN_PANE_WIDTH);
  const capped = setCanvasPaneWidth(narrow, narrow.rows[0].id, 1, 0.9);
  assert.equal(capped.rows[0].weights[1], 0.5);
  assert.equal(rowTotal(capped.rows[0]), 1);

  assert.throws(() => setCanvasPaneWidth(layout, "missing", 0, 0.5), /unknown canvas pane width/i);
  assert.throws(() => setCanvasPaneWidth(layout, layout.rows[0].id, 5, 0.5), /unknown canvas pane width/i);
  assert.throws(() => setCanvasPaneWidth(layout, layout.rows[0].id, 0, Number.NaN), /invalid canvas width/i);

  // A pane added to a row that is already full shrinks the others to make room.
  const third = addCanvasPane(layout, pane("three"), "two", "row");
  assert.equal(Math.round(rowTotal(third.rows[0]) * 1000) / 1000, 1);
  assert.deepEqual(third.rows[0].weights.map((weight) => Math.round(weight * 1000) / 1000), [0.333, 0.333, 0.333]);

  // A pane added to a row with spare room keeps every existing width untouched.
  const intoGap = addCanvasPane(narrow, pane("four"), "two", "row");
  assert.deepEqual(intoGap.rows[0].weights.map((weight) => Math.round(weight * 1000) / 1000), [0.5, 0.2, 0.3]);
});

test("making room for a new pane never squeezes another below the floor", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");
  const rowId = layout.rows[0].id;
  layout = setCanvasPaneWidth(layout, rowId, 0, CANVAS_MIN_PANE_WIDTH);
  layout = setCanvasPaneWidth(layout, rowId, 1, 0.87);

  // The row is nearly full and one pane already sits on the floor.
  const crowded = addCanvasPane(layout, pane("three"), "two", "row");
  assert.ok(crowded.rows[0].weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH),
    `every pane stays above the floor: ${crowded.rows[0].weights.join(", ")}`);
  assert.ok(rowTotal(crowded.rows[0]) <= 1 + 1e-9, "the row never overflows");

  // Moving a pane into that row obeys the same floor.
  let target = addCanvasPane(emptyCanvasLayout(), pane("a"));
  target = addCanvasPane(target, pane("b"), "a", "row");
  target = setCanvasPaneWidth(target, target.rows[0].id, 0, 0.9);
  target = addCanvasPane(target, pane("c"), "a", "column");
  const moved = moveCanvasPane(target, "c", "up");
  assert.ok(moved.rows[0].weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH));
  assert.ok(rowTotal(moved.rows[0]) <= 1 + 1e-9);
});

test("row heights are stored per row and clamped to a usable range", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "column");
  const rowId = layout.rows[0].id;

  const taller = setCanvasRowHeight(layout, rowId, 900);
  assert.equal(taller.rows[0].height, 900);
  assert.equal(taller.rows[1].height, null, "resizing one row leaves the others alone");

  assert.equal(setCanvasRowHeight(layout, rowId, 10).rows[0].height, CANVAS_MIN_ROW_HEIGHT);
  assert.equal(setCanvasRowHeight(layout, rowId, 99999).rows[0].height, CANVAS_MAX_ROW_HEIGHT);
  assert.throws(() => setCanvasRowHeight(layout, "missing", 400), /unknown canvas row/i);
  assert.throws(() => setCanvasRowHeight(layout, rowId, Number.NaN), /invalid canvas row height/i);

  // A pane pushed into a brand-new row starts unpinned, whatever it came from.
  let pair = addCanvasPane(emptyCanvasLayout(), pane("left"));
  pair = addCanvasPane(pair, pane("right"), "left", "row");
  pair = setCanvasRowHeight(pair, pair.rows[0].id, 900);
  const split = moveCanvasPane(pair, "right", "down");
  assert.equal(split.rows[0].height, 900);
  assert.equal(split.rows[1].height, null);
});

test("the canvas rejects duplicate identities and enforces row limits", () => {
  const layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.throws(() => addCanvasPane(layout, pane("dupe", "one"), "one", "row"), /already on the canvas/i);
  assert.throws(() => addCanvasPane(layout, pane("conflict", "other", "/tmp/one.sync-conflict-x.jsonl"), "one", "row"), /already on the canvas/i);
  assert.throws(() => addCanvasPane(layout, pane("two"), "missing", "row"), /unknown canvas pane/i);
  assert.throws(() => addCanvasPane(layout, pane("two"), "one", "diagonal"), /unknown placement/i);

  let fullRow = layout;
  for (let index = 2; index <= 8; index += 1) fullRow = addCanvasPane(fullRow, pane(`pane-${index}`), "one", "row");
  assert.throws(() => addCanvasPane(fullRow, pane("nine"), "one", "row"), /at most eight/i);
  assert.ok(fullRow.rows[0].weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH), "eight panes still fit above the floor");

  let tenRows = layout;
  let target = "one";
  for (let index = 2; index <= 10; index += 1) {
    const id = `row-${index}`;
    tenRows = addCanvasPane(tenRows, pane(id), target, "column");
    target = id;
  }
  assert.equal(tenRows.rows.length, 10);
  assert.throws(() => addCanvasPane(tenRows, pane("row-11"), target, "column"), /at most ten rows/i);
});

test("directional movement, replace, and focus preserve identities", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");
  layout = addCanvasPane(layout, pane("three"), "one", "column");

  assert.deepEqual(canvasPaneMoves(layout, "two"), { left: true, right: false, up: false, down: true });
  const left = moveCanvasPane(layout, "two", "left");
  assert.deepEqual(left.rows[0].panes.map((item) => item.id), ["two", "one"]);
  const down = moveCanvasPane(layout, "two", "down");
  assert.deepEqual(down.rows.map((row) => row.panes.map((item) => item.id)), [["one"], ["two", "three"]]);
  assert.ok(rowTotal(down.rows[1]) <= 1, "a pane arriving in a row never overflows it");
  const up = moveCanvasPane(down, "three", "up");
  assert.deepEqual(up.rows.map((row) => row.panes.map((item) => item.id)), [["one", "three"], ["two"]]);
  assert.ok(rowTotal(up.rows[0]) <= 1);
  assert.throws(() => moveCanvasPane(layout, "one", "left"), /cannot move/i);

  const replaced = replaceCanvasPane(layout, "two", pane("fresh"));
  assert.equal(replaced.rows[0].panes[1].id, "two");
  assert.equal(replaced.rows[0].panes[1].sessionId, "fresh");
  assert.throws(() => replaceCanvasPane(layout, "two", pane("one")), /already on the canvas/i);

  assert.equal(toggleCanvasFocus(layout, "two").focusedPaneId, "two");
  assert.equal(toggleCanvasFocus(toggleCanvasFocus(layout, "two"), "two").focusedPaneId, null);
  assert.throws(() => toggleCanvasFocus(layout, "missing"), /unknown canvas pane/i);
  assert.equal(canonicalSessionPath("/tmp/a.sync-conflict-20260901-x.jsonl"), "/tmp/a.jsonl");
});

test("version 1 split trees migrate into preserved rows", () => {
  const legacy = {
    version: 1,
    root: {
      kind: "split", id: "vertical", axis: "column", ratio: 0.5,
      first: { kind: "split", id: "horizontal", axis: "row", ratio: 0.85, first: pane("one"), second: pane("two") },
      second: pane("three"),
    },
    focusedPaneId: "two",
  };
  const migrated = migrateCanvasLayout(legacy);
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);
  assert.equal(migrated.rows[0].weights[0], 0.85);
  assert.equal(migrated.rows[0].height, null);
  assert.equal(migrated.focusedPaneId, "two");
});

test("version 2 rows migrate their shared weights into per-pane widths", () => {
  const stored = {
    version: 2,
    rows: [{ id: "row-a", weights: [3, 1], panes: [pane("one"), pane("two")] }],
    focusedPaneId: null,
  };
  const migrated = normalizeCanvasLayout(stored);
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.rows[0].weights, [0.75, 0.25]);
  assert.equal(migrated.rows[0].height, null);
  assert.equal(normalizeCanvasLayout(migrated), migrated, "a version 3 layout is already current");

  // Lopsided legacy weights must still leave every pane a usable width.
  const lopsided = normalizeCanvasLayout({
    version: 2,
    rows: [{ id: "row-b", weights: [1e9, 1, 1], panes: [pane("one"), pane("two"), pane("three")] }],
    focusedPaneId: null,
  });
  assert.ok(lopsided.rows[0].weights.every((weight) => weight >= CANVAS_MIN_PANE_WIDTH));
  assert.equal(Math.round(rowTotal(lopsided.rows[0]) * 1000) / 1000, 1);
});

test("organize reflows every pane into an even grid", () => {
  let layout = emptyCanvasLayout();
  for (let index = 1; index <= 6; index += 1) {
    const id = `pane-${index}`;
    layout = index === 1 ? addCanvasPane(layout, pane(id)) : addCanvasPane(layout, pane(id), `pane-${index - 1}`, "column");
  }
  layout = setCanvasRowHeight(layout, layout.rows[0].id, 900);
  layout = setCanvasPaneWidth(layout, layout.rows[1].id, 0, 0.3);

  const organized = organizeCanvasLayout(toggleCanvasFocus(layout, "pane-3"));
  assert.equal(organized.focusedPaneId, null, "organizing shows the whole grid it just built");
  assert.deepEqual(organized.rows.map((row) => row.panes.map((item) => item.id)),
    [["pane-1", "pane-2", "pane-3"], ["pane-4", "pane-5", "pane-6"]]);
  assert.ok(organized.rows.every((row) => row.height === null), "organizing unpins every row");
  assert.ok(organized.rows.every((row) => row.weights.every((weight) => Math.abs(weight - 1 / 3) < 1e-9)),
    "every pane gets the same share of its row");

  // Reading order is preserved and the last row keeps the same column widths.
  const seven = addCanvasPane(organized, pane("pane-7"), "pane-6", "column");
  const regridded = organizeCanvasLayout(seven);
  assert.deepEqual(regridded.rows.map((row) => row.panes.length), [3, 3, 1]);
  assert.equal(regridded.rows[2].weights[0], 1 / 3, "a short last row keeps the grid's column width");
  assert.equal(organizeCanvasLayout(emptyCanvasLayout()).rows.length, 0);
});
