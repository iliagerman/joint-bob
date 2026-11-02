// Feature: long-running tasks, explained step by step. A long migration is planned on the laptop,
// moved to the home server with "Runs on" and "Take ownership", the laptop is closed, and the
// work is followed and continued from a phone.
import * as THREE from "three";
import { around, beats, bed, defineFeature, display, events, fit, frameOf, handset, linear, look, notebook, say, sfx, spoken } from "../feature.js";
import { easeInOut } from "../timeline.js";

const [plan, move, lid, phoneBeat, next, tagline] = beats(["lid-01", { name: "lid-02", hold: 20 }, { name: "lid-03", hold: 30 }, "lid-04", "lid-05", { name: "lid-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;
const lidCloses = lid.at + 40;

const laptop = notebook({ lid: [[0, 1], [lidCloses, 1], [lidCloses + 24, 0]] });
const server = display([3.9, 2.05, -1.5], { width: 4.8, height: 3.0, turn: -0.14, arrive: lidCloses + 16, dim: [[phoneBeat.from - 4, end]] });
const phone = handset([6.9, 1.75, 1.7], { turn: -0.22, arrive: phoneBeat.from - 4 });

const closed = { position: [2.3, 3.0, 7.0], target: [0.9, 0.5, -0.3] };
const two = { position: [2.4, 3.3, 9.6], target: [2.2, 1.35, -0.8] };
const nearServer = { position: [3.5, 2.7, 8.0], target: [3.5, 1.8, -1.2] };
const phoneShot = { position: [6.5, 1.75, 8.4], target: [6.3, 1.5, 0.6] };
const phoneClose = { position: [6.8, 1.72, 7.5], target: [6.6, 1.5, 0.9] };

const lines = [
  say(plan, "Some tasks take longer than you can stay at your desk. This one, a migration of two hundred test files, *will take about forty minutes.*"),
  say(move, "So before he leaves, Alex *moves it to his home server.* He picks the server in Runs on, and takes ownership there, with the whole conversation and its history."),
  say(lid, "Now he can *close the laptop.* The agent doesn't notice. It keeps working on the server."),
  say(phoneBeat, "On the way home, *the same conversation is on his phone, live,* so he can watch it finish and open the pull request."),
  say(next, "And when it's done, he *tells it what to do next,* right from his phone."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const lap = events("moveLaptop");
const home = events("moveServer");
const hand = events("movePhone");
// The plan, read slowly; then Runs on, the lock, Take ownership, and the move done.
const a = fit("moveLaptop", plan.from, plan.to, 0.3, lap.pick - 0.6);
const pickEnd = move.at + 150;
const b1 = fit("moveLaptop", move.from, pickEnd, lap.pick - 0.6, lap.take + 1.0);
const b2 = fit("moveLaptop", pickEnd, lid.from, lap.taken - 0.8, lap.taken + 1.6);
const c = fit("moveLaptop", lid.from, lidCloses + 30, lap.go - 1.2, lap.go + 0.4);
const taken = frameOf(b2, lap.taken);

export default defineFeature({
  id: "lid",
  kicker: "Long-running tasks",
  duration,
  end,
  tagline: ["Start anywhere.", "Finish anywhere."],
  devices: { laptop, server, phone },
  screens: () => ({
    laptop: [a, b1, b2, c],
    server: [{ clip: "moveServer", from: lidCloses + 12, to: duration, start: home.serverOpen + 4.5, rate: 1 }],
    phone: [
      fit("movePhone", phoneBeat.from - 8, phoneBeat.to, hand.phoneOpen + 4.4, hand.done + 1.2),
      fit("movePhone", next.from, next.to, hand.phoneSend - 1.6, hand.merged - 0.8),
      { clip: "movePhone", from: next.to, to: duration, start: hand.merged - 0.8, rate: 0.6 },
    ],
  }),
  shots: [
    { from: plan.from, to: plan.to, start: look(laptop, 0.6, 0.5, 4.6, 0.4, 0.1), end: look(laptop, 0.58, 0.46, 3.6, 0.2, 0.05) },
    { from: move.from, to: move.at + 60, start: look(laptop, 0.42, 0.3, 3.6, 0.3, 0.05), end: look(laptop, 0.38, 0.22, 3.0, 0.15, 0.03) },
    { from: move.at + 60, to: pickEnd, start: look(laptop, 0.62, 0.74, 3.5, 0.2, 0.05), end: look(laptop, 0.64, 0.8, 3.0, 0.1, 0.03) },
    { from: pickEnd, to: lid.from, start: look(laptop, 0.5, 0.3, 3.8, 0.2, 0.05), end: look(laptop, 0.46, 0.26, 3.3, 0.1, 0.03) },
    { from: lid.from, to: lidCloses, start: look(laptop, 0.6, 0.6, 3.8, 0.2, 0.05), end: look(laptop, 0.6, 0.62, 3.4, 0.1, 0.03) },
    { from: lidCloses, to: lidCloses + 26, start: look(laptop, 0.6, 0.62, 3.4, 0.1, 0.03), end: closed, ease: easeInOut, glide: 0 },
    { from: lidCloses + 26, to: lidCloses + 56, start: closed, end: two, ease: easeInOut, glide: 0 },
    { from: lidCloses + 56, to: phoneBeat.from - 6, start: two, end: nearServer, ease: linear, glide: 0 },
    { from: phoneBeat.from - 6, to: phoneBeat.from + 20, start: nearServer, end: phoneShot, ease: easeInOut, glide: 0 },
    { from: phoneBeat.from + 20, to: end, start: phoneShot, end: phoneClose, ease: linear, glide: 0 },
    { from: end, to: duration, start: { position: [3.2, 3.6, 12.5], target: [3.4, 1.5, 0] }, end: { position: [3.4, 3.8, 14], target: [3.4, 1.5, 0] } },
  ],
  rings: [
    { from: move.at + 10, to: move.at + 58, ...around(laptop, 0.262, 0.105, 0.405, 0.168) },
    { from: move.at + 66, to: pickEnd - 4, ...around(laptop, 0.232, 0.915, 0.99, 0.985), sun: true },
  ],
  stickers: [
    { text: "About 40 minutes ⏳", paint: "sun", from: plan.at + 60, to: plan.to - 4, at: { x: 1480, y: 250 }, tilt: 3, size: 44 },
    { text: "① Runs on: Home server", paint: "mint", from: move.at + 12, to: move.at + 58, at: { x: 1400, y: 250 }, tilt: -3, size: 42 },
    { text: "② Take ownership", paint: "sun", from: move.at + 68, to: pickEnd - 4, at: { x: 1300, y: 330 }, tilt: 3, size: 44 },
    { text: "Now runs on: Home server ✅", paint: "mint", from: taken, to: lid.from - 4, at: { x: 1470, y: 300 }, tilt: -3, size: 44 },
    { text: "💤 asleep", paint: "ink", from: lidCloses + 30, to: phoneBeat.from - 8, at: new THREE.Vector3(0.7, 0.4, 0.3), shift: [0, -50], tilt: -4, size: 36 },
    { text: "Still running ✅", paint: "mint", from: lidCloses + 40, to: phoneBeat.from - 8, at: new THREE.Vector3(server.center.x + 0.9, server.center.y + 1.38, server.center.z + 0.1), tilt: 4, size: 40 },
    { text: "Same conversation, live 📱", paint: "ink", from: phoneBeat.from + 24, to: phoneBeat.to - 4, at: new THREE.Vector3(phone.center.x + 0.75, phone.center.y + 0.55, phone.center.z), shift: [20, 0], tilt: 3, size: 34 },
    { text: "Merged from the sofa 🛋️", paint: "sun", from: next.at + 120, to: end - 4, at: { x: 1560, y: 400 }, tilt: 3, size: 46 },
  ],
  moods: [{ at: lidCloses, mood: "night" }, { at: phoneBeat.from, mood: "calm" }],
  lines,
  sounds: [bed(duration, 0), ...spoken(lines), sfx("pop", plan.at + 60), sfx("pop", move.at + 12), sfx("pop", move.at + 68), sfx("chime", taken), sfx("lid", lidCloses + 20), sfx("pop", phoneBeat.from + 24), sfx("chime", next.at + 120)],
});
