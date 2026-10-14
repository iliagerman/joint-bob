// Use case: a long task that outlives the laptop. It is planned on the laptop, moved to the
// home server with the "Runs on" menu, and followed to its end from a phone.
import * as THREE from "three";
import { around, bed, defineFeature, display, handset, linear, look, notebook, sfx, spoken } from "../feature.js";
import { easeInOut } from "../timeline.js";

const scene = { plan: 0, move: 84, lid: 186, phone: 288, next: 372, end: 450 };
const duration = 566;

const laptop = notebook({ lid: [[0, 1], [214, 1], [238, 0]] });
const server = display([3.9, 2.05, -1.5], { width: 4.8, height: 3.0, turn: -0.14, arrive: 228, dim: [[scene.phone - 4, scene.end]] });
const phone = handset([6.9, 1.75, 1.7], { turn: -0.22, arrive: scene.phone - 4 });

const closed = { position: [2.3, 3.0, 7.0], target: [0.9, 0.5, -0.3] };
const two = { position: [2.4, 3.3, 9.6], target: [2.2, 1.35, -0.8] };
const nearServer = { position: [3.5, 2.7, 8.0], target: [3.5, 1.8, -1.2] };
const phoneShot = { position: [6.5, 1.75, 8.4], target: [6.3, 1.5, 0.6] };
const phoneClose = { position: [6.8, 1.72, 7.5], target: [6.6, 1.5, 0.9] };

