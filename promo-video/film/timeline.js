// Everything that is a function of time: scene boundaries, which part of which recording
// is on which screen, where the devices are, where the camera is, and when each sound plays.
// Plain module, used by the page that draws the film and by the script that renders it.
import * as THREE from "three";

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION = 1344;
export const FOV = 28;

// Scene starts, in frames. The film has five parts: the problem (an agent dies with the
// laptop), the same moment with Joint Bob, a teammate joining in, an alert that becomes a
// pull request overnight, and the numbers that say what happened.
export const scene = {
  roll: 0,        // an agent at work in a terminal
  lidOne: 75,     // the lid closes
  dead: 120,      // and the agent is gone
  rewind: 210,    // "let's try that again"
  withBob: 285,   // the same task in Joint Bob, running on the server
  lidTwo: 345,    // the lid closes again; the server carries on
  phone: 450,     // checking in from a phone
  team: 540,      // a teammate opens the same conversation and posts into it
  fork: 633,      // then forks it to try her own idea
  hook: 726,      // a webhook: what calls it, and what the agent should do
  night: 804,     // 3 AM, production breaks, the alert calls the webhook
  report: 918,    // the conversation the call started, and its report
  morning: 1041,  // the fix waiting in the review inbox
  costs: 1098,    // the dashboard: where the money went, what changed, and why
  end: 1230,
};

// World layout, in metres-ish. The laptop sits at the origin on the floor.
export const laptop = { width: 3.4, depth: 2.3, height: 0.1, lidThickness: 0.05, screenWidth: 3.14, screenHeight: 1.9625, openAngle: (100 * Math.PI) / 180 };
export const serverPanel = { center: new THREE.Vector3(3.9, 2.05, -1.5), width: 4.8, height: 3.0, turn: -0.14 };
export const phone = { center: new THREE.Vector3(6.9, 1.75, 1.7), screenWidth: 1.0, screenHeight: 2.174, turn: -0.22 };
// The teammate's screen stands beside the server's, the two turned in like an open book.
export const teamPanel = { center: new THREE.Vector3(9.1, 2.05, -1.5), width: 4.8, height: 3.0, turn: -0.12 };
export const serverTurnForTeam = 0.12;
export const hookPanel = { center: new THREE.Vector3(15.0, 2.1, 0), width: 5.6, height: 3.5, turn: 0 };
// Where the phone stands for the morning scene, the wall of logs for the night, and the dashboard.
export const morningPhone = { center: new THREE.Vector3(21.6, 1.8, 1.5), turn: 0.12 };
export const logWall = { center: new THREE.Vector3(25.0, 2.1, 0), width: 5.6, height: 3.5, turn: 0 };
export const costsPanel = { center: new THREE.Vector3(33.0, 2.1, 0), width: 5.6, height: 3.5, turn: 0 };

export const colors = { background: "#0a1216", accent: "#37cfab", text: "#ebeced", muted: "#94999e", danger: "#ff5d55", sun: "#ffb454" };
export const fonts = {
  serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  sans: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
};

const clamp01 = (value) => Math.min(1, Math.max(0, value));
export const progress = (frame, from, to) => clamp01((frame - from) / (to - from));
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t) => t * t * t;
/** Overshoots a little before settling, for things that pop in. */
export const pop = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
export const linear = (t) => t;

/** Lid angle. Shut once to kill the agent, flung open by the rewind, then shut again with the server carrying on. */
export function lidAngle(frame) {
  const firstClose = easeIn(progress(frame, scene.lidOne + 9, scene.lidOne + 33));
  const reopen = pop(progress(frame, scene.rewind + 2, scene.rewind + 26));
  const secondClose = easeIn(progress(frame, scene.lidTwo + 5, scene.lidTwo + 29));
  if (frame < scene.rewind + 2) return laptop.openAngle * (1 - firstClose);
  if (frame < scene.lidTwo + 5) return laptop.openAngle * Math.min(1.04, reopen);
  return laptop.openAngle * (1 - secondClose);
}

/** A point on the laptop's open screen, in screen fractions from its top left, and the way the screen faces. */
export function laptopScreenPoint(u, v) {
  const along = laptop.depth / 2 + 0.01 + (0.5 - v) * laptop.screenHeight;
  const angle = laptop.openAngle;
  return new THREE.Vector3((u - 0.5) * laptop.screenWidth, laptop.height + along * Math.sin(angle), -laptop.depth / 2 + along * Math.cos(angle));
}
const laptopFacing = new THREE.Vector3(0, -Math.cos(laptop.openAngle), Math.sin(laptop.openAngle));

