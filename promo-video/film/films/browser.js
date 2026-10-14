// Use case: the browser an agent drives. It opens a staging shop inside the conversation,
// clicks through it like a customer, finds the bug, fixes it and checks again, while a
// person watches the same page live and can take control of it.
import { around, bed, defineFeature, display, look, sfx, spoken } from "../feature.js";

const scene = { open: 0, customer: 84, fix: 180, wheel: 282, end: 384 };
const duration = 490;

const desk = display([0, 2.1, 0]);
// Where the live page sits on the recording, in screen fractions.
const page = [0.75, 0.79];

const lines = [
  { audio: "audio/browser-01.mp3", at: 6, until: scene.customer - 3, text: "Give your agent *a real browser.* 🌐" },
  { audio: "audio/browser-02.mp3", at: scene.customer + 6, until: scene.fix - 3, text: "It clicks through your site *like a customer.*" },
  { audio: "audio/browser-03.mp3", at: scene.fix + 6, until: scene.wheel - 3, text: "Finds the bug. Fixes it. *Checks again.*" },
  { audio: "audio/browser-04.mp3", at: scene.wheel + 6, until: scene.end - 3, text: "Watch it live. *Take the wheel* any time. ✋" },
  { audio: "audio/browser-05.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "browser",
  kicker: "Agent browser",
  duration,
  end: scene.end,
  tagline: ["Agents that see", "what they ship."],
  devices: { desk },
  screens: (meta) => {
    const events = meta.browser.events;
    return { desk: [
      // The request, then the panel opening on the page the agent has just loaded.
      { clip: "browser", from: 0, to: 34, start: events.send - 1.05, rate: 1 },
      // The wait for the first picture is skipped.
      { clip: "browser", from: 34, to: 50, start: events.panel - 0.35, rate: 1.2 },
      { clip: "browser", from: 50, to: scene.customer, start: events.live - 0.1, rate: 1 },
      // Each step about a second after the agent says it: into the cart, to checkout, the promo code.
      { clip: "browser", from: scene.customer, to: scene.customer + 32, start: events.adding + 0.5, rate: 1.2 },
      { clip: "browser", from: scene.customer + 32, to: scene.customer + 60, start: events.checkout + 0.5, rate: 1.2 },
      { clip: "browser", from: scene.customer + 60, to: scene.fix + 30, start: events.applying + 1.0, rate: 1.2 },
      // The fix deployed, the same steps again, and a test order.
      { clip: "browser", from: scene.fix + 30, to: scene.fix + 68, start: events.retry + 1.6, rate: (events.applies + 0.3 - (events.retry + 1.6)) / (38 / 30) },
      { clip: "browser", from: scene.fix + 68, to: scene.wheel, start: events.done - 1.6, rate: 1 },
      // A person takes control, and hands it back.
      { clip: "browser", from: scene.wheel, to: scene.wheel + 52, start: events.control - 1.0, rate: 1 },
      { clip: "browser", from: scene.wheel + 52, to: duration, start: events.resumed - 0.8, rate: 1 },
    ] };
  },
  shots: [
    { from: 0, to: 34, start: look(desk, 0.3, 0.8, 4.6, 0.2), end: look(desk, 0.32, 0.8, 4.2, 0.1) },
    { from: 34, to: scene.customer, start: look(desk, 0.55, 0.52, 6.4, 0.2), end: look(desk, 0.6, 0.56, 5.4, 0.1) },
    { from: scene.customer, to: scene.fix, start: look(desk, ...page, 3.5, -0.1), end: look(desk, ...page, 3.0, -0.03) },
    { from: scene.fix, to: scene.fix + 30, start: look(desk, 0.62, 0.72, 4.6, 0.1), end: look(desk, 0.64, 0.74, 4.0, 0.05) },
    { from: scene.fix + 30, to: scene.wheel, start: look(desk, ...page, 3.5, 0.1), end: look(desk, ...page, 3.0, 0.03) },
    { from: scene.wheel, to: scene.end, start: look(desk, 0.7, 0.5, 4.6, -0.1), end: look(desk, 0.72, 0.5, 4.0, -0.03) },
    { from: scene.end, to: duration, start: look(desk, 0.5, 0.45, 7.5, 0.6), end: look(desk, 0.5, 0.45, 9.5, 0.2) },
  ],
  rings: [
    { from: scene.fix + 4, to: scene.fix + 30, ...around(desk, 0.555, 0.815, 0.825, 0.875), sun: true },
    { from: scene.wheel + 8, to: scene.end - 3, ...around(desk, 0.522, 0.365, 0.75, 0.45) },
  ],
  stickers: [
    { text: "🌐 Inside the conversation", paint: "mint", from: 44, to: scene.customer - 3, at: { x: 1380, y: 250 }, tilt: 3, size: 46 },
    { text: "👆 Real clicks, real page", paint: "ink", from: scene.customer + 10, to: scene.fix - 3, at: { x: 1500, y: 200 }, tilt: -3, size: 44 },
    { text: "🐛 Reproduced", paint: "danger", from: scene.fix + 4, to: scene.fix + 29, at: { x: 420, y: 320 }, tilt: -4, size: 54 },
    { text: "🔧 Fixed", paint: "mint", from: scene.fix + 50, to: scene.fix + 67, at: { x: 1560, y: 220 }, tilt: 4, size: 54 },
    { text: "✅ Order went through", paint: "mint", from: scene.fix + 78, to: scene.wheel - 3, at: { x: 1480, y: 220 }, tilt: -3, size: 50 },
    { text: "✋ You have control", paint: "sun", from: scene.wheel + 22, to: scene.wheel + 50, at: { x: 560, y: 300 }, tilt: -3, size: 48 },
    { text: "▶️ Hand it back", paint: "mint", from: scene.wheel + 62, to: scene.end - 3, at: { x: 560, y: 300 }, tilt: 3, size: 48 },
  ],
  confetti: [{ at: scene.fix + 78, origin: { x: 1000, y: 420 }, until: scene.wheel }],
  lines,
  sounds: [bed(duration, 8), ...spoken(lines), sfx("whoosh", 32), sfx("pop", 44), sfx("whoosh", scene.customer - 3), sfx("pop", scene.customer + 10), sfx("whoosh", scene.fix - 3), sfx("alarm", scene.fix + 4, 0.25), sfx("pop", scene.fix + 50), sfx("chime", scene.fix + 76), sfx("party", scene.fix + 78), sfx("whoosh", scene.wheel - 3), sfx("pop", scene.wheel + 22), sfx("pop", scene.wheel + 62), sfx("whoosh", scene.end - 3)],
});
