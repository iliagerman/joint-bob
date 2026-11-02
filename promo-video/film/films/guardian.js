// Feature: Guardian, explained step by step. Rules are plain questions; switched on, Guardian
// checks commands, file changes and what is sent to the model. An agent's `rm -rf` is paused for
// the person; blocked, the agent archives instead. A key pasted into a message is removed.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [rule, checks, asks, block, secret, tagline] = beats(["guardian-01", "guardian-02", "guardian-03", "guardian-04", "guardian-05", { name: "guardian-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(rule, "Guardian is *a set of rules that every agent has to follow.* Each rule is a plain yes or no question, such as: is this command dangerous?"),
  say(checks, "Once you switch it on in Settings, Guardian checks *every command, every file change,* and everything an agent is about to send to the model."),
  say(asks, "When an action matches a rule, the agent is paused, and *you're asked first.* Here, an agent wants to delete twelve hundred customer files.", { tone: "sun" }),
  say(block, "You click Block, and the agent is told why. So it *finds a safer way,* and archives the files instead of deleting them."),
  say(secret, "And if you paste a key into a message by mistake, Guardian *removes it before the message ever reaches the model.*"),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("guardian");
// One rule opened: its question in plain words.
const a = fit("guardian", rule.from, rule.to, at.editor - 0.3, at.editor + 6.0);
// The switch that turns it on for every conversation, and the rules it checks.
const b = fit("guardian", checks.from, checks.to, at.enabled - 1.4, at.enabled + 3.2);
// An agent about to delete files; Guardian's card asks.
const c = fit("guardian", asks.from, asks.to, at.review - 3.4, at.review + 3.0);
// Block, and the agent archives instead.
const d = fit("guardian", block.from, block.to, at.blocked - 1.0, at.archived + 1.6);
// A message with a cloud key in it, and the agent's answer without it.
const e = fit("guardian", secret.from, end, at.secret - 2.8, at.secretAnswered + 1.6);
const card = frameOf(c, at.review + 0.1);
const blocked = frameOf(d, at.blocked);
const archived = frameOf(d, at.archived - 0.4);
const answered = frameOf(e, at.secretAnswered - 0.2);

export default defineFeature({
  id: "guardian",
  kicker: "Guardian",
  duration,
  end,
  tagline: ["Your rules,", "on every agent."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c, d, e] }),
  shots: [
    { from: rule.from, to: rule.to, start: look(desk, 0.55, 0.55, 6.0, 0.2), end: look(desk, 0.56, 0.56, 4.7, 0.05) },
    { from: checks.from, to: checks.to, start: look(desk, 0.55, 0.42, 5.0, -0.1), end: look(desk, 0.56, 0.42, 4.4, -0.04) },
    { from: asks.from, to: card, start: look(desk, 0.62, 0.55, 4.8, 0.1), end: look(desk, 0.66, 0.66, 4.4, 0.05) },
    { from: card, to: blocked, start: look(desk, 0.68, 0.72, 4.4, 0.05), end: look(desk, 0.72, 0.76, 3.9) },
    { from: blocked, to: block.to, start: look(desk, 0.62, 0.6, 4.4, -0.1), end: look(desk, 0.6, 0.56, 4.0, -0.04) },
    { from: secret.from, to: answered, start: look(desk, 0.68, 0.84, 4.4, 0.1), end: look(desk, 0.7, 0.87, 3.9, 0.04) },
    { from: answered, to: end, start: look(desk, 0.62, 0.52, 4.6, -0.1), end: look(desk, 0.6, 0.5, 4.1, -0.04) },
    { from: end, to: duration, start: { position: [0.2, 3.2, 11.5], target: [0, 1.9, 0] }, end: { position: [0.4, 3.4, 13], target: [0, 1.9, 0] } },
  ],
  rings: [
    { from: rule.at + 30, to: rule.to - 4, ...around(desk, 0.235, 0.505, 0.94, 0.605) },
    { from: frameOf(b, at.enabled - 0.6), to: frameOf(b, at.enabled + 1.4), ...around(desk, 0.212, 0.24, 0.418, 0.272) },
    { from: frameOf(b, at.enabled + 1.4), to: checks.to - 4, ...around(desk, 0.222, 0.315, 0.94, 0.565) },
    { from: card + 6, to: blocked - 2, ...around(desk, 0.478, 0.71, 0.985, 0.88), sun: true },
    { from: blocked - 14, to: blocked + 12, ...around(desk, 0.834, 0.823, 0.882, 0.86), sun: true },
    { from: archived, to: block.to - 4, ...around(desk, 0.505, 0.33, 0.675, 0.73) },
    { from: secret.at + 10, to: answered - 2, ...around(desk, 0.513, 0.9, 0.889, 0.958), sun: true },
    { from: answered + 6, to: end - 4, ...around(desk, 0.51, 0.25, 0.668, 0.49) },
  ],
  stickers: [
    { text: "A rule is a question ❓", paint: "ink", from: rule.at + 32, to: rule.to - 4, at: { x: 1480, y: 230 }, tilt: 3, size: 42 },
    { text: "One switch, every agent", paint: "mint", from: frameOf(b, at.enabled - 0.6), to: frameOf(b, at.enabled + 1.4), at: { x: 1440, y: 230 }, tilt: -3, size: 42 },
    { text: "Commands · files · what goes to the AI", paint: "sun", from: frameOf(b, at.enabled + 1.4), to: checks.to - 4, at: { x: 1380, y: 230 }, tilt: 3, size: 40 },
    { text: "Paused. Your call ✋", paint: "sun", from: card + 8, to: blocked - 2, at: { x: 1430, y: 260 }, tilt: -3, size: 46 },
    { text: "Archived. Nothing deleted ✅", paint: "mint", from: archived, to: block.to - 4, at: { x: 1560, y: 260 }, tilt: 3, size: 44 },
    { text: "A real key, by mistake 🔑", paint: "sun", from: secret.at + 12, to: answered - 2, at: { x: 1440, y: 280 }, tilt: -3, size: 44 },
    { text: "Removed before the model saw it 🔒", paint: "mint", from: answered + 8, to: end - 4, at: { x: 1460, y: 330 }, tilt: 3, size: 40 },
  ],
  moods: [{ at: card + 6, mood: "alarm" }, { at: archived, mood: "calm" }],
  lines,
  sounds: [bed(duration, 40), ...spoken(lines), sfx("pop", rule.at + 32), sfx("pop", frameOf(b, at.enabled - 0.6)), sfx("alarm", card + 6), sfx("pop", blocked), sfx("chime", archived), sfx("pop", secret.at + 12), sfx("chime", answered + 8)],
});
