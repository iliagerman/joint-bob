import assert from "node:assert/strict";
import test from "node:test";
import type { BobDecision } from "../src/control-center/decisions.js";
import { appliedSettings, displayRunFrom, lighterLevels, mayBeAboutDisplay, parseDisplayIntent, type AppearanceContext } from "../src/server/control-center-display.js";

const context: AppearanceContext = {
  settings: { theme: "dark", global: 1, sections: { chat: 1, projects: 1 } },
  themes: [{ id: "dark", label: "Dark" }, { id: "midnight", label: "Midnight" }],
  sections: [{ id: "chat", label: "Conversation" }, { id: "projects", label: "Projects panel" }],
  scale: { min: 0.8, max: 2, step: 0.05 },
};
const decision = (kind: BobDecision["kind"], confidence = 0.95): BobDecision => ({ kind, size: "short", projectId: null, autoRespond: false, confidence });
const level = (modelId: string) => ({ provider: "claude", modelId, thinkingLevel: "medium", description: modelId });

test("the display agent's answer is a change only when it fits one of the shapes", () => {
  assert.deepEqual(parseDisplayIntent('Done:\n{"intent":"change","theme":"midnight","reply":"Switched to Midnight."}'), { intent: "change", theme: "midnight", reply: "Switched to Midnight." });
  assert.deepEqual(parseDisplayIntent('{"intent":"none"}'), { intent: "none" });
  for (const bad of ["", "midnight", '{"intent":"change","theme":"midnight"}', '{"intent":"restyle","css":"body{}"}']) assert.equal(parseDisplayIntent(bad), null, bad);
});

test("a change keeps to what the page allows: its themes and parts, sizes snapped to its steps and range", () => {
  assert.deepEqual(appliedSettings({ intent: "change", theme: "midnight", global: 1.13, sections: { chat: 9 }, reply: "x" }, context), { theme: "midnight", global: 1.15, sections: { chat: 2, projects: 1 } });
  assert.deepEqual(appliedSettings({ intent: "change", reply: "x" }, context), context.settings, "what is left out stays");
  assert.match(appliedSettings({ intent: "change", theme: "neon", reply: "x" }, context) as string, /no "neon" theme/);
  assert.match(appliedSettings({ intent: "change", sections: { cards: 1.2 }, reply: "x" }, context) as string, /no "cards" part/);
});

test("a message goes to the display agent when the decision model says so, or it is not surely something else and names how the app looks", () => {
  assert.equal(mayBeAboutDisplay("anything", decision("display"), 0.9), true);
  assert.equal(mayBeAboutDisplay("switch to the dark theme", decision("task"), 0.9), false, "the model is sure it is work in a project");
  assert.equal(mayBeAboutDisplay("switch to the dark theme", decision("task", 0.4), 0.9), true, "an unsure guess does not rule it out");
  assert.equal(mayBeAboutDisplay("make the text bigger", null, 0.9), true);
  assert.equal(mayBeAboutDisplay("what is running?", null, 0.9), false);
});

test("the display agent runs on the profile's lighter half of levels, the one the decision model chose, or the lightest", () => {
  const levels = { "1": level("haiku"), "2": level("haiku-2"), "4": level("sonnet-small"), "6": level("sonnet"), "8": level("opus"), "10": level("opus-max"), "5": null };
  assert.deepEqual(Object.keys(lighterLevels(levels)), ["1", "2", "4"], "never one of the strongest");
  const lighter = lighterLevels(levels);
  assert.deepEqual(displayRunFrom("claude", lighter, { level: 2, score: 2, confidence: 0.8 }, 0.3, "TypeSafe (Jev)"), { harnessId: "claude", provider: "claude", modelId: "haiku-2", thinkingLevel: "medium", by: "TypeSafe (Jev) chose level 2" });
  assert.equal(displayRunFrom("claude", lighter, { level: 2, score: 2, confidence: 0.1 }, 0.3, "TypeSafe (Jev)")?.modelId, "haiku", "unsure: the lightest");
  assert.equal(displayRunFrom("claude", lighter, null, 0.3, "TypeSafe (Jev)")?.by, "lightest level 1");
  assert.equal(displayRunFrom("claude", {}, null, 0.3, "TypeSafe (Jev)"), null);
});