const lines = [
  { audio: "audio/lid-01.mp3", at: 6, until: scene.move - 3, text: "A long task. And *you have to leave.* 🏃" },
  { audio: "audio/lid-02.mp3", at: scene.move + 6, until: scene.lid - 3, text: "Move it to *your server.* Two clicks." },
  { audio: "audio/lid-03.mp3", at: scene.lid + 6, until: scene.phone - 3, text: "Close the laptop. *It keeps running.*" },
  { audio: "audio/lid-04.mp3", at: scene.phone + 6, until: scene.next - 3, text: "Watch it finish *from your phone.* 📱" },
  { audio: "audio/lid-05.mp3", at: scene.next + 6, until: scene.end - 3, text: "And tell it *what's next.*" },
  { audio: "audio/lid-06.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "lid",
  kicker: "Long-running tasks",
  duration,
  end: scene.end,
  tagline: ["Start anywhere.", "Finish anywhere."],
  devices: { laptop, server, phone },
  screens: (meta) => {
    const lap = meta.moveLaptop.events;
    const home = meta.moveServer.events;
    const hand = meta.movePhone.events;
    return {
      laptop: [
        // The plan, read slowly; then the three moments of the move, each at the speed it happened.
        { clip: "moveLaptop", from: 0, to: scene.move, start: lap.pick - 1.9, rate: 0.6 },
        { clip: "moveLaptop", from: scene.move, to: scene.move + 36, start: lap.pick - 0.6, rate: 1 },
        { clip: "moveLaptop", from: scene.move + 36, to: scene.move + 66, start: lap.take - 0.7, rate: 1 },
        { clip: "moveLaptop", from: scene.move + 66, to: scene.lid, start: lap.taken - 0.3, rate: 1 },
        { clip: "moveLaptop", from: scene.lid, to: scene.lid + 64, start: lap.go - 1.0, rate: 1 },
      ],
      server: [{ clip: "moveServer", from: 222, to: duration, start: home.serverOpen + 0.4, rate: 1 }],
      phone: [
        { clip: "movePhone", from: scene.phone - 10, to: scene.phone + 42, start: hand.phoneOpen - 0.9, rate: 1 },
        { clip: "movePhone", from: scene.phone + 42, to: scene.next, start: hand.done - 0.9, rate: 1 },
        { clip: "movePhone", from: scene.next, to: scene.next + 38, start: hand.phoneSend - 1.2, rate: 1 },
        { clip: "movePhone", from: scene.next + 38, to: duration, start: hand.merged - 0.6, rate: 1 },
      ],
    };
  },
  shots: [
    { from: 0, to: scene.move, start: look(laptop, 0.6, 0.5, 4.3, 0.4, 0.1), end: look(laptop, 0.58, 0.46, 3.6, 0.2, 0.05) },
    { from: scene.move, to: scene.move + 36, start: look(laptop, 0.42, 0.3, 3.6, 0.3, 0.05), end: look(laptop, 0.38, 0.22, 3.0, 0.15, 0.03) },
    { from: scene.move + 36, to: scene.move + 66, start: look(laptop, 0.62, 0.74, 3.5, 0.2, 0.05), end: look(laptop, 0.64, 0.8, 3.0, 0.1, 0.03) },
    { from: scene.move + 66, to: scene.lid, start: look(laptop, 0.5, 0.3, 3.8, 0.2, 0.05), end: look(laptop, 0.46, 0.26, 3.3, 0.1, 0.03) },
    { from: scene.lid, to: scene.lid + 26, start: look(laptop, 0.6, 0.7, 3.8, 0.2, 0.05), end: look(laptop, 0.6, 0.72, 3.4, 0.1, 0.03) },
    { from: scene.lid + 26, to: scene.lid + 50, start: look(laptop, 0.6, 0.72, 3.4, 0.1, 0.03), end: closed, ease: easeInOut },
    { from: scene.lid + 50, to: scene.lid + 72, start: closed, end: two, ease: easeInOut },
    { from: scene.lid + 72, to: scene.phone - 6, start: two, end: nearServer, ease: linear },
    { from: scene.phone - 6, to: scene.phone + 16, start: nearServer, end: phoneShot, ease: easeInOut },
    { from: scene.phone + 16, to: scene.end, start: phoneShot, end: phoneClose, ease: linear },
    { from: scene.end, to: duration, start: { position: [3.2, 3.6, 12.5], target: [3.4, 1.5, 0] }, end: { position: [3.4, 3.8, 14], target: [3.4, 1.5, 0] } },
  ],
  links: [
    { from: [0.6, 0.2, -0.7], via: [1.2, 2.4, -1.4], to: [server.center.x - 2.1, server.center.y - 1.2, server.center.z + 0.2], drawFrom: 228, drawTo: 254 },
    { from: [server.center.x + 2.2, server.center.y - 0.9, server.center.z + 0.1], via: [5.6, 0.0, 0.4], to: [phone.center.x - 0.1, phone.center.y - 1.12, phone.center.z - 0.2], drawFrom: scene.phone - 2, drawTo: scene.phone + 20 },
  ],
  rings: [
    { from: scene.move + 6, to: scene.move + 36, ...around(laptop, 0.262, 0.105, 0.405, 0.168) },
    { from: scene.move + 38, to: scene.move + 66, ...around(laptop, 0.232, 0.915, 0.99, 0.985), sun: true },
  ],
  stickers: [
    { text: "⏳ About 40 minutes", paint: "sun", from: 22, to: scene.move - 4, at: { x: 1480, y: 250 }, tilt: 3, size: 46 },
    { text: "Runs on: this laptop 😬", paint: "ink", from: 40, to: scene.move - 4, at: { x: 1470, y: 370 }, tilt: -3, size: 40 },
    { text: "① Pick your server", paint: "mint", from: scene.move + 8, to: scene.move + 35, at: { x: 1400, y: 250 }, tilt: -3, size: 46 },
    { text: "② Take ownership", paint: "sun", from: scene.move + 40, to: scene.move + 65, at: { x: 1300, y: 330 }, tilt: 3, size: 46 },
    { text: "Now runs on: Home server ✅", paint: "mint", from: scene.move + 72, to: scene.lid - 3, at: { x: 1470, y: 300 }, tilt: -3, size: 46 },
    { text: "💤 asleep", paint: "ink", from: scene.lid + 58, to: scene.phone - 8, at: new THREE.Vector3(0.7, 0.4, 0.3), shift: [0, -50], tilt: -4, size: 36 },
    { text: "Still running ✅", paint: "mint", from: scene.lid + 66, to: scene.phone - 8, at: new THREE.Vector3(server.center.x + 0.9, server.center.y + 1.38, server.center.z + 0.1), tilt: 4, size: 42 },
    { text: "Same conversation 👆", paint: "ink", from: scene.phone + 20, to: scene.phone + 58, at: new THREE.Vector3(phone.center.x + 0.75, phone.center.y + 0.55, phone.center.z), shift: [20, 0], tilt: 3, size: 34 },
    { text: "🎉 PR #231 opened", paint: "mint", from: scene.phone + 62, to: scene.next - 2, at: { x: 1560, y: 400 }, tilt: -4, size: 54 },
    { text: "Merged from the sofa 🛋️", paint: "sun", from: scene.next + 52, to: scene.end - 2, at: { x: 1560, y: 400 }, tilt: 3, size: 48 },
  ],
  confetti: [{ at: scene.phone + 62, origin: { x: 1200, y: 420 }, until: scene.next }],
  lines,
  sounds: [bed(duration, 2), ...spoken(lines), sfx("whoosh", scene.move - 3), sfx("pop", scene.move + 8), sfx("pop", scene.move + 40), sfx("chime", scene.move + 70), sfx("whoosh", scene.lid - 3), sfx("lid", scene.lid + 46), sfx("pop", scene.lid + 66), sfx("whoosh", scene.phone - 6), sfx("pop", scene.phone + 20), sfx("chime", scene.phone + 60), sfx("party", scene.phone + 62), sfx("pop", scene.next + 52), sfx("whoosh", scene.end - 3)],
});
