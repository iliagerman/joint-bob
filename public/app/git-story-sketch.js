import { createPen, easeInOut, FPS, oval, paperTile, pencilSvg, progress, roundRect } from "./sketch/ink.js";
import { between, drift, frameRect, HEIGHT, project, view, WIDTH } from "./sketch/camera.js";
import { jonahLook, mayaLook, person } from "./sketch/people.js";
import { boardRect, drawBoard, FRONT, ROOM, ROOMS, roomX, SEAT_Y, SEATS } from "./git-story-rooms.js";
import { drawHeading, shownAt, slideItems } from "./git-story-board.js";

// The Activity overview's stage, drawn on paper like the landing page's films: each chapter is a
// room drawn on one long sheet by a pencil, Maya and Jonah talk in it behind a table, and the
// chapter's slide is drawn on the board between them as the lines are spoken. The camera glides to
// a chapter's room when it starts, then settles where the slide can be read. The player tells the
// stage what happens (`enter` a chapter, a `line` and who acts how) and calls `draw` every frame;
// the stage keeps its own clock in frames, as the films do.

const LOOKS = { host: mayaLook, cohost: jonahLook };
const NAMES = { host: "Maya", cohost: "Jonah" };
const NAME_COLORS = { host: "#c4561f", cohost: "#3f6fb6" };
const FACE = { host: 1, cohost: -1 };
const OTHER = { host: "cohost", cohost: "host" };
// The light over the frame in each mood: warm paper, a darker edge when it is tense, a green tint for an insight, sunrise once resolved.
const LIGHTS = {
  calm: { near: [255, 248, 236], far: [248, 242, 236] },
  tension: { near: [248, 236, 232], far: [212, 188, 190] },
  insight: { near: [240, 255, 246], far: [226, 242, 232] },
  resolved: { near: [255, 238, 208], far: [250, 222, 198] },
};
const OUTDOOR = new Set(["street", "rooftop"]);
// When each part of a room is drawn, in frames from the moment the pencil starts on it.
const PARTS = { back: [0, 40], front: [8, 40], host: [14, 56], cohost: [24, 66], board: [30, 58] };
const ITEMS_FROM = 56;
const MARKS = ["?", "!", "💡"];
const MIN_FRAME_MS = 30;

let caveat = null;
// The handwriting is the films' Caveat, loaded the first time a stage is made.
function loadHandwriting() {
  caveat ??= (() => {
    const face = new FontFace("Caveat", `url("${new URL("./sketch/caveat.ttf", import.meta.url).href}")`, { weight: "400 700" });
    document.fonts.add(face);
    return face.load().catch((error) => console.warn(`The overview's handwriting did not load (${error.message}); it is drawn in the browser's own font.`));
  })();
  return caveat;
}

const wide = (ox) => frameRect(ox, ROOM.top, ROOM.w, ROOM.h, 0.04);
const withHosts = (ox) => view(ox + 700, 436, 1.45);
const onBoard = (ox) => { const board = boardRect(ox); return frameRect(board.x - 24, board.y - 30, board.w + 48, board.h + 60, 0.03); };
const toward = (ox, who) => view(ox + (who === "host" ? 560 : 840), 405, 1.55);

// The mouth while a host speaks: open on the syllables, never still for long.
const syllable = (frame) => Math.max(0, 0.18 + 0.42 * Math.abs(Math.sin(frame * 0.62)) * (0.65 + 0.35 * Math.sin(frame * 0.17 + 1)));

/** Moves every number of `pose` a share `k` of the way to `target`; anything else takes the target's value. */
function ease(pose, target, k) {
  if (!pose) return { ...target };
  const next = { ...target };
  for (const [name, value] of Object.entries(target)) {
    const was = pose[name];
    if (Array.isArray(value) && Array.isArray(was)) next[name] = value.map((v, i) => was[i] + (v - was[i]) * k);
    else if (typeof value === "number" && typeof was === "number") next[name] = was + (value - was) * k;
  }
  return next;
}

