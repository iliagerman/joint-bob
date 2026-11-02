// Feature: story mode, explained step by step. A conversation's change is written up as a
// story; Overview turns it into a short show where two hosts explain it, in the Kokoro voices
// the app uses; a question typed under the player is answered as a new chapter.
import { around, beats, bed, defineFeature, display, events, fit, look, on, say, sfx, spoken } from "../feature.js";

const at = events("story");
// How long the hosts talk: from just before Maya's first line to the end of Jonah's question
// and her answer, and for the answer to the follow-up question.
const showLength = Math.round((at.line3 + 4.6 - (at.line1 - 0.4)) * 30);
const answerLength = Math.round((at.line9 + 4.2 - (at.line8 - 0.4)) * 30);
const [written, examples, overview, show, ask, answer, tagline] = beats([
  "story-01", "story-02", "story-03", { pause: showLength }, "story-04", { pause: answerLength }, { name: "story-05", min: 116 },
]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(written, "Reviewing a change means working out what was done, and why. *Story mode writes that up for you,* straight from the conversation that made it."),
  say(examples, "You get a clear account of *what changed and the reasons behind it,* worked examples of the new behavior, and the parts of the code that matter."),
  say(overview, "Or press Overview, and *two hosts talk you through the change* as a short show, in voices that run on your own machine."),
  // What the hosts say, under the picture; their voices are in the sounds below.
  { at: show.from + 12, until: show.from + Math.round((at.line2 - at.line1) * 30) - 4, text: "🎙️ Maya: Some customers were *charged twice* for one order.", tone: "sun", length: Math.round(3.3 * 30) },
  { at: show.from + 12 + Math.round((at.line2 - at.line1) * 30), until: show.from + Math.round((at.line3 - at.line1) * 30) - 4, text: "🎙️ Jonah: *Twice?* How does that even happen?", tone: "sun", length: Math.round(2.8 * 30) },
  { at: show.from + 12 + Math.round((at.line3 - at.line1) * 30), until: show.to - 4, text: "🎙️ Maya: The provider timed out, but *still took the money.* Then we retried.", tone: "sun", length: Math.round(4.4 * 30) },
  say(ask, "If something isn't clear, *ask a question,* and the answer is added to the show as a new chapter."),
  { at: answer.from + 12, until: answer.from + Math.round((at.line9 - at.line8) * 30) - 4, text: "🎙️ Jonah: What about orders created *before the fix?*", tone: "sun", length: Math.round(3.3 * 30) },
  { at: answer.from + 12 + Math.round((at.line9 - at.line8) * 30), until: answer.to - 4, text: "🎙️ Maya: They get a key *on their first retry,* so they are covered too.", tone: "sun", length: Math.round(3.9 * 30) },
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

// The written story: what changed and why, then examples and the code.
const a = fit("story", written.from, written.to, at.story - 0.2, at.examples + 0.4);
const b = fit("story", examples.from, examples.to, at.examples + 0.4, at.overview - 1.0);
// Overview in the conversation, and the show starting.
const c = fit("story", overview.from, overview.to, at.overview - 0.9, at.line1 - 0.4);
// Maya and Jonah, at the pace they spoke.
const d = { clip: "story", from: show.from, to: show.to, start: at.line1 - 0.4, rate: 1 };
// A question under the player, and the chapter that answers it.
const e = fit("story", ask.from, ask.to, at.asked - 2.4, at.line8 - 0.4);
const f = { clip: "story", from: answer.from, to: duration, start: at.line8 - 0.4, rate: 1 };

export default defineFeature({
  id: "story",
  kicker: "Story mode",
  duration,
  end,
  tagline: ["Review the story,", "not just the diff."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c, d, e, f] }),
  shots: [
    { from: written.from, to: written.to, start: look(desk, 0.56, 0.52, 6.0, 0.15), end: look(desk, 0.57, 0.56, 5.0, 0.05) },
    { from: examples.from, to: examples.to, start: look(desk, 0.56, 0.6, 5.2, -0.1), end: look(desk, 0.57, 0.64, 4.5, -0.04) },
    { from: overview.from, to: overview.at + 60, start: look(desk, 0.82, 0.3, 4.6, 0.1), end: look(desk, 0.88, 0.27, 3.8, 0.04) },
    { from: overview.at + 60, to: overview.to, start: look(desk, 0.5, 0.45, 6.2), end: look(desk, 0.5, 0.45, 5.4) },
    { from: show.from, to: show.to, start: look(desk, 0.5, 0.46, 5.2, 0.1), end: look(desk, 0.5, 0.46, 4.6, -0.05) },
    { from: ask.from, to: ask.to, start: look(desk, 0.47, 0.84, 5.2, -0.1), end: look(desk, 0.45, 0.88, 4.7, -0.04) },
    { from: answer.from, to: end, start: look(desk, 0.52, 0.58, 5.4, 0.1), end: look(desk, 0.52, 0.55, 4.8, 0.04) },
    { from: end, to: duration, start: { position: [0.2, 3.2, 11.5], target: [0, 1.9, 0] }, end: { position: [0.4, 3.4, 13], target: [0, 1.9, 0] } },
  ],
  rings: [
    { from: written.at + 40, to: written.to - 4, ...around(desk, 0.19, 0.6, 0.967, 0.727) },
    { from: overview.at + 6, to: overview.at + 58, ...around(desk, 0.89, 0.232, 0.952, 0.262), sun: true },
    { from: ask.at + 20, to: ask.to - 4, ...around(desk, 0.038, 0.89, 0.918, 0.94) },
    { from: answer.from + 30, to: answer.to - 4, ...around(desk, 0.52, 0.715, 0.74, 0.745), sun: true },
  ],
  stickers: [
    { text: "Written for reviewers 📖", paint: "ink", from: written.at + 40, to: written.to - 4, at: { x: 1460, y: 230 }, tilt: 3, size: 42 },
    { text: "Examples and the code that matters", paint: "mint", from: examples.at + 40, to: examples.to - 4, at: { x: 1400, y: 230 }, tilt: -3, size: 40 },
    { text: "Overview 🎙️", paint: "sun", from: overview.at + 8, to: overview.at + 58, at: { x: 1300, y: 300 }, tilt: -3, size: 46 },
    { text: "Maya", paint: "mint", from: show.from + 8, to: show.to - 4, at: on(desk, 0.37, 0.44), tilt: -3, size: 36 },
    { text: "Jonah", paint: "ink", from: show.from + 8, to: show.to - 4, at: on(desk, 0.74, 0.44), tilt: 3, size: 36 },
    { text: "Your question ❓", paint: "sun", from: ask.at + 22, to: ask.to - 4, at: { x: 1400, y: 300 }, tilt: 3, size: 44 },
    { text: "A new chapter: older orders ☕", paint: "mint", from: answer.from + 30, to: end - 4, at: { x: 1420, y: 220 }, tilt: -3, size: 40 },
  ],
  lines,
  sounds: [
    bed(duration, 80), ...spoken(lines),
    // The hosts, at the moments the recording's player spoke them.
    ...["01", "02", "03"].map((line, index) => ({ audio: `audio/story-line-${line}.mp3`, at: show.from + 12 + Math.round(([at.line1, at.line2, at.line3][index] - at.line1) * 30), volume: 1.7 })),
    { audio: "audio/story-line-08.mp3", at: answer.from + 12, volume: 1.7 },
    { audio: "audio/story-line-09.mp3", at: answer.from + 12 + Math.round((at.line9 - at.line8) * 30), volume: 1.7 },
    sfx("pop", written.at + 40), sfx("pop", overview.at + 8), sfx("pop", ask.at + 22), sfx("chime", answer.from + 30),
  ],
});
