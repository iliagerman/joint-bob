import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCanvasKey, canvasChordLabel, canvasChordIsUsable, canvasChordMatches, canvasKeyFromCode,
  clearCanvasRowHeight, emptyCanvasLayout, fuzzyMatchScore, normalizeCanvasKeymap,
  addCanvasPane, setCanvasRowHeight,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

test("an empty modifier set falls back to the default chord", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: [], recentPane: "a" });
  assert.deepEqual(keymap.modifiers, ["meta", "shift"]);
  assert.equal(keymap.recentPane, "A");
});

test("two commands cannot hold the same key", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: ["ctrl"], recentPane: "k", focusPane: "K", paneSearch: "9", toggleView: "v" });
  assert.deepEqual(keymap, { modifiers: ["ctrl"], recentPane: "K", focusPane: null, paneSearch: "9", toggleView: "V" });
});

// Every account has a keymap saved from before the canvas gained a toggle key. A command
// the stored keymap never had an opinion about starts on its default; a command the user
// actually cleared arrives as an explicit null and stays cleared.
test("a command missing from a stored keymap starts on its default key", async () => {
  const upgraded = normalizeCanvasKeymap({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F" });
  assert.equal(upgraded.toggleView, "V");
  assert.equal(normalizeCanvasKeymap({ modifiers: ["meta", "shift"], toggleView: null }).toggleView, null);

  const { normalizeCanvasKeymapPreference } = await import(`../src/preferences.js?canvas-keymap=${Date.now()}-${Math.random()}`);
  assert.equal(normalizeCanvasKeymapPreference({ modifiers: ["meta", "shift"], recentPane: "E", focusPane: "G", paneSearch: "F" }).toggleView, "V");
  assert.equal(normalizeCanvasKeymapPreference({ modifiers: ["meta", "shift"], toggleView: null }).toggleView, null);
});

// The toggle key is the one command that answers while the canvas is closed, so a
// conversation shortcut must never be able to sit on the same key.
test("a default key already taken by another command is dropped rather than duplicated", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: ["ctrl"], recentPane: "V" });
  assert.equal(keymap.recentPane, "V");
  assert.equal(keymap.toggleView, null);
});

test("a chord matches only when no extra modifier is held", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: ["meta", "shift"] });
  assert.equal(canvasChordMatches(keymap, { metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }), true);
  assert.equal(canvasChordMatches(keymap, { metaKey: true, shiftKey: true, ctrlKey: true, altKey: false }), false);
  assert.equal(canvasChordMatches(keymap, { metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }), false);
});

test("a binding reads the physical key, not the character", () => {
  assert.equal(canvasKeyFromCode("Digit4"), "4");
  assert.equal(canvasKeyFromCode("KeyF"), "F");
  assert.equal(canvasKeyFromCode("Slash"), null);
});

test("a pane can be inserted immediately left of its target", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "row");
  layout = addCanvasPane(layout, pane("left"), "two", "left");
  assert.deepEqual(layout.rows[0].panes.map((item) => item.id), ["one", "left", "two"]);
});

test("the chord label draws the configured modifiers", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: ["meta", "shift"] });
  assert.equal(canvasChordLabel(keymap, "4"), "⌘⇧4");
  assert.equal(canvasChordLabel(normalizeCanvasKeymap({ modifiers: ["ctrl", "alt"] })), "⌃⌥");
});

test("fuzzy matching ranks initials and adjacent runs above scattered hits", () => {
  const deployScore = fuzzyMatchScore("Project One · Deploy the node", "deploy");
  const delayedScore = fuzzyMatchScore("Project One · Delayed reply on you", "deploy");
  assert.ok(deployScore !== null && delayedScore !== null && deployScore > delayedScore);
  assert.equal(fuzzyMatchScore("Alpha", "zz"), null);
  assert.equal(fuzzyMatchScore("Alpha", ""), 0);
});

test("clearing a row height gives the row its share back", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  const rowId = layout.rows[0].id;
  layout = setCanvasRowHeight(layout, rowId, 720);
  assert.equal(typeof layout.rows[0].height, "number");
  layout = clearCanvasRowHeight(layout, rowId);
  assert.equal(layout.rows[0].height, null);
  assert.throws(() => clearCanvasRowHeight(layout, "no-such-row"), /unknown canvas row/i);
});

test("stored keymaps degrade instead of taking the node down", async () => {
  const { defaultCanvasKeymap, normalizeCanvasKeymapPreference } = await import(`../src/preferences.js?canvas-keymap=${Date.now()}-${Math.random()}`);
  assert.deepEqual(normalizeCanvasKeymapPreference(null), defaultCanvasKeymap());
  const keymap = normalizeCanvasKeymapPreference({ modifiers: ["meta"], recentPane: "!!", focusPane: "g", paneSearch: null, toggleView: null });
  assert.deepEqual(keymap, { modifiers: ["meta"], recentPane: null, focusPane: "G", paneSearch: null, toggleView: null });
  assert.deepEqual(normalizeCanvasKeymapPreference({ modifiers: ["bogus"] }).modifiers, ["meta", "shift"]);
});

test("shift on its own is never a usable chord", () => {
  assert.equal(canvasChordIsUsable(["shift"]), false);
  assert.equal(canvasChordIsUsable(["alt", "shift"]), true);
  assert.equal(canvasChordIsUsable(["meta"]), true);
});

test("a shift-only chord falls back to the default instead of eating capital letters", async () => {
  assert.deepEqual(normalizeCanvasKeymap({ modifiers: ["shift"], paneSearch: "f" }).modifiers, ["meta", "shift"]);
  const { normalizeCanvasKeymapPreference: normalizeCanvasKeymapPreferenceTypescript, defaultCanvasKeymap } = await import(`../src/preferences.js?canvas-keymap=${Date.now()}-${Math.random()}`);
  assert.deepEqual(normalizeCanvasKeymapPreferenceTypescript({ modifiers: ["shift"], recentPane: "E", focusPane: "G", paneSearch: "F" }).modifiers, defaultCanvasKeymap().modifiers);
});
