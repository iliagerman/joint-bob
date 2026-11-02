import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Real player, stick figures and browser audio; only the voice-generation service is held back.
test("narrated mouths wait for audio between lines and resume without skipping speech", { timeout: 90_000 }, async (t) => {
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
    // Two seconds of a quiet tone, generated locally; no credentials or remote audio.
    const rate = 24000, samples = rate * 2;
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
  const mouths = page.locator('.gsp-actors ellipse[rx="3.5"]');
  const voiceNote = page.locator(".gsp-voice-note");
  await page.locator(".gsp-play").click();
  await voiceNote.waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await mouths.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("ry")))), [0.7, 0.7], "Mouths must stay closed while the first clip is being generated");
  assert.equal(await caption.innerText(), "The first complete line.");

  await page.evaluate("window.__releaseVoice('The first complete line.')");
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 1);
  await page.waitForFunction(() => Number(document.querySelector('.gsp-actors ellipse[rx="3.5"]')!.getAttribute("ry")) >= 1);
  assert.equal(await voiceNote.isVisible(), false);

  // A real pause stops mouth movement and resumes the same line, not the next one.
  await page.locator(".gsp-play").click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await mouths.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("ry")))), [0.7, 0.7]);
  assert.equal(await caption.innerText(), "The first complete line.");
  await page.locator(".gsp-play").click();
  await page.waitForFunction(() => !(window as unknown as { __audio: HTMLAudioElement }).__audio.paused);
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");

  // The first line ends, but the next clip is still waiting for the voice service.
  await page.waitForFunction(() => document.querySelector(".gsp-caption > span:last-child")!.textContent === "The second complete line.");
  await voiceNote.waitFor({ state: "visible" });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await mouths.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("ry")))), [0.7, 0.7], "Mouths must stop between clips, rather than silently acting out the next line");
  assert.deepEqual(await page.evaluate("window.__heard"), ["The first complete line."]);

  await page.evaluate("window.__releaseVoice('The second complete line.')");
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 2);
  await page.waitForFunction(() => Number(document.querySelectorAll('.gsp-actors ellipse[rx="3.5"]')[1].getAttribute("ry")) >= 1);
  assert.equal(await voiceNote.isVisible(), false);
  assert.equal(await caption.innerText(), "The second complete line.");
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");
  await page.waitForFunction(() => document.querySelector(".gsp-caption > span:last-child")!.textContent === "The final complete line.");
  await page.evaluate("window.__releaseVoice('The final complete line.')");
  await page.waitForFunction(() => (window as unknown as { __heard: string[] }).__heard.length === 3);
  await page.evaluate("window.__audio.currentTime = window.__audio.duration - 0.05");
  await page.locator(".gsp-play", { hasText: "Replay" }).waitFor();
  assert.deepEqual(await page.evaluate("window.__heard"), ["The first complete line.", "The second complete line.", "The final complete line."]);
});
