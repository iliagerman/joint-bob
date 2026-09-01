import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, canonicalSessionPath, canvasPaneMoves, emptyCanvasLayout, listCanvasPanes,
  migrateCanvasLayout, moveCanvasPane, removeCanvasPane, replaceCanvasPane,
  setCanvasRowBoundary, toggleCanvasFocus,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

test("canvas layout operations build rows and remove empty rows", () => {
  const first = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.equal(listCanvasPanes(first).length, 1);
  assert.deepEqual(first.rows[0].panes.map((item) => item.id), ["one"]);
  assert.equal(canvasPaneMoves(first, "one").down, false);

  const beside = addCanvasPane(first, pane("two"), "one", "row");
  assert.deepEqual(beside.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"]]);
  assert.deepEqual(beside.rows[0].weights, [1, 1]);

  const below = addCanvasPane(beside, pane("three"), "one", "column");
  assert.deepEqual(below.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);

  const removed = removeCanvasPane(removeCanvasPane(below, "one"), "two");
  assert.deepEqual(removed.rows.map((row) => row.panes.map((item) => item.id)), [["three"]]);
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

test("directional movement, replace, focus, and resize preserve identities", () => {
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

  const resized = setCanvasRowBoundary(layout, layout.rows[0].id, 0, 100, 0.1);
  const total = resized.rows[0].weights[0] + resized.rows[0].weights[1];
  assert.equal(resized.rows[0].weights[0] / total, 0.85);
  assert.throws(() => setCanvasRowBoundary(layout, "missing", 0, 1, 1), /unknown canvas boundary/i);
  assert.throws(() => setCanvasRowBoundary(layout, layout.rows[0].id, 0, 1e308, 1e308), /invalid canvas weights/i);
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
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);
  assert.equal(migrated.rows[0].weights[0] / migrated.rows[0].weights.reduce((sum, weight) => sum + weight, 0), 0.85);
  assert.equal(migrated.focusedPaneId, "two");
});
