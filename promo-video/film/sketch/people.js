// The people of the films, drawn with the pen: a big round head, a hoodie or a jumper, arms
// that reach for whatever their hands are placed on. Seen in three-quarter view, facing the way
// `dir` says. A pose is a set of numbers (lean, where the eyes look, brows, smile) and the points
// the hands go to; `poseAt` blends a list of poses over time.
import { easeInOut, progress } from "../timeline.js";
import { oval } from "./ink.js";

export const alexLook = { name: "alex", skin: "#f3c7a3", hair: "#5b3a29", top: "#8edbc4", glasses: true, legs: "#7f9cc8", shoes: "#3b3532" };
export const mayaLook = { name: "maya", skin: "#c98d69", hair: "#30241f", top: "#ffc56a", glasses: false, earring: "#37cfab", legs: "#5f6f8f", shoes: "#3b3532" };

const blush = "#f2958a";
const arm = { upper: 80, fore: 74, width: 29 };

/**
 * A pose at a frame, from a list of { at, over, ...pose }: each pose blends in over `over` frames
 * (14 by default) from the one before. Hand points blend too.
 */
export function poseAt(keys, frame) {
  let pose = { ...keys[0] };
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    if (frame < key.at) break;
    const t = easeInOut(progress(frame, key.at, key.at + (key.over ?? 14)));
    const next = { ...pose };
    for (const [name, value] of Object.entries(key)) {
      if (name === "at" || name === "over") continue;
      const was = pose[name];
      if (Array.isArray(value) && Array.isArray(was)) next[name] = value.map((v, k) => was[k] + (v - was[k]) * t);
      else if (typeof value === "number" && typeof was === "number") next[name] = was + (value - was) * t;
      else next[name] = t < 0.5 ? was : value;
    }
    pose = next;
  }
  return pose;
}

/** Where the elbow goes for a hand at `hand`: two bones, bending downwards. */
function elbowFor(shoulder, hand, bend) {
  const dx = hand[0] - shoulder[0];
  const dy = hand[1] - shoulder[1];
  const reach = Math.min(arm.upper + arm.fore - 2, Math.max(Math.abs(arm.upper - arm.fore) + 2, Math.hypot(dx, dy)));
  const base = Math.atan2(dy, dx);
  const open = Math.acos((arm.upper * arm.upper + reach * reach - arm.fore * arm.fore) / (2 * arm.upper * reach));
  const options = [base + open, base - open].map((angle) => [shoulder[0] + Math.cos(angle) * arm.upper, shoulder[1] + Math.sin(angle) * arm.upper]);
  // The elbow hangs below the line from shoulder to hand, or sticks out when `bend` says.
  return bend === "out" ? (options[0][0] < options[1][0] ? options[0] : options[1]) : options[0][1] > options[1][1] ? options[0] : options[1];
}

/** The outline of a sleeve along shoulder, elbow and wrist, rounded at both ends. */
function tube(points, width) {
  const half = width / 2;
  const normal = (a, b) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const size = Math.hypot(dx, dy) || 1; return [-dy / size, dx / size]; };
  const [s, e, w] = points;
  const n1 = normal(s, e);
  const n2 = normal(e, w);
  const nm = [(n1[0] + n2[0]) / 2, (n1[1] + n2[1]) / 2];
  const side = (n, sign) => (p) => [p[0] + n[0] * half * sign, p[1] + n[1] * half * sign];
  const along = [(w[0] - e[0]) / (Math.hypot(w[0] - e[0], w[1] - e[1]) || 1), (w[1] - e[1]) / (Math.hypot(w[0] - e[0], w[1] - e[1]) || 1)];
  const back = [(s[0] - e[0]) / (Math.hypot(s[0] - e[0], s[1] - e[1]) || 1), (s[1] - e[1]) / (Math.hypot(s[0] - e[0], s[1] - e[1]) || 1)];
  return [
    side(n1, 1)(s), side(nm, 1)(e), side(n2, 1)(w),
    [w[0] + along[0] * half * 0.5 + n2[0] * half * 0.4, w[1] + along[1] * half * 0.5 + n2[1] * half * 0.4],
    [w[0] + along[0] * half * 0.5 - n2[0] * half * 0.4, w[1] + along[1] * half * 0.5 - n2[1] * half * 0.4],
    side(n2, -1)(w), side(nm, -1)(e), side(n1, -1)(s),
    [s[0] + back[0] * half * 0.9, s[1] + back[1] * half * 0.9],
  ];
}

/**
 * Draws one person. `at` is the point they sit on, `layer` the bottom of the four layers they use
 * (the far arm, the body, the head, the near arm). `pose` comes from `poseAt`. The head is drawn
 * first, as an artist would, then the body, then the arms.
 */
