// Feature: the Costs view, explained step by step: where the money went over the last 30 days,
// what changed against last month and who changed it, and which skill fails more than the rest.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [money, changed, skill, tagline] = beats(["analytics-01", "analytics-02", { name: "analytics-03", hold: 20 }, { name: "analytics-04", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(money, "Joint Bob keeps track of *what every conversation costs.* The Costs view shows where the money went, by project, model, label and skill."),
  say(changed, "Compare one period with another, and it tells you *what changed,* and which projects or models made the difference."),
  say(skill, "It also shows which skills cost the most, and *which ones fail more often than the rest,* so you know what to fix first."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("costs");
// The dialog opens on the last 30 days, and its totals load.
const a = fit("costs", money.from, money.to, at.overview + 0.1, at.compare - 0.6);
// The Compare tab, and the scroll down to "What changed".
const b = fit("costs", changed.from, changed.to, at.compare - 0.2, at.changes + 2.8);
// Skills & time, and the skill that fails more.
const c = fit("costs", skill.from, end, at.insights - 0.4, at.insights + 3.0);
const whatChanged = frameOf(b, at.changes + 0.4);

export default defineFeature({
  id: "analytics",
  kicker: "Costs and analytics",
  duration,
  end,
  tagline: ["Know what your agents cost.", "And why."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c] }),
  shots: [
    { from: money.from, to: money.to, start: look(desk, 0.5, 0.42, 6.6, 0.3), end: look(desk, 0.5, 0.42, 5.4, 0.1) },
    { from: changed.from, to: changed.to, start: look(desk, 0.5, 0.42, 5.9, -0.2), end: look(desk, 0.6, 0.4, 5.0, -0.05) },
    { from: skill.from, to: end, start: look(desk, 0.62, 0.32, 5.8, 0.2), end: look(desk, 0.64, 0.3, 5.0, 0.05) },
    { from: end, to: duration, start: look(desk, 0.5, 0.45, 7.5, 0.6), end: look(desk, 0.5, 0.45, 9.5, 0.2) },
  ],
  rings: [
    { from: whatChanged, to: changed.to - 4, ...around(desk, 0.68, 0.175, 0.955, 0.52), sun: true },
    { from: skill.at + 40, to: end - 4, ...around(desk, 0.503, 0.265, 0.965, 0.4) },
  ],
  stickers: [
    { text: "By project, model and skill", paint: "mint", from: money.at + 40, to: money.to - 4, at: { x: 1400, y: 720 }, tilt: -3, size: 42 },
    { text: "−$6.44, and who changed it 👉", paint: "sun", from: whatChanged, to: changed.to - 4, at: { x: 640, y: 300 }, tilt: 3, size: 42 },
    { text: "Fails twice as often as the rest", paint: "mint", from: skill.at + 42, to: end - 4, at: { x: 1300, y: 760 }, tilt: -3, size: 42 },
  ],
  lines,
  sounds: [bed(duration, 6), ...spoken(lines), sfx("pop", money.at + 40), sfx("pop", whatChanged), sfx("pop", skill.at + 42)],
});
