// Feature: subscription pools, explained step by step. Three Claude accounts are added as
// profiles in Settings → Connections, put in one pool in the order they should be used, and the
// pool becomes the default. The pool's own failover test then runs the first one out of quota,
// then the second, and the third takes over.
import { around, beats, bed, defineFeature, display, events, fit, frameOf, look, say, sfx, spoken } from "../feature.js";

const [profiles, pool, assign, failover, tagline] = beats(["pools-01", "pools-02", "pools-03", "pools-04", { name: "pools-05", min: 116 }]);
const end = tagline.from;
const duration = tagline.to;

const desk = display([0, 2.1, 0]);

const lines = [
  say(profiles, "If your team pays for several Claude accounts, *Joint Bob can use all of them.* You add each one in Settings, under Connections, as a profile that you sign in to once."),
  say(pool, "Next, you create *a pool.* You give it a name, and list the accounts in the order they should be tried: account one first, then two, then three."),
  say(assign, "Then you choose *where the pool applies.* It can be your default for everything, or cover one workspace, one project, a single conversation, or your whole team."),
  say(failover, "Now, when an account reaches its limit, *the turn moves to the next one* in the pool before the reply starts. When that one runs out too, the third takes over, and the agent carries on."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const at = events("pools");
// Settings → Connections and the three accounts added; the pool named, the accounts put in order
// and saved; the pool made the default; the failover test.
const a = fit("pools", profiles.from, profiles.to, at.settings - 1.0, at.profiles + 1.4);
const b = fit("pools", pool.from, pool.to, at.poolForm + 0.2, at.pool + 1.6);
const c = fit("pools", assign.from, assign.to, at.assign - 0.3, at.assigned + 1.6);
const d = fit("pools", failover.from, end, at.simulation - 0.4, at.secondFailover + 2.4);
const firstOut = frameOf(d, at.failover - 0.1);
const secondIn = frameOf(d, at.failover + 0.9);
const secondOut = frameOf(d, at.secondFailover - 0.1);
const thirdIn = frameOf(d, at.secondFailover + 0.9);

export default defineFeature({
  id: "pools",
  kicker: "Subscription pools",
  duration,
  end,
  tagline: ["Use everything", "you already pay for."],
  devices: { desk },
  screens: () => ({ desk: [a, b, c, d] }),
  shots: [
    { from: profiles.from, to: profiles.to, start: look(desk, 0.55, 0.55, 6.2, 0.25), end: look(desk, 0.58, 0.68, 4.9, 0.1) },
    { from: pool.from, to: pool.to, start: look(desk, 0.55, 0.45, 5.2, -0.1), end: look(desk, 0.48, 0.6, 4.6, -0.05) },
    { from: assign.from, to: assign.to, start: look(desk, 0.56, 0.55, 5.0, 0.15), end: look(desk, 0.56, 0.6, 4.4, 0.05) },
    { from: failover.from, to: end, start: look(desk, 0.58, 0.7, 5.4, -0.1), end: look(desk, 0.58, 0.72, 5.0, -0.04) },
    { from: end, to: duration, start: { position: [0.2, 3.2, 11.5], target: [0, 1.9, 0] }, end: { position: [0.4, 3.4, 13], target: [0, 1.9, 0] } },
  ],
  // Each ring is placed at the moment its part of the screen shows in the recording.
  rings: [
    { from: frameOf(a, at.profiles + 0.2), to: profiles.to - 4, ...around(desk, 0.225, 0.62, 0.95, 0.88) },
    { from: frameOf(b, at.pool - 2.6), to: frameOf(b, at.pool - 0.3), ...around(desk, 0.235, 0.34, 0.86, 0.53), sun: true },
    { from: frameOf(b, at.pool + 0.3), to: pool.to - 4, ...around(desk, 0.228, 0.48, 0.468, 0.845) },
    { from: frameOf(c, at.assigned + 0.2), to: assign.to - 4, ...around(desk, 0.232, 0.525, 0.95, 0.675) },
    { from: firstOut, to: secondIn, ...around(desk, 0.231, 0.649, 0.463, 0.8), sun: true },
    { from: secondIn, to: secondOut, ...around(desk, 0.473, 0.649, 0.704, 0.8) },
    { from: thirdIn, to: end - 4, ...around(desk, 0.713, 0.649, 0.945, 0.8) },
  ],
  stickers: [
    { text: "① Add each account", paint: "ink", from: profiles.at + 20, to: profiles.to - 4, at: { x: 1480, y: 230 }, tilt: 3, size: 42 },
    { text: "② Put them in order", paint: "sun", from: pool.at + 20, to: pool.to - 4, at: { x: 1500, y: 230 }, tilt: -3, size: 42 },
    { text: "③ Choose where it applies", paint: "mint", from: assign.at + 20, to: assign.to - 4, at: { x: 1460, y: 230 }, tilt: 3, size: 42 },
    { text: "Account 1: out of quota", paint: "sun", from: firstOut, to: secondIn, at: { x: 1420, y: 230 }, tilt: 3, size: 42 },
    { text: "④ Account 2 takes over ✅", paint: "mint", from: secondIn, to: secondOut, at: { x: 1420, y: 230 }, tilt: -3, size: 42 },
    { text: "Then account 3 ✅", paint: "mint", from: thirdIn, to: end - 4, at: { x: 1440, y: 230 }, tilt: 3, size: 42 },
  ],
  moods: [{ at: firstOut, mood: "alarm" }, { at: secondIn, mood: "calm" }],
  lines,
  sounds: [bed(duration, 20), ...spoken(lines), sfx("pop", profiles.at + 20), sfx("pop", pool.at + 20), sfx("pop", assign.at + 20), sfx("alarm", firstOut), sfx("chime", secondIn), sfx("chime", thirdIn)],
});
