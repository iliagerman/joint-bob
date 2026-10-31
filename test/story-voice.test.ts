import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { updateStorySettings, DEFAULT_STORY_SETTINGS } from "../src/story-settings.js";
import { narrateStoryText, storyVoiceStatus, voiceCacheFile } from "../src/server/story-voice.js";

test("Kokoro is reported as installed in a development checkout", () => {
  assert.deepEqual(storyVoiceStatus(), { available: true, reason: null });
});

test("a line already spoken in the chosen voice is replayed from disk without starting the model", async () => {
  const text = `Replay ${Math.random()}`;
  updateStorySettings({ ...DEFAULT_STORY_SETTINGS, hostVoice: "af_bella", cohostVoice: "bm_george", speed: 1.1 });
  const host = voiceCacheFile("af_bella", 1.1, text);
  const cohost = voiceCacheFile("bm_george", 1.1, text);
  assert.notEqual(host, cohost);
  await mkdir(path.dirname(host), { recursive: true });
  await writeFile(host, "host-wav");
  await writeFile(cohost, "cohost-wav");
  assert.equal((await narrateStoryText(text, "host")).toString(), "host-wav");
  assert.equal((await narrateStoryText(text, "cohost")).toString(), "cohost-wav");
  updateStorySettings(DEFAULT_STORY_SETTINGS);
});
