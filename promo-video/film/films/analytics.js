// Use case: the Costs dashboard. One screen, three looks: where the money went, what changed
// against last month, and which skill fails more than the rest.
import { around, bed, defineFeature, display, look, sfx, spoken } from "../feature.js";

const desk = display([0, 2.1, 0]);
const scene = { money: 0, changed: 84, skill: 204, end: 296 };
const duration = 410;

const lines = [
  { audio: "audio/analytics-01.mp3", at: 8, until: scene.changed - 3, text: "Where did *the money go?* 💸" },
  { audio: "audio/analytics-02.mp3", at: scene.changed + 6, until: scene.skill - 3, text: "What changed since last month, *in one sentence.*" },
  { audio: "audio/analytics-03.mp3", at: scene.skill + 6, until: scene.end - 3, text: "And which skill *keeps failing.* 🔎" },
  { audio: "audio/analytics-04.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "analytics",
  kicker: "Costs and analytics",
  duration,
  end: scene.end,
  tagline: ["Know what your agents cost.", "And why."],
  devices: { desk },
  screens: (meta) => {
    const events = meta.costs.events;
    return { desk: [
      // The dashboard opens and its totals load.
      { clip: "costs", from: 0, to: scene.changed, start: events.overview - 0.35, rate: 0.6 },
      // The Compare tab, and the scroll down to "What changed", at the speed it happened.
      { clip: "costs", from: scene.changed, to: scene.changed + 50, start: events.compare - 0.16, rate: 1 },
      { clip: "costs", from: scene.changed + 50, to: scene.skill, start: events.changes + 0.3, rate: 0.3 },
      { clip: "costs", from: scene.skill, to: duration, start: events.insights - 0.3, rate: 0.5 },
    ] };
  },
  shots: [
    { from: 0, to: scene.changed, start: look(desk, 0.5, 0.42, 6.6, 0.3), end: look(desk, 0.5, 0.42, 5.7, 0.1) },
    { from: scene.changed, to: scene.skill, start: look(desk, 0.45, 0.42, 5.9, -0.2), end: look(desk, 0.42, 0.4, 4.9, -0.05) },
    { from: scene.skill, to: scene.end, start: look(desk, 0.62, 0.32, 5.8, 0.2), end: look(desk, 0.64, 0.3, 5.0, 0.05) },
    { from: scene.end, to: duration, start: look(desk, 0.5, 0.45, 7.5, 0.6), end: look(desk, 0.5, 0.45, 9.5, 0.2) },
  ],
  rings: [
    { from: scene.changed + 54, to: scene.skill - 4, ...around(desk, 0.028, 0.228, 0.66, 0.272), sun: true },
    { from: scene.skill + 22, to: scene.end - 3, ...around(desk, 0.503, 0.275, 0.97, 0.337) },
  ],
  stickers: [
    { text: "By project, model and skill", paint: "mint", from: 26, to: scene.changed - 4, at: { x: 1400, y: 720 }, tilt: -3, size: 46 },
    { text: "The why, in one sentence 👆", paint: "sun", from: scene.changed + 56, to: scene.skill - 4, at: { x: 1300, y: 760 }, tilt: 3, size: 46 },
    { text: "Fails 3× more than the rest", paint: "mint", from: scene.skill + 26, to: scene.end - 3, at: { x: 1300, y: 760 }, tilt: -3, size: 46 },
  ],
  lines,
  sounds: [bed(duration, 6), ...spoken(lines), sfx("whoosh", scene.changed - 3), sfx("pop", scene.changed + 56), sfx("whoosh", scene.skill - 3), sfx("pop", scene.skill + 26), sfx("whoosh", scene.end - 3)],
});
