import assert from "node:assert/strict";
import test from "node:test";
import { canvasPaneEngine } from "../public/canvas-layout.js";
import { harnessIdFromPath, harnessLabel } from "../public/harness-metadata.js";

const harnesses = [
  { id: "pi", label: "Pi", newSessionPath: "new" },
  { id: "claude", label: "Claude", newSessionPath: "claude:new" },
  { id: "kiro", label: "Kiro", newSessionPath: "kiro:new" },
  { id: "future", label: "Future Agent", newSessionPath: "future:start" },
];

test("harness metadata resolves every supported session path without native defaults", () => {
  assert.equal(harnessIdFromPath(harnesses, "kiro:abc"), "kiro");
  assert.equal(harnessIdFromPath(harnesses, "draft:future:abc"), "future");
  assert.equal(harnessIdFromPath(harnesses, "future:start"), "future");
  assert.equal(harnessIdFromPath(harnesses, "/legacy/transcript.jsonl"), "pi");
  assert.equal(harnessLabel(harnesses, "future"), "Future Agent");
  assert.equal(harnessLabel(harnesses, "late-adapter"), "late-adapter");
  assert.equal(canvasPaneEngine({ sessionPath: "draft:kiro:abc" }, harnesses), "kiro");
  assert.throws(() => harnessIdFromPath(harnesses.filter(({ newSessionPath }) => newSessionPath !== "new"), "/legacy/transcript.jsonl"), /resolve harness/);
});
