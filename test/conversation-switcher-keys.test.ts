import assert from "node:assert/strict";
import test from "node:test";
import { isSwitcherKey, isSwitcherNavigationCode, switcherHeld, switcherStep } from "../public/canvas-layout.js";

const event = (code: string, modifiers: Record<string, boolean> = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers,
});

test("Mac: Control+Option+Tab is the switcher, and Shift on top steps back", () => {
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true, altKey: true }), true), true);
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true, altKey: true, shiftKey: true }), true), true);
  assert.equal(switcherStep(event("Tab", { ctrlKey: true, altKey: true, shiftKey: true }), true), -1);
  assert.equal(switcherStep(event("Tab", { ctrlKey: true, altKey: true }), true), 1);
});

test("Mac: near misses are not the switcher", () => {
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true }), true), false, "Control+Tab is the browser's tab key");
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true, altKey: true, metaKey: true }), true), false);
  assert.equal(isSwitcherKey(event("Space", { ctrlKey: true, altKey: true }), true), false);
  assert.equal(isSwitcherKey(event("Tab", { altKey: true }), true), false);
});

test("Windows: Ctrl+Shift+Space is the switcher, with no Alt or Meta beside it", () => {
  assert.equal(isSwitcherKey(event("Space", { ctrlKey: true, shiftKey: true }), false), true);
  assert.equal(isSwitcherKey(event("Space", { ctrlKey: true, shiftKey: true, altKey: true }), false), false);
  assert.equal(isSwitcherKey(event("Space", { ctrlKey: true, shiftKey: true, metaKey: true }), false), false);
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true, shiftKey: true }), false), false, "Ctrl+Shift+Tab is the browser's");
  assert.equal(isSwitcherKey(event("Tab", { ctrlKey: true, altKey: true }), false), false, "Ctrl+Alt is AltGr on many layouts");
});

test("Windows: Shift is part of the chord, so it never steps back", () => {
  assert.equal(switcherStep(event("Space", { ctrlKey: true, shiftKey: true }), false), 1);
});

test("the hold lasts while every chord modifier is down", () => {
  assert.equal(switcherHeld(event("Tab", { ctrlKey: true, altKey: true }), true), true);
  assert.equal(switcherHeld(event("Alt", { ctrlKey: true }), true), false, "letting go of Option ends the hold");
  assert.equal(switcherHeld(event("Control", { altKey: true }), true), false, "letting go of Control ends the hold");
  assert.equal(switcherHeld(event("Shift", { ctrlKey: true, shiftKey: false }), false), false, "letting go of Shift ends the Windows hold");
  assert.equal(switcherHeld(event("Space", { ctrlKey: true, shiftKey: true }), false), true);
});

test("an open switcher answers to digits, arrows and Escape only", () => {
  for (const code of ["Digit1", "Digit0", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"]) {
    assert.equal(isSwitcherNavigationCode(code), true, code);
  }
  for (const code of ["KeyA", "Tab", "Space", "Enter"]) {
    assert.equal(isSwitcherNavigationCode(code), false, code);
  }
});