/**
 * How a host holds themselves for what they are doing, in the room's own frame (x from the room's
 * left edge): hands on the table, a hand up to ask or towards the board, a fist for a cheer.
 */
function targetPose(host, frame, speaking, mood) {
  const face = FACE[host.who];
  const seat = SEATS[host.who];
  const partner = [1, 0.05];
  const board = [0.8, -0.55];
  const us = [0.15, 0.05];
  const pose = {
    lean: 0.02, nod: 0.03, gaze: partner, smile: 0.5, worry: 0, raise: 0, frown: 0,
    near: [seat + face * 42, FRONT + 6], far: [seat - face * 38, FRONT + 9], nearBend: "tucked", farBend: "tucked", nearHand: "rest", farHand: "rest",
  };
  const since = frame - host.at;
  const action = host.action === "pointThenExplain" && since >= 40 ? "explain" : host.action;
  // A raised hand stays above the microphone on the table in front of them.
  if (action === "ask") Object.assign(pose, { raise: 0.7, smile: 0.3, near: [seat + face * 150, 596], nearBend: "out" });
  else if (action === "pointThenExplain") Object.assign(pose, { gaze: board, raise: 0.3, smile: 0.6, near: [seat + face * 160, 562], nearBend: "out" });
  else if (action === "explain") {
    Object.assign(pose, { gaze: Math.floor((frame + (host.who === "host" ? 0 : 40)) / 75) % 2 ? us : partner, smile: 0.6 });
    if (speaking) Object.assign(pose, { near: [seat + face * (96 + 14 * Math.sin(frame / 9)), 646 - 10 * Math.sin(frame / 13)], nearBend: "out" });
  } else if (action === "think") Object.assign(pose, { gaze: [0.4, -0.8], smile: 0.1, raise: 0.2 });
  else if (action === "worry") Object.assign(pose, { gaze: board, worry: 0.8, smile: -0.3 });
  else if (action === "cheer") {
    Object.assign(pose, { gaze: us, smile: 1, raise: 0.5 });
    if (since < 60) Object.assign(pose, { far: [seat - face * 14, 590], farBend: "out", farHand: "fist" });
  } else Object.assign(pose, { nod: 0.03 + 0.03 * Math.max(0, Math.sin(frame / 20)) });
  if (mood === "tension" && action !== "cheer") pose.worry = Math.max(pose.worry, 0.3);
  if (mood === "resolved") pose.smile = Math.max(pose.smile, 0.7);
  return pose;
}

const shifted = (pose, ox) => ({ ...pose, near: [pose.near[0] + ox, pose.near[1]], far: [pose.far[0] + ox, pose.far[1]] });

/** "?" and "!" in a speech bubble over a head, or a light bulb for an insight. */
function drawMark(pen, mark, x, y) {
  if (mark === "💡") {
    pen.wash(oval(x, y - 6, 44, 44, 16), "#ffd77a", { alpha: 0.35 });
    pen.shape(oval(x, y - 10, 20, 22, 14), { fill: "#ffe27a", alpha: 0.9, width: 2.6 });
    pen.shape(roundRect(x - 10, y + 10, 20, 14, 4), { fill: "#c4c9ce", alpha: 0.8, width: 2.2 });
    for (const turn of [-1.2, -0.6, 0, 0.6, 1.2]) pen.line([x + Math.sin(turn) * 32, y - 10 - Math.cos(turn) * 32], [x + Math.sin(turn) * 44, y - 10 - Math.cos(turn) * 44], { width: 2.6, over: 0 });
    return;
  }
  pen.shape(oval(x, y - 6, 34, 30, 16), { fill: "#fffaf0", alpha: 0.9, width: 2.6 });
  pen.stroke([[x - 14, y + 20], [x - 22, y + 36], [x - 2, y + 22]], { width: 2.4, smooth: false });
  pen.text(mark, x, y + 10, { size: 50, align: "center", color: mark === "?" ? "#3f6fb6" : "#c4561f" });
}

