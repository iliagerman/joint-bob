// The people of the films, drawn with the pen: Alex and Maya, nearly facing us and turned a little
// the way they face (`dir`). The faces follow the usual rules for an appealing cartoon: a rounded
// head with a short soft chin, the eyes at mid-height as dark ovals with a catch-light, thin relaxed
// brows, a small nose with the mouth close under it, ears level with the eyes. Alex wears a hoodie
// and round glasses, Maya a jumper, earrings and her hair in a bun. Arms reach for whatever their
// hands are placed on. A pose is a set of numbers (lean, where the eyes look, brows, smile) and the
// points the hands go to; `poseAt` blends a list of poses over time.
import { easeInOut, FPS, progress } from "../timeline.js";
import { oval } from "./ink.js";

export const alexLook = {
  name: "alex", skin: "#f6cdae", skinShade: "#e3a888", blush: "#f4a296", hair: "#5a3a2a", hairShade: "#43291d", hairLight: "#87604a",
  top: "#86d8c0", topShade: "#5cb69e", eye: "#2d211b", lips: "#b5584a", glasses: true, legs: "#7f9cc8", legsShade: "#5f7aa6", shoes: "#3b3532",
};
export const mayaLook = {
  name: "maya", skin: "#c98f6b", skinShade: "#a96f4f", blush: "#e3826f", hair: "#2c201b", hairShade: "#1b1410", hairLight: "#5b463b",
  top: "#f7bd5d", topShade: "#df9a3c", eye: "#22180f", lips: "#9c4a3e", glasses: false, earring: "#37cfab", legs: "#5f6f8f", legsShade: "#4a5875", shoes: "#3b3532",
};

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
function elbowFor(shoulder, hand, bend, outward = -1) {
  // An arm reaching towards us, as over a laptop's lid, is seen end-on: drawn straight, and short.
  if (bend === "straight") return [(shoulder[0] + hand[0]) / 2, (shoulder[1] + hand[1]) / 2];
  // Elbows tucked in at the sides, as when holding something at the chest: the upper arm hangs
  // down beside the body and the forearm, coming forward, is seen short.
  if (bend === "tucked") return [shoulder[0] + outward * 5, shoulder[1] + arm.upper * 0.8];
  const dx = hand[0] - shoulder[0];
  const dy = hand[1] - shoulder[1];
  const reach = Math.min(arm.upper + arm.fore - 2, Math.max(Math.abs(arm.upper - arm.fore) + 2, Math.hypot(dx, dy)));
  const base = Math.atan2(dy, dx);
  const open = Math.acos((arm.upper * arm.upper + reach * reach - arm.fore * arm.fore) / (2 * arm.upper * reach));
  const options = [base + open, base - open].map((angle) => [shoulder[0] + Math.cos(angle) * arm.upper, shoulder[1] + Math.sin(angle) * arm.upper]);
  // The elbow hangs below the line from shoulder to hand, or sticks out when `bend` says.
  // "out" puts the elbow away from the body, on the arm's own side (`outward` is -1 for the left).
  return bend === "out" ? (options[0][0] * outward > options[1][0] * outward ? options[0] : options[1]) : options[0][1] > options[1][1] ? options[0] : options[1];
}

/** The outline of a sleeve along shoulder, elbow and wrist, narrowing to the wrist and rounded at both ends. */
function tube(points, width) {
  const half = width / 2;
  const normal = (a, b) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const size = Math.hypot(dx, dy) || 1; return [-dy / size, dx / size]; };
  const [s, e, w] = points;
  const n1 = normal(s, e);
  const n2 = normal(e, w);
  const nm = [(n1[0] + n2[0]) / 2, (n1[1] + n2[1]) / 2];
  const halfAt = (p) => (p === s ? half : p === e ? half * 0.92 : half * 0.8);
  const side = (n, sign) => (p) => [p[0] + n[0] * halfAt(p) * sign, p[1] + n[1] * halfAt(p) * sign];
  const along = [(w[0] - e[0]) / (Math.hypot(w[0] - e[0], w[1] - e[1]) || 1), (w[1] - e[1]) / (Math.hypot(w[0] - e[0], w[1] - e[1]) || 1)];
  const back = [(s[0] - e[0]) / (Math.hypot(s[0] - e[0], s[1] - e[1]) || 1), (s[1] - e[1]) / (Math.hypot(s[0] - e[0], s[1] - e[1]) || 1)];
  return [
    side(n1, 1)(s), side(nm, 1)(e), side(n2, 1)(w),
    [w[0] + along[0] * half * 0.3 + n2[0] * half * 0.5, w[1] + along[1] * half * 0.3 + n2[1] * half * 0.5],
    [w[0] + along[0] * half * 0.3 - n2[0] * half * 0.5, w[1] + along[1] * half * 0.3 - n2[1] * half * 0.5],
    side(n2, -1)(w), side(nm, -1)(e), side(n1, -1)(s),
    [s[0] + back[0] * half * 0.9, s[1] + back[1] * half * 0.9],
  ];
}