export function person(pen, { at, look, dir = 1, pose, frame, layer = 10, nearLayer = layer + 3, legs = false, scale = 1 }) {
  const [hx, hy] = at;
  const lean = pose.lean ?? 0;
  const breath = 1 + 0.012 * Math.sin(frame / 22 + hx);
  // From the body's own frame (x forward, y down, from the seat) to the sheet.
  const body = (x, y) => {
    const by = y * breath;
    const rx = x * Math.cos(lean) - by * Math.sin(lean);
    const ry = x * Math.sin(lean) + by * Math.cos(lean);
    return [hx + dir * rx * scale, hy + ry * scale];
  };
  const headCenter = body(6, -236);
  const nod = (pose.nod ?? 0) + lean * 0.4 + Math.sin(frame / 47 + hx) * 0.02;
  const head = (x, y) => {
    const rx = x * Math.cos(nod) - y * Math.sin(nod);
    const ry = x * Math.sin(nod) + y * Math.cos(nod);
    return [headCenter[0] + dir * rx * scale, headCenter[1] + ry * scale];
  };
  const map = (fn, points) => points.map(([x, y]) => fn(x, y));

  // The head.
  pen.on(layer + 2);
  pen.shape(map(head, oval(0, 0, 54, 57, 18).map(([x, y]) => [x + (y > 10 && x > 0 ? 3 : 0), y])), { fill: look.skin, alpha: 0.6, width: 3.2 });
  pen.shape(map(head, [[-22, -8], [-33, -13], [-39, 1], [-33, 16], [-22, 14]]), { fill: look.skin, alpha: 0.7, width: 2.6 });
  pen.stroke(map(head, [[-26, -3], [-31, 2], [-26, 8]]), { width: 1.8 });
  drawHair(pen, look, head, map);
  drawFace(pen, look, pose, frame, head, map, hx);
  if ((pose.headphones ?? 0) > 0.5) {
    pen.stroke(map(head, [[-36, -18], [-30, -58], [0, -78], [32, -70], [48, -50]]), { width: 7, color: "#3d4348" });
    pen.shape(map(head, oval(-31, 2, 15, 22, 12)), { fill: "#37cfab", alpha: 0.8, width: 2.8 });
    // Sound, coming out of the headphones.
    for (const k of [1, 2]) pen.stroke(map(head, [[-58 - k * 12, -16 - k * 6], [-64 - k * 14, 2], [-58 - k * 12, 20 + k * 6]]), { width: 2.4, alpha: 0.4 + 0.3 * Math.abs(Math.sin(frame / 9 + k)) });
  }

  // The body: the neck, the hood behind it, the hoodie or jumper.
  pen.on(layer + 1);
  pen.shape(map(body, [[-6, -168], [-6, -196], [20, -198], [22, -168]]), { fill: look.skin, alpha: 0.6, width: 2.4 });
  if (look.name === "alex") pen.shape(map(body, [[-44, -160], [-50, -192], [-26, -210], [6, -206], [-6, -186], [-24, -168]]), { fill: look.top, alpha: 0.75, width: 2.8 });
  pen.shape(map(body, [[-56, 4], [-63, -64], [-58, -126], [-44, -160], [-14, -178], [26, -176], [50, -158], [60, -116], [59, -56], [53, 4]]), { fill: look.top, alpha: 0.62, width: 3.2 });
  if (look.name === "alex") {
    pen.stroke(map(body, [[2, -172], [0, -138]]), { width: 2 });
    pen.stroke(map(body, [[20, -170], [23, -140]]), { width: 2 });
    pen.stroke(map(body, [[-22, -34], [-10, -60], [36, -60], [46, -34]]), { width: 2.2 });
  } else {
    pen.stroke(map(body, [[-14, -176], [2, -158], [24, -175]]), { width: 2.2 });
    pen.stroke(map(body, [[-52, -20], [52, -20]]), { width: 1.8, alpha: 0.7 });
  }

  if (legs) drawLegs(pen, look, body, map, layer);

  // The arms reach for the hands' points; the far one sits behind the body.
  const shoulders = { near: body(36, -148), far: body(-26, -150) };
  const hands = { near: pose.near ?? body(70, -40), far: pose.far ?? body(40, -30) };
  const typing = pose.typing ?? 0;
  const jiggle = (k) => [Math.sin(frame * 1.7 + k) * 2.5 * typing, Math.abs(Math.sin(frame * 1.3 + k * 2)) * -4 * typing];
  for (const side of ["far", "near"]) {
    const shift = jiggle(side === "near" ? 0 : 2);
    const hand = [hands[side][0] + shift[0], hands[side][1] + shift[1]];
    const elbow = elbowFor(shoulders[side], hand, pose[`${side}Bend`]);
    pen.on(side === "far" ? layer : nearLayer);
    const shade = side === "far" ? 0.8 : 0.62;
    pen.shape(tube([shoulders[side], elbow, hand], arm.width * scale), { fill: look.top, alpha: shade, width: 2.8 });
    const along = [(hand[0] - elbow[0]) / arm.fore, (hand[1] - elbow[1]) / arm.fore];
    const palm = [hand[0] + along[0] * 12 * scale, hand[1] + along[1] * 12 * scale];
    pen.shape(oval(palm[0], palm[1], 14 * scale, 12.5 * scale, 10), { fill: look.skin, alpha: 0.7, width: 2.4 });
  }
  pen.on(layer);
  return { head: headCenter, shoulders };
}

