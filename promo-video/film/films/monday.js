// The main film: one developer's Monday, drawn on paper. Alex starts a long test migration at his
// desk, one of his Claude accounts runs out and the next in his pool takes over, he is asked before
// an agent deletes files, gets a dashboard, asks his assistant how the fix is going and schedules
// the launch from his phone at the café, sees Maya join and fork his work from her desk, hears the
// change explained, moves the work to his home server at 5:40, closes the laptop, merges from the
// train, and at six the launch he scheduled goes out. The real recordings play inside the screens drawn on the sheet.
import { beats, events, fit, frameOf, say, score, sfx, spoken } from "../feature.js";
import { devices, places, world } from "../sketch/places.js";
import { defineSketch, frameRect, onScreen, part, view } from "../sketch/story.js";
import { HEIGHT } from "../timeline.js";

export const parts = beats([
  "monday-01", "monday-02", "monday-03", "monday-04", { name: "monday-05", hold: 10 }, { name: "monday-06", hold: 10 },
  "monday-07", { name: "monday-08", hold: 90 }, { name: "monday-09", hold: 20 }, { name: "monday-10", hold: 30 }, { pause: 96 }, { name: "monday-11", min: 116 },
]);
// `map` is the whole day seen from above, before the name.
const [open, limit, guard, dash, lunch, maya, story, handoff, train, shipped, map, tagline] = parts;
const end = tagline.from;
const duration = tagline.to;
const lidCloses = handoff.at + 150;

const lines = [
  say(open, "It's Monday morning, and Alex has *a release due at six.* He starts the big test migration on his laptop, and lets the agent get going."),
  say(limit, "Halfway through, one of his Claude accounts hits its limit. Joint Bob *moves the task to the next account in his pool,* and the agent doesn't miss a step."),
  say(guard, "Then an agent cleaning up old exports tries to delete customer files. *Guardian stops it and asks him first,* so he blocks it, and the agent archives them instead.", { tone: "sun" }),
  say(dash, "Something looks off at checkout, so *he asks for a dashboard,* and a minute later he's looking at the errors, hour by hour."),
  say(lunch, "At lunch, his assistant tells him how the fix is going, and from his phone, *he schedules the launch for six.*"),
  say(maya, "Meanwhile his teammate Maya *opens his conversation from her own machine,* adds a request, and forks it to try a fix of her own."),
  say(story, "Before the review, *two hosts walk him through the whole change,* so he knows exactly what he's approving."),
  say(handoff, "At five forty, *he moves the work to his home server,* and closes the laptop. The agent keeps going."),
  say(train, "On the train home it finishes, and *he merges the pull request from his phone.*"),
  say(shipped, "At six, *the launch he scheduled goes out by itself,* right on time."),
  { audio: tagline.audio, at: end + 6, until: 0, text: "" },
];

const lap = events("moveLaptop");
const home = events("moveServer");
const hand = events("movePhone");
const pools = events("pools");
const guardian = events("guardian");
const dashboard = events("dashboards");
const lunchPhone = events("assistantPhone");
const launchPhone = events("launchPhone");
const assistant = events("assistant");
const mate = events("teammate");
const podcast = events("story");
const sameMoment = events("server").teammateSend - mate.teammateSend;

