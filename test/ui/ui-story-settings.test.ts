import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const LOCATIONS = ["podcast", "classroom", "lecture", "coffeehouse", "street", "train", "server", "matrix", "rooftop"];
const defaults = {
  instructions: "Make a short podcast.", backdrops: true, locations: LOCATIONS, moods: true, codeSlides: true, codeWriteup: true, maxCodeLines: 12,
  ask: true, narrate: true, voiceProvider: "auto", hostVoice: "af_heart", cohostVoice: "am_michael", elevenHostVoice: "EXAVITQu4vr4xnSDxMaL", elevenCohostVoice: "CwhRBWXzGAHq8TQ4Fs17", speed: 1,
};

// A stand-in for audio playback: this Chrome cannot decode a clip, so each one "plays" briefly and then ends.
const FAKE_AUDIO = `window.Audio = class { constructor(src = "") { this.src = src; } pause() {} play() { setTimeout(() => this.onended?.(), 60); return Promise.resolve(); } removeAttribute() { this.src = ""; } hasAttribute() { return Boolean(this.src); } };`;

async function openStorySettings(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId("settings-tab-story").click();
  await page.waitForFunction(() => (document.getElementById("storyInstructions") as HTMLTextAreaElement).value !== "");
}

async function mockStoryApi(page: Page, local: { available: boolean; reason: string | null }) {
  const voice = { allowed: true, installed: local.available, installing: false, installError: null, reason: local.reason };
  let settings = { ...defaults };
  const puts: Array<Record<string, unknown>> = [];
  const spoken: Array<Record<string, unknown>> = [];
  const reply = () => ({ settings, defaultInstructions: "The default instructions.", locations: LOCATIONS.map((id) => ({ id, label: `Place ${id}` })), voices: [{ id: "af_heart", label: "Heart · American, female" }, { id: "am_michael", label: "Michael · American, male" }, { id: "bf_emma", label: "Emma · British, female" }], voice });
  await page.route("**/api/story-settings", async (route) => {
    if (route.request().method() === "PUT") {
      settings = route.request().postDataJSON();
      puts.push(settings);
    }
    return route.fulfill({ json: reply() });
  });
  await page.route("**/api/story-settings/test-voice", (route) => {
    spoken.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "audio/wav", body: "RIFF" });
  });
  return { puts, spoken };
}

test("Settings → Story mode saves instructions, places, code and voices on this node, and tests the voices", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.addInitScript(FAKE_AUDIO);
  const { puts, spoken } = await mockStoryApi(page, { available: true, reason: null });
  await openStorySettings(page, node.url, environment.username, environment.password);

  assert.equal(await page.getByTestId("story-instructions").inputValue(), "Make a short podcast.");
  assert.equal(await page.locator("#storyLocations input:checked").count(), 9);
  assert.match(await page.getByTestId("story-voice-status").innerText(), /Local voice is installed on this node/);
  assert.equal(await page.getByTestId("story-host-voice").inputValue(), "af_heart");

  await page.getByTestId("story-instructions-reset").click();
  assert.equal(await page.getByTestId("story-instructions").inputValue(), "The default instructions.");
  await page.getByTestId("story-instructions").fill("Explain it like a lecture.");
  await page.getByTestId("story-location-rooftop").uncheck();
  await page.getByTestId("story-moods").uncheck();
  await page.getByTestId("story-code-writeup").uncheck();
  await page.getByTestId("story-max-code-lines").fill("8");
  await page.getByTestId("story-cohost-voice").selectOption("bf_emma");
  await page.getByTestId("story-speed").fill("1.1");
  await page.getByTestId("story-save").click();
  await page.getByTestId("story-save-status").getByText("Saved on this node").waitFor();
  assert.deepEqual(puts, [{
    instructions: "Explain it like a lecture.", backdrops: true, locations: LOCATIONS.filter((id) => id !== "rooftop"), moods: false, codeSlides: true, codeWriteup: false,
    maxCodeLines: 8, ask: true, narrate: true, voiceProvider: "auto", hostVoice: "af_heart", cohostVoice: "bf_emma", elevenHostVoice: "EXAVITQu4vr4xnSDxMaL", elevenCohostVoice: "CwhRBWXzGAHq8TQ4Fs17", speed: 1.1,
  }]);

  // Switching the places off hides the list, and the choice survives a reload of the tab.
  await page.getByTestId("story-backdrops").uncheck();
  assert.equal(await page.getByTestId("story-locations").isVisible(), false);
  await page.getByTestId("settings-tab-notifications").click();
  await page.getByTestId("settings-tab-story").click();
  await page.waitForFunction(() => (document.getElementById("storyInstructions") as HTMLTextAreaElement).value === "Explain it like a lecture.");
  await page.waitForFunction(() => (document.getElementById("storyBackdrops") as HTMLInputElement).checked, undefined, { timeout: 5000 });

  await page.getByTestId("story-test-voices").click();
  for (let wait = 0; wait < 50 && spoken.length < 2; wait += 1) await page.waitForTimeout(100);
  assert.deepEqual(spoken.map((request) => request.who), ["host", "cohost"]);
});

test("Settings → Story mode says plainly when local voice is not installed", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await mockStoryApi(page, { available: false, reason: "Local voice is not installed on this node." });
  await openStorySettings(page, node.url, environment.username, environment.password);
  assert.match(await page.getByTestId("story-voice-status").innerText(), /not installed on this node/);
  assert.equal(await page.getByTestId("story-test-voices").isDisabled(), true);
});