/** The server's screen turns to face the middle when the teammate's screen arrives beside it. */
export function serverTurn(frame) {
  return serverPanel.turn + (serverTurnForTeam - serverPanel.turn) * easeInOut(progress(frame, scene.team - 4, scene.team + 14));
}

/** A point on an upright screen, in screen fractions from its top left. `turn` overrides the screen's own. */
export function panelPoint(panel, u, v, turn = panel.turn ?? 0) {
  const across = (u - 0.5) * panel.width;
  return new THREE.Vector3(panel.center.x + across * Math.cos(turn), panel.center.y + (0.5 - v) * panel.height, panel.center.z - across * Math.sin(turn));
}
/** A camera view that faces a point on an upright screen from `distance` away. */
export function facing(panel, u, v, distance, side = 0, turn = panel.turn ?? 0) {
  const target = panelPoint(panel, u, v, turn);
  return { position: [target.x + Math.sin(turn) * distance + side, target.y + 0.04, target.z + Math.cos(turn) * distance], target: target.toArray() };
}
/** A camera view that faces a point on the laptop's screen from `distance` away. */
export function facingLaptop(u, v, distance, side = 0, rise = 0) {
  const target = laptopScreenPoint(u, v);
  const position = target.clone().addScaledVector(laptopFacing, distance);
  return { position: [position.x + side, position.y + rise, position.z], target: target.toArray() };
}