// What each screen shows, beat by beat.
const plan = fit("moveLaptop", open.from, open.to, 0.2, lap.pick - 0.4);
const pool = fit("pools", limit.from, limit.to, pools.simulation - 0.2, pools.failover + 2.4);
const halfGuard = guard.at + 150;
const card = fit("guardian", guard.from, halfGuard, guardian.review - 2.4, guardian.blocked - 0.4);
const archive = fit("guardian", halfGuard, guard.to, guardian.blocked - 0.4, guardian.archived + 1.6);
const ask = fit("dashboards", dash.from, dash.at + 70, dashboard.typed - 1.2, dashboard.typed + 0.4);
const built = fit("dashboards", dash.at + 70, dash.to, dashboard.tested - 3.2, dashboard.tested - 0.4);
const saved = { clip: "assistant", from: lunch.from, to: maya.from, start: assistant.synced + 0.5, rate: 0.3 };
// At lunch, on his phone: the assistant's answer, then (past the form loading) the launch for six, saved.
const lunchAnswer = fit("assistantPhone", lunch.from - 4, lunch.from + 130, lunchPhone.opened + 3.0, lunchPhone.answered + 2.6);
const lunchForm = fit("assistantPhone", lunch.from + 130, lunch.from + 200, lunchPhone.scheduled - 6.6, lunchPhone.scheduled + 0.2);
const lunchSaved = fit("assistantPhone", lunch.from + 200, maya.from, lunchPhone.scheduled + 1.2, lunchPhone.scheduled + 4.4);
const herMessage = fit("teammate", maya.from - 4, maya.at + 140, mate.teammateRead + 2.0, mate.teammateAnswered + 1.4);
const herFork = fit("teammate", maya.at + 140, story.from, mate.forkClick - 0.8, mate.forkAnswered + 1.0);
const hisSide = fit("server", maya.from, story.from, mate.teammateRead + 2.0 + sameMoment, mate.forkAnswered + 1.0 + sameMoment);
const hosts = { clip: "story", from: story.from, to: handoff.from, start: podcast.line1 - 0.6, rate: 1 };
const runsOn = fit("moveLaptop", handoff.from, handoff.at + 60, lap.pick - 0.6, lap.take + 1.0);
const ownership = fit("moveLaptop", handoff.at + 60, lidCloses + 30, lap.taken - 0.6, lap.go + 0.6);
const outOfQuota = frameOf(pool, pools.failover - 0.1);
const takesOver = frameOf(pool, pools.failover + 1.0);
const cardShown = frameOf(card, guardian.review + 0.1);
const blocked = frameOf(archive, guardian.blocked);
const archived = frameOf(archive, guardian.archived - 0.4);
const merged = shipped.from - 24;
// At six the launch report arrives on the phone in his hand.
const launched = shipped.from + 30;

// Alex at his desk: where his hands are, where he looks, how he feels, beat by beat.
// He faces us behind his laptop, so his hands are on the keyboard behind the lid and he looks down at it.
const keys = { near: [615, 728], far: [545, 728], nearHand: "hidden", farHand: "hidden" };
const down = [0.15, 0.75];
const atDesk = [
  { at: 0, lean: 0.02, nod: 0.04, gaze: down, worry: 0, raise: 0, frown: 0, smile: 0.4, open: 0, typing: 1, headphones: 0, ...keys },
  { at: open.at + 200, typing: 0.3, smile: 0.6, gaze: [0.1, 0.2] },
  { at: outOfQuota - 10, worry: 1, smile: -0.5, typing: 0, gaze: [0.1, 0.55], lean: 0.03 },
  { at: takesOver, worry: 0, smile: 0.8, raise: 0.4 },
  { at: limit.to - 30, raise: 0, smile: 0.5, typing: 1, gaze: down },
  { at: cardShown - 6, raise: 1, open: 0.7, typing: 0, lean: -0.02, gaze: [0.1, 0.3] },
  { at: blocked - 20, raise: 0, open: 0, frown: 0.7, gaze: down },
  { at: archived, frown: 0, smile: 0.9 },
  { at: dash.from + 20, smile: 0.3, typing: 1, lean: 0.03, gaze: down },
  { at: dash.to - 70, smile: 0.7, typing: 0.2 },
  { at: maya.from, smile: 0.5, typing: 0.4 },
  { at: maya.at + 150, smile: 0.9, raise: 0.3, typing: 0, gaze: [0.3, 0.1] },
  { at: story.from, raise: 0, headphones: 1, typing: 0, lean: 0.01, smile: 0.5, nod: 0.08, gaze: [0.1, 0.3] },
  { at: handoff.from, headphones: 0, typing: 1, lean: 0.03, nod: 0.04, gaze: down, ...keys },
  // He takes the lid by its top edge and folds it down.
  { at: lidCloses - 16, typing: 0, near: [640, 634], far: [520, 634], nearHand: "lid", farHand: "lid", nearBend: "straight", farBend: "straight", smile: 0.6 },
  { at: lidCloses, near: [640, 728], far: [520, 728], over: 18 },
  { at: lidCloses + 30, lean: -0.02, near: [690, 470], far: [470, 470], nearBend: "out", farBend: "out", nearHand: "fist", farHand: "fist", smile: 1, gaze: [0.1, -0.6], shut: 1, over: 22 },
];
// At the café he holds his phone in both hands in front of him and looks down at it.
const atCafe = [{ at: 0, lean: 0.03, nod: 0.1, gaze: [0.1, 0.7], smile: 0.6, open: 0, typing: 0, near: [866, -430], far: [824, -430], nearHand: "phone", farHand: "phone", nearBend: "tucked", farBend: "tucked" }, { at: lunch.at + 120, smile: 0.9, raise: 0.4 }];
const onTrain = [
  { at: 0, lean: 0.03, nod: 0.1, gaze: [0.1, 0.7], smile: 0.4, typing: 0, near: [3176, 784], far: [3132, 784], nearHand: "phone", farHand: "phone", nearBend: "tucked", farBend: "tucked" },
  { at: launched - 4, smile: 1, open: 0.6, raise: 0.6, gaze: [0.2, -0.2], far: [3110, 540], farBend: "out", farHand: "fist", over: 10 },
  { at: shipped.to - 40, open: 0, raise: 0.2 },
];
const mayaKeys = { near: [1975, 728], far: [2045, 728], nearHand: "hidden", farHand: "hidden" };
const mayaPose = [
  { at: 0, lean: 0.02, nod: 0.04, gaze: [0.15, 0.75], smile: 0.5, typing: 1, ...mayaKeys },
  { at: maya.at + 120, typing: 0, smile: 0.8, raise: 0.4 },
  { at: maya.at + 160, typing: 1, raise: 0 },
];