/** Rain over an outdoor room when the chapter is tense, falling a little slanted. */
function rain(ctx, ox, frame) {
  ctx.save();
  ctx.strokeStyle = "rgba(110, 130, 165, 0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 0; k < 90; k++) {
    const x = ox + 40 + ((k * 397 - frame * 4) % 1320 + 1320) % 1320;
    const y = 60 + ((k * 211 + frame * 26) % 660);
    ctx.moveTo(x, y);
    ctx.lineTo(x - 5, y + 22);
  }
  ctx.stroke();
  ctx.restore();
}

export function createSketchStage(canvas, pencil) {
  const ctx = canvas.getContext("2d");
  const tile = paperTile();
  const pattern = ctx.createPattern(tile, "repeat");
  const totals = new Map();
  const rooms = new Map();
  const hosts = { host: { who: "host", action: "listen", at: 0, mark: null, pose: null }, cohost: { who: "cohost", action: "listen", at: 0, mark: null, pose: null } };
  const light = { near: [...LIGHTS.calm.near], far: [...LIGHTS.calm.far] };
  const started = performance.now();
  let generation = 0;
  let current = null;
  let camera = { from: view(700, 480, 1.2), to: view(700, 480, 1.2), start: 0, span: 1 };
  let pending = null;
  let lastDraw = 0;
  let handwriting = false;
  for (const host of Object.values(hosts)) host.pose = targetPose(host, 0, false, "calm");
  // Parsed into real SVG nodes; the app never assigns markup strings to elements.
  pencil.replaceChildren(document.importNode(new DOMParser().parseFromString(pencilSvg(), "image/svg+xml").documentElement, true));
  loadHandwriting().then(() => {
    handwriting = true;
    for (const room of rooms.values()) prepare(room, frameAt(performance.now()));
  });

  const frameAt = (now) => ((now - started) * FPS) / 1000;
  const placeAt = (frame) => between(camera.from, camera.to, easeInOut(progress(frame, camera.start, camera.start + camera.span)));
  // The camera glides to `to` over `span` frames, starting no earlier than `notBefore`.
  function aim(to, frame, span, notBefore = frame) {
    if (notBefore > frame) { pending = { to, start: notBefore, span }; return; }
    pending = null;
    camera = { from: placeAt(frame), to, start: frame, span };
  }
  function settle(frame) {
    if (!pending || frame < pending.start) return;
    const { to, span } = pending;
    pending = null;
    camera = { from: placeAt(frame), to, start: frame, span };
  }

  // The slide's items are laid out once the handwriting is in, so they are measured in it.
  function prepare(room, frame) {
    if (!handwriting) return;
    room.items = slideItems(room.chapter.visual, room.board);
    measure(room);
    reveal(room, room.reveal, frame);
  }

  // One pass with every line drawn, so each group knows how much ink it has to lay down.
  function measure(room) {
    const pen = createPen(ctx, { frame: 0, zoom: 1, view: null, paper: () => pattern, totals, measure: true });
    drawRoom(pen, room, 0, true);
    for (const who of ["host", "cohost"]) for (const mark of MARKS) {
      pen.begin(`emote-${who}-${mark}`, 0, 1, 34);
      drawMark(pen, mark, 0, 0);
      pen.end();
    }
    pen.finish();
  }

  function reveal(room, step, frame) {
    room.reveal = step;
    const shown = new Map();
    let queued = 0;
    for (const item of shownAt(room.items, step)) {
      const since = room.shown.get(item.id);
      if (since !== undefined) { shown.set(item.id, since); continue; }
      shown.set(item.id, Math.max(frame, room.at + ITEMS_FROM) + queued * 10);
      queued += 1;
    }
    room.shown = shown;
  }

  function drawHost(pen, room, who, frame) {
    const { ox, at } = room;
    const id = `${generation}-${room.seg}`;
    const seat = ox + SEATS[who];
    const [from, to] = PARTS[who];
    pen.begin(`${id}-${who}`, at + from, at + to, 10);
    person(pen, { at: [seat, SEAT_Y], look: LOOKS[who], dir: FACE[who], pose: shifted(hosts[who].pose, ox), frame, layer: 10, nearLayer: 21, farLayer: 21 });
    if (room.room.sit) {
      pen.on(9);
      pen.shape(roundRect(seat - 78, 600, 156, 150, 30), { fill: room.room.chair ?? "#55606b", alpha: 0.5, width: 2.6 });
    }
    pen.on(23);
    pen.text(NAMES[who], seat, 846, { size: 42, align: "center", color: NAME_COLORS[who] });
    pen.end();
    const host = hosts[who];
    if (room !== current || !host.mark || frame > host.mark.at + 60) return;
    pen.begin(`emote-${who}-${host.mark.text}`, host.mark.at, host.mark.at + 10, 34);
    drawMark(pen, host.mark.text, seat + FACE[who] * 80, 400);
    pen.end();
  }

  function drawRoom(pen, room, frame, measuring) {
    const { ox, at } = room;
    const id = `${generation}-${room.seg}`;
    const t = { frame, sunP: room.sunP };
    pen.begin(`${id}-back`, at + PARTS.back[0], at + PARTS.back[1], 0);
    room.room.back(pen, ox, t);
    pen.end();
    pen.begin(`${id}-front`, at + PARTS.front[0], at + PARTS.front[1], 20);
    room.room.front(pen, ox, t);
    pen.end();
    for (const who of ["host", "cohost"]) drawHost(pen, room, who, frame);
    pen.begin(`${id}-board`, at + PARTS.board[0], at + PARTS.board[1], 26);
    drawBoard(pen, room.board, room.room);
    drawHeading(pen, room.board, room.chapter.title);
    pen.end();
    for (const item of room.items) {
      const from = measuring ? 0 : room.shown.get(item.id);
      if (from === undefined) continue;
      pen.begin(`${id}-${item.id}`, from, from + item.span, item.group === "hl" ? 31 : 30);
      item.draw(pen);
      pen.end();
    }
  }

  function lightAndVignette() {
    const rgb = (c) => `rgb(${c.map(Math.round).join(",")})`;
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    const wash = ctx.createRadialGradient(WIDTH * 0.35, HEIGHT * 0.2, 0, WIDTH * 0.35, HEIGHT * 0.2, WIDTH * 1.1);
    wash.addColorStop(0, rgb(light.near));
    wash.addColorStop(1, rgb(light.far));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.45, WIDTH / 2, HEIGHT / 2, WIDTH * 0.75);
    vignette.addColorStop(0, "rgba(255,255,255,0)");
    vignette.addColorStop(1, "rgba(196,178,150,0.55)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
  }

  return {
    /** A new script: every room is drawn again from blank paper. */
    reset() {
      generation += 1;
      rooms.clear();
      totals.clear();
      current = null;
    },
    /** The story moves into chapter `seg`, in the room `place`; the pencil draws it as the camera arrives. */
    enter(seg, chapter, place, mood) {
      const frame = frameAt(performance.now());
      const ox = roomX(seg);
      const moving = Boolean(current) && current.seg !== seg;
      const room = { seg, ox, key: place, room: ROOMS[place], chapter, mood, at: frame + (moving ? 26 : 0), board: boardRect(ox), items: [], shown: new Map(), reveal: 0, sunP: 0 };
      rooms.set(seg, room);
      current = room;
      prepare(room, frame);
      aim(wide(ox), frame, moving ? 46 : 1);
    },
    /**
     * A line starts: the slide shows up to `reveal`, the speaker acts, the listener reacts, `marks` go over heads
     * ({ who, text } with "?", "!" or "💡"), and the camera finds its shot.
     */
    line({ seg, reveal: step, speaker, action, reaction, marks, question }) {
      const frame = frameAt(performance.now());
      const room = rooms.get(seg);
      reveal(room, step, frame);
      Object.assign(hosts[speaker], { action, at: frame });
      Object.assign(hosts[OTHER[speaker]], { action: reaction, at: frame });
      for (const who of ["host", "cohost"]) {
        const mark = marks.find((candidate) => candidate.who === who);
        hosts[who].mark = mark ? { text: mark.text, at: Math.max(frame, room.at + PARTS[who][1]) } : null;
      }
      const target = room.chapter.visual.kind === "code" ? onBoard(room.ox) : question ? toward(room.ox, speaker) : withHosts(room.ox);
      aim(target, frame, 26, room.at + 44);
    },
    /** The frame at `now`: `speaking` is the host whose voice is playing, `sunP` how far the chapter's sun has risen. */
    draw(now, { speaking, sunP }) {
      if (now - lastDraw < MIN_FRAME_MS) return;
      const steps = lastDraw ? Math.min(4, ((now - lastDraw) * FPS) / 1000) : 1;
      lastDraw = now;
      const frame = frameAt(now);
      settle(frame);
      const mood = current?.mood ?? "calm";
      if (current) current.sunP = sunP;
      for (const who of ["host", "cohost"]) {
        const host = hosts[who];
        host.pose = { ...ease(host.pose, targetPose(host, frame, speaking === who, mood), 1 - Math.exp(-steps / 4)), open: speaking === who ? syllable(frame) : 0 };
      }
      const goal = LIGHTS[mood];
      const k = 1 - Math.exp(-steps / 20);
      for (const part of ["near", "far"]) light[part] = light[part].map((value, i) => value + (goal[part][i] - value) * k);

      const at = drift(placeAt(frame), frame);
      const scale = canvas.width / WIDTH;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const offset = new DOMMatrix([1, 0, 0, 1, (-at.x * at.zoom * scale) % tile.width, (-at.y * at.zoom * scale) % tile.height]);
      const paper = () => { pattern.setTransform(ctx.getTransform().invertSelf().multiplySelf(offset)); return pattern; };
      ctx.fillStyle = paper();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.translate(WIDTH / 2, HEIGHT / 2);
      ctx.rotate(at.tilt);
      ctx.scale(at.zoom, at.zoom);
      ctx.translate(-at.x, -at.y);
      const reach = Math.hypot(WIDTH, HEIGHT) / 2 / at.zoom;
      const bounds = { x1: at.x - reach, x2: at.x + reach, y1: at.y - reach, y2: at.y + reach };
      const pen = createPen(ctx, { frame, zoom: at.zoom, view: bounds, paper, totals });
      // Only the rooms the camera can see are drawn; a room the story has not reached yet is still blank paper.
      for (const room of rooms.values()) if (room.ox + ROOM.w >= bounds.x1 && room.ox <= bounds.x2) drawRoom(pen, room, frame, false);
      pen.finish();
      if (current && mood === "tension" && OUTDOOR.has(current.key)) rain(ctx, current.ox, frame);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      lightAndVignette();

      const tip = pen.tip();
      const point = tip ? project(at, tip) : null;
      const onFrame = point && point.x > -100 && point.x < WIDTH + 100 && point.y > -100 && point.y < HEIGHT + 100;
      pencil.hidden = !onFrame;
      if (onFrame) pencil.style.transform = `translate(${(point.x * 960) / WIDTH}px, ${(point.y * 540) / HEIGHT}px) scale(0.5)`;
    },
    /** The canvas keeps as many pixels as it is shown at, up to the films' 1920 across. */
    resize(width) {
      const pixels = Math.min(WIDTH, Math.round(width * (window.devicePixelRatio || 1)));
      if (canvas.width === pixels) return;
      canvas.width = pixels;
      canvas.height = Math.round((pixels * 9) / 16);
      lastDraw = 0;
    },
  };
}
