// Feature: dashboards, explained step by step. A dashboard is described in a sentence; a
// dashboard agent finds the data, builds the page and writes a script that refreshes it without
// AI; the draft is checked, saved, and refreshed with one click.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [ask, build, draft, refresh, tagline] = beats(["dashboards-01", "dashboards-02", "dashboards-03", "dashboards-04", { name: "dashboards-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(ask, "Every project can have its own dashboards, and you don't have to build them yourself. *You just describe what you want to see.*"),
  say(build, "A dashboard agent then *explores where the data lives,* builds the page, and writes a small script that knows how to refresh it."),
  say(draft, "You check the draft, and save it. Its charts, headline numbers and tables *run in a sandbox,* with no access to the network."),
  say(refresh, "From then on, Refresh simply runs that script, so *new numbers arrive in seconds,* without another call to the AI."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("dashboards");
// The request, typed into the project's new dashboard.
const a = fit("dashboards", ask.from, ask.to, at.empty - 0.4, at.typed + 0.6);
// The dashboard agent at work, then its note about what it built.
const b = fit("dashboards", build.from, build.to, at.building - 0.4, at.built + 2.0);
// The draft: numbers, errors per hour with the fix marked, the top errors; then saved.
const c = fit("dashboards", draft.from, draft.to, at.tested - 3.4, at.saved - 0.2);
// Refreshed by its script.
// Refreshed by its script: the click, the new numbers, then they stay.
const d = fit("dashboards", refresh.from, refresh.at + 100, at.refresh - 0.6, at.refresh + 2.8);
const note = frameOf(b, at.built - 0.2);
const refreshed = frameOf(d, at.refresh - 0.2);

export default defineFeature({
  id: "dashboards",
  kicker: "Dashboards",
  duration,
  end,
  tagline: ["Ask for a dashboard.", "Get one."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c, d] }),
  shots: [
    { from: ask.from, to: ask.to, start: look(desk, 0.5, 0.45, 6.0, 0.2), end: look(desk, 0.5, 0.48, 4.4, 0.05) },
    { from: build.from, to: note, start: look(desk, 0.5, 0.42, 5.4, -0.1), end: look(desk, 0.58, 0.48, 4.6, -0.04) },
    { from: note, to: build.to, start: look(desk, 0.3, 0.45, 4.6, 0.1), end: look(desk, 0.28, 0.42, 4.0, 0.04) },
    { from: draft.from, to: draft.to, start: look(desk, 0.62, 0.55, 5.4, 0.1), end: look(desk, 0.62, 0.52, 4.5, 0.04) },
    { from: refresh.from, to: refresh.at + 70, start: look(desk, 0.55, 0.3, 5.0, -0.1), end: look(desk, 0.55, 0.3, 4.6, -0.04) },
    { from: refresh.at + 70, to: end, start: look(desk, 0.6, 0.5, 5.4), end: look(desk, 0.6, 0.5, 4.8) },
    { from: end, to: duration, start: { position: [0.2, 3.2, 11.5], target: [0, 1.9, 0] }, end: { position: [0.4, 3.4, 13], target: [0, 1.9, 0] } },
  ],
  rings: [
    { from: ask.at + 50, to: ask.to - 4, ...around(desk, 0.238, 0.393, 0.761, 0.585) },
    { from: build.at + 20, to: Math.min(note - 2, frameOf(b, at.preview - 0.6)), ...around(desk, 0.435, 0.443, 0.873, 0.693) },
    { from: note + 6, to: build.to - 4, ...around(desk, 0.035, 0.343, 0.308, 0.463), sun: true },
    { from: draft.at + 30, to: draft.to - 4, ...around(desk, 0.347, 0.388, 0.972, 0.747) },
    { from: refreshed, to: refresh.at + 70, ...around(desk, 0.378, 0.038, 0.675, 0.078), sun: true },
  ],
  stickers: [
    { text: "Just describe it 💬", paint: "ink", from: ask.at + 50, to: ask.to - 4, at: { x: 1480, y: 230 }, tilt: 3, size: 44 },
    { text: "It finds the data 🔎", paint: "mint", from: build.at + 22, to: note - 2, at: { x: 1460, y: 230 }, tilt: -3, size: 44 },
    { text: "Plus a refresh script 📜", paint: "sun", from: note + 8, to: build.to - 4, at: { x: 760, y: 330 }, tilt: 3, size: 44 },
    { text: "Sandboxed 🔒", paint: "ink", from: draft.at + 32, to: draft.to - 4, at: { x: 700, y: 215 }, tilt: 3, size: 44 },
    { text: "One click. No AI 🔄", paint: "sun", from: refreshed, to: end - 4, at: { x: 1400, y: 360 }, tilt: -3, size: 46 },
  ],
  lines,
  sounds: [bed(duration, 50), ...spoken(lines), sfx("pop", ask.at + 50), sfx("pop", build.at + 22), sfx("pop", note + 8), sfx("chime", draft.at + 32), sfx("pop", refreshed)],
});
