// Feature: secret accounts, explained step by step. A credential is added once on the laptop,
// reaches the owner's other machine, is shared with the team read-only, is attached to a project,
// and is used by an agent there without its value ever being in the conversation.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [add, twinBeat, team, attach, chat, tagline] = beats(["secrets-01", "secrets-02", "secrets-03", "secrets-04", { name: "secrets-05", hold: 20 }, { name: "secrets-06", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const mine = display([0, 2.1, 0]);
// The owner's server and the teammate's machine, smaller, one above the other beside it.
const twin = display([5.3, 3.12, -0.6], { width: 3.0, height: 1.875, turn: -0.2, arrive: twinBeat.from - 6 });
const mate = display([5.3, 1.02, -0.6], { width: 3.0, height: 1.875, turn: -0.2, arrive: team.at + 60 });

const lines = [
  say(add, "Agents often need keys and tokens. In Joint Bob, you *add each one once,* as a secret account, and it's stored encrypted."),
  say(twinBeat, "*Your other machines receive it automatically,* so the same account works wherever the conversation runs."),
  say(team, "You can *share it with your team* as well. Teammates can use it, but only you can change it."),
  say(attach, "Attach it to a workspace, a project or a single conversation, and *agents there can use it* without asking you for it."),
  say(chat, "The key is in the agent's environment, so *it never has to be pasted into the chat.*"),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const owner = events("secretsOwner");
const server = events("secretsTwin");
const teammate = events("secretsMate");
// The label and the masked token, typed, then the saved row.
const a = fit("secretsOwner", add.from, add.to, owner.form + 0.3, owner.saved + 1.2);
const b = { clip: "secretsOwner", from: add.to, to: team.from, start: owner.saved + 1.2, rate: 0.3 };
// Share: the whole cluster.
const c = fit("secretsOwner", team.from, team.to, owner.shareDialog + 0.1, owner.shared + 1.0);
// The project's secret accounts, then the conversation that uses one.
const middle = Math.round((attach.from + attach.to) / 2);
const d1 = fit("secretsOwner", attach.from, middle, owner.scope + 0.2, owner.attached + 1.0);
const d2 = fit("secretsOwner", middle, chat.from, owner.used - 4.0, owner.used - 0.4);
const e = fit("secretsOwner", chat.from, end, owner.used - 0.4, owner.used + 2.4);
const used = frameOf(d2, owner.used - 2.4);

export default defineFeature({
  id: "secrets",
  kicker: "Secrets",
  duration,
  end,
  tagline: ["One place for your keys.", "Every machine that needs them."],
  devices: { mine, twin, mate },
  screens: () => ({
    mine: [a, b, c, d1, d2, e],
    twin: [{ clip: "secretsTwin", from: twinBeat.from - 8, to: duration, start: server.twin + 0.1, rate: 1 }],
    mate: [{ clip: "secretsMate", from: team.at + 54, to: duration, start: teammate.mate + 0.1, rate: 1 }],
  }),
  shots: [
    { from: add.from, to: add.to, start: look(mine, 0.5, 0.42, 5.4, 0.2), end: look(mine, 0.55, 0.4, 4.4, 0.1) },
    { from: twinBeat.from, to: twinBeat.to, start: look(twin, 0.56, 0.5, 4.0, -0.2), end: look(twin, 0.58, 0.5, 3.1, -0.1) },
    { from: team.from, to: team.at + 60, start: look(mine, 0.5, 0.55, 4.4, 0.1), end: look(mine, 0.5, 0.56, 3.8, 0.05) },
    { from: team.at + 60, to: team.to, start: look(mate, 0.56, 0.5, 4.0, -0.2), end: look(mate, 0.58, 0.5, 3.1, -0.1) },
    { from: attach.from, to: middle, start: look(mine, 0.5, 0.5, 4.6, 0.1), end: look(mine, 0.5, 0.52, 4.0, 0.05) },
    { from: middle, to: chat.from, start: look(mine, 0.62, 0.55, 5.2, 0.1), end: look(mine, 0.62, 0.58, 4.6, 0.05) },
    { from: chat.from, to: end, start: look(mine, 0.62, 0.66, 4.4, -0.1), end: look(mine, 0.62, 0.68, 3.8, -0.05) },
    { from: end, to: duration, start: { position: [2.6, 3.2, 12], target: [2.6, 2.0, 0] }, end: { position: [2.8, 3.4, 13.5], target: [2.6, 2.0, 0] } },
  ],
  links: [
    { from: [2.75, 3.3, 0.05], via: [3.6, 4.3, -0.3], to: [twin.center.x - 1.45, twin.center.y + 0.5, twin.center.z + 0.3], drawFrom: twinBeat.from - 2, drawTo: twinBeat.from + 20 },
    { from: [2.75, 1.0, 0.05], via: [3.6, 0.2, -0.3], to: [mate.center.x - 1.45, mate.center.y - 0.5, mate.center.z + 0.3], drawFrom: team.at + 58, drawTo: team.at + 80 },
  ],
  rings: [
    { from: twinBeat.at + 20, to: twinBeat.to - 4, ...around(twin, 0.215, 0.415, 0.96, 0.515) },
    { from: team.at + 86, to: team.to - 4, ...around(mate, 0.21, 0.415, 0.975, 0.515) },
    { from: chat.at + 10, to: end - 4, ...around(mine, 0.34, 0.655, 0.955, 0.745), sun: true },
  ],
  stickers: [
    { text: "Typed once. Masked 🔒", paint: "ink", from: add.at + 30, to: add.to - 4, at: { x: 1520, y: 300 }, tilt: 3, size: 42 },
    { text: "Home server has it 🖥️", paint: "mint", from: twinBeat.at + 20, to: twinBeat.to - 4, at: { x: 1380, y: 240 }, tilt: 3, size: 44 },
    { text: "Shared with the team 👥", paint: "sun", from: team.at + 20, to: team.at + 58, at: { x: 1460, y: 300 }, tilt: -3, size: 44 },
    { text: "Maya: can use it, can't change it", paint: "mint", from: team.at + 86, to: team.to - 4, at: { x: 1300, y: 240 }, tilt: 3, size: 38 },
    { text: "This project only 📎", paint: "sun", from: attach.at + 20, to: middle - 4, at: { x: 1500, y: 300 }, tilt: -3, size: 44 },
    { text: "PR #214, as northwind-bot 🤖", paint: "mint", from: used, to: chat.from - 4, at: { x: 1380, y: 220 }, tilt: 3, size: 42 },
    { text: "No token in the chat 🙈", paint: "sun", from: chat.at + 12, to: end - 4, at: { x: 1420, y: 250 }, tilt: -3, size: 44 },
  ],
  lines,
  sounds: [bed(duration, 14), ...spoken(lines), sfx("pop", add.at + 30), sfx("chime", twinBeat.at + 20), sfx("pop", team.at + 20), sfx("chime", team.at + 86), sfx("pop", attach.at + 20), sfx("chime", used), sfx("pop", chat.at + 12)],
});
