// Use case: secret accounts. A credential is added once on the laptop, reaches the owner's
// other machine, is shared with the team read-only, is attached to a project, and is used
// by an agent there without its value ever being in the conversation.
import { around, bed, defineFeature, display, look, sfx, spoken } from "../feature.js";

const scene = { add: 0, twin: 72, team: 138, attach: 228, chat: 330, end: 402 };
const duration = 490;

const mine = display([0, 2.1, 0]);
// The owner's server and the teammate's machine, smaller, one above the other beside it.
const twin = display([5.3, 3.12, -0.6], { width: 3.0, height: 1.875, turn: -0.2, arrive: scene.twin - 6 });
const mate = display([5.3, 1.02, -0.6], { width: 3.0, height: 1.875, turn: -0.2, arrive: scene.team + 30 });

const lines = [
  { audio: "audio/secrets-01.mp3", at: 6, until: scene.twin - 3, text: "Add a credential *once.* 🔑" },
  { audio: "audio/secrets-02.mp3", at: scene.twin + 6, until: scene.team - 3, text: "Your other machines *get it.*" },
  { audio: "audio/secrets-03.mp3", at: scene.team + 6, until: scene.attach - 3, text: "Share it with the team. *Read-only* for them." },
  { audio: "audio/secrets-04.mp3", at: scene.attach + 6, until: scene.chat - 3, text: "Attach it to a project. *Agents just use it.*" },
  { audio: "audio/secrets-05.mp3", at: scene.chat + 6, until: scene.end - 3, text: "It never gets *pasted into a chat.* 🙈" },
  { audio: "audio/secrets-06.mp3", at: scene.end + 4, until: 0, text: "" },
];

