import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STORY_INSTRUCTIONS, DEFAULT_STORY_SETTINGS, STORY_LOCATIONS, getStorySettings, storyInstructions, updateStorySettings, voiceLabel } from "../src/story-settings.js";

test("story settings start at the defaults and keep what is saved", () => {
  assert.deepEqual(getStorySettings(), DEFAULT_STORY_SETTINGS);
  const saved = updateStorySettings({ ...DEFAULT_STORY_SETTINGS, locations: ["classroom", "matrix"], moods: false, codeSlides: false, maxCodeLines: 8, speed: 0.9 });
  assert.deepEqual(getStorySettings(), saved);
  assert.deepEqual(saved.locations, ["classroom", "matrix"]);
  updateStorySettings(DEFAULT_STORY_SETTINGS);
});

test("settings with an unknown location, voice or speed are refused", () => {
  assert.throws(() => updateStorySettings({ ...DEFAULT_STORY_SETTINGS, locations: ["moon"] }));
  assert.throws(() => updateStorySettings({ ...DEFAULT_STORY_SETTINGS, hostVoice: "nobody" }));
  assert.throws(() => updateStorySettings({ ...DEFAULT_STORY_SETTINGS, speed: 3 }));
  assert.throws(() => updateStorySettings({ ...DEFAULT_STORY_SETTINGS, apiKey: "secret" }));
  assert.throws(() => updateStorySettings({ ...DEFAULT_STORY_SETTINGS, locations: [] }), /at least one location/);
  updateStorySettings({ ...DEFAULT_STORY_SETTINGS, backdrops: false, locations: [] });
  updateStorySettings(DEFAULT_STORY_SETTINGS);
  assert.deepEqual(DEFAULT_STORY_SETTINGS.locations, [...STORY_LOCATIONS]);
});

test("empty instructions fall back to the default and a voice reads as a name with its accent", () => {
  assert.equal(storyInstructions({ ...DEFAULT_STORY_SETTINGS, instructions: "  " }), DEFAULT_STORY_INSTRUCTIONS);
  assert.equal(storyInstructions({ ...DEFAULT_STORY_SETTINGS, instructions: "Keep it short." }), "Keep it short.");
  assert.equal(voiceLabel("af_heart"), "Heart · American, female");
  assert.equal(voiceLabel("bm_george"), "George · British, male");
});
