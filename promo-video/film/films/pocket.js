// Feature: phone access, explained step by step. Joint Bob installs on a phone like an app; its
// projects and conversations are all there; one is picked up where it was, and the next step is
// sent from the phone while the work runs on the home server.
import { around, beats, bed, defineFeature, events, fit, frameOf, handset, look, say, sfx, spoken } from "../feature.js";

const [install, list, open, send, tagline] = beats(["phone-01", "phone-02", "phone-03", "phone-04", { name: "phone-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const phone = handset([0, 2.0, 0]);

const lines = [
  say(install, "Joint Bob runs on your own machines, and *your phone can reach them too.* You open it in the phone's browser, and install it, like any other app."),
  say(list, "*All of your projects and conversations are there,* including the ones running on your home server right now."),
  say(open, "Open one, and you *pick it up exactly where it was,* with its full history and the agent's progress."),
  say(send, "Then you type the next step and send it. *The work carries on on the server,* and you follow along from wherever you are."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("pocket");
// The install banner the page offers.
const a = fit("pocket", install.from, install.to, at.banner + 0.2, at.banner + 2.6);
// The project's conversations, and one tapped.
const b = fit("pocket", list.from, list.to, at.project - 3.0, at.open - 0.2);
// The conversation on the home server, as it was left (its few seconds of "Connecting…" skipped).
const c = fit("pocket", open.from, open.to, at.open + 4.4, at.send - 3.4);
// The next step typed and sent; the agent finishes and opens the pull request.
const d = fit("pocket", send.from, end, at.send - 2.8, at.done + 1.6);
const opened = frameOf(d, at.done - 0.4);

export default defineFeature({
  id: "phone",
  kicker: "On your phone",
  duration,
  end,
  tagline: ["Your desk,", "in your pocket."],
  devices: { phone },
  screens: () => ({ phone: [a, b, c, d] }),
  shots: [
    { from: install.from, to: install.to, start: look(phone, 0.5, 0.5, 6.0), end: look(phone, 0.5, 0.74, 4.2) },
    { from: list.from, to: list.to, start: look(phone, 0.5, 0.5, 5.4), end: look(phone, 0.5, 0.6, 4.4) },
    { from: open.from, to: open.to, start: look(phone, 0.5, 0.3, 4.6), end: look(phone, 0.5, 0.45, 4.2) },
    { from: send.from, to: send.at + 90, start: look(phone, 0.5, 0.82, 3.9), end: look(phone, 0.5, 0.86, 3.5) },
    { from: send.at + 90, to: end, start: look(phone, 0.5, 0.6, 4.6), end: look(phone, 0.5, 0.62, 4.0) },
    { from: end, to: duration, start: { position: [0, 2.6, 8.5], target: [0, 1.9, 0] }, end: { position: [0.2, 2.8, 10], target: [0, 1.9, 0] } },
  ],
  rings: [
    { from: install.at + 60, to: install.to - 4, ...around(phone, 0.03, 0.8, 0.97, 0.89) },
    { from: open.at + 8, to: open.at + 110, ...around(phone, 0.04, 0.125, 0.38, 0.16), sun: true },
    { from: send.at + 12, to: send.at + 80, ...around(phone, 0.06, 0.845, 0.71, 0.906) },
  ],
  stickers: [
    { text: "One tap: Install 📲", paint: "ink", from: install.at + 60, to: install.to - 4, at: { x: 1460, y: 300 }, tilt: 3, size: 44 },
    { text: "Every conversation 💬", paint: "mint", from: list.at + 20, to: list.to - 4, at: { x: 1460, y: 300 }, tilt: -3, size: 44 },
    { text: "Runs on your home server 🖥️", paint: "sun", from: open.at + 10, to: open.at + 110, at: { x: 1440, y: 300 }, tilt: 3, size: 42 },
    { text: "Sent from your phone ✅", paint: "mint", from: send.at + 40, to: opened - 4, at: { x: 1440, y: 300 }, tilt: -3, size: 44 },
    { text: "PR #212 opened 🎉", paint: "mint", from: opened, to: end - 4, at: { x: 1440, y: 300 }, tilt: 3, size: 50 },
  ],
  confetti: [{ at: opened, origin: { x: 960, y: 520 }, until: end }],
  lines,
  sounds: [bed(duration, 70), ...spoken(lines), sfx("pop", install.at + 60), sfx("pop", list.at + 20), sfx("pop", open.at + 10), sfx("chime", send.at + 40), sfx("party", opened)],
});