export default defineFeature({
  id: "secrets",
  kicker: "Secrets",
  duration,
  end: scene.end,
  tagline: ["One place for your keys.", "Every machine that needs them."],
  devices: { mine, twin, mate },
  screens: (meta) => {
    const owner = meta.secretsOwner.events;
    const server = meta.secretsTwin.events;
    const teammate = meta.secretsMate.events;
    return {
      mine: [
        // The label and the masked token, typed faster than they were, then the saved row.
        { clip: "secretsOwner", from: 0, to: 44, start: owner.form + 1.2, rate: (owner.typed - owner.form - 1.2) / (44 / 30) },
        { clip: "secretsOwner", from: 44, to: scene.team, start: owner.saved - 0.5, rate: 1 },
        // Share: the whole cluster.
        { clip: "secretsOwner", from: scene.team, to: scene.attach, start: owner.shareDialog + 0.1, rate: 1.15 },
        // The project's secret accounts, then the conversation that uses one.
        { clip: "secretsOwner", from: scene.attach, to: scene.attach + 36, start: owner.scope + 0.2, rate: 1.15 },
        { clip: "secretsOwner", from: scene.attach + 36, to: scene.chat, start: owner.used - 2.3, rate: 1 },
        { clip: "secretsOwner", from: scene.chat, to: duration, start: owner.used + 0.6, rate: 0.5 },
      ],
      twin: [{ clip: "secretsTwin", from: scene.twin - 8, to: duration, start: server.twin - 1.5, rate: 1 }],
      mate: [{ clip: "secretsMate", from: scene.team + 28, to: duration, start: teammate.mate - 1.5, rate: 1 }],
    };
  },
  shots: [
    { from: 0, to: 44, start: look(mine, 0.5, 0.42, 5.0, 0.2), end: look(mine, 0.5, 0.42, 4.2, 0.1) },
    { from: 44, to: scene.twin, start: look(mine, 0.62, 0.36, 5.2, 0.1), end: look(mine, 0.64, 0.38, 4.6, 0.05) },
    { from: scene.twin, to: scene.team, start: look(twin, 0.56, 0.5, 4.0, -0.2), end: look(twin, 0.58, 0.5, 3.1, -0.1) },
    { from: scene.team, to: scene.team + 40, start: look(mine, 0.5, 0.55, 4.4, 0.1), end: look(mine, 0.5, 0.56, 3.8, 0.05) },
    { from: scene.team + 40, to: scene.attach, start: look(mate, 0.56, 0.5, 4.0, -0.2), end: look(mate, 0.58, 0.5, 3.1, -0.1) },
    { from: scene.attach, to: scene.attach + 36, start: look(mine, 0.5, 0.5, 4.6, 0.1), end: look(mine, 0.5, 0.52, 4.0, 0.05) },
    { from: scene.attach + 36, to: scene.chat, start: look(mine, 0.62, 0.55, 5.2, 0.1), end: look(mine, 0.62, 0.58, 4.6, 0.05) },
    { from: scene.chat, to: scene.end, start: look(mine, 0.62, 0.66, 4.4, -0.1), end: look(mine, 0.62, 0.68, 3.8, -0.05) },
    { from: scene.end, to: duration, start: { position: [2.6, 3.2, 12], target: [2.6, 2.0, 0] }, end: { position: [2.8, 3.4, 13.5], target: [2.6, 2.0, 0] } },
  ],
  links: [
    { from: [2.75, 3.3, 0.05], via: [3.6, 4.3, -0.3], to: [twin.center.x - 1.45, twin.center.y + 0.5, twin.center.z + 0.3], drawFrom: scene.twin - 2, drawTo: scene.twin + 20 },
    { from: [2.75, 1.0, 0.05], via: [3.6, 0.2, -0.3], to: [mate.center.x - 1.45, mate.center.y - 0.5, mate.center.z + 0.3], drawFrom: scene.team + 32, drawTo: scene.team + 54 },
  ],
  rings: [
    { from: scene.twin + 26, to: scene.team - 3, ...around(twin, 0.21, 0.48, 0.975, 0.57) },
    { from: scene.team + 58, to: scene.attach - 3, ...around(mate, 0.21, 0.415, 0.975, 0.515) },
    { from: scene.chat + 10, to: scene.end - 3, ...around(mine, 0.34, 0.655, 0.955, 0.745), sun: true },
  ],
  stickers: [
    { text: "Typed once. Masked. 🔒", paint: "ink", from: 12, to: 43, at: { x: 1520, y: 300 }, tilt: 3, size: 44 },
    { text: "Saved ✅", paint: "mint", from: 52, to: scene.twin - 3, at: { x: 1500, y: 300 }, tilt: -3, size: 50 },
    { text: "🖥️ Home server has it", paint: "mint", from: scene.twin + 26, to: scene.team - 3, at: { x: 1380, y: 240 }, tilt: 3, size: 46 },
    { text: "👥 The whole team", paint: "sun", from: scene.team + 12, to: scene.team + 39, at: { x: 1460, y: 300 }, tilt: -3, size: 46 },
    { text: "👩‍💻 Maya: read-only", paint: "mint", from: scene.team + 58, to: scene.attach - 3, at: { x: 1380, y: 240 }, tilt: 3, size: 46 },
    { text: "📎 This project only", paint: "sun", from: scene.attach + 10, to: scene.attach + 35, at: { x: 1500, y: 300 }, tilt: -3, size: 46 },
    { text: "🤖 PR #214, as northwind-bot", paint: "mint", from: scene.attach + 62, to: scene.chat - 3, at: { x: 1380, y: 220 }, tilt: 3, size: 44 },
    { text: "No token in sight 🙈", paint: "sun", from: scene.chat + 14, to: scene.end - 3, at: { x: 1420, y: 250 }, tilt: -3, size: 48 },
  ],
  lines,
  sounds: [bed(duration, 14), ...spoken(lines), sfx("pop", 12), sfx("chime", 50), sfx("whoosh", scene.twin - 3), sfx("pop", scene.twin + 26), sfx("whoosh", scene.team - 3), sfx("pop", scene.team + 12), sfx("whoosh", scene.team + 38), sfx("pop", scene.team + 58), sfx("whoosh", scene.attach - 3), sfx("pop", scene.attach + 10), sfx("chime", scene.attach + 60), sfx("whoosh", scene.chat - 3), sfx("pop", scene.chat + 14), sfx("whoosh", scene.end - 3)],
});
