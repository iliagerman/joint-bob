import assert from "node:assert/strict";
import test from "node:test";
import {
  addCanvasPane, canonicalSessionPath, emptyCanvasLayout, listCanvasPanes,
  removeCanvasPane, replaceCanvasPane, setCanvasSplitRatio, swapCanvasPanes, toggleCanvasFocus,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

test("canvas layout operations build, list, and tear down split trees", () => {
  const first = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.equal(listCanvasPanes(first).length, 1);
  assert.equal(first.root.id, "one");

  const split = addCanvasPane(first, pane("two"), "one", "row");
  assert.equal(split.root.kind, "split");
  assert.equal(split.root.axis, "row");
  assert.equal(listCanvasPanes(split).length, 2);
  assert.equal(split.root.first.id, "one");
  assert.equal(split.root.second.id, "two");

  // Removing one pane collapses its parent split instead of leaving a stub.
  const collapsed = removeCanvasPane(split, "one");
  assert.equal(collapsed.root.id, "two");
  assert.equal(collapsed.focusedPaneId, null);
});

test("the canvas rejects duplicate conversation identities and caps its size", () => {
  const layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  assert.throws(() => addCanvasPane(layout, pane("dupe", "one"), "one", "row"), /already on the canvas/i);
  assert.throws(() => addCanvasPane(layout, pane("conflict", "other", "/tmp/one.sync-conflict-x.jsonl"), "one", "row"), /already on the canvas/i);
  assert.throws(() => addCanvasPane(layout, pane("two"), "missing", "row"), /unknown canvas pane/i);
  assert.throws(() => addCanvasPane(layout, pane("two"), "one", "diagonal"), /unknown split axis/i);

  let full = addCanvasPane(layout, pane("two"), "one", "column");
  for (let index = 3; index <= 8; index += 1) full = addCanvasPane(full, pane(`pane-${index}`), "one", "row");
  assert.equal(listCanvasPanes(full).length, 8);
  assert.throws(() => addCanvasPane(full, pane("nine"), "one", "row"), /at most eight/i);
});

test("swap, replace, focus, and resize keep every conversation identity intact", () => {
  const base = addCanvasPane(addCanvasPane(emptyCanvasLayout(), pane("one")), pane("two"), "one", "row");
  const swapped = swapCanvasPanes(base, "one", "two");
  // Pane ids are slot ids: swapping exchanges the conversations, not the slots.
  assert.equal(swapped.root.first.id, "one");
  assert.equal(swapped.root.first.sessionId, "two");
  assert.equal(swapped.root.second.id, "two");
  assert.equal(swapped.root.second.sessionId, "one");
  assert.throws(() => swapCanvasPanes(base, "one", "one"), /with itself/i);
  assert.throws(() => swapCanvasPanes(base, "one", "missing"), /unknown canvas pane/i);

  // Replacing keeps the pane id and position, only the conversation changes.
  const replaced = replaceCanvasPane(base, "two", pane("fresh"));
  assert.equal(replaced.root.second.id, "two");
  assert.equal(replaced.root.second.sessionId, "fresh");
  assert.throws(() => replaceCanvasPane(base, "two", pane("one")), /already on the canvas/i);

  assert.equal(toggleCanvasFocus(base, "two").focusedPaneId, "two");
  assert.equal(toggleCanvasFocus(toggleCanvasFocus(base, "two"), "two").focusedPaneId, null);
  assert.throws(() => toggleCanvasFocus(base, "missing"), /unknown canvas pane/i);

  const splitId = base.root.id;
  assert.equal(setCanvasSplitRatio(base, splitId, 0).root.ratio, 0.15);
  assert.equal(setCanvasSplitRatio(base, splitId, 5).root.ratio, 0.85);
  assert.throws(() => setCanvasSplitRatio(base, "missing", 0.5), /unknown canvas split/i);
  assert.equal(canonicalSessionPath("/tmp/a.sync-conflict-20260901-x.jsonl"), "/tmp/a.jsonl");
});
