import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, canonicalSessionPath, canvasPaneMoves, CANVAS_MIN_PANE_WIDTH,
  CANVAS_MIN_ROW_HEIGHT, emptyCanvasLayout, listCanvasPanes, migrateCanvasLayout,
  moveCanvasPane, normalizeCanvasLayout, organizeCanvasLayout, removeCanvasPane,
  replaceCanvasPane, setCanvasRowBoundary, setCanvasRowHeight, toggleCanvasFocus,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

test("canvas layout operations build rows and remove empty rows", () => {
  const first = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.equal(first.version, 5);
  assert.equal(listCanvasPanes(first).length, 1);
  assert.deepEqual(first.rows[0].panes.map((item) => item.id), ["one"]);
  assert.deepEqual(first.rows[0].weights, [1]);
  assert.equal(first.rows[0].height, null);
  assert.equal(canvasPaneMoves(first, "one").down, false);

  const beside = addCanvasPane(first, pane("two"), "one", "row");
  assert.deepEqual(beside.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"]]);

  const below = addCanvasPane(beside, pane("three"), "one", "column");
  assert.deepEqual(below.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);

  const removed = removeCanvasPane(removeCanvasPane(below, "one"), "two");
  assert.deepEqual(removed.rows.map((row) => row.panes.map((item) => item.id)), [["three"]]);
});

test("pane widths and row heights can be resized without collapsing the grid", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");
  layout = addCanvasPane(layout, pane("three"), "two", "column");

  const rowId = layout.rows[0].id;
  const widened = setCanvasRowBoundary(layout, rowId, 0, 0.7, 0.3);
  assert.deepEqual(widened.rows[0].weights.map((weight) => Math.round(weight * 10) / 10), [0.7, 0.3]);
  assert.equal(widened.rows[0].weights.reduce((sum, weight) => sum + weight, 0), 1,
    "resizing keeps the row filled");

  const clamped = setCanvasRowBoundary(layout, rowId, 0, 0.99, 0.01);
  assert.ok(Math.abs(clamped.rows[0].weights[1] - CANVAS_MIN_PANE_WIDTH) < 1e-9);
  assert.equal(clamped.rows[0].weights.reduce((sum, weight) => sum + weight, 0), 1);
  assert.throws(() => setCanvasRowBoundary(layout, "missing", 0, 0.5, 0.5), /unknown canvas boundary/i);
  assert.throws(() => setCanvasRowBoundary(layout, rowId, 0, Number.NaN, 0.5), /invalid canvas weights/i);

  const taller = setCanvasRowHeight(layout, rowId, 720);
  assert.equal(taller.rows[0].height, 720);
  assert.equal(taller.rows[1].height, null, "resizing one row leaves the other row fluid");
  assert.equal(setCanvasRowHeight(layout, rowId, 1).rows[0].height, CANVAS_MIN_ROW_HEIGHT);
  assert.throws(() => setCanvasRowHeight(layout, "missing", 720), /unknown canvas row/i);
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
  const up = moveCanvasPane(down, "three", "up");
  assert.deepEqual(up.rows.map((row) => row.panes.map((item) => item.id)), [["one", "three"], ["two"]]);
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

test("version 1 split trees migrate into rows that keep reading order", () => {
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
  assert.equal(migrated.version, 5);
  assert.deepEqual(migrated.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);
  assert.deepEqual(migrated.rows[0].weights, [0.5, 0.5]);
  assert.equal(migrated.focusedPaneId, "two");
});

test("stored canvas versions migrate to resizable rows", () => {
  const v3 = normalizeCanvasLayout({
    version: 3,
    rows: [{ id: "row-a", height: 900, weights: [0.5, 0.2], panes: [pane("one"), pane("two")] }],
    focusedPaneId: null,
  });
  assert.equal(v3.version, 5);
  assert.equal(v3.rows[0].height, 900);
  assert.deepEqual(v3.rows[0].weights.map((weight) => Math.round(weight * 10) / 10), [0.7, 0.3]);

  const v4 = normalizeCanvasLayout({
    version: 4,
    rows: [{ id: "row-b", panes: [pane("one"), pane("two")] }],
    focusedPaneId: null,
  });
  assert.equal(v4.version, 5);
  assert.deepEqual(v4.rows[0].weights, [0.5, 0.5]);
  assert.equal(v4.rows[0].height, null);

  const current = { version: 5, rows: [{ id: "row-c", height: 500, weights: [1], panes: [pane("one")] }], focusedPaneId: null };
  assert.equal(normalizeCanvasLayout(current), current, "a version 5 layout is already current");
});

test("organize reflows every pane into an even grid", () => {
  let layout = emptyCanvasLayout();
  for (let index = 1; index <= 6; index += 1) {
    const id = `pane-${index}`;
    layout = index === 1 ? addCanvasPane(layout, pane(id)) : addCanvasPane(layout, pane(id), `pane-${index - 1}`, "column");
  }

  const organized = organizeCanvasLayout(toggleCanvasFocus(layout, "pane-3"));
  assert.equal(organized.focusedPaneId, null, "organizing shows the whole grid it just built");
  assert.deepEqual(organized.rows.map((row) => row.panes.map((item) => item.id)),
    [["pane-1", "pane-2", "pane-3"], ["pane-4", "pane-5", "pane-6"]]);
  assert.ok(organized.rows.every((row) => row.height === null));
  assert.ok(organized.rows.every((row) => row.weights.every((weight) => Math.abs(weight - 1 / 3) < 1e-9)));

  const seven = addCanvasPane(organized, pane("pane-7"), "pane-6", "column");
  const regridded = organizeCanvasLayout(seven);
  assert.deepEqual(regridded.rows.map((row) => row.panes.length), [3, 3, 1]);
  assert.equal(organizeCanvasLayout(emptyCanvasLayout()).rows.length, 0);
});