/**
 * Draws one person. `at` is the point they sit on, `layer` the bottom of the four layers they use
 * (the far arm, the body, the head, the near arm). `pose` comes from `poseAt`. The head is drawn
 * first, as an artist would, then the body, then the arms.
 */
/**
 * Draws one person. `at` is the point they sit on, `layer` the bottom of the four layers they use
 * (the far arm, the body, the head, the near arm). `pose` comes from `poseAt`. The head is drawn
 * first, as an artist would, then the body, then the arms. The head and body are drawn in a
 * portrait's own units (the head's centre at 0,0, about 236 tall), scaled into the sheet by `K`.
 */
export function person(pen, { at, look, dir = 1, pose, frame, layer = 10, nearLayer = layer + 3, farLayer = layer, holding = null, gripLayer = layer + 2.7, legs = false, scale = 1 }) {
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
  // Portrait units: the head and the neck and shoulders around it.
  const H = (points) => points.map(([x, y]) => head(x * K, y * K));
  const B = (points) => points.map(([x, y]) => body(6 + x * K, -236 + y * K));

  pen.on(layer + 2);
  drawHead(pen, look, pose, frame, H, hx);

  // The body: the hood behind the neck, the hoodie or jumper, the neck, the collar.
  pen.on(layer + 1);
  const alex = look.name === "alex";
  if (alex) pen.shape(B([[-86, 176], [-80, 128], [-44, 106], [44, 106], [80, 128], [86, 176]]), { fill: look.topShade, alpha: 0.85, width: 2.8 });
  else drawNeck(pen, look, B, false);
  pen.shape(B([[-36, 150], [36, 150], [90, 166], [134, 204], [150, 280], [156, 500], [-156, 500], [-150, 280], [-134, 204], [-90, 166]]), { fill: look.top, alpha: 0.85, width: 3 });
  pen.wash(B([[-154, 496], [-148, 282], [-132, 208], [-104, 184], [-114, 282], [-116, 496]]), look.topShade, { alpha: 0.55 });
  if (alex) {
    drawNeck(pen, look, B, true);
    pen.stroke(B([[-40, 152], [0, 196], [40, 152]]), { width: 2.4 });
    pen.stroke(B([[-16, 184], [-20, 262]]), { width: 2 });
    pen.stroke(B([[16, 184], [20, 266]]), { width: 2 });
    pen.shape(B(oval(-20, 272, 4.5, 9, 10)), { fill: "#ffffff", alpha: 0.8, width: 1.6 });
    pen.shape(B(oval(20, 276, 4.5, 9, 10)), { fill: "#ffffff", alpha: 0.8, width: 1.6 });
  } else {
    pen.shape(B([[-38, 150], [0, 172], [38, 150], [40, 160], [0, 184], [-40, 160]]), { fill: look.topShade, alpha: 0.8, width: 2.2 });
  }

  if (legs) drawLegs(pen, look, body, map, layer);

  // The arms reach for the hands' points; the far one sits behind the body.
  const shoulders = { near: body(6 + 128 * K, -236 + 212 * K), far: body(6 - 120 * K, -236 + 214 * K) };
  const hands = { near: pose.near ?? body(70, -40), far: pose.far ?? body(40, -30) };
  // Typing: the hands take turns pressing keys, two or so presses a second each, in bursts with
  // pauses between. A press is a small dip of the hand and back, so the arm hardly moves.
  const typing = pose.typing ?? 0;
  const seconds = frame / FPS;
  const burst = easeInOut(Math.min(1, Math.max(0, (Math.sin(seconds * 1.15 + hx * 0.01) + 0.25) * 2.2)));
  const press = (k) => Math.pow(Math.max(0, Math.sin(seconds * Math.PI * 2 * 2.1 + k * Math.PI)), 6) * typing * burst;
  for (const side of ["far", "near"]) {
    const dip = press(side === "near" ? 0 : 1);
    const hand = [hands[side][0] + dip * 0.6 * scale, hands[side][1] + dip * 2.4 * scale];
    const elbow = elbowFor(shoulders[side], hand, pose[`${side}Bend`], side === "near" ? dir : -dir);
    // What the hand is doing: holding the phone (`holding`), gripping an edge, a fist, or resting.
    const kind = pose[`${side}Hand`] ?? (holding && side === "near" ? "phone" : "rest");
    // A hand holding a phone is behind it, its fingertips over the phone's edges.
    pen.on(kind === "phone" ? layer + 2.3 : side === "far" ? farLayer : nearLayer);
    // Sleeves the same colour as the hoodie or jumper, the far one a little deeper.
    const shade = side === "far" ? 0.92 : 0.85;
    pen.shape(tube([shoulders[side], elbow, hand], arm.width * scale), { fill: look.top, alpha: shade, width: 2.8 });
    const reach = Math.hypot(hand[0] - elbow[0], hand[1] - elbow[1]) || 1;
    const along = [(hand[0] - elbow[0]) / reach, (hand[1] - elbow[1]) / reach];
    if (kind === "phone") gripPhone(pen, look, holding, hand, gripLayer);
    else if (kind === "lid") gripEdge(pen, look, hand, scale, gripLayer);
    else if (kind === "fist") drawFist(pen, look, hand, along, scale);
    else if (kind !== "hidden") drawHand(pen, look, hand, along, scale, dip);
  }
  pen.on(layer);
  return { head: headCenter, shoulders };
}