const closedLaptop = { position: [2.3, 3.0, 7.0], target: [0.9, 0.5, -0.3] };
const twoScreens = { position: [2.4, 3.3, 9.6], target: [2.2, 1.35, -0.8] };
const phoneShot = { position: [6.5, 1.75, 8.4], target: [6.3, 1.5, 0.6] };
const phoneClose = { position: [6.8, 1.72, 7.5], target: [6.6, 1.5, 0.9] };
const sideBySide = { position: [6.5, 2.35, 11.0], target: [6.5, 1.95, -1.5] };
const morningClose = { position: [21.8, 1.78, 7.8], target: [21.75, 1.55, 1.5] };
const wide = { position: [8.0, 4.0, 21.5], target: [8.0, 2.0, 0] };
const shots = [
  // Part one. Close on the terminal, back as the lid comes down, then creep in on the body.
  { from: 0, to: 75, start: { position: [1.2, 2.2, 4.7], target: [0.05, 1.13, -1.2] }, end: { position: [0.6, 2.1, 4.2], target: [0.03, 1.1, -1.15] }, ease: easeOut },
  { from: 75, to: 120, start: { position: [0.6, 2.1, 4.2], target: [0.03, 1.1, -1.15] }, end: closedLaptop, ease: easeInOut },
  { from: 120, to: 210, start: closedLaptop, end: { position: [1.8, 2.5, 5.8], target: [0.5, 0.45, -0.2] }, ease: linear },
  // The rewind snaps back to where the film began.
  { from: 210, to: 238, start: { position: [1.8, 2.5, 5.8], target: [0.5, 0.45, -0.2] }, end: { position: [0.9, 2.15, 4.8], target: [0.04, 1.12, -1.2] }, ease: easeInOut },
  { from: 238, to: 285, start: { position: [0.9, 2.15, 4.8], target: [0.04, 1.12, -1.2] }, end: { position: [0.7, 2.1, 4.5], target: [0.04, 1.12, -1.2] }, ease: linear },
  // Part two. Right up to the screen, where "Runs on: Home server" can be read.
  { from: 285, to: 345, start: facingLaptop(0.46, 0.34, 4.1, 0.5, 0.1), end: facingLaptop(0.44, 0.3, 3.4, 0.25, 0.05), ease: easeOut },
  { from: 345, to: 368, start: facingLaptop(0.44, 0.3, 3.4, 0.25, 0.05), end: closedLaptop, ease: easeInOut },
  { from: 368, to: 390, start: closedLaptop, end: twoScreens, ease: easeInOut },
  { from: 390, to: 444, start: twoScreens, end: { position: [3.5, 2.7, 8.0], target: [3.5, 1.8, -1.2] }, ease: linear },
  { from: 444, to: 466, start: { position: [3.5, 2.7, 8.0], target: [3.5, 1.8, -1.2] }, end: phoneShot, ease: easeInOut },
  { from: 466, to: 534, start: phoneShot, end: phoneClose, ease: linear },
  // Part three. Two screens side by side, then a close look at each.
  { from: 534, to: 554, start: phoneClose, end: sideBySide, ease: easeInOut },
  { from: 554, to: 585, start: sideBySide, end: { position: [6.5, 2.3, 10.2], target: [6.5, 1.95, -1.5] }, ease: linear },
  { from: 585, to: 633, start: facing(serverPanel, 0.68, 0.58, 5.6, 0.2, serverTurnForTeam), end: facing(serverPanel, 0.7, 0.6, 4.8, 0.1, serverTurnForTeam), ease: easeOut },
  { from: 633, to: 663, start: facing(teamPanel, 0.6, 0.44, 5.6, -0.2), end: facing(teamPanel, 0.6, 0.42, 4.9, -0.1), ease: easeOut },
  { from: 663, to: 690, start: facing(teamPanel, 0.56, 0.2, 5.0, -0.1), end: facing(teamPanel, 0.54, 0.16, 4.3, -0.05), ease: easeOut },
  { from: 690, to: 720, start: facing(teamPanel, 0.68, 0.6, 5.5, -0.15), end: facing(teamPanel, 0.7, 0.62, 5.0, -0.05), ease: easeOut },
  // Part four. The webhook form, the night, the call, the report, the morning. Hard cuts between them.
  { from: 720, to: 734, start: facing(teamPanel, 0.7, 0.62, 4.9, -0.05), end: facing(hookPanel, 0.58, 0.38, 5.4, 0.2), ease: easeInOut },
  { from: 734, to: 804, start: facing(hookPanel, 0.58, 0.38, 5.4, 0.2), end: facing(hookPanel, 0.59, 0.38, 4.8, 0.05), ease: easeOut },
  { from: 804, to: 918, start: facing(logWall, 0.5, 0.56, 9.8, -0.6), end: facing(logWall, 0.5, 0.56, 8.4, 0.4), ease: linear },
  { from: 918, to: 951, start: facing(hookPanel, 0.36, 0.5, 5.2, 0.15), end: facing(hookPanel, 0.36, 0.56, 4.4, 0.1), ease: easeOut },
  { from: 951, to: 990, start: facing(hookPanel, 0.72, 0.5, 5.8, -0.15), end: facing(hookPanel, 0.72, 0.5, 5.3, -0.1), ease: linear },
  { from: 990, to: 1041, start: facing(hookPanel, 0.72, 0.5, 5.5, -0.15), end: facing(hookPanel, 0.73, 0.52, 4.6, -0.05), ease: easeOut },
  { from: 1041, to: 1098, start: { position: [21.95, 1.8, 8.5], target: [21.8, 1.55, 1.5] }, end: morningClose, ease: easeOut },
  // Part five. The dashboard, three looks.
  { from: 1098, to: 1140, start: facing(costsPanel, 0.5, 0.42, 6.6, 0.3), end: facing(costsPanel, 0.5, 0.42, 5.7, 0.1), ease: easeOut },
  { from: 1140, to: 1191, start: facing(costsPanel, 0.45, 0.42, 5.9, -0.2), end: facing(costsPanel, 0.42, 0.4, 4.9, -0.05), ease: easeOut },
  { from: 1191, to: 1230, start: facing(costsPanel, 0.62, 0.32, 5.8, 0.2), end: facing(costsPanel, 0.64, 0.3, 5.0, 0.05), ease: easeOut },
  // Out to the first screens for the end card.
  { from: 1230, to: 1264, start: { position: [20, 4.5, 24], target: [14, 2.0, 0] }, end: wide, ease: easeOut },
  { from: 1264, to: DURATION, start: wide, end: { position: [8.0, 4.2, 23], target: [8.0, 2.0, 0] }, ease: linear },
];

export function cameraAt(frame) {
  const shot = shots.find((candidate) => frame >= candidate.from && frame < candidate.to) ?? shots[shots.length - 1];
  const t = shot.ease(progress(frame, shot.from, shot.to));
  const position = new THREE.Vector3(...shot.start.position).lerp(new THREE.Vector3(...shot.end.position), t);
  const target = new THREE.Vector3(...shot.start.target).lerp(new THREE.Vector3(...shot.end.target), t);
  // A slight float, so a held shot never looks frozen.
  position.x += Math.sin(frame / 31) * 0.035;
  position.y += Math.sin(frame / 23) * 0.025;
  // The picture jolts when the agent dies.
  const jolt = 1 - progress(frame, scene.dead, scene.dead + 14);
  if (frame >= scene.dead && jolt > 0) position.x += Math.sin(frame * 2.7) * 0.07 * jolt;
  return { position, target };
}

