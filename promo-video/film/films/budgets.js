// Feature: cost control, explained step by step. A cluster manager sets limits for the whole
// team, a project gets a tighter daily limit and one conversation a total; the conversation warns
// at 80%, and one over its limit holds new work.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [team, tighter, warning, limit, tagline] = beats(["budgets-01", "budgets-02", "budgets-03", "budgets-04", { name: "budgets-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(team, "Agents can run for hours, so Joint Bob lets you *put a ceiling on what they spend.* If you manage a team, you set limits for everyone under Settings, Cluster, Budget."),
  say(tighter, "Any project or conversation can also get *a tighter limit of its own,* by the hour, day, week, month or in total, from the Budget option in its menu."),
  say(warning, "As spending gets close, *at eighty percent of a limit,* a notice appears above the message box, showing how much has been used, and of which limit.", { tone: "sun" }),
  say(limit, "And once a limit is reached, Joint Bob *doesn't start any new work* until it resets or you raise it, so there are no surprise bills."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("budgets");
// Settings → Cluster → Budget, the team's limits typed in and saved.
const a = fit("budgets", team.from, team.to, at.cluster - 0.6, at.clusterSaved + 0.8);
// The project's Budget… dialog, then one conversation's.
const middle = Math.round((tighter.from + tighter.to) / 2);
const b1 = fit("budgets", tighter.from, middle, at.project - 0.4, at.projectSaved + 0.2);
const b2 = fit("budgets", middle, tighter.to, at.conversation - 0.3, at.warning - 0.7);
// The amber notice above the composer.
const c = fit("budgets", warning.from, warning.to, at.warning - 0.2, at.warning + 3.2);
// A conversation over its limit: the red notice, and a new message that waits.
const halfway = Math.round((limit.from + limit.to) / 2);
const d1 = fit("budgets", limit.from, halfway, at.over - 0.4, at.over + 2.2);
const d2 = fit("budgets", halfway, end, at.sent - 2.4, at.sent + 4.0);
const waits = frameOf(d2, at.sent + 0.4);

export default defineFeature({
  id: "budgets",
  kicker: "Cost control",
  duration,
  end,
  tagline: ["Your agents,", "on a budget."],
  devices: { desk },
  screens: () => ({ desk: [a, b1, b2, c, d1, d2] }),
  shots: [
    { from: team.from, to: team.to, start: look(desk, 0.55, 0.55, 6.2, 0.2), end: look(desk, 0.6, 0.64, 4.6, 0.05) },
    { from: tighter.from, to: middle, start: look(desk, 0.5, 0.48, 4.8, -0.1), end: look(desk, 0.5, 0.48, 4.1, -0.04) },
    { from: middle, to: tighter.to, start: look(desk, 0.52, 0.5, 4.6, 0.1), end: look(desk, 0.52, 0.5, 4.0, 0.04) },
    { from: warning.from, to: warning.to, start: look(desk, 0.72, 0.72, 4.8, -0.1), end: look(desk, 0.73, 0.78, 3.8, -0.04) },
    { from: limit.from, to: halfway, start: look(desk, 0.72, 0.76, 4.2, 0.1), end: look(desk, 0.72, 0.78, 3.8, 0.04) },
    { from: halfway, to: end, start: look(desk, 0.66, 0.62, 4.8), end: look(desk, 0.64, 0.6, 4.2) },
    { from: end, to: duration, start: { position: [0.2, 3.2, 11.5], target: [0, 1.9, 0] }, end: { position: [0.4, 3.4, 13], target: [0, 1.9, 0] } },
  ],
  rings: [
    { from: frameOf(a, at.typed - 2.5), to: team.to - 4, ...around(desk, 0.2, 0.535, 0.955, 0.77) },
    { from: frameOf(b1, at.project + 1.4), to: middle - 2, ...around(desk, 0.443, 0.43, 0.56, 0.475), sun: true },
    { from: frameOf(b2, at.conversation + 1.6), to: tighter.to - 4, ...around(desk, 0.57, 0.495, 0.7, 0.55) },
    { from: warning.at + 14, to: warning.to - 4, ...around(desk, 0.472, 0.848, 0.99, 0.885), sun: true },
    { from: limit.at + 10, to: halfway - 2, ...around(desk, 0.472, 0.848, 0.99, 0.885), sun: true },
    { from: waits, to: end - 4, ...around(desk, 0.545, 0.3, 0.668, 0.72) },
  ],
  stickers: [
    { text: "Whole team: $500 a month", paint: "ink", from: team.at + 40, to: team.to - 4, at: { x: 1460, y: 230 }, tilt: 3, size: 42 },
    { text: "This project: $25 a day", paint: "sun", from: frameOf(b1, at.project + 1.4), to: middle - 2, at: { x: 1460, y: 230 }, tilt: -3, size: 42 },
    { text: "This conversation: $37 in total", paint: "mint", from: frameOf(b2, at.conversation + 1.6), to: tighter.to - 4, at: { x: 1430, y: 230 }, tilt: 3, size: 42 },
    { text: "⚠️ 86% used", paint: "sun", from: warning.at + 16, to: warning.to - 4, at: { x: 1400, y: 300 }, tilt: -3, size: 50 },
    { text: "Limit reached", paint: "danger", from: limit.at + 12, to: halfway - 2, at: { x: 1400, y: 300 }, tilt: 3, size: 50 },
    { text: "New work waits ⏸", paint: "mint", from: waits, to: end - 4, at: { x: 1460, y: 300 }, tilt: -3, size: 46 },
  ],
  moods: [{ at: warning.at + 14, mood: "morning" }, { at: limit.at + 10, mood: "alarm" }, { at: waits, mood: "calm" }],
  lines,
  sounds: [bed(duration, 30), ...spoken(lines), sfx("pop", team.at + 40), sfx("pop", frameOf(b1, at.project + 1.4)), sfx("pop", frameOf(b2, at.conversation + 1.6)), sfx("pop", warning.at + 16), sfx("alarm", limit.at + 12), sfx("chime", waits)],
});
