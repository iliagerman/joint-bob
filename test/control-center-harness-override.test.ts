import assert from "node:assert/strict";
import test from "node:test";
import { harnessFromMessage } from "../src/control-center/harness-override.js";

const harnesses = [{ id: "pi", label: "Pi" }, { id: "claude", label: "Claude Code" }, { id: "kiro", label: "Kiro" }];

test("the agent the person names is used, and nothing else counts as naming one", () => {
  assert.equal(harnessFromMessage("fix the menu with Pi", harnesses), "pi");
  assert.equal(harnessFromMessage("do it using Claude Code please", harnesses), "claude");
  assert.equal(harnessFromMessage("run this on kiro", harnesses), "kiro");
  assert.equal(harnessFromMessage("use the claude agent for the review", harnesses), "claude");
  assert.equal(harnessFromMessage("fix the menu", harnesses), null);
  assert.equal(harnessFromMessage("the pi calculation is wrong, with some tolerance", harnesses), null, "a word that happens to be an agent's name is not a choice");
  assert.equal(harnessFromMessage("pick it up on Monday", harnesses), null);
});