const projector = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.1, 200);
/** Where a point in the world lands on the frame, for labels drawn over the 3D scene. */
export function project(point, frame) {
  const view = cameraAt(frame);
  projector.position.copy(view.position);
  projector.lookAt(view.target);
  projector.updateMatrixWorld();
  const projected = point.clone().project(projector);
  return { x: (projected.x * 0.5 + 0.5) * WIDTH, y: (-projected.y * 0.5 + 0.5) * HEIGHT, visible: projected.z < 1 && Math.abs(projected.x) < 1.2 && Math.abs(projected.y) < 1.2 };
}

/** The mood of the room: its colour and the colour of the glow behind the devices. */
export function moodAt(frame) {
  const moods = {
    calm: { background: "#0a1216", glow: "#37cfab" },
    dead: { background: "#170b0e", glow: "#ff5d55" },
    night: { background: "#070b1f", glow: "#5b7cff" },
    morning: { background: "#24130c", glow: "#ffb454" },
  };
  const blend = (a, b, t) => ({ background: new THREE.Color(a.background).lerp(new THREE.Color(b.background), t), glow: new THREE.Color(a.glow).lerp(new THREE.Color(b.glow), t) });
  if (frame < scene.dead) return blend(moods.calm, moods.dead, progress(frame, scene.lidOne + 30, scene.dead + 6));
  if (frame < scene.night) return blend(moods.dead, moods.calm, progress(frame, scene.rewind, scene.rewind + 20));
  if (frame < scene.report) return blend(moods.night, moods.night, 0);
  if (frame < scene.morning) return blend(moods.night, moods.calm, progress(frame, scene.report, scene.report + 12));
  if (frame < scene.costs) return blend(moods.morning, moods.morning, 0);
  return blend(moods.morning, moods.calm, progress(frame, scene.costs, scene.costs + 10));
}

/**
 * Narration lines and the captions that carry the same message with the sound off.
 * Words between asterisks are picked out in colour.
 */
export const lines = [
  { audio: "audio/vo-01.mp3", at: 8, until: 70, text: "Your agent is *on a roll.* 🚀" },
  { audio: "audio/vo-02.mp3", at: 72, until: 122, text: "You close the laptop." },
  { audio: "audio/vo-03.mp3", at: 126, until: 208, text: "And your agent… *dies.* 💀", tone: "danger" },
  { audio: "audio/vo-04.mp3", at: 214, until: 0, text: "" },
  { audio: "audio/vo-05.mp3", at: 288, until: 343, text: "Now it runs on *your server.*" },
  { audio: "audio/vo-06.mp3", at: 348, until: 446, text: "Close the lid. *It keeps going.*" },
  { audio: "audio/vo-07.mp3", at: 456, until: 536, text: "Check in *from your phone.* 📱" },
  { audio: "audio/vo-08.mp3", at: 546, until: 631, text: "Bring in *a teammate.* Same conversation, live. 👋" },
  { audio: "audio/vo-09.mp3", at: 638, until: 722, text: "Or *fork it* and try your own idea. 🍴" },
  { audio: "audio/vo-10.mp3", at: 732, until: 802, text: "Wire your alerts to *an agent.* 🔔" },
  { audio: "audio/vo-11.mp3", at: 809, until: 916, text: "3 AM. Production breaks. *The alert calls Joint Bob.*", tone: "danger" },
  { audio: "audio/vo-12.mp3", at: 923, until: 1039, text: "It finds the bug. Fixes it. *Opens a pull request.*" },
  { audio: "audio/vo-13.mp3", at: 1045, until: 1096, text: "You wake up to *a fix.* ☕" },
  { audio: "audio/vo-14.mp3", at: 1104, until: 1228, text: "Then see what happened, *and why.* 📊" },
  { audio: "audio/vo-15.mp3", at: 1234, until: 0, text: "" },
];

/**
 * Every sound, in frames. The music stops dead with the agent and comes back with the rewind,
 * picking up where it left off. `offset` and `length` are seconds into the file.
 */
