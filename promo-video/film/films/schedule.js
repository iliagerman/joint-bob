// Feature: scheduled tasks, explained step by step. A support line's calls are reviewed every
// hour: the task is made in the project's Scheduled tasks dialog, its run starts a conversation
// by itself, the agent fixes what it finds and opens a pull request, and the report waits in the
// review inbox.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, handset, look, say, sfx, spoken } from "../feature.js";

const [chore, form, runs, report, inbox, tagline] = beats(["schedule-01", "schedule-02", "schedule-03", "schedule-04", { name: "schedule-05", hold: 20 }, { name: "schedule-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0], { dim: [[inbox.from + 4, end]] });
const phone = handset([4.6, 1.8, 1.6], { turn: -0.18, arrive: inbox.from - 6 });

const lines = [
  say(chore, "Some checks need doing every hour, and nobody wants to do them. *A scheduled task hands that job to an agent.*"),
  say(form, "You open a project's scheduled tasks, *write what the agent should look for,* and choose how often it runs, on which machine, and with which agent."),
  say(runs, "From then on, *it runs by itself.* Every hour, a new conversation starts, and the agent reviews that hour's support calls."),
  say(report, "When it finds a problem, it *traces the cause, fixes it, and opens a pull request,* then writes up what it did."),
  say(inbox, "The report *waits in your review inbox,* so all you have to do is read it."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("schedule");
const morning = events("scheduleInbox");
// The project's menu, and the Scheduled tasks dialog it opens.
const a = fit("schedule", chore.from, chore.to, 0.6, at.form + 0.2);
// The form typed, then saved.
const b = fit("schedule", form.from, form.to, at.form + 0.2, at.saved + 1.0);
// The run's conversation appearing by itself, working.
const c = fit("schedule", runs.from, runs.to, at.closed - 0.6, at.open + 2.2);
// Its report.
const d = fit("schedule", report.from, report.to, at.open + 2.2, at.reported + 2.0);
const typed = frameOf(b, at.typed - 1.6);
const reported = frameOf(d, at.reported);

export default defineFeature({
  id: "schedule",
  kicker: "Scheduled tasks",
  duration,
  end,
  tagline: ["Set it once.", "It keeps watching."],
  devices: { desk, phone },
  screens: () => ({
    desk: [a, b, c, d],
    phone: [fit("scheduleInbox", inbox.from - 10, duration, Math.max(0, morning.inbox - 0.1), morning.report + 3.0)],
  }),
  shots: [
    { from: chore.from, to: chore.to, start: look(desk, 0.4, 0.45, 6.4, 0.3), end: look(desk, 0.45, 0.45, 5.4, 0.1) },
    { from: form.from, to: form.to, start: look(desk, 0.5, 0.42, 5.2, 0.15), end: look(desk, 0.5, 0.44, 4.5, 0.05) },
    { from: runs.from, to: runs.to, start: look(desk, 0.38, 0.58, 5.0, -0.1), end: look(desk, 0.36, 0.6, 4.2, -0.05) },
    { from: report.from, to: inbox.from, start: look(desk, 0.62, 0.45, 5.4, -0.15), end: look(desk, 0.6, 0.47, 4.5, -0.05) },
    { from: inbox.from, to: end, start: { position: [4.6, 1.82, 7.8], target: [4.6, 1.6, 1.6] }, end: { position: [4.75, 1.8, 6.6], target: [4.7, 1.6, 1.6] } },
    { from: end, to: duration, start: { position: [2.0, 3.2, 11.5], target: [2.2, 1.9, 0] }, end: { position: [2.2, 3.4, 13], target: [2.2, 1.9, 0] } },
  ],
  rings: [
    { from: typed, to: frameOf(b, at.typed + 1.0), ...around(desk, 0.252, 0.346, 0.747, 0.483), sun: true },
    { from: frameOf(b, at.typed + 1.0), to: form.to - 4, ...around(desk, 0.252, 0.534, 0.495, 0.581) },
    { from: frameOf(c, at.appeared + 0.3), to: runs.to - 4, ...around(desk, 0.2375, 0.559, 0.457, 0.681) },
    { from: reported, to: reported + 60, ...around(desk, 0.51, 0.335, 0.675, 0.505), sun: true },
    { from: reported + 62, to: inbox.from - 4, ...around(desk, 0.51, 0.26, 0.675, 0.72) },
  ],
  stickers: [
    { text: "42 support calls an hour 📞", paint: "ink", from: chore.at + 20, to: chore.to - 4, at: { x: 1440, y: 240 }, tilt: 3, size: 42 },
    { text: "① What to check", paint: "sun", from: typed, to: frameOf(b, at.typed + 1.0), at: { x: 1620, y: 330 }, tilt: 3, size: 42 },
    { text: "② How often, where, which agent", paint: "mint", from: frameOf(b, at.typed + 1.0), to: form.to - 4, at: { x: 1250, y: 720 }, tilt: -3, size: 40 },
    { text: "On the hour, by itself ⏰", paint: "ink", from: frameOf(c, at.appeared + 0.3), to: runs.to - 4, at: { x: 1380, y: 300 }, tilt: -3, size: 44 },
    { text: "Found the cause 🔎", paint: "sun", from: reported, to: reported + 60, at: { x: 420, y: 330 }, tilt: -4, size: 44 },
    { text: "PR #88 opened 🎉", paint: "mint", from: reported + 62, to: inbox.from - 4, at: { x: 440, y: 520 }, tilt: 4, size: 50 },
    { text: "Waiting in your inbox 📥", paint: "mint", from: inbox.at + 30, to: end - 4, at: { x: 1470, y: 380 }, tilt: 3, size: 42 },
  ],
  confetti: [{ at: reported + 62, origin: { x: 1150, y: 520 }, until: inbox.from }],
  lines,
  sounds: [bed(duration, 12), ...spoken(lines), sfx("pop", chore.at + 20), sfx("pop", typed), sfx("pop", frameOf(b, at.typed + 1.0)), sfx("chime", frameOf(c, at.appeared + 0.3)), sfx("pop", reported), sfx("party", reported + 62), sfx("pop", inbox.at + 30)],
});
