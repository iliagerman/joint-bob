// The thirty-second cut of Alex's Monday, for posting (LinkedIn) and the top of the landing page.
// Its own five lines, on the same drawn sheet: the release due at six, the pool taking over,
// Guardian asking first and the launch scheduled, the work moved to his server and merged from the
// train, and the launch going out at six. Only his desk and the train are drawn.
import { beats, events, fit, frameOf, say, score, sfx, spoken } from "../feature.js";
import { devices, places, world } from "../sketch/places.js";
import { defineSketch, frameRect, onScreen, part, view } from "../sketch/story.js";
import { HEIGHT } from "../timeline.js";

const [open, limit, guard, handoff, launch, tagline] = beats(
  ["short-01", "short-02", { name: "short-03", hold: 4 }, { name: "short-04", hold: 6 }, { name: "short-05", hold: 14 }, { name: "monday-11", min: 116 }],
  { lead: 6, gap: 8 },
);
const end = tagline.from;
const duration = tagline.to;
const lidCloses = handoff.at + 46;

const lines = [
  say(open, "Alex has *a release due at six.* His agents start on it at nine."),
  say(limit, "When one Claude account runs out, *the next one in his pool takes over.*"),
  say(guard, "*Guardian asks him* before anything risky, and *his assistant schedules the launch.*", { tone: "sun" }),
  say(handoff, "At five forty, he moves the work to his server, and *merges from the train.*"),
  say(launch, "At six, *the launch goes out,* on time."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const lap = events("moveLaptop");
const hand = events("movePhone");
const pools = events("pools");
const guardian = events("guardian");
const assistant = events("assistant");
const launchPhone = events("launchPhone");

const plan = fit("moveLaptop", open.from, open.to, 0.2, lap.pick - 0.4);
const pool = fit("pools", limit.from, limit.to, pools.simulation + 1.2, pools.failover + 1.8);
const guardHalf = guard.at + 70;
const card = fit("guardian", guard.from, guardHalf, guardian.review - 1.0, guardian.review + 1.4);
const tasks = fit("assistant", guardHalf, guard.to, assistant.tasks + 0.2, assistant.tasks + 2.6);
const runsOn = fit("moveLaptop", handoff.from, lidCloses + 20, lap.pick - 0.6, lap.take + 1.0);
const outOfQuota = frameOf(pool, pools.failover - 0.1);
const takesOver = frameOf(pool, pools.failover + 0.7);
const cardShown = frameOf(card, guardian.review + 0.1);
const trainAt = lidCloses + 40;
const merged = launch.from - 6;
const launched = launch.at + 20;

const keys = { near: [735, 736], far: [800, 730] };
const atDesk = [
  { at: 0, lean: 0.1, nod: 0.04, gaze: [1, 0.35], worry: 0, raise: 0, frown: 0, smile: 0.4, open: 0, typing: 1, headphones: 0, ...keys },
  { at: outOfQuota - 8, worry: 1, smile: -0.5, typing: 0, lean: 0.16 },
  { at: takesOver, worry: 0, smile: 0.8, raise: 0.4 },
  { at: cardShown - 6, raise: 1, open: 0.7, typing: 0, lean: 0.04, near: [700, 650] },
  { at: guardHalf, raise: 0, open: 0, smile: 0.7, near: keys.near, typing: 0.6 },
  { at: lidCloses - 16, typing: 0, near: [826, 580], smile: 0.6 },
  { at: lidCloses, near: [826, 726], over: 16 },
  { at: lidCloses + 24, lean: -0.08, near: [700, 478], far: [470, 488], nearBend: "out", farBend: "out", smile: 1, gaze: [0.2, -0.6], shut: 1, over: 18 },
];
const onTrain = [
  { at: 0, lean: 0.04, nod: 0.05, gaze: [1, -0.3], smile: 0.4, typing: 0, near: [3316, 758], far: [3290, 770] },
  { at: launched - 4, smile: 1, open: 0.6, raise: 0.6, far: [3130, 520], farBend: "out", over: 10 },
  { at: launch.to - 20, open: 0, raise: 0.2 },
];
// Places this cut never visits are given a start no frame reaches, so they stay blank paper.
const never = [1e9, 1e9 + 1];
const t = {
  draw: {
    title: [2, 26], desk: [14, 44], alex: [30, 62], room: [48, 86],
    cafeFront: never, cafeAlex: never, cafeRoom: never, mayaDesk: never, maya: never, mayaRoom: never, homeFront: never, homeRoom: never,
    trainFront: [trainAt - 6, trainAt + 12], trainAlex: [trainAt + 4, trainAt + 34], trainRoom: [trainAt + 20, trainAt + 56],
  },
  clock: [[0, 542], [limit.from, 640], [guard.from, 700], [handoff.from, 1060]],
  lid: [[0, 1], [lidCloses, 0]],
  alex: { office: atDesk, cafe: atDesk, train: onTrain },
  maya: atDesk,
  links: { maya: { from: 1e9, gone: 1e9 }, server: { from: 1e9 } },
  journey: [
    { from: 70, to: 90, points: [[300, 1050], [420, 1062]], label: "9:02 AM", labelAt: [360, 1110] },
    { from: trainAt - 40, to: trainAt - 4, points: [[1220, 1062], [1700, 1110], [2200, 1110], [2560, 1080]], label: "5:40 PM", labelAt: [1290, 1120] },
    { from: launched + 4, to: launched + 30, points: [[3300, 1080], [3640, 1080]], label: "6:00 PM · launched ✓", labelAt: [3560, 1130], color: "#0f8a6c" },
  ],
};

const desk = frameRect(places.desk.x, places.desk.y, places.desk.w, places.desk.h);
const office = frameRect(places.office.x, places.office.y, places.office.w, places.office.h, 0.04);
const laptop = devices.laptop;
const phoneView = (device, fill = 0.8) => view(device.x + device.w / 2, device.y + device.h / 2 + 0.05 * device.h, (HEIGHT * fill) / device.h);
const train = frameRect(places.train.x, places.train.y, places.train.w, places.train.h);

export default defineSketch({
  id: "short",
  kicker: "A day with Joint Bob",
  duration,
  end,
  tagline: ["Ship faster.", "Stay in charge."],
  places: world(t),
  screens: () => ({
    laptop: [plan, pool, card, tasks, runsOn],
    trainPhone: [
      fit("movePhone", trainAt - 10, launch.from, hand.phoneSend - 1.0, hand.merged + 0.4),
      fit("launchPhone", launch.from, launched + 50, launchPhone.report - 0.4, launchPhone.report + 2.4),
      { clip: "launchPhone", from: launched + 50, to: duration, start: launchPhone.report + 2.4, rate: 0.4 },
    ],
  }),
  shots: [
    { from: 0, to: 22, start: view(560, 190, 1.9), end: view(600, 200, 1.8) },
    { from: 22, to: 70, start: view(600, 200, 1.8), end: office },
    { from: 70, to: 100, start: office, end: desk },
    { from: 100, to: open.to, start: desk, end: onScreen(laptop, 0.52, 0.5, 1.16) },
    { from: limit.from, to: limit.to, start: onScreen(laptop, 0.58, 0.68, 0.98), end: onScreen(laptop, 0.58, 0.7, 0.88) },
    { from: guard.from, to: guardHalf, start: onScreen(laptop, 0.7, 0.74, 0.95), end: onScreen(laptop, 0.74, 0.78, 0.84) },
    { from: guardHalf, to: guard.to, start: onScreen(laptop, 0.5, 0.45, 0.9), end: onScreen(laptop, 0.5, 0.42, 0.78) },
    { from: handoff.from, to: lidCloses - 12, start: onScreen(laptop, 0.4, 0.3, 0.8), end: onScreen(laptop, 0.38, 0.25, 0.7) },
    { from: lidCloses - 12, to: trainAt, start: desk, end: view(650, 620, 2.6), glide: 20 },
    { from: trainAt, to: trainAt + 40, start: train, end: train, glide: 34 },
    { from: trainAt + 40, to: launched + 40, start: phoneView(devices.trainPhone, 0.72), end: phoneView(devices.trainPhone, 0.84) },
    { from: launched + 40, to: duration, start: view(3240, 650, 2.2), end: view(3250, 660, 2.4) },
  ],
  rings: [
    { from: outOfQuota, to: takesOver, part: part(laptop, 0.231, 0.649, 0.463, 0.8), tone: "sun" },
    { from: takesOver, to: limit.to - 4, part: part(laptop, 0.473, 0.649, 0.704, 0.8) },
    { from: cardShown, to: guardHalf - 2, part: part(laptop, 0.478, 0.71, 0.985, 0.88), tone: "sun" },
    { from: guardHalf + 8, to: guard.to - 4, part: part(laptop, 0.25, 0.275, 0.75, 0.42) },
  ],
  notes: [
    { text: "Account 2 takes over ✓", paint: "mint", from: takesOver, to: limit.to - 4, at: { x: 1440, y: 230 }, tilt: -3 },
    { text: "rm -rf? Ask first ✋", paint: "pink", from: cardShown, to: guardHalf - 2, at: { x: 1420, y: 230 }, tilt: -3 },
    { text: "Launch: Mondays, 6 PM 🚀", paint: "sun", from: guardHalf + 8, to: guard.to - 4, at: { x: 1420, y: 230 }, tilt: 3 },
    { text: "Merged ✓", paint: "mint", from: merged - 20, to: launch.from + 6, at: { x: 1440, y: 300 }, tilt: 3, size: 72 },
    { text: "v2.4 is live 🚀", paint: "sun", from: launched, to: launched + 40, at: { x: 1440, y: 300 }, tilt: -3, size: 72 },
  ],
  confetti: [{ at: launched, origin: { x: 960, y: 420 }, until: launched + 75 }],
  light: [
    { at: 0, x: 0.1, y: 0.1, near: [255, 231, 186, 1], far: [255, 248, 236, 1] },
    { at: handoff.from, x: 0.9, y: 0.2, near: [255, 214, 170, 1], far: [255, 240, 226, 1], over: 40 },
    { at: trainAt - 10, x: 0.8, y: 0.1, near: [236, 214, 236, 1], far: [222, 226, 246, 1], over: 40 },
  ],
  lines,
  sounds: [
    score("short", duration, 0.44), ...spoken(lines),
    sfx("alarm", outOfQuota), sfx("chime", takesOver), sfx("alarm", cardShown), sfx("pop", guardHalf + 8),
    sfx("lid", lidCloses + 10, 0.5), sfx("chime", merged), sfx("party", launched),
  ],
});