/**
 * A hand at the end of a sleeve, drawn the way a cartoonist would: one mitten outline with the
 * thumb as a bump on the upper side, two creases for the fingers, which curl a little as a key is
 * pressed, and the sleeve's cuff over the wrist. `along` is the forearm's direction.
 */
function drawHand(pen, look, wrist, along, scale, dip) {
  // Across the forearm, the side that faces up on the sheet, where the thumb shows.
  let across = [-along[1], along[0]];
  if (across[1] > 0) across = [-across[0], -across[1]];
  const at = ([forward, side]) => [wrist[0] + (along[0] * forward + across[0] * side) * scale, wrist[1] + (along[1] * forward + across[1] * side) * scale];
  const curl = dip * 1.5;
  const mitten = [[0, -9], [10, -10.5], [20, -9.5], [26 - curl, -6], [28.5 - curl, -1], [27 - curl, 4], [21, 7], [15, 7.5], [13, 10], [9.5, 13.5], [4.5, 13.5], [1.5, 10.5], [0, 8.5]];
  pen.shape(mitten.map(at), { fill: look.skin, alpha: 0.72, width: 2.4 });
  pen.wash([[4, -9], [20, -9], [25 - curl, -5], [14, -3], [4, -4]].map(at), look.skinShade, { alpha: 0.3 });
  pen.stroke([[16, 2.5], [25.5 - curl, 2]].map(at), { width: 1.4, alpha: 0.6 });
  pen.stroke([[15, -3], [25 - curl, -3.5]].map(at), { width: 1.4, alpha: 0.6 });
  pen.stroke([[8, 9], [13, 6.5]].map(at), { width: 1.3, alpha: 0.5 });
  pen.shape([[-6, -11.5], [1.5, -11.5], [2, 11.5], [-6, 11.5]].map(at), { fill: look.top, alpha: 0.85, width: 2.4, smooth: false });
}

