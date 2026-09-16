import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCanvasKey, canvasKeyFromCode, chordFromEvent, chordId, chordKeyLabel, chordLabel, chordMatches,
  conversationChordLabel, CANVAS_KEYMAP_COMMANDS, DEFAULT_CANVAS_KEYMAP, emptyCanvasLayout,
  fuzzyMatchScore, normalizeCanvasKeymap, normalizeChord, shortcutsConflict, addCanvasPane, listCanvasPanes,
} from "../public/canvas-layout.js";

const pane = (id, sessionId = id, sessionPath = `/tmp/${id}.jsonl`) => ({
  kind: "pane", id, projectId: "project", sessionPath, sessionId, executionNodeId: null,
});

const event = (code, modifiers = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers,
});

import { normalizeCanvasKeymapPreference } from "../src/preferences.js";

for (const normalize of [normalizeCanvasKeymap, normalizeCanvasKeymapPreference]) {
  test(`${normalize.name}: version 4 rebuilds every command onto one modifier pair`, () => {
    assert.deepEqual(normalize({}).commands.notify, ["ctrl", "alt", "Y"]);
    assert.deepEqual(normalize({}).commands.closePane, ["ctrl", "alt", "W"]);
    // A keymap saved under the old per-command scheme describes shortcuts that no
    // longer exist, so its commands are rebuilt and only its base modifiers carry over.
    const old = normalize({ version: 3, base: ["ctrl"], commands: { notify: ["meta", "shift", "Y"], browser: null } });
    assert.equal(old.version, 4);
    assert.deepEqual(old.base, ["ctrl"]);
    assert.deepEqual(old.commands.notify, ["ctrl", "alt", "Y"]);
    assert.deepEqual(old.commands.browser, ["ctrl", "alt", "B"]);
    // A keymap already on version 4 keeps every chord the account chose.
    const kept = normalize({ version: 4, base: ["meta", "shift"], commands: { notify: ["meta", "ctrl", "Y"], browser: null } });
    assert.deepEqual(kept.commands.notify, ["meta", "ctrl", "Y"]);
    assert.equal(kept.commands.browser, null);
  });
}

// ─── Chords ────────────────────────────────────────────────────────────────────────

test("a shortcut supports one chord or a two-stroke sequence, at most four keys", () => {
  assert.deepEqual(normalizeChord(["shift", "ctrl", "X"]), ["ctrl", "shift", "X"]);
  assert.deepEqual(normalizeChord(["meta", "K"]), ["meta", "K"]);
  assert.deepEqual(normalizeChord(["ctrl", "alt", "shift", "9"]), ["ctrl", "alt", "shift", "9"]);
  assert.deepEqual(normalizeChord(["ctrl", "SPACE", "\\"]), ["ctrl", "SPACE", "\\"]);
  assert.equal(normalizeChord(["meta", "ctrl", "alt", "shift", "X"]), null, "five keys is over the ceiling");
  assert.equal(normalizeChord(["shift", "X"]), null, "Shift alone would swallow capitals");
  assert.equal(normalizeChord(["meta"]), null, "a shortcut needs a key");
  assert.equal(normalizeChord(["meta", "X", "Y", "Z"]), null, "sequences stop after two strokes");
  assert.equal(normalizeChord("meta"), null);
  assert.equal(normalizeChord(["meta", "NOPE"]), null, "a key outside the vocabulary");
});

test("chords may use Space, the arrows, and the slashes a binding cannot", () => {
  assert.deepEqual(normalizeChord(["ctrl", "SPACE"]), ["ctrl", "SPACE"]);
  assert.deepEqual(normalizeChord(["meta", "ARROWLEFT"]), ["meta", "ARROWLEFT"]);
  assert.deepEqual(normalizeChord(["alt", "\\"]), ["alt", "\\"]);
  assert.equal(canonicalCanvasKey(" "), null, "a conversation binding still cannot be Space");
  assert.equal(canonicalCanvasKey("/"), null);
  assert.equal(canvasKeyFromCode("Backslash"), "\\");
  assert.equal(canvasKeyFromCode("Slash"), "/");
  assert.equal(canvasKeyFromCode("Space"), "SPACE");
  assert.equal(canvasKeyFromCode("ArrowDown"), "ARROWDOWN");
});

test("the base chord may hold three modifiers so a conversation key is still the fourth", () => {
  assert.deepEqual(normalizeChord(["meta", "ctrl", "alt"], { modifierOnly: true }), ["meta", "ctrl", "alt"]);
  assert.equal(normalizeChord(["meta", "ctrl", "alt", "shift"], { modifierOnly: true }), null);
  assert.equal(normalizeChord(["meta", "shift", "X"], { modifierOnly: true }), null, "the base carries no key of its own");
  assert.equal(normalizeChord(["shift"], { modifierOnly: true }), null);
});