const t = {
  draw: {
    title: [4, 56], desk: [38, 92], alex: [70, 128], room: [104, 170],
    cafeFront: [lunch.from + 6, lunch.from + 40], cafeAlex: [lunch.from + 24, lunch.from + 74], cafeRoom: [lunch.from + 54, lunch.from + 104],
    mayaDesk: [maya.from + 14, maya.from + 46], maya: [maya.from + 34, maya.from + 82], mayaRoom: [maya.from + 64, maya.from + 110],
    homeFront: [lidCloses + 50, lidCloses + 86], homeRoom: [lidCloses + 72, lidCloses + 120],
    trainFront: [train.from + 8, train.from + 32], trainAlex: [train.from + 20, train.from + 66], trainRoom: [train.from + 46, train.from + 96],
  },
  clock: [[0, 542], [limit.from, 640], [guard.from, 675], [dash.from, 710], [lunch.from, 750], [maya.from, 850], [story.from, 990], [handoff.from, 1060]],
  lid: [[0, 1], [lidCloses, 0]],
  alex: { office: atDesk, cafe: atCafe, train: onTrain },
  maya: mayaPose,
  links: { maya: { from: maya.from + 96, gone: story.from - 6 }, server: { from: lidCloses + 20 } },
  // The phones' screens, drawn large beside him while the story looks at them.
  projections: { lunch: { from: lunch.from + 44, gone: maya.from - 4 }, train: { from: train.from + 64 } },
  journey: [
    { from: 150, to: 176, points: [[300, 1050], [420, 1062]], label: "9:02 AM", labelAt: [360, 1110] },
    { from: lunch.from - 46, to: lunch.from - 4, points: [[290, 1060], [130, 760], [110, 300], [190, -150], [420, -190]], label: "12:30 PM", labelAt: [320, -232] },
    { from: maya.from - 36, to: maya.from + 4, points: [[1500, -160], [1600, 60], [1400, 260]], label: "2:10 PM", labelAt: [1590, 250] },
    { from: train.from - 50, to: train.from - 12, points: [[1220, 1062], [1700, 1110], [2200, 1110], [2560, 1080]], label: "5:40 PM", labelAt: [1290, 1120] },
    { from: train.from - 16, to: train.from + 4, points: [[2560, 1080], [2600, 1078]], label: "5:50 PM", labelAt: [2660, 1130] },
    { from: launched + 10, to: launched + 40, points: [[3300, 1080], [3640, 1080]], label: "6:00 PM · launched ✓", labelAt: [3560, 1130], color: "#0f8a6c" },
  ],
};

const desk = frameRect(places.desk.x, places.desk.y, places.desk.w, places.desk.h);
const office = frameRect(places.office.x, places.office.y, places.office.w, places.office.h, 0.04);
const laptop = devices.laptop;
const phoneView = (device, fill = 0.8) => view(device.x + device.w / 2, device.y + device.h / 2 + 0.05 * device.h, (HEIGHT * fill) / device.h);
const wide = (name, margin) => frameRect(places[name].x, places[name].y, places[name].w, places[name].h, margin);

