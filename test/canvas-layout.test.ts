import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, canonicalSessionPath, canvasPaneMoves, emptyCanvasLayout, listCanvasPanes,
  migrateCanvasLayout, moveCanvasPane, normalizeCanvasLayout, organizeCanvasLayout,
  removeCanvasPane, replaceCanvasPane, toggleCanvasFocus,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

test("canvas layout operations build rows and remove empty rows", () => {
  const first = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.equal(first.version, 4);
  assert.equal(listCanvasPanes(first).length, 1);
  assert.deepEqual(first.rows[0].panes.map((item) => item.id), ["one"]);
  assert.equal(canvasPaneMoves(first, "one").down, false);

  const beside = addCanvasPane(first, pane("two"), "one", "row");
  assert.deepEqual(beside.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"]]);

  const below = addCanvasPane(beside, pane("three"), "one", "column");
  assert.deepEqual(below.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);

  const removed = removeCanvasPane(removeCanvasPane(below, "one"), "two");
  assert.deepEqual(removed.rows.map((row) => row.panes.map((item) => item.id)), [["three"]]);
});

test("a row carries nothing but its panes, so no pane can own a width or a height", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");
  layout = addCanvasPane(layout, pane("three"), "two", "column");

  for (const row of layout.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "panes"],
      "a grid row stores only its identity and its panes");
  }
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
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);
  assert.equal(migrated.focusedPaneId, "two");
});

test("stored widths and pinned heights are dropped when a layout is read", () => {
  const stored = {
    version: 3,
    rows: [
      { id: "row-a", height: 900, weights: [0.5, 0.2], panes: [pane("one"), pane("two")] },
      { id: "row-b", height: null, weights: [0.3], panes: [pane("three")] },
    ],
    focusedPaneId: null,
  };
  const migrated = normalizeCanvasLayout(stored);
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.rows.map((row) => Object.keys(row).sort()), [["id", "panes"], ["id", "panes"]]);
  assert.deepEqual(migrated.rows.map((row) => row.panes.map((item) => item.id)), [["one", "two"], ["three"]]);

  const v2 = normalizeCanvasLayout({
    version: 2,
    rows: [{ id: "row-c", weights: [3, 1], panes: [pane("one"), pane("two")] }],
    focusedPaneId: null,
  });
  assert.equal(v2.version, 4);
  assert.deepEqual(Object.keys(v2.rows[0]).sort(), ["id", "panes"]);

  const current = { version: 4, rows: [{ id: "row-d", panes: [pane("one")] }], focusedPaneId: null };
  assert.equal(normalizeCanvasLayout(current), current, "a version 4 layout is already current");
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

  const seven = addCanvasPane(organized, pane("pane-7"), "pane-6", "column");
  const regridded = organizeCanvasLayout(seven);
  assert.deepEqual(regridded.rows.map((row) => row.panes.length), [3, 3, 1]);
  assert.equal(organizeCanvasLayout(emptyCanvasLayout()).rows.length, 0);
});