const musicStops = (scene.lidOne + 33) / FPS;
export const sounds = [
  { audio: "audio/music.mp3", at: 0, volume: 0.1, offset: 0, length: musicStops, fadeIn: 0.3, fadeOut: 0.06 },
  { audio: "audio/music.mp3", at: scene.rewind + 26, volume: 0.1, offset: musicStops, length: (DURATION - (scene.rewind + 26)) / FPS, fadeIn: 0.15, fadeOut: 1.3 },
  ...lines.map((line) => ({ audio: line.audio, at: line.at, volume: 1.7 })),
  { audio: "audio/sfx-lid.mp3", at: scene.lidOne + 29, volume: 0.85 },
  { audio: "audio/sfx-powerdown.mp3", at: scene.lidOne + 33, volume: 0.45 },
  { audio: "audio/sfx-flatline.mp3", at: scene.dead + 2, volume: 0.12, length: 1.6, fadeOut: 0.3 },
  { audio: "audio/sfx-trombone.mp3", at: scene.dead + 52, volume: 0.4, length: 1.25, fadeOut: 0.25 },
  { audio: "audio/sfx-rewind.mp3", at: scene.rewind - 2, volume: 0.38 },
  { audio: "audio/sfx-pop.mp3", at: scene.rewind + 30, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.withBob - 3, volume: 0.35 },
  { audio: "audio/sfx-lid.mp3", at: scene.lidTwo + 25, volume: 0.85 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.lidTwo + 22, volume: 0.4 },
  { audio: "audio/sfx-pop.mp3", at: scene.lidTwo + 54, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.phone - 6, volume: 0.4 },
  { audio: "audio/sfx-pop.mp3", at: scene.phone + 22, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.team - 6, volume: 0.4 },
  { audio: "audio/sfx-pop.mp3", at: scene.team + 16, volume: 2.5 },
  { audio: "audio/sfx-chime.mp3", at: scene.team + 52, volume: 1.4 },
  { audio: "audio/sfx-pop.mp3", at: scene.fork + 30, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.hook - 6, volume: 0.4 },
  { audio: "audio/sfx-pop.mp3", at: scene.hook + 22, volume: 2.5 },
  { audio: "audio/sfx-pop.mp3", at: scene.hook + 44, volume: 2.5 },
  { audio: "audio/sfx-alarm.mp3", at: scene.night + 2, volume: 0.4 },
  { audio: "audio/sfx-snore.mp3", at: scene.night + 46, volume: 0.32 },
  { audio: "audio/sfx-alarm.mp3", at: scene.night + 84, volume: 0.3 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.report - 3, volume: 0.35 },
  { audio: "audio/sfx-chime.mp3", at: scene.report + 74, volume: 1.6 },
  { audio: "audio/sfx-party.mp3", at: scene.report + 76, volume: 25 },
  { audio: "audio/sfx-pop.mp3", at: scene.morning + 6, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.costs - 3, volume: 0.35 },
  { audio: "audio/sfx-pop.mp3", at: scene.costs + 48, volume: 2.5 },
  { audio: "audio/sfx-pop.mp3", at: scene.costs + 98, volume: 2.5 },
  { audio: "audio/sfx-whoosh.mp3", at: scene.end - 3, volume: 0.35 },
];

/**
 * Which stretch of which recording plays when. A segment maps video frames `from`..`to` onto
 * the recording starting at `start` seconds, at `rate` (0 holds one frame). The event times
 * come from the capture, so every cut lands on the real click it is meant to show.
 */