export default defineSketch({
  id: "monday",
  kicker: "A day with Joint Bob",
  duration,
  end,
  tagline: ["Ship faster.", "Stay in charge."],
  places: world(t),
  screens: () => ({
    laptop: [plan, pool, card, archive, ask, built, saved, hisSide, hosts, runsOn, ownership],
    lunchPhone: [lunchAnswer, lunchForm, lunchSaved],
    hers: [herMessage, herFork],
    server: [{ clip: "moveServer", from: lidCloses + 12, to: duration, start: home.serverOpen + 4.5, rate: 1 }],
    trainPhone: [
      fit("movePhone", train.from - 6, train.at + 70, hand.done - 1.2, hand.done + 1.0),
      fit("movePhone", train.at + 70, shipped.from, hand.phoneSend - 1.4, hand.merged + 0.4),
      fit("launchPhone", shipped.from, launched + 60, launchPhone.report - 0.4, launchPhone.report + 2.6),
      { clip: "launchPhone", from: launched + 60, to: duration, start: launchPhone.report + 2.6, rate: 0.4 },
    ],
  }),
  shots: [
    // The title being written, then the office drawn around Alex, then into his screen.
    { from: 0, to: 50, start: view(560, 190, 1.9), end: view(600, 200, 1.75) },
    { from: 50, to: 150, start: view(600, 200, 1.75), end: office },
    { from: 150, to: 215, start: office, end: desk },
    { from: 215, to: open.to, start: desk, end: onScreen(laptop, 0.52, 0.5, 1.16) },
    { from: limit.from, to: takesOver + 40, start: onScreen(laptop, 0.58, 0.66, 0.98), end: onScreen(laptop, 0.58, 0.7, 0.86) },
    { from: takesOver + 40, to: limit.to, start: desk, end: view(640, 640, 3.4) },
    { from: guard.from, to: halfGuard, start: onScreen(laptop, 0.68, 0.7, 1.04), end: onScreen(laptop, 0.74, 0.76, 0.88) },
    { from: halfGuard, to: archived + 30, start: onScreen(laptop, 0.62, 0.58, 1.04), end: onScreen(laptop, 0.6, 0.52, 0.94) },
    { from: archived + 30, to: guard.to, start: desk, end: view(650, 640, 3.3) },
    { from: dash.from, to: dash.at + 70, start: onScreen(laptop, 0.5, 0.48, 1.1), end: onScreen(laptop, 0.5, 0.5, 0.99) },
    { from: dash.at + 70, to: lunch.from - 10, start: onScreen(laptop, 0.62, 0.55, 1.16), end: onScreen(laptop, 0.64, 0.55, 1.01) },
    // Up the sheet to the café.
    { from: lunch.from - 10, to: lunch.from + 80, start: wide("cafe", 0.04), end: wide("cafe", 0.0), glide: 50 },
    { from: lunch.from + 80, to: maya.from - 10, start: phoneView(devices.lunchPhone, 0.74), end: phoneView(devices.lunchPhone, 0.84) },
    // Back down to the office, where Maya is drawn in beside him.
    { from: maya.from - 10, to: maya.from + 140, start: wide("both", 0.02), end: wide("both", -0.02), glide: 50 },
    { from: maya.from + 140, to: maya.at + 140, start: onScreen(devices.hers, 0.6, 0.62, 1.1), end: onScreen(devices.hers, 0.62, 0.66, 0.99) },
    { from: maya.at + 140, to: story.from, start: onScreen(devices.hers, 0.56, 0.45, 1.16), end: onScreen(devices.hers, 0.6, 0.5, 1.04) },
    // The review, with headphones on.
    { from: story.from, to: story.at + 110, start: view(660, 630, 3.0), end: view(650, 625, 3.4) },
    { from: story.at + 110, to: handoff.from, start: onScreen(laptop, 0.5, 0.45, 1.16), end: onScreen(laptop, 0.5, 0.45, 1.04) },
    // 5:40: the server takes over, the lid shuts, the work flies home.
    { from: handoff.from, to: handoff.at + 60, start: onScreen(laptop, 0.4, 0.28, 0.83), end: onScreen(laptop, 0.36, 0.22, 0.68) },
    { from: handoff.at + 60, to: lidCloses - 20, start: onScreen(laptop, 0.55, 0.45, 1.1), end: onScreen(laptop, 0.5, 0.38, 0.99) },
    { from: lidCloses - 20, to: lidCloses + 40, start: desk, end: view(650, 620, 2.6) },
    { from: lidCloses + 40, to: train.from - 6, start: wide("home", 0.04), end: wide("home", 0.0), glide: 50 },
    // Down to the train, and into his phone.
    { from: train.from - 6, to: train.from + 96, start: wide("train", 0.04), end: wide("train", 0.0), glide: 50 },
    { from: train.from + 96, to: launched + 50, start: phoneView(devices.trainPhone, 0.72), end: phoneView(devices.trainPhone, 0.84) },
    { from: launched + 50, to: shipped.to - 10, start: view(3240, 650, 2.2), end: view(3250, 660, 2.4) },
    // The whole day, from above.
    { from: shipped.to - 10, to: duration, start: wide("sheet", 0.05), end: wide("sheet", 0.1), glide: 64 },
  ],
  rings: [
    { from: outOfQuota, to: takesOver, part: part(laptop, 0.231, 0.649, 0.463, 0.8), tone: "sun" },
    { from: takesOver, to: takesOver + 40, part: part(laptop, 0.473, 0.649, 0.704, 0.8) },
    { from: cardShown, to: blocked - 4, part: part(laptop, 0.478, 0.71, 0.985, 0.88), tone: "sun" },
    { from: archived, to: archived + 30, part: part(laptop, 0.505, 0.33, 0.675, 0.73) },
    { from: dash.at + 80, to: dash.to - 4, part: part(laptop, 0.347, 0.388, 0.972, 0.747) },
    { from: handoff.from + 10, to: handoff.at + 58, part: part(laptop, 0.262, 0.105, 0.405, 0.168) },
  ],
  notes: [
    { text: "Claude account 1: out of quota", paint: "pink", from: outOfQuota, to: takesOver, at: { x: 1400, y: 230 }, tilt: 3 },
    { text: "Account 2 takes over ✓", paint: "mint", from: takesOver, to: takesOver + 40, at: { x: 1440, y: 230 }, tilt: -3 },
    { text: "phew.", paint: "paper", from: takesOver + 52, to: limit.to - 4, at: { x: 1320, y: 300 }, tilt: 4, size: 64 },
    { text: "rm -rf? Ask first ✋", paint: "pink", from: cardShown, to: blocked - 4, at: { x: 1420, y: 230 }, tilt: -3 },
    { text: "Archived. Nothing deleted ✓", paint: "mint", from: archived, to: guard.to - 4, at: { x: 1440, y: 230 }, tilt: 3 },
    { text: "Checkout health, built for him", paint: "sun", from: dash.at + 80, to: dash.to - 4, at: { x: 1300, y: 200 }, tilt: -3 },
    { text: "On track ✓", paint: "mint", from: lunch.from + 96, to: lunch.from + 128, at: { x: 1440, y: 300 }, tilt: 3 },
    { text: "Launch: Mondays, 6 PM 🚀", paint: "sun", from: lunch.from + 204, to: maya.from - 12, at: { x: 1400, y: 300 }, tilt: -3 },
    { text: "Her own fork 🍴", paint: "sun", from: maya.at + 150, to: story.from - 8, at: { x: 1460, y: 230 }, tilt: -3 },
    { text: "PR #212, explained 🎙️", paint: "sun", from: story.at + 20, to: story.at + 104, at: { x: 1440, y: 230 }, tilt: 3 },
    { text: "Now runs on: Home server ✓", paint: "mint", from: handoff.at + 70, to: lidCloses - 22, at: { x: 1420, y: 230 }, tilt: -3 },
    { text: "Still running ✓", paint: "mint", from: lidCloses + 104, to: train.from - 8, at: { x: 1460, y: 220 }, tilt: 4 },
    { text: "Merged ✓", paint: "mint", from: merged, to: shipped.from + 6, at: { x: 1440, y: 300 }, tilt: 3, size: 72 },
    { text: "v2.4 is live 🚀", paint: "sun", from: launched, to: launched + 50, at: { x: 1440, y: 300 }, tilt: -3, size: 72 },
  ],
  confetti: [{ at: launched, origin: { x: 960, y: 420 }, until: launched + 75 }],
  light: [
    { at: 0, x: 0.1, y: 0.1, near: [255, 231, 186, 1], far: [255, 248, 236, 1] },
    { at: lunch.from, x: 0.5, y: 0.0, near: [255, 250, 238, 1], far: [255, 255, 255, 1] },
    { at: handoff.from, x: 0.9, y: 0.2, near: [255, 214, 170, 1], far: [255, 240, 226, 1], over: 60 },
    { at: train.from - 20, x: 0.8, y: 0.1, near: [236, 214, 236, 1], far: [222, 226, 246, 1], over: 60 },
    { at: shipped.to - 10, x: 0.5, y: 0.4, near: [255, 250, 238, 1], far: [255, 255, 255, 1], over: 40 },
  ],
  lines,
  sounds: [
    score("monday", duration, 1.42), ...spoken(lines),
    sfx("alarm", outOfQuota), sfx("chime", takesOver),
    sfx("alarm", cardShown), sfx("pop", blocked), sfx("chime", archived),
    sfx("chime", dash.at + 80), sfx("chime", lunch.from + 96), sfx("pop", lunch.from + 204),
    sfx("chime", maya.from + 50), sfx("pop", maya.at + 150), sfx("pop", story.at + 20),
    sfx("chime", handoff.at + 70), sfx("lid", lidCloses + 14, 0.5), sfx("chime", lidCloses + 104), sfx("chime", merged), sfx("party", launched),
  ],
});