function drawHair(pen, look, head, map) {
  if (look.name === "alex") {
    pen.shape(map(head, [[-50, 20], [-58, -12], [-53, -40], [-35, -60], [-6, -69], [24, -65], [46, -51], [58, -31], [57, -15], [48, -24], [42, -12], [33, -27], [22, -19], [11, -33], [-2, -25], [-12, -37], [-21, -21], [-30, -7], [-36, 12]]), { fill: look.hair, alpha: 0.85, width: 3 });
    pen.stroke(map(head, [[-6, -68], [0, -84], [12, -80]]), { width: 2.6 });
    pen.stroke(map(head, [[-30, -46], [-14, -56], [6, -58]]), { width: 1.6, alpha: 0.6 });
    return;
  }
  // A bun on top, and hair down to the jaw at the back.
  pen.shape(map(head, oval(-18, -74, 25, 22, 12)), { fill: look.hair, alpha: 0.85, width: 3 });
  pen.stroke(map(head, [[-30, -78], [-16, -88], [-6, -74], [-18, -66]]), { width: 1.6, alpha: 0.7 });
  pen.shape(map(head, [[-46, 38], [-58, 2], [-55, -34], [-37, -57], [-7, -66], [24, -62], [46, -47], [57, -25], [50, -20], [36, -36], [16, -42], [-2, -36], [-18, -24], [-29, -4], [-33, 24], [-38, 46]]), { fill: look.hair, alpha: 0.85, width: 3 });
}

function drawFace(pen, look, pose, frame, head, map, offset) {
  const gaze = pose.gaze ?? [0.4, 0.1];
  const worry = pose.worry ?? 0;
  const raise = pose.raise ?? 0;
  const frown = pose.frown ?? 0;
  const smile = pose.smile ?? 0.3;
  const open = pose.open ?? 0;
  // A blink every three seconds or so, unless the pose shuts the eyes.
  const cycle = (frame + Math.round(offset)) % 97;
  const shut = pose.shut ?? (cycle < 4 ? 1 : 0);
  const eyes = [[12, -1, 4.4], [40, -2, 3.8]];
  for (const [x, y, r] of eyes) {
    const ex = x + gaze[0] * 3.5;
    const ey = y + gaze[1] * 3;
    if (shut > 0.5) pen.stroke(map(head, [[ex - 5, ey + 1], [ex, ey + 3], [ex + 5, ey + 1]]), { width: 2.4 });
    else pen.dot(...head(ex, ey), r * 0.85);
  }
  if (look.glasses) {
    pen.ellipse(...head(12, -2), 15, 14.5, { width: 2.6 });
    pen.ellipse(...head(40, -3), 11.5, 13.5, { width: 2.4 });
    pen.stroke(map(head, [[27, -6], [29.5, -7]]), { width: 2.2, smooth: false });
    pen.stroke(map(head, [[-3, -5], [-24, -7]]), { width: 2.2, smooth: false });
  }
  if (look.earring) pen.shape(oval(...head(-28, 22), 4, 4, 8), { fill: look.earring, alpha: 0.9, width: 1.6 });
  // Brows: the inner ends rise with worry and drop with a frown; both lift in surprise.
  const inner = -worry * 6 + frown * 5 - raise * 7;
  const outer = worry * 2 - frown * 1 - raise * 7;
  pen.stroke(map(head, [[1, -24 + outer], [11, -28 + (inner + outer) / 2], [22, -26 + inner]]), { width: 2.8 });
  pen.stroke(map(head, [[33, -27 + inner], [42, -29 + (inner + outer) / 2], [50, -24 + outer]]), { width: 2.6 });
  // The nose, the cheeks, the mouth.
  pen.stroke(map(head, [[49, 0], [58, 10], [50, 14]]), { width: 2.4 });
  pen.wash(map(head, oval(13, 15, 9, 6, 8)), blush, { alpha: 0.3 });
  pen.wash(map(head, oval(45, 15, 6, 5, 8)), blush, { alpha: 0.3 });
  if (open > 0.15) {
    pen.shape(map(head, oval(35, 28, 6 + 2 * open, 3 + 6 * open, 10)), { fill: "#8a3c33", alpha: 0.8, width: 2.4 });
  } else {
    pen.stroke(map(head, [[24, 24 - 4 * smile], [34, 27 + 5 * smile], [45, 23 - 4 * smile]]), { width: 2.6 });
  }
}

function drawLegs(pen, look, body, map, layer) {
  pen.on(layer);
  for (const [shift, shade] of [[-14, 0.85], [6, 0.65]]) {
    pen.shape(map(body, [[-30 + shift, -30], [100 + shift, -36], [118 + shift, -20], [116 + shift, 96], [92 + shift, 98], [90 + shift, 4], [-34 + shift, 12]]), { fill: look.legs, alpha: shade, width: 2.8, smooth: false });
    pen.shape(map(body, [[88 + shift, 96], [120 + shift, 94], [146 + shift, 104], [146 + shift, 116], [88 + shift, 116]]), { fill: look.shoes, alpha: 0.85, width: 2.6 });
  }
}