test("a chord answers an event only when every modifier and the key match exactly", () => {
  assert.equal(chordMatches(["meta", "shift", "P"], event("KeyP", { metaKey: true, shiftKey: true })), true);
  assert.equal(chordMatches(["meta", "shift", "P"], event("KeyP", { metaKey: true, shiftKey: true, ctrlKey: true })), false,
    "a stray Control held beside the chord must not fire it");
  assert.equal(chordMatches(["meta", "shift", "P"], event("KeyP", { metaKey: true })), false);
  assert.equal(chordMatches(["meta", "shift", "P"], event("KeyN", { metaKey: true, shiftKey: true })), false);
  assert.equal(chordMatches(["ctrl", "\\"], event("Backslash", { ctrlKey: true })), true);
  assert.equal(chordFromEvent(event("ShiftLeft", { shiftKey: true })), null, "a modifier going down is not a chord");
});

test("the chord label draws the captured modifiers and a readable key", () => {
  // The platform is passed in, so the label is the same on a Mac and on a Linux CI runner.
  assert.equal(chordLabel(["meta", "shift", "P"], true), "\u2318\u21e7P");
  assert.equal(chordLabel(["ctrl", "\\"], true), "\u2303\\");
  assert.equal(chordLabel(["ctrl", "SPACE"], true), "\u2303Space");
  assert.equal(chordLabel(["ctrl", "SPACE", "\\"], true), "\u2303Space \\");
  assert.equal(chordLabel(["meta", "shift", "ARROWLEFT"], true), "\u2318\u21e7\u2190");
  assert.equal(chordLabel(["meta", "ENTER"], true), "\u2318\u23ce");
  assert.equal(chordLabel(["ctrl", "alt"], true), "\u2303\u2325");
  assert.equal(conversationChordLabel({ base: ["meta", "shift"] }, "4", true), "\u2318\u21e74");
  // Off a Mac the same chord spells its modifiers out.
  assert.equal(chordLabel(["ctrl", "alt", "Y"], false), "Ctrl+Alt+Y");
  assert.equal(chordLabel(["meta", "shift", "P"], false), "Win+Shift+P");
  assert.equal(conversationChordLabel({ base: ["meta", "shift"] }, "4", false), "Win+Shift+4");
  // A button badge drops the modifiers and keeps only what makes the shortcut unique.
  assert.equal(chordKeyLabel(["ctrl", "alt", "Y"]), "Y");
  assert.equal(chordKeyLabel(["ctrl", "alt", "ARROWLEFT"]), "\u2190");
  assert.equal(chordKeyLabel(["ctrl", "SPACE", "\\"]), "Space \\");
});

// ─── Keymap normalization and migration ────────────────────────────────────────────

test("every command has a default chord, and the defaults never collide", () => {
  const defaults = DEFAULT_CANVAS_KEYMAP.commands;
  for (const command of CANVAS_KEYMAP_COMMANDS) {
    assert.ok(Array.isArray(defaults[command]), `${command} has a default chord`);
    assert.notEqual(normalizeChord(defaults[command]), null, `${command}'s default is a valid chord`);
    // One modifier pair everywhere is what lets a button badge name the key alone.
    assert.deepEqual(defaults[command].slice(0, 2), ["ctrl", "alt"], `${command} rides Control+Option`);
    assert.equal(defaults[command].length, 3, `${command} is one chord, not a sequence`);
  }
  const ids = Object.values(defaults).map(chordId);
  assert.equal(new Set(ids).size, ids.length, "no two defaults share one chord");
  assert.deepEqual(defaults.browser, ["ctrl", "alt", "B"]);
  assert.deepEqual(defaults.scheduledTasks, ["ctrl", "alt", "S"]);
  assert.deepEqual(defaults.splitRight, ["ctrl", "alt", "\\"]);
  assert.deepEqual(defaults.splitBelow, ["ctrl", "alt", "-"]);
  // The conversation keys ride their own modifiers, or Control+Option+3 would mean
  // both "page 3" and "the conversation holding 3".
  assert.notDeepEqual(DEFAULT_CANVAS_KEYMAP.base, ["ctrl", "alt"]);
});

test("new command defaults never steal an existing custom binding", () => {
  const keymap = normalizeCanvasKeymap({ version: 4, base: ["meta", "shift"], commands: { notify: ["ctrl", "alt", "B"] } });
  assert.deepEqual(keymap.commands.notify, ["ctrl", "alt", "B"]);
  assert.equal(keymap.commands.browser, null);
});

