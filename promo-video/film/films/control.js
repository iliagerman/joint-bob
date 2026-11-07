// Feature: the control center, explained step by step. One board of every agent in every project,
// each with its running summary; a Guardian question answered from its card; Bob, beside the board,
// starting a task in the right project and answering what is left before the release; and on a
// phone, the same Bob answering and scheduling a release that waits for an OK.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, handset, look, say, sfx, spoken } from "../feature.js";

const [board, need, task, question, pocket, tagline] = beats(["control-01", "control-02", "control-03", "control-04", { name: "control-05", hold: 30 }, { name: "control-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0], { dim: [[pocket.from + 4, end]] });
const phone = handset([4.6, 1.8, 1.6], { turn: -0.18, arrive: pocket.from - 6 });

const lines = [
  say(board, "The control center is *one board for every agent you have running,* in every project, each with a live line of what it's doing right now."),
  say(need, "When an agent needs you, it rises to the top. Here, Guardian asks before a command deletes old snapshots, and *you allow it right from the card.*", { tone: "sun" }),
  say(task, "Beside the board is Bob. Give it a task in plain words, and *it starts the work in the right project,* marked started by Bob."),
  say(question, "Ask what's left before the release, and *Bob answers from everything that's running.*"),
  say(pocket, "On your phone, the control center is Bob, full screen. *Ask how a fix is going, or have it schedule a release,* and it waits for your OK before it creates anything."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("control");
const hand = events("controlPhone");
// The board: the question waiting at the top, three jobs running with their summaries.
const a = fit("control", board.from, board.to, 0.4, at.need - 0.4);
// Guardian's question on its card, and Allow once.
const b = fit("control", need.from, need.to, at.need - 0.4, at.cleared + 2.0);
// A task told to Bob, started in checkout-api, and its card on the board.
const c = fit("control", task.from, task.to, at.task - 0.4, at.card + 2.6);
// A question, answered from what is running.
const d = fit("control", question.from, pocket.from, at.question - 0.4, at.answered + 4.0);
const e = { clip: "control", from: pocket.from, to: duration, start: at.answered + 4.0, rate: 0.2 };
// On the phone: a question, then the release scheduled with Create it.
const p1 = fit("controlPhone", pocket.from - 10, pocket.at + 120, hand.ask - 0.6, hand.answered + 1.6);
const p2 = fit("controlPhone", pocket.at + 120, end, hand.schedule - 0.4, hand.scheduled + 2.4);
const allowed = frameOf(b, at.allowed);
const started = frameOf(c, at.started);
const answered = frameOf(d, at.answered);
const proposal = frameOf(p2, hand.proposal);
const scheduled = frameOf(p2, hand.scheduled);

export default defineFeature({
  id: "control",
  kicker: "Control center",
  duration,
  end,
  tagline: ["Every agent,", "one place."],
  devices: { desk, phone },
  screens: () => ({
    desk: [a, b, c, d, e],
    phone: [p1, p2, { clip: "controlPhone", from: end, to: duration, start: hand.scheduled + 2.4, rate: 0.3 }],
  }),
  shots: [
    { from: board.from, to: board.to, start: look(desk, 0.5, 0.5, 6.0, 0.2), end: look(desk, 0.36, 0.52, 4.8, 0.05) },
    { from: need.from, to: allowed, start: look(desk, 0.24, 0.36, 4.6, 0.1), end: look(desk, 0.22, 0.3, 3.9, 0.04) },
    { from: allowed, to: need.to, start: look(desk, 0.3, 0.44, 4.6, 0.05), end: look(desk, 0.32, 0.5, 4.4, 0) },
    { from: task.from, to: started, start: look(desk, 0.8, 0.8, 4.6, -0.1), end: look(desk, 0.82, 0.84, 4.0, -0.04) },
    { from: started, to: task.to, start: look(desk, 0.5, 0.42, 4.8, 0.05), end: look(desk, 0.42, 0.38, 4.4, 0.02) },
    { from: question.from, to: pocket.from, start: look(desk, 0.82, 0.6, 4.6, -0.1), end: look(desk, 0.82, 0.62, 3.8, -0.04) },
    { from: pocket.from, to: end, start: { position: [4.6, 1.82, 7.8], target: [4.6, 1.6, 1.6] }, end: { position: [4.75, 1.8, 6.6], target: [4.7, 1.6, 1.6] } },
    { from: end, to: duration, start: { position: [2.0, 3.2, 11.5], target: [2.2, 1.9, 0] }, end: { position: [2.2, 3.4, 13], target: [2.2, 1.9, 0] } },
  ],
  rings: [
    { from: board.at + 40, to: board.to - 4, ...around(desk, 0.07, 0.11, 0.69, 0.98) },
    { from: need.at + 8, to: allowed + 12, ...around(desk, 0.107, 0.293, 0.383, 0.673), sun: true },
    { from: started, to: task.to - 4, ...around(desk, 0.107, 0.29, 0.383, 0.535) },
    { from: answered, to: question.to - 4, ...around(desk, 0.69, 0.48, 0.99, 0.91) },
  ],
  stickers: [
    { text: "Every agent, every project 🗂️", paint: "ink", from: board.at + 40, to: board.to - 4, at: { x: 1460, y: 230 }, tilt: 3, size: 42 },
    { text: "Guardian asks first ✋", paint: "sun", from: need.at + 10, to: allowed - 2, at: { x: 1460, y: 260 }, tilt: -3, size: 46 },
    { text: "Allowed once ✅", paint: "mint", from: allowed + 4, to: need.to - 4, at: { x: 1460, y: 260 }, tilt: 3, size: 46 },
    { text: "Started by Bob, in checkout-api 🤖", paint: "mint", from: started + 4, to: task.to - 4, at: { x: 1400, y: 230 }, tilt: -3, size: 40 },
    { text: "From what's running 💬", paint: "ink", from: answered + 4, to: question.to - 4, at: { x: 1320, y: 230 }, tilt: 3, size: 44 },
    { text: "Bob, in your pocket 📱", paint: "mint", from: pocket.at + 20, to: proposal - 4, at: { x: 1460, y: 300 }, tilt: 3, size: 44 },
    { text: "Waits for your OK ✋", paint: "sun", from: proposal + 4, to: scheduled - 2, at: { x: 1460, y: 300 }, tilt: -3, size: 44 },
    { text: "Mondays, 6 PM 🚀", paint: "mint", from: scheduled + 2, to: end - 4, at: { x: 1460, y: 300 }, tilt: 3, size: 50 },
  ],
  moods: [{ at: need.at + 10, mood: "alarm" }, { at: allowed + 4, mood: "calm" }],
  lines,
  sounds: [bed(duration, 30), ...spoken(lines), sfx("pop", board.at + 40), sfx("alarm", need.at + 10), sfx("chime", allowed + 4), sfx("chime", started + 4), sfx("pop", answered + 4), sfx("pop", pocket.at + 20), sfx("pop", proposal + 4), sfx("chime", scheduled + 2)],
});
