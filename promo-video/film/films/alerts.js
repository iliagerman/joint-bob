// Feature: webhooks, explained step by step. A webhook is made on the home server with standing
// instructions; a 3 AM alert calls it and starts a conversation that finds the bug, fixes it and
// opens a pull request; the report waits in the morning inbox.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, handset, look, say, sfx, spoken } from "../feature.js";

const [hook, night, fix, morning, tagline] = beats(["alerts-01", "alerts-02", "alerts-03", { name: "alerts-04", hold: 20 }, { name: "alerts-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0], { dim: [[morning.from + 4, end]] });
const phone = handset([4.6, 1.8, 1.6], { turn: -0.18, arrive: morning.from - 6 });

const lines = [
  say(hook, "A webhook is *a private address that starts work in Joint Bob.* You create one in Settings, choose the project, and write standing instructions for the agent."),
  say(night, "Then you point your alerting tool at it. When production breaks *at three in the morning,* the alert calls the webhook, and a new conversation begins.", { tone: "danger" }),
  say(fix, "The agent reads the alert, *finds the bug, fixes it and opens a pull request,* with nobody at a keyboard."),
  say(morning, "In the morning, *the report and the fix are waiting in your inbox.*"),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("webhook");
const inbox = events("morning");
// Settings → Webhooks: the form, its instructions, and the webhook created.
const a = fit("webhook", hook.from, hook.to, at.tab - 0.6, at.created + 1.0);
// The quiet list at night, the alert's conversation appearing, and opened.
const b = fit("webhook", night.from, night.to, at.closed - 0.4, at.open + 1.4);
// The agent's work, up to its report.
const c = fit("webhook", fix.from, morning.from, at.open + 1.4, at.reported + 1.0);
const d = { clip: "webhook", from: morning.from, to: duration, start: at.reported + 1.0, rate: 0.3 };
const typed = frameOf(a, at.typed - 2.0);
const appeared = frameOf(b, at.appeared);
const reported = frameOf(c, at.reported - 0.6);

export default defineFeature({
  id: "alerts",
  kicker: "Webhooks",
  duration,
  end,
  tagline: ["Alerts that", "fix themselves."],
  devices: { desk, phone },
  screens: () => ({
    desk: [a, b, c, d],
    phone: [
      fit("morning", morning.from - 10, morning.at + 60, Math.max(0, inbox.inbox - 0.2), inbox.open + 0.4),
      fit("morning", morning.at + 60, duration, inbox.report - 0.3, inbox.report + 2.2),
    ],
  }),
  shots: [
    { from: hook.from, to: hook.to, start: look(desk, 0.5, 0.5, 6.0, 0.2), end: look(desk, 0.58, 0.58, 4.6, -0.04) },
    { from: night.from, to: appeared, start: look(desk, 0.4, 0.5, 6.0, 0.2), end: look(desk, 0.38, 0.56, 5.0, 0.1) },
    { from: appeared, to: night.to, start: look(desk, 0.38, 0.58, 4.8, 0.1), end: look(desk, 0.36, 0.6, 4.0, 0.04) },
    { from: fix.from, to: morning.from, start: look(desk, 0.62, 0.5, 5.0, -0.1), end: look(desk, 0.62, 0.5, 4.2, -0.04) },
    { from: morning.from, to: end, start: { position: [4.6, 1.82, 7.8], target: [4.6, 1.6, 1.6] }, end: { position: [4.75, 1.8, 6.6], target: [4.7, 1.6, 1.6] } },
    { from: end, to: duration, start: { position: [2.0, 3.2, 11.5], target: [2.2, 1.9, 0] }, end: { position: [2.2, 3.4, 13], target: [2.2, 1.9, 0] } },
  ],
  rings: [
    { from: typed, to: hook.to - 4, ...around(desk, 0.209, 0.546, 0.954, 0.69) },
    { from: appeared + 4, to: night.to - 4, ...around(desk, 0.238, 0.585, 0.45, 0.63), sun: true },
    { from: reported, to: morning.from - 4, ...around(desk, 0.534, 0.296, 0.71, 0.68) },
  ],
  stickers: [
    { text: "Its standing orders 📋", paint: "ink", from: typed, to: hook.to - 4, at: { x: 1460, y: 230 }, tilt: -3, size: 42 },
    { text: "3:02 AM · checkout errors 🚨", paint: "danger", from: night.at + 20, to: appeared - 2, at: { x: 1440, y: 260 }, tilt: 3, size: 42 },
    { text: "On it at 3:02 🤖", paint: "mint", from: appeared + 6, to: night.to - 4, at: { x: 1400, y: 300 }, tilt: 3, size: 44 },
    { text: "Found the cause 🔎", paint: "sun", from: fix.at + 40, to: reported - 2, at: { x: 1460, y: 260 }, tilt: -3, size: 44 },
    { text: "Fixed, PR opened 🛠️", paint: "mint", from: reported, to: morning.from - 4, at: { x: 1460, y: 260 }, tilt: 3, size: 44 },
    { text: "Waiting in your inbox 📥", paint: "mint", from: morning.at + 30, to: end - 4, at: { x: 1470, y: 380 }, tilt: 3, size: 42 },
  ],
  moods: [{ at: night.from, mood: "night" }, { at: night.at + 20, mood: "alarm" }, { at: appeared + 6, mood: "night" }, { at: morning.from - 6, mood: "morning" }],
  lines,
  sounds: [bed(duration, 9.5), ...spoken(lines), sfx("pop", typed), sfx("alarm", night.at + 20), sfx("chime", appeared + 6), sfx("pop", fix.at + 40), sfx("chime", reported), sfx("pop", morning.at + 30)],
});