test("a direct shortcut and a sequence using it as a prefix cannot coexist", () => {
  assert.equal(shortcutsConflict(["ctrl", "SPACE"], ["ctrl", "SPACE", "K"]), true);
  assert.equal(shortcutsConflict(["ctrl", "SPACE", "K"], ["ctrl", "SPACE", "L"]), false);
  const keymap = normalizeCanvasKeymap({
    version: 4,
    base: ["meta", "shift"],
    commands: { spotlight: ["ctrl", "SPACE"], recents: ["ctrl", "SPACE", "K"] },
  });
  assert.deepEqual(keymap.commands.spotlight, ["ctrl", "SPACE"]);
  assert.equal(keymap.commands.recents, null);
});

test("a stored chord-shape keymap keeps its chords, drops the unbindable, and unbinds duplicates", () => {
  const keymap = normalizeCanvasKeymap({
    version: 4,
    base: ["ctrl", "alt"],
    commands: {
      spotlight: ["ctrl", "alt", "P"],
      recents: ["meta", "K"],
      paneSearch: ["shift", "F"],          // Shift alone: unbindable, so unbound.
      focusPane: null,                     // Explicitly cleared stays cleared.
      recentPane: ["ctrl", "alt", "P"],    // Collides with spotlight, which comes first.
    },
  });
  assert.deepEqual(keymap.base, ["ctrl", "alt"]);
  assert.deepEqual(keymap.commands.spotlight, ["ctrl", "alt", "P"]);
  assert.deepEqual(keymap.commands.recents, ["meta", "K"]);
  assert.equal(keymap.commands.paneSearch, null);
  assert.equal(keymap.commands.focusPane, null);
  assert.equal(keymap.commands.recentPane, null);
  // A command the stored keymap never mentions starts on its default.
  assert.deepEqual(keymap.commands.toggleView, DEFAULT_CANVAS_KEYMAP.commands.toggleView);
});

// Every account has a keymap saved from before chords existed. Its modifiers become
// the base that conversation keys ride; its per-command keys described the old
// scheme, so every command starts from the current default instead.
test("a legacy keymap keeps its modifiers as the base and rebuilds its commands", () => {
  const keymap = normalizeCanvasKeymap({ modifiers: ["ctrl"], recentPane: "a", focusPane: "K", paneSearch: null });
  assert.deepEqual(keymap.base, ["ctrl"]);
  assert.deepEqual(keymap.commands.recentPane, DEFAULT_CANVAS_KEYMAP.commands.recentPane);
  assert.deepEqual(keymap.commands.paneSearch, DEFAULT_CANVAS_KEYMAP.commands.paneSearch);
  assert.deepEqual(normalizeCanvasKeymap({ modifiers: ["shift"], recentPane: "E" }).base, DEFAULT_CANVAS_KEYMAP.base,
    "a shift-only legacy chord falls back to the default base instead of eating capitals");
});

test("stored keymaps degrade instead of taking the page down", () => {
  assert.deepEqual(normalizeCanvasKeymap(null).commands.splitRight, DEFAULT_CANVAS_KEYMAP.commands.splitRight);
  assert.deepEqual(normalizeCanvasKeymap("nope"), normalizeCanvasKeymap(null));
  assert.deepEqual(normalizeCanvasKeymap({ base: ["bogus"] }).base, DEFAULT_CANVAS_KEYMAP.base);
  assert.deepEqual(normalizeCanvasKeymap({ version: 4, commands: { notify: ["shift", "Y"] } }).commands.notify, null,
    "a shortcut without a real modifier would swallow ordinary typing");
});

test("the node and the page normalize keymaps identically", async () => {
  const { normalizeCanvasKeymapPreference } = await import(`../src/preferences.js?canvas-keymap=${Date.now()}-${Math.random()}`);
  const samples = [
    null,
    { modifiers: ["ctrl", "alt"], recentPane: "a", focusPane: "K", paneSearch: null },
    { modifiers: ["shift"], recentPane: "E" },
    { base: ["ctrl", "alt"], commands: { spotlight: ["ctrl", "alt", "P"], recents: ["meta", "K"], paneSearch: ["shift", "F"], recentPane: ["ctrl", "alt", "P"] } },
    { base: ["meta", "ctrl", "alt", "shift"], commands: {} },
    { commands: { splitRight: ["ctrl", "SPACE"], page9: ["ctrl", "alt", "9"] } },
    { version: 2, commands: { spotlight: ["ctrl", "SPACE"], recents: ["ctrl", "SPACE", "K"] } },
  ];
  for (const sample of samples) {
    assert.deepEqual(normalizeCanvasKeymapPreference(sample), normalizeCanvasKeymap(sample), JSON.stringify(sample));
  }
});

// ─── Layout and finder behaviour the keymap tests have always guarded ─────────────

test("a pane can be inserted immediately left of its target", () => {
  let layout = addCanvasPane(emptyCanvasLayout(), pane("one"));
  layout = addCanvasPane(layout, pane("two"), "one", "right");
  layout = addCanvasPane(layout, pane("left"), "two", "left");
  assert.deepEqual(listCanvasPanes(layout).map((item) => item.id), ["one", "left", "two"]);
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