// Portrait units to the sheet: the head is about 112 tall there.
const K = 0.475;
/** Moves points sideways in proportion to how near the middle of the face they are: the slight turn. */
const turned = (points) => points.map(([x, y]) => [x + (1 - Math.abs(x) / 140) * 14, y]);
// How far the features sit forward of the head's middle, for the turn.
const ahead = 9;

/** The neck. Under a hoodie it runs down into the hood's V; under a jumper the collar covers its foot. */
function drawNeck(pen, look, B, vee) {
  const outline = vee ? [[-28, 92], [30, 92], [32, 146], [40, 152], [0, 194], [-40, 152], [-30, 146]] : [[-28, 92], [30, 92], [32, 170], [-30, 170]];
  pen.shape(B(outline), { fill: look.skin, alpha: 0.85, width: 2.4 });
  pen.wash(B([[-30, 94], [32, 94], [32, 128], [0, 120], [-30, 126]]), look.skinShade, { alpha: 0.5 });
  if (vee) pen.wash(B([[-40, 150], [0, 164], [40, 150], [0, 180]]), look.skinShade, { alpha: 0.45 });
}

/** The head: ears, the head itself, the hair, the face, glasses or earrings, headphones. */
function drawHead(pen, look, pose, frame, H, offset) {
  const maya = look.name === "maya";
  if (maya) {
    pen.shape(H(oval(ahead * 0.5, -150, 46, 40, 16)), { fill: look.hair, alpha: 0.9, width: 2.8 });
    pen.stroke(H([[ahead * 0.5 - 34, -152], [ahead * 0.5, -170], [ahead * 0.5 + 34, -150]]), { width: 2, color: look.hairLight, alpha: 0.8 });
  }
  for (const side of [-1, 1]) {
    const ex = side * 98 + ahead * 0.3;
    pen.shape(H(oval(ex, 10, 15, 22, 12)), { fill: look.skin, alpha: 0.85, width: 2.4 });
    pen.stroke(H([[ex - side * 2, 0], [ex + side * 6, 10], [ex - side * 2, 22]]), { width: 1.6, color: look.skinShade });
    if (look.earring) pen.shape(H(oval(ex, 40, 7, 7, 10)), { fill: look.earring, alpha: 0.9, width: 1.6 });
  }
  pen.shape(H(turned([[0, -118], [54, -110], [88, -80], [100, -34], [97, 12], [86, 52], [64, 86], [32, 108], [0, 114], [-32, 108], [-64, 86], [-86, 52], [-97, 12], [-100, -34], [-88, -80], [-54, -110]])), { fill: look.skin, alpha: 0.85, width: 3 });
  // Shade only down the far side of the face and a little under the chin.
  pen.wash(H(turned([[-97, 12], [-86, 52], [-64, 86], [-32, 108], [-8, 113], [-22, 102], [-50, 82], [-72, 50], [-84, 10], [-88, -14]])), look.skinShade, { alpha: 0.55 });
  drawHair(pen, look, H);
  drawFace(pen, look, pose, frame, H, offset);
  if ((pose.headphones ?? 0) > 0.5) {
    pen.stroke(H([[-104, -10], [-96, -110], [0, -164], [96, -110], [104, -10]]), { width: 6, color: "#3d4348" });
    for (const side of [-1, 1]) pen.shape(H(oval(side * 100 + ahead * 0.3, 8, 22, 32, 12)), { fill: "#37cfab", alpha: 0.85, width: 2.6 });
    // Sound, coming out of the headphones.
    for (const k of [1, 2]) pen.stroke(H([[-136 - k * 22, -24 - k * 10], [-148 - k * 26, 8], [-136 - k * 22, 40 + k * 10]]), { width: 2, alpha: 0.4 + 0.3 * Math.abs(Math.sin(frame / 9 + k)) });
  }
}

/**
 * A hand holding a phone whose back faces us: the thumb is on the screen, out of sight, and the
 * fingers wrap round the back, so we see three fingertips just inside the edge on the hand's side.
 */
function gripPhone(pen, look, r, hand, onLayer) {
  pen.on(onLayer);
  const left = hand[0] < r.x + r.w / 2;
  const x = left ? r.x + 3 : r.x + r.w - 3;
  for (const v of [0.46, 0.6, 0.74]) pen.shape(oval(x, r.y + r.h * v, 5.2, 4.4, 10), { fill: look.skin, alpha: 0.92, width: 1.6 });
}

