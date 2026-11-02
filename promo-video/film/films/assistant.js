// Feature: assistants, explained step by step. A conversation becomes Alex's release assistant;
// he tells it what to look after; it answers how a feature is going from the project's
// conversations and books a review in his calendar; from his phone he schedules a launch for every
// Monday at six; and at six the launch runs through the assistant and reports in the same chat.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, handset, look, say, sfx, spoken } from "../feature.js";

const [make, tell, progress, meeting, schedule, launch, tagline] = beats([
  "assistant-01", "assistant-02", "assistant-03", "assistant-04", { name: "assistant-05", hold: 10 }, { name: "assistant-06", hold: 20 }, { name: "assistant-07", min: 116 },
]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0], { dim: [[schedule.from, launch.from + 2]] });
const phone = handset([4.6, 1.8, 1.6], { turn: -0.18, arrive: schedule.from - 8, leave: launch.from - 4 });

const lines = [
  say(make, "Any conversation can become *an assistant:* an agent with a name, its own instructions, and one chat that you can open on your laptop or your phone."),
  say(tell, "You tell it *what to look after.* Alex's release assistant keeps track of the checkout work, his meetings, and his launches."),
  say(progress, "Ask how a feature is going, and *it answers from the work in your project's conversations:* what's merged, what's left, and what's in the way."),
  say(meeting, "With your calendar connected, *it books meetings too,* like a review with Maya tomorrow at ten."),
  say(schedule, "Most importantly, *it schedules launches.* From his phone, Alex sets one for every Monday at six, with the steps the release should follow."),
  say(launch, "At six, *the launch runs through the assistant on its own,* and the report lands in the same chat."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("assistant");
const pocket = events("assistantPhone");
// The conversation's Create assistant button, a name, and the assistant's own page.
const a = fit("assistant", make.from, make.to, at.dialog - 0.6, at.page + 1.6);
// Its settings: what it is for.
const b = fit("assistant", tell.from, tell.to, at.page + 1.2, at.instructions - 0.6);
// The question typed, then (past the wait while it works) the answer.
const progressHalf = progress.at + 110;
const c1 = fit("assistant", progress.from, progressHalf, at.asked - 0.3, at.asked + 2.6);
const c2 = fit("assistant", progressHalf, progress.to, at.book - 0.2, at.book + 2.4);
// The meeting asked for, then booked.
const meetingHalf = meeting.at + 80;
const d1 = fit("assistant", meeting.from, meetingHalf, at.book + 0.2, at.booked - 1.6);
const d2 = fit("assistant", meetingHalf, meeting.to, at.booked + 0.6, at.booked + 4.0);
// On the phone: the Scheduled task form, filled in for Mondays at six, and saved.
const formShown = pocket.scheduled - 9.4;
const e1 = fit("assistantPhone", schedule.from - 8, schedule.at + 200, formShown, pocket.scheduled + 0.2);
const e2 = fit("assistantPhone", schedule.at + 200, schedule.to, pocket.scheduled + 1.2, pocket.scheduled + 4.6);
// Back on the laptop: the launch in the assistant's tasks, then its report in the chat.
const launchHalf = launch.at + 70;
const f1 = fit("assistant", launch.from, launchHalf, at.tasks + 0.2, at.tasks + 2.8);
const f2 = fit("assistant", launchHalf, end, at.launched + 0.2, at.launched + 3.2);
const answered = c2.from + 8;
const booked = d2.from + 6;
const timed = frameOf(e1, pocket.scheduled - 2.6);
const saved = e2.from + 4;
const reported = f2.from + 6;

export default defineFeature({
  id: "assistant",
  kicker: "Assistants",
  duration,
  end,
  tagline: ["Your launches,", "on schedule."],
  devices: { desk, phone },
  screens: () => ({ desk: [a, b, c1, c2, d1, d2, f1, f2], phone: [e1, e2] }),
  shots: [
    { from: make.from, to: make.to, start: look(desk, 0.5, 0.48, 5.8, 0.2), end: look(desk, 0.49, 0.5, 4.4, 0.05) },
    { from: tell.from, to: tell.to, start: look(desk, 0.5, 0.45, 4.6, -0.1), end: look(desk, 0.5, 0.56, 3.8, -0.04) },
    { from: progress.from, to: progressHalf, start: look(desk, 0.5, 0.55, 4.2, 0.1), end: look(desk, 0.55, 0.6, 3.8, 0.05) },
    { from: progressHalf, to: progress.to, start: look(desk, 0.46, 0.7, 3.9, 0.05), end: look(desk, 0.44, 0.72, 3.4, 0.02) },
    { from: meeting.from, to: meetingHalf, start: look(desk, 0.5, 0.82, 3.9, -0.1), end: look(desk, 0.5, 0.85, 3.6, -0.05) },
    { from: meetingHalf, to: meeting.to, start: look(desk, 0.5, 0.32, 3.8, -0.05), end: look(desk, 0.48, 0.3, 3.3, -0.02) },
    { from: schedule.from, to: schedule.at + 200, start: { position: [4.62, 1.98, 5.4], target: [4.6, 1.95, 1.6] }, end: { position: [4.7, 1.96, 4.7], target: [4.66, 1.95, 1.6] } },
    { from: schedule.at + 200, to: schedule.to, start: { position: [4.68, 2.08, 4.9], target: [4.64, 2.06, 1.6] }, end: { position: [4.72, 2.08, 4.5], target: [4.68, 2.06, 1.6] } },
    { from: launch.from, to: launchHalf, start: look(desk, 0.5, 0.45, 4.6, 0.1), end: look(desk, 0.5, 0.4, 4.0, 0.05) },
    { from: launchHalf, to: end, start: look(desk, 0.42, 0.45, 3.9, -0.05), end: look(desk, 0.4, 0.48, 3.4, -0.02) },
    { from: end, to: duration, start: { position: [2.0, 3.2, 11.5], target: [2.2, 1.9, 0] }, end: { position: [2.2, 3.4, 13], target: [2.2, 1.9, 0] } },
  ],
  rings: [
    { from: frameOf(a, at.dialog + 0.6), to: frameOf(a, at.page - 0.3), ...around(desk, 0.32, 0.47, 0.67, 0.53) },
    { from: frameOf(b, at.instructions - 3.4), to: frameOf(b, at.instructions - 1.0), ...around(desk, 0.237, 0.52, 0.763, 0.643) },
    { from: answered, to: progress.to - 4, ...around(desk, 0.24, 0.608, 0.592, 0.872) },
    { from: booked, to: meeting.to - 4, ...around(desk, 0.24, 0.256, 0.718, 0.341) },
    { from: timed, to: e1.to - 2, ...around(phone, 0.07, 0.305, 0.93, 0.555), sun: true },
    { from: saved, to: schedule.to - 4, ...around(phone, 0.075, 0.255, 0.925, 0.5) },
    { from: f1.from + 10, to: launchHalf - 4, ...around(desk, 0.25, 0.275, 0.75, 0.42) },
    { from: reported, to: end - 4, ...around(desk, 0.24, 0.4, 0.505, 0.6) },
  ],
  stickers: [
    { text: "① Make it an assistant", paint: "ink", from: frameOf(a, at.dialog + 0.6), to: frameOf(a, at.page - 0.3), at: { x: 1480, y: 230 }, tilt: 3, size: 42 },
    { text: "② What it looks after", paint: "mint", from: tell.at + 30, to: tell.to - 4, at: { x: 1480, y: 230 }, tilt: -3, size: 42 },
    { text: "How's it going? Answered ✅", paint: "mint", from: answered, to: progress.to - 4, at: { x: 1440, y: 230 }, tilt: 3, size: 42 },
    { text: "Booked with Maya 📅", paint: "sun", from: booked, to: meeting.to - 4, at: { x: 1460, y: 230 }, tilt: -3, size: 42 },
    { text: "③ Every Monday, 6 PM 🚀", paint: "sun", from: timed, to: schedule.to - 4, at: { x: 640, y: 300 }, tilt: -3, size: 44 },
    { text: "Launched, and reported here ✅", paint: "mint", from: reported, to: end - 4, at: { x: 1420, y: 230 }, tilt: 3, size: 42 },
  ],
  lines,
  sounds: [bed(duration, 60), ...spoken(lines), sfx("pop", frameOf(a, at.dialog + 0.6)), sfx("pop", tell.at + 30), sfx("chime", answered), sfx("chime", booked), sfx("pop", timed), sfx("chime", saved), sfx("chime", reported)],
});