export function clipPlan(meta) {
  const laptopEvents = meta.laptop.events;
  const serverEvents = meta.server.events;
  const phoneEvents = meta.phone.events;
  const teamEvents = meta.teammate.events;
  const hookEvents = meta.webhook.events;
  const morningEvents = meta.morning.events;
  const costsEvents = meta.costs.events;
  // The laptop, the server and the phone show one conversation on one clock: `sent` seconds after the request went out.
  const sent = (frame) => 1.0 + (frame - scene.withBob) / FPS;
  // The teammate's message lands on the server's screen just after the cut to it.
  const teammateSends = scene.team + 38;
  const sinceTeammate = (frame) => (frame - teammateSends) / FPS;
  const typingRate = (hookEvents.typed - (hookEvents.form + 0.1)) / (66 / FPS);
  const working = { from: scene.report + 33, to: scene.report + 72 };
  return {
    // The laptop screen from the rewind until the lid is shut again.
    laptop: [{ from: scene.rewind + 20, to: scene.lidTwo + 32, start: laptopEvents.send + sent(scene.rewind + 20), rate: 1 }],
    // The home server: the same conversation at the same real moment, then the teammate's message arriving.
    server: [
      { from: scene.lidTwo + 15, to: scene.team - 6, start: serverEvents.send + sent(scene.lidTwo + 15), rate: 1 },
      { from: scene.team - 6, to: scene.team + 45, start: serverEvents.teammateSend + sinceTeammate(scene.team - 6), rate: 1 },
      // The close look starts once her message is past the queue and the agent has begun to answer.
      { from: scene.team + 45, to: scene.hook, start: serverEvents.teammateSend + 1.15, rate: 1 },
      { from: scene.end - 10, to: DURATION, start: serverEvents.teammateAnswered + 0.5, rate: 0 },
    ],
    // The phone: open the running conversation, send the next request, see the result.
    phone: [
      { from: scene.phone - 6, to: scene.phone + 42, start: phoneEvents.phoneOpen - 1.1, rate: 1 },
      { from: scene.phone + 42, to: scene.phone + 69, start: phoneEvents.phoneSend - 0.75, rate: 1 },
      { from: scene.phone + 69, to: scene.team + 16, start: phoneEvents.shipped - 0.3, rate: 1 },
    ],
    // The teammate's machine: she writes into the conversation, then forks it and asks her own question.
    teammate: [
      { from: scene.team - 6, to: scene.fork, start: teamEvents.teammateSend + sinceTeammate(scene.team - 6), rate: 1 },
      // The menu and the click, then the fork under its new name, then her own question in it.
      { from: scene.fork, to: scene.fork + 30, start: teamEvents.forkClick - 0.8, rate: 1 },
      // The fork takes its "[F]" name two seconds after it opens.
      { from: scene.fork + 30, to: scene.fork + 57, start: teamEvents.forked + 2.0, rate: 1 },
      { from: scene.fork + 57, to: scene.hook + 8, start: teamEvents.forkSend + 0.9, rate: 1 },
      { from: scene.end - 10, to: DURATION, start: teamEvents.forkAnswered + 0.5, rate: 0 },
    ],
    // The webhook: the form filled and held, then the conversation the call started, then its report.
    webhook: [
      { from: scene.hook - 6, to: scene.hook + 60, start: hookEvents.form + 0.1, rate: typingRate },
      { from: scene.hook + 60, to: scene.night, start: hookEvents.typed + 0.3, rate: 0 },
      { from: scene.report - 6, to: working.from, start: hookEvents.open - 1.3, rate: 1 },
      { from: working.from, to: working.to, start: hookEvents.open + 0.4, rate: (hookEvents.reported - 1.2 - (hookEvents.open + 0.4)) / ((working.to - working.from) / FPS) },
      // `reported` is when the report starts to arrive; it is whole about a second and a half later.
      { from: working.to, to: scene.costs, start: hookEvents.reported - 0.1, rate: 1 },
      { from: scene.end - 10, to: DURATION, start: hookEvents.reported + 2.0, rate: 0 },
    ],
    // The next morning on the phone: the review inbox, then the report.
    morning: [
      { from: scene.morning - 10, to: scene.morning + 32, start: morningEvents.inbox - 0.55, rate: 1.25 },
      { from: scene.morning + 32, to: scene.costs + 6, start: morningEvents.report + 0.1, rate: 0.4 },
    ],
    // The dashboard: totals by project, what changed and why, and the skill that fails more.
    costs: [
      // `overview` is when the totals and the table have loaded.
      { from: scene.costs - 6, to: scene.costs + 42, start: costsEvents.overview + 0.15, rate: 0.4 },
      { from: scene.costs + 42, to: scene.costs + 93, start: costsEvents.changes + 0.3, rate: 0.3 },
      { from: scene.costs + 93, to: scene.end + 40, start: costsEvents.insights + 0.4, rate: 0.3 },
    ],
  };
}

/** The recording frame a screen shows at a video frame, or null while that screen is off. */
export function sourceFrame(segments, frame, frameCount) {
  const segment = segments.find((candidate) => frame >= candidate.from && frame < candidate.to);
  if (!segment) return null;
  const time = segment.start + ((frame - segment.from) / FPS) * segment.rate;
  return Math.min(frameCount - 1, Math.max(0, Math.round(time * FPS)));
}