/** Fingertips curled over an edge, like the top of a laptop's lid, the hand itself behind it. */
function gripEdge(pen, look, at, scale, onLayer) {
  pen.on(onLayer);
  for (const k of [-1.5, -0.5, 0.5, 1.5]) pen.shape(oval(at[0] + k * 7 * scale, at[1] + 2, 3.8 * scale, 5 * scale, 10), { fill: look.skin, alpha: 0.9, width: 1.6 });
}

/** A closed hand at the end of the forearm: a rounded fist with knuckles and the thumb across it. */
function drawFist(pen, look, wrist, along, scale) {
  let across = [-along[1], along[0]];
  if (across[1] > 0) across = [-across[0], -across[1]];
  const at = ([fw, sd]) => [wrist[0] + (along[0] * fw + across[0] * sd) * scale, wrist[1] + (along[1] * fw + across[1] * sd) * scale];
  pen.shape([[0, -12], [10, -14], [22, -12], [28, -4], [28, 6], [22, 12], [10, 13], [0, 11]].map(at), { fill: look.skin, alpha: 0.85, width: 2.2 });
  pen.stroke([[16, -10], [16, 8]].map(at), { width: 1.4, alpha: 0.6 });
  pen.stroke([[6, 9], [18, 4], [24, -2]].map(at), { width: 1.6, color: look.skinShade });
  pen.shape([[-6, -13], [2, -13], [2, 13], [-6, 13]].map(at), { fill: look.top, alpha: 0.85, width: 2, smooth: false });
}

function drawHair(pen, look, H) {
  if (look.name === "alex") {
    pen.shape(H(turned([[-102, -6], [-108, -58], [-92, -108], [-52, -138], [0, -148], [54, -140], [96, -110], [110, -62], [106, -12], [96, -36], [76, -58], [46, -58], [18, -72], [-8, -60], [-38, -68], [-68, -52], [-92, -28]])), { fill: look.hair, alpha: 0.92, width: 3 });
    pen.wash(H(turned([[-102, -6], [-108, -58], [-92, -108], [-66, -124], [-80, -80], [-84, -40], [-92, -28]])), look.hairShade, { alpha: 0.6 });
    pen.stroke(H(turned([[-30, -118], [8, -128], [44, -116]])), { width: 2.2, color: look.hairLight, alpha: 0.9 });
    pen.stroke(H(turned([[-60, -92], [-40, -104], [-16, -100]])), { width: 2.2, color: look.hairLight, alpha: 0.9 });
    return;
  }
  pen.shape(H(turned([[-100, 4], [-106, -54], [-88, -104], [-46, -134], [0, -142], [46, -134], [88, -104], [106, -54], [100, 4], [92, -24], [70, -62], [34, -80], [4, -78], [-30, -82], [-66, -64], [-90, -28]])), { fill: look.hair, alpha: 0.92, width: 3 });
  pen.wash(H(turned([[-100, 4], [-106, -54], [-88, -104], [-64, -120], [-76, -70], [-86, -28]])), look.hairShade, { alpha: 0.6 });
  pen.stroke(H(turned([[-58, -84], [-38, -112], [-16, -128]])), { width: 2.2, color: look.hairLight, alpha: 0.9 });
  pen.stroke(H(turned([[64, -80], [44, -110], [24, -128]])), { width: 2.2, color: look.hairLight, alpha: 0.9 });
  // Two loose strands framing the face.
  pen.stroke(H(turned([[-88, -36], [-96, 4], [-90, 40]])), { width: 2, color: look.hair });
  pen.stroke(H(turned([[90, -36], [98, 6], [92, 42]])), { width: 2, color: look.hair });
}

/**
 * The face: two dark oval eyes with catch-lights that look where the pose says and blink, brows
 * that rise with surprise and worry and drop with a frown, a small nose, and a mouth that smiles,
 * frowns or opens. Alex's round glasses go over his eyes.
 */
