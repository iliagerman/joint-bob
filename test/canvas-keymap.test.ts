import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCanvasKey, canvasChordLabel, canvasChordIsUsable, canvasChordMatches, canvasKeyFromCode,
  canvasSplitPlacement, emptyCanvasLayout, fuzzyMatchScore, normalizeCanvasKeymap,
  addCanvasPane, listCanvasPanes,
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
  const keymap = normalizeCanvasKeymap({ modifiers: ["ctrl"], recentPane: "k", focusPane: "K", paneSearch: "9", toggleView: "v", spotlight: "p", pendingReviews: "r" });
  assert.deepEqual(keymap, { modifiers: ["ctrl"], recentPane: "K", focusPane: null, paneSearch: "9", toggleView: "V", spotlight: "P", pendingReviews: "R" });
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
  layout = addCanvasPane(layout, pane("two"), "one", "right");
  layout = addCanvasPane(layout, pane("left"), "two", "left");
  assert.deepEqual(listCanvasPanes(layout).map((item) => item.id), ["one", "left", "two"]);
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

test("a placement word and legacy axis word both name the same side", () => {
  const base = addCanvasPane(emptyCanvasLayout(), pane("one"));
  const beside = addCanvasPane(base, pane("two"), "one", "right");
  const legacy = addCanvasPane(base, pane("two"), "one", "row");
  assert.equal(beside.pages[0].root.axis, "row");
  assert.equal(beside.pages[0].root.axis, legacy.pages[0].root.axis);
  assert.equal(addCanvasPane(base, pane("two"), "one", "below").pages[0].root.axis, "column");
  assert.throws(() => addCanvasPane(base, pane("two"), "one", "sideways"), /Unknown placement/);
});

test("stored keymaps degrade instead of taking the node down", async () => {
  const { defaultCanvasKeymap, normalizeCanvasKeymapPreference } = await import(`../src/preferences.js?canvas-keymap=${Date.now()}-${Math.random()}`);
  assert.deepEqual(normalizeCanvasKeymapPreference(null), defaultCanvasKeymap());
  const keymap = normalizeCanvasKeymapPreference({ modifiers: ["meta"], recentPane: "!!", focusPane: "g", paneSearch: null, toggleView: null });
  assert.deepEqual(keymap, { modifiers: ["meta"], recentPane: null, focusPane: "G", paneSearch: null, toggleView: null, spotlight: "P", pendingReviews: "R" });
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

// A key under a finger beats a letter the conversation is also typing, so punctuation
// and Enter are bindable. Space stays out: it is the split leader. "/" and "\\" stay out
// because a binding travels as a URL path segment, and "\\" already means "split".
test("a shortcut key can be punctuation or Enter, but not Space or a slash", () => {
  assert.equal(canonicalCanvasKey("["), "[");
  assert.equal(canonicalCanvasKey("enter"), "ENTER");
  assert.equal(canonicalCanvasKey("ENTER"), "ENTER");
  assert.equal(canonicalCanvasKey(" "), null);
  assert.equal(canonicalCanvasKey("SPACE"), null);
  assert.equal(canonicalCanvasKey("/"), null);
  assert.equal(canonicalCanvasKey("\\"), null);

  assert.equal(canvasKeyFromCode("BracketLeft"), "[");
  assert.equal(canvasKeyFromCode("Quote"), "'");
  assert.equal(canvasKeyFromCode("Enter"), "ENTER");
  assert.equal(canvasKeyFromCode("NumpadEnter"), "ENTER");
  assert.equal(canvasKeyFromCode("Space"), null);
  assert.equal(canvasKeyFromCode("Slash"), null);

  const keymap = normalizeCanvasKeymap({ modifiers: ["ctrl"], recentPane: "[", focusPane: "enter", paneSearch: "/" });
  assert.equal(keymap.recentPane, "[");
  assert.equal(keymap.focusPane, "ENTER");
  assert.equal(keymap.paneSearch, null, "a key the canvas cannot carry is dropped, not stored");
  assert.equal(canvasChordLabel({ modifiers: ["meta"] }, "ENTER"), "\u2318\u23ce", "Enter reads as a symbol, not as four letters");
  assert.equal(canvasChordLabel({ modifiers: ["meta"] }, "["), "\u2318[");
});

// Terminal muscle memory: the new pane appears where the key points.
test("the split leader opens to the right or below, the way a terminal does", () => {
  assert.equal(canvasSplitPlacement({ code: "Backslash" }), "right");
  assert.equal(canvasSplitPlacement({ code: "Minus" }), "below");
  assert.equal(canvasSplitPlacement({ code: "KeyQ" }), null);
});

// The panel that lists every shortcut is itself reachable by a fixed chord. The bare
// "/" is left to the terminal and the code editor, which both use it.
test("the help chord is Command or Control with a question mark, never a bare slash", async () => {
  const { isCanvasHelpShortcut } = await import("../public/canvas-layout.js");
  assert.equal(isCanvasHelpShortcut({ code: "Slash", key: "?", metaKey: true, shiftKey: true, ctrlKey: false, altKey: false }), true);
  assert.equal(isCanvasHelpShortcut({ code: "Slash", key: "?", metaKey: false, shiftKey: true, ctrlKey: true, altKey: false }), true);
  // A layout that types "?" from another key still answers.
  assert.equal(isCanvasHelpShortcut({ code: "Minus", key: "?", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }), true);
  assert.equal(isCanvasHelpShortcut({ code: "Slash", key: "/", metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }), false,
    "a bare slash belongs to the terminal and the editor");
  assert.equal(isCanvasHelpShortcut({ code: "Slash", key: "?", metaKey: false, shiftKey: true, ctrlKey: false, altKey: false }), false);
  assert.equal(isCanvasHelpShortcut({ code: "Slash", key: "?", metaKey: true, shiftKey: true, ctrlKey: false, altKey: true }), false);
});
