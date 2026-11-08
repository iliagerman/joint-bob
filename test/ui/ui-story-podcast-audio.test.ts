import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Real player, drawn hosts and browser audio; only the voice-generation service is held back.
test("the movie makes every clip before it plays, then speaks each line without waiting", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("login-dialog").waitFor({ state: "hidden" });
  await page.evaluate(`(async () => {
    const { playStoryPodcast } = await import('/app/git-story-podcast.js');
    const lines = ['The first complete line.', 'The second complete line.', 'The final complete line.'];
    const script = {
      title: 'Delayed narration',
      chapters: lines.map((text, index) => ({
        title: 'Chapter ' + (index + 1), location: 'podcast', mood: 'calm',
        visual: { kind: 'flow', nodes: [{ label: 'Start', sub: '', tone: 'neutral' }, { label: 'Finish', sub: '', tone: 'good' }] },
        lines: [{ who: index === 1 ? 'cohost' : 'host', text, reveal: 1 }],
      })),
      writeup: { changed: [], how: [], why: [], rejected: [], limits: [] }, followUps: [],
    };
    const settings = { backdrops: true, locations: ['podcast'], moods: true, codeSlides: true, codeWriteup: true, ask: false };
    // Twenty seconds of a quiet tone, generated locally; no credentials or remote audio. A line never ends by itself
    // while the test checks it, since the test skips to each clip's end.
    const rate = 24000, samples = rate * 20;
    const wav = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset, value) => [...value].forEach((char, index) => wav.setUint8(offset + index, char.charCodeAt(0)));
    text(0, 'RIFF'); wav.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt '); wav.setUint32(16, 16, true);
    wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true);
    wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); text(36, 'data'); wav.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index++) wav.setInt16(44 + index * 2, Math.round(1500 * Math.sin(index * 2 * Math.PI * 220 / rate)), true);
    window.__voiceRequests = [];
    window.__heard = [];
    window.__audio = new Audio();
    window.__audio.addEventListener('playing', () => {
      const line = document.querySelector('.gsp-caption > span:last-child').textContent;
      if (window.__heard.at(-1) !== line) window.__heard.push(line);
    });
    window.__releaseVoice = (line) => window.__voiceRequests.find((request) => request.text === line).resolve(new Blob([wav.buffer], { type: 'audio/wav' }));
    playStoryPodcast({ script, settings, host: document.body, audio: window.__audio,
      narrate: (text) => new Promise((resolve) => window.__voiceRequests.push({ text, resolve })),
    });
  })()`);
  const caption = page.locator(".gsp-caption > span:last-child");
  // The stage draws the hosts on a canvas and says which of them is talking, so a mouth moves only while they are.
  const speaking = () => page.locator(".gsp-stage").getAttribute("data-speaking");
  const play = page.locator(".gsp-play");
  const progress = page.locator(".gsp-progress");

  // Every line's clip is made before the movie can start, so a slow voice never holds it at a line.
  await progress.filter({ hasText: "Preparing the voice: 0 of 3 lines." }).waitFor();
  assert.equal(await play.isDisabled(), true, "Play waits for the voice");
  assert.deepEqual(await page.evaluate("window.__voiceRequests.map((request) => request.text)"), ["The first complete line.", "The second complete line.", "The final complete line."]);
  await page.evaluate("window.__releaseVoice('The second complete line.')");
  await progress.filter({ hasText: "1 of 3 lines." }).waitFor();
  await page.evaluate("window.__releaseVoice('The first complete line.')");
  await page.evaluate("window.__releaseVoice('The final complete line.')");
  await progress.waitFor({ state: "hidden" });
  assert.equal(await play.isDisabled(), false);
  assert.equal(await speaking(), "", "Mouths stay closed until the movie plays");
  assert.equal(await caption.innerText(), "The first complete line.");

  await play.click();
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 1);
  await page.waitForFunction(() => document.querySelector(".gsp-stage")!.getAttribute("data-speaking") === "host");

  // A real pause stops mouth movement and resumes the same line, not the next one.
  await play.click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await speaking(), "");
  assert.equal(await caption.innerText(), "The first complete line.");
  await play.click();
  await page.waitForFunction(() => !(window as unknown as { __audio: HTMLAudioElement }).__audio.paused);

  // Each line ends straight into the next, with nothing more asked of the voice service.
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 2);
  await page.waitForFunction(() => document.querySelector(".gsp-stage")!.getAttribute("data-speaking") === "cohost");
  assert.equal(await caption.innerText(), "The second complete line.");
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 3);
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");
  await play.filter({ hasText: "Replay" }).waitFor();
  assert.deepEqual(await page.evaluate("window.__heard"), ["The first complete line.", "The second complete line.", "The final complete line."]);
  assert.equal(await page.evaluate("window.__voiceRequests.length"), 3, "each line is spoken once");
});
