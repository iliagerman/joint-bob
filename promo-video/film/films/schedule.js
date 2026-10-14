// Use case: a scheduled task. A support line's calls are reviewed every hour by an agent
// that scores them, fixes what is causing the bad ones and opens a pull request. The report
// waits in the review inbox.
import { around, bed, defineFeature, display, handset, look, sfx, spoken } from "../feature.js";

const scene = { chore: 0, form: 84, runs: 186, report: 276, inbox: 402, end: 474 };
const duration = 590;

const desk = display([0, 2.1, 0], { dim: [[scene.inbox + 4, scene.end]] });
const phone = handset([4.6, 1.8, 1.6], { turn: -0.18, arrive: scene.inbox - 6 });

const lines = [
  { audio: "audio/schedule-01.mp3", at: 4, until: scene.form - 3, text: "Some checks, *nobody wants to do* every hour. 😩" },
  { audio: "audio/schedule-02.mp3", at: scene.form + 6, until: scene.runs - 3, text: "So *schedule an agent.* Tell it what to look for." },
  { audio: "audio/schedule-03.mp3", at: scene.runs + 6, until: scene.report - 3, text: "Every hour, it *reviews the support calls.* 📞" },
  { audio: "audio/schedule-04.mp3", at: scene.report + 6, until: scene.inbox - 3, text: "Finds the cause, fixes it, *opens a PR.*" },
  { audio: "audio/schedule-05.mp3", at: scene.inbox + 6, until: scene.end - 3, text: "You just *read the report.* ☕" },
  { audio: "audio/schedule-06.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "schedule",
  kicker: "Scheduled tasks",
  duration,
  end: scene.end,
  tagline: ["Set it once.", "It keeps watching."],
  devices: { desk, phone },
  screens: (meta) => {
    const events = meta.schedule.events;
    const inbox = meta.scheduleInbox.events;
    return {
      desk: [
        // The project's menu, and the scheduled tasks it opens.
        { clip: "schedule", from: 0, to: scene.form, start: events.dialog - 2.2, rate: 1 },
        // The form, typed faster than it was, then held.
        { clip: "schedule", from: scene.form, to: scene.form + 66, start: events.form + 0.1, rate: (events.typed - events.form - 0.1) / (66 / 30) },
        { clip: "schedule", from: scene.form + 66, to: scene.runs, start: events.typed + 0.3, rate: 0 },
        // The saved task, then the conversation its run starts, appearing by itself.
        { clip: "schedule", from: scene.runs, to: scene.runs + 36, start: events.saved + 0.5, rate: 0.5 },
        { clip: "schedule", from: scene.runs + 36, to: scene.report, start: events.appeared - 0.5, rate: 1 },
        { clip: "schedule", from: scene.report, to: scene.report + 24, start: events.open - 0.4, rate: 1 },
        { clip: "schedule", from: scene.report + 24, to: duration, start: events.reported - 0.2, rate: 1 },
      ],
      phone: [
        { clip: "scheduleInbox", from: scene.inbox - 10, to: scene.inbox + 28, start: Math.max(0, inbox.inbox), rate: 0.8 },
        { clip: "scheduleInbox", from: scene.inbox + 28, to: duration, start: inbox.report + 0.3, rate: 0.5 },
      ],
    };
  },
  shots: [
    { from: 0, to: scene.form, start: look(desk, 0.4, 0.45, 6.4, 0.3), end: look(desk, 0.42, 0.45, 5.6, 0.1) },
    { from: scene.form, to: scene.runs, start: look(desk, 0.5, 0.42, 5.2, 0.15), end: look(desk, 0.5, 0.42, 4.5, 0.05) },
    { from: scene.runs, to: scene.runs + 36, start: look(desk, 0.5, 0.45, 4.9, -0.1), end: look(desk, 0.5, 0.45, 4.4, -0.05) },
    { from: scene.runs + 36, to: scene.report, start: look(desk, 0.38, 0.58, 5.0, -0.1), end: look(desk, 0.36, 0.6, 4.2, -0.05) },
    { from: scene.report, to: scene.inbox, start: look(desk, 0.72, 0.45, 5.4, -0.15), end: look(desk, 0.72, 0.47, 4.5, -0.05) },
    { from: scene.inbox, to: scene.end, start: { position: [4.6, 1.82, 7.8], target: [4.6, 1.6, 1.6] }, end: { position: [4.75, 1.8, 6.6], target: [4.7, 1.6, 1.6] } },
    { from: scene.end, to: duration, start: { position: [2.0, 3.2, 11.5], target: [2.2, 1.9, 0] }, end: { position: [2.2, 3.4, 13], target: [2.2, 1.9, 0] } },
  ],
  rings: [
    { from: scene.form + 24, to: scene.form + 66, ...around(desk, 0.252, 0.346, 0.747, 0.483), sun: true },
    { from: scene.form + 68, to: scene.runs - 3, ...around(desk, 0.252, 0.534, 0.495, 0.581) },
    { from: scene.runs + 46, to: scene.report - 3, ...around(desk, 0.2375, 0.559, 0.457, 0.681) },
    { from: scene.report + 44, to: scene.report + 84, ...around(desk, 0.523, 0.34, 0.942, 0.476), sun: true },
    { from: scene.report + 86, to: scene.inbox - 3, ...around(desk, 0.52, 0.487, 0.715, 0.527) },
  ],
  stickers: [
    { text: "📞 42 support calls an hour", paint: "ink", from: 16, to: scene.form - 4, at: { x: 1440, y: 240 }, tilt: 3, size: 44 },
    { text: "Who listens to them all?", paint: "sun", from: 40, to: scene.form - 4, at: { x: 1460, y: 350 }, tilt: -3, size: 40 },
    { text: "① What to check", paint: "sun", from: scene.form + 24, to: scene.form + 65, at: { x: 1620, y: 330 }, tilt: 3, size: 44 },
    { text: "② How often", paint: "mint", from: scene.form + 68, to: scene.runs - 3, at: { x: 1250, y: 720 }, tilt: -3, size: 44 },
    { text: "Saved. Next run: 8:00 ⏰", paint: "mint", from: scene.runs + 6, to: scene.runs + 35, at: { x: 1470, y: 260 }, tilt: 3, size: 44 },
    { text: "⏰ On the hour, by itself", paint: "ink", from: scene.runs + 46, to: scene.report - 3, at: { x: 1380, y: 300 }, tilt: -3, size: 46 },
    { text: "🔎 Found the cause", paint: "sun", from: scene.report + 44, to: scene.report + 84, at: { x: 420, y: 330 }, tilt: -4, size: 46 },
    { text: "🎉 PR #88 opened", paint: "mint", from: scene.report + 88, to: scene.inbox - 3, at: { x: 440, y: 520 }, tilt: 4, size: 56 },
    { text: "📥 Waiting in your inbox", paint: "mint", from: scene.inbox + 22, to: scene.end - 3, at: { x: 1470, y: 380 }, tilt: 3, size: 44 },
  ],
  confetti: [{ at: scene.report + 88, origin: { x: 1150, y: 520 }, until: scene.inbox }],
  lines,
  sounds: [bed(duration, 12), ...spoken(lines), sfx("whoosh", scene.form - 3), sfx("pop", scene.form + 24), sfx("pop", scene.form + 68), sfx("whoosh", scene.runs - 3), sfx("chime", scene.runs + 44), sfx("whoosh", scene.report - 3), sfx("pop", scene.report + 44), sfx("chime", scene.report + 86), sfx("party", scene.report + 88), sfx("whoosh", scene.inbox - 6), sfx("pop", scene.inbox + 22), sfx("whoosh", scene.end - 3)],
});