function drawFace(pen, look, pose, frame, H, offset) {
  const gaze = pose.gaze ?? [0.4, 0.1];
  const worry = pose.worry ?? 0;
  const raise = pose.raise ?? 0;
  const frown = pose.frown ?? 0;
  const smile = pose.smile ?? 0.3;
  const open = pose.open ?? 0;
  // A blink every three seconds or so, unless the pose shuts the eyes.
  const shut = pose.shut ?? ((frame + Math.round(offset)) % 97 < 4 ? 1 : 0);
  const eyes = [[-34 + ahead, 6, 0.94], [34 + ahead, 6, 1.06]];
  pen.wash(H(oval(-54 + ahead, 40, 16, 9, 12)), look.blush, { alpha: 0.4 });
  pen.wash(H(oval(54 + ahead, 40, 16, 9, 12)), look.blush, { alpha: 0.4 });
  for (const [ex, ey, k] of eyes) {
    const x = ex + gaze[0] * 3;
    const y = ey + gaze[1] * 2.6;
    if (shut > 0.5) pen.stroke(H([[ex - 10 * k, ey + 1], [ex, ey + 6], [ex + 10 * k, ey + 1]]), { width: 2.2 });
    else {
      pen.shape(H(oval(x, y, 7.5 * k, 10.5 * k, 12)), { fill: look.eye, alpha: 1, width: 1.2 });
      const [cx, cy] = H([[x + 2.4 * k, y - 4 * k]])[0];
      pen.dot(cx, cy, 1.4, { color: "#ffffff" });
    }
    // Brows: inner ends rise with worry and drop with a frown; both lift in surprise.
    const inward = ex < ahead ? 1 : -1;
    const inner = -worry * 7 + frown * 6 - raise * 8;
    const outer = worry * 2 - frown * 1 - raise * 8;
    const ends = [[ex - 16 * k, -20], [ex + 16 * k, -22]];
    const brow = ends.map(([bx, by]) => [bx, by + ((bx - ex) * inward > 0 ? inner : outer)]);
    pen.stroke(H([brow[0], [ex, -27 - raise * 8 + frown * 2], brow[1]]), { width: 2.6, color: look.hairShade });
  }
  pen.stroke(H([[ahead + 4, 18], [ahead + 12, 34], [ahead + 2, 38]]), { width: 1.8, color: look.skinShade });
  if (open > 0.15) {
    pen.shape(H(oval(ahead + 1, 60, 10 + 5 * open, 3 + 10 * open, 12)), { fill: "#8a3c33", alpha: 0.9, width: 2 });
  } else {
    pen.stroke(H([[ahead - 16, 58 - 3 * smile], [ahead, 62 + 8 * smile], [ahead + 18, 57 - 3 * smile]]), { width: 2.4, color: look.lips });
  }
  if (look.glasses) {
    for (const [ex, ey, k] of eyes) pen.stroke(H(oval(ex, ey, 27 * k, 25 * k, 20)), { closed: true, width: 2.4, color: "#2b2f33" });
    pen.stroke(H([[eyes[0][0] + 27 * eyes[0][2], 2], [ahead, -2], [eyes[1][0] - 27 * eyes[1][2], 2]]), { width: 2.2, color: "#2b2f33" });
    pen.stroke(H([[eyes[0][0] - 27 * eyes[0][2], 2], [-96 + ahead * 0.3, 0]]), { width: 2.2, color: "#2b2f33" });
    pen.stroke(H([[eyes[1][0] + 27 * eyes[1][2], 2], [96 + ahead * 0.3, 0]]), { width: 2.2, color: "#2b2f33" });
  }
}

function drawLegs(pen, look, body, map, layer) {
  pen.on(layer);
  for (const [shift, shade] of [[-14, 0.85], [6, 0.65]]) {
    pen.shape(map(body, [[-30 + shift, -30], [100 + shift, -36], [118 + shift, -20], [116 + shift, 96], [92 + shift, 98], [90 + shift, 4], [-34 + shift, 12]]), { fill: look.legs, alpha: shade, width: 2.8, smooth: false });
    pen.shape(map(body, [[88 + shift, 96], [120 + shift, 94], [146 + shift, 104], [146 + shift, 116], [88 + shift, 116]]), { fill: look.shoes, alpha: 0.85, width: 2.6 });
  }
}
