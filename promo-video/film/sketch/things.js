// The objects of the drawn world: furniture, devices, plants, a clock, a cat. Each takes the pen
// and where to stand, and draws itself in ink and watercolour. Devices draw a recording into
// their screen through `drawScreen`.
import { inkColor, noise, oval, roundRect } from "./ink.js";
import { drawScreen } from "./story.js";

export const tones = {
  wood: "#e2b98b", woodDark: "#b98a5e", metal: "#c4c9ce", device: "#9aa3ab", leaf: "#7cc49a", leafDark: "#4f9c72",
  pot: "#e98f6b", wall: "#dfe8ea", warm: "#f6dcc0", dusk: "#e3dbef", train: "#d7e3ec", shadow: "#a89f93", sun: "#ffd77a",
  mint: "#37cfab", coffee: "#8a5a3c", cream: "#fff4dc", red: "#e8613c", blue: "#7fa6d9", seat: "#6f8fc4",
};

/** An irregular soft blob of colour behind a scene, the way a storybook vignette fades out at its edges. */
export function backdrop(pen, x, y, w, h, color, seed = 1, alpha = 0.55) {
  const points = Array.from({ length: 22 }, (_, i) => {
    const angle = (i / 22) * Math.PI * 2;
    const r = 1 + 0.06 * noise(i * 0.9, seed) + 0.03 * noise(i * 2.3, seed + 4);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const squircle = (value) => Math.sign(value) * Math.pow(Math.abs(value), 0.45);
    return [x + w / 2 + squircle(c) * (w / 2) * r, y + h / 2 + squircle(s) * (h / 2) * r];
  });
  pen.wash(points, color, { alpha });
}

/** A soft grey shadow on the floor or a table. */
export const shadow = (pen, cx, cy, rx, ry, alpha = 0.35) => pen.wash(oval(cx, cy, rx, ry, 16), tones.shadow, { alpha });

export function floor(pen, x1, x2, y) {
  pen.line([x1, y], [x2, y], { width: 2.4 });
  pen.line([x1 + 60, y + 26], [x1 + (x2 - x1) * 0.45, y + 26], { width: 1.4, alpha: 0.5 });
  pen.line([x1 + (x2 - x1) * 0.6, y + 22], [x2 - 80, y + 22], { width: 1.4, alpha: 0.5 });
}

/** A desk seen from the front: the top, a front panel, drawers on one side. */
export function desk(pen, x1, x2, top, bottom, { drawers = "right" } = {}) {
  shadow(pen, (x1 + x2) / 2, bottom + 6, (x2 - x1) * 0.55, 18);
  pen.shape([[x1 - 14, top], [x2 + 14, top], [x2 + 14, top + 18], [x1 - 14, top + 18]], { fill: tones.wood, alpha: 0.75, smooth: false, width: 3 });
  pen.shape([[x1, top + 18], [x2, top + 18], [x2, bottom], [x1, bottom]], { fill: tones.wood, alpha: 0.5, smooth: false, width: 3 });
  const dx = drawers === "right" ? x2 - 200 : x1;
  pen.line([dx + (drawers === "right" ? 0 : 200), top + 18], [dx + (drawers === "right" ? 0 : 200), bottom], { width: 2.4 });
  for (const k of [0.33, 0.66]) pen.line([dx, top + 18 + (bottom - top - 18) * k], [dx + 200, top + 18 + (bottom - top - 18) * k], { width: 2.2 });
  for (const k of [0.17, 0.5, 0.83]) pen.line([dx + 80, top + 18 + (bottom - top - 18) * k], [dx + 120, top + 18 + (bottom - top - 18) * k], { width: 3.2 });
  // A little wood grain.
  pen.stroke([[x1 + 40, top + 70], [x1 + 160, top + 66], [x1 + 260, top + 72]], { width: 1.3, alpha: 0.5 });
  pen.stroke([[x1 + 90, top + 140], [x1 + 240, top + 136]], { width: 1.3, alpha: 0.5 });
}

/**
 * A laptop seen from the front, its screen at `rect`. `open` runs from 1 (open) to 0 (shut): the
 * lid folds towards us onto the keyboard, the screen going dark as it does.
 */
export function laptop(pen, rect, picture, open = 1) {
  const { x, y, w, h } = rect;
  const hinge = y + h + 8;
  const base = { x1: x - 30, x2: x + w + 30, y1: hinge, y2: hinge + 20 };
  shadow(pen, x + w / 2, base.y2 + 4, w * 0.66, 10, 0.3);
  // The keyboard deck, seen at a low angle: wider at the front, with rows of keys.
  pen.shape([[base.x1 + 12, base.y1], [base.x2 - 12, base.y1], [base.x2, base.y2], [base.x1, base.y2]], { fill: tones.metal, alpha: 0.7, smooth: false, width: 2.8 });
  for (const [row, inset] of [[0.3, 22], [0.58, 16]]) {
    const ky = base.y1 + (base.y2 - base.y1) * row;
    for (let k = 0; k < 13; k++) {
      const kx = base.x1 + inset + ((base.x2 - base.x1 - inset * 2) * (k + 0.5)) / 13;
      pen.line([kx - 6, ky], [kx + 6, ky], { width: 1.6, alpha: 0.55, over: 0 });
    }
  }
  pen.line([base.x1 + 4, base.y2 - 2], [base.x2 - 4, base.y2 - 2], { width: 1.4, alpha: 0.5, over: 0 });
  if (open > 0.06) {
    // The lid stands on the hinge, shorter as it folds forward.
    const top = hinge - (h + 16) * open;
    const lid = [[x - 8, top], [x + w + 8, top], [x + w + 8, hinge], [x - 8, hinge]];
    pen.shape(lid, { fill: tones.device, alpha: 0.55, smooth: false, width: 3 });
    const glass = { x, y: top + 8 * open, w, h: Math.max(1, h * open) };
    drawScreen(pen, glass, open > 0.98 ? picture : { ...picture, image: picture?.image ?? null }, { power: open > 0.98 ? 1 : open * 0.35 });
    pen.box(glass.x, glass.y, glass.w, glass.h, { width: 2.2, over: 1.5 });
  } else {
    // Shut: the back of the lid lies on the keyboard, with a little logo.
    const lid = [[base.x1 + 8, base.y1 - 12], [base.x2 - 8, base.y1 - 12], [base.x2 - 2, base.y1 + 4], [base.x1 + 2, base.y1 + 4]];
    pen.shape(lid, { fill: tones.device, alpha: 0.75, smooth: false, width: 3 });
    pen.shape(oval(x + w / 2, base.y1 - 4, 9, 4, 10), { fill: tones.mint, alpha: 0.9, width: 1.6 });
  }
}

/**
 * A laptop seen from behind, on a desk whose top is at `y`, centred on `x`: the back of the lid
 * with the logo, standing on its base. `open` runs from 1 to 0 as the lid folds down onto the
 * keyboard, towards the person using it. Returns the lid's rectangle, for a projection's lines.
 */
export function laptopBack(pen, x, y, open = 1, { w = 170, h = 102 } = {}) {
  shadow(pen, x, y + 4, w * 0.6, 8, 0.3);
  pen.shape([[x - w / 2 - 8, y - 8], [x + w / 2 + 8, y - 8], [x + w / 2 + 4, y], [x - w / 2 - 4, y]], { fill: tones.metal, alpha: 0.75, smooth: false, width: 2.4 });
  const tall = Math.max(6, h * open);
  const lid = { x: x - w / 2, y: y - 8 - tall, w, h: tall };
  pen.shape(roundRect(lid.x, lid.y, lid.w, lid.h, Math.min(10, tall / 2)), { fill: tones.device, alpha: 0.7, width: 2.8 });
  if (open > 0.3) pen.shape(oval(x, lid.y + tall * 0.48, 11, 12 * Math.min(1, open * 1.2), 12), { fill: tones.mint, alpha: 0.9, width: 1.8 });
  return lid;
}

/** The back of a phone in someone's hand: dark, with its camera at the top. */
export function phoneBack(pen, rect) {
  const { x, y, w, h } = rect;
  pen.shape(roundRect(x, y, w, h, w * 0.2), { fill: "#3d4348", alpha: 0.85, width: Math.min(2.6, 1.2 + w * 0.02) });
  pen.shape(roundRect(x + w * 0.14, y + w * 0.14, w * 0.36, w * 0.36, w * 0.1), { fill: "#2a2e32", alpha: 0.9, width: 1.2 });
  pen.dot(x + w * 0.32, y + w * 0.32, w * 0.08, { color: "#11151a" });
}

/**
 * A screen shown large beside the device it belongs to: a drawn screen with a dark bezel at
 * `screen`, joined to the device at `from` by two pencil lines from its nearer corners, with a soft
 * shadow under it so it floats over the page. `open` shrinks it back into the device as it shuts.
 */
export function screenProjection(pen, from, screen, picture, open = 1) {
  const grow = open * open * (3 - 2 * open);
  if (grow < 0.04 && !pen.measure) return;
  // It shrinks to the point on the device's edge where the lines meet, so it never covers the device.
  const right = screen.x > from.x;
  const near = right ? from.x + from.w : from.x;
  const dot = [near, from.y + from.h / 2];
  const r = { x: dot[0] + (screen.x - dot[0]) * grow, y: dot[1] + (screen.y - dot[1]) * grow, w: Math.max(4, screen.w * grow), h: Math.max(4, screen.h * grow) };
  const far = right ? r.x - 10 : r.x + r.w + 10;
  pen.stroke([[near, from.y], [(near + far) / 2, (from.y + r.y) / 2 - 6], [far, r.y]], { width: 1.6, alpha: 0.5 * grow });
  pen.stroke([[near, from.y + from.h], [(near + far) / 2, (from.y + from.h + r.y + r.h) / 2 + 6], [far, r.y + r.h]], { width: 1.6, alpha: 0.5 * grow });
  pen.wash(roundRect(r.x + 6, r.y + 12, r.w + 10, r.h + 10, 14), tones.shadow, { alpha: 0.32 });
  pen.shape(roundRect(r.x - 12, r.y - 12, r.w + 24, r.h + 24, 14), { fill: "#3d4348", alpha: 0.85, width: 3 });
  drawScreen(pen, r, picture, { power: grow });
  pen.box(r.x, r.y, r.w, r.h, { width: 2, over: 1.5 });
}

/** A monitor on a stand, its screen at `rect`. */
export function monitor(pen, rect, picture, { foot } = {}) {
  const { x, y, w, h } = rect;
  const bottom = foot ?? y + h + 70;
  shadow(pen, x + w / 2, bottom + 2, w * 0.3, 8, 0.3);
  pen.shape([[x + w / 2 - 50, bottom - 8], [x + w / 2 + 50, bottom - 8], [x + w / 2 + 62, bottom], [x + w / 2 - 62, bottom]], { fill: tones.device, alpha: 0.6, smooth: false, width: 2.6 });
  pen.shape([[x + w / 2 - 12, y + h + 10], [x + w / 2 + 12, y + h + 10], [x + w / 2 + 12, bottom - 8], [x + w / 2 - 12, bottom - 8]], { fill: tones.device, alpha: 0.6, smooth: false, width: 2.6 });
  pen.shape(roundRect(x - 12, y - 12, w + 24, h + 26, 8), { fill: "#3d4348", alpha: 0.75, width: 3 });
  drawScreen(pen, rect, picture);
  pen.box(x, y, w, h, { width: 2, over: 1.5 });
}

/** A phone, its screen at `rect`. */
export function phone(pen, rect, picture) {
  const { x, y, w, h } = rect;
  // The case, the bezel and the earpiece keep a phone's proportions at any size.
  const side = Math.max(2.5, w * 0.076);
  const cap = w * 0.13;
  const line = Math.min(2.8, 1.2 + w * 0.017);
  pen.shape(roundRect(x - side, y - cap, w + side * 2, h + cap * 2, w * 0.17), { fill: "#3d4348", alpha: 0.8, width: line });
  drawScreen(pen, rect, picture, { radius: w * 0.11 });
  pen.stroke([[x + w * 0.37, y - cap * 0.5], [x + w * 0.63, y - cap * 0.5]], { width: line, smooth: false });
}

/**
 * A phone's screen shown large beside the person holding it, the way an explainer magnifies a
 * detail: a drawn phone at `screen`, joined to the phone in the hand at `held` by two pencil lines
 * from its near corners, with a soft shadow under it so it floats over the page. Drawn by the
 * pen like everything else, in its own group.
 */
export function projection(pen, held, screen, picture) {
  const right = screen.x > held.x;
  const near = right ? held.x + held.w : held.x;
  const far = right ? screen.x - screen.w * 0.08 : screen.x + screen.w * 1.08;
  pen.stroke([[near, held.y], [(near + far) / 2, (held.y + screen.y) / 2 - 6], [far, screen.y]], { width: 1.6, alpha: 0.5 });
  pen.stroke([[near, held.y + held.h], [(near + far) / 2, (held.y + held.h + screen.y + screen.h) / 2 + 6], [far, screen.y + screen.h]], { width: 1.6, alpha: 0.5 });
  pen.wash(roundRect(screen.x - screen.w * 0.02, screen.y + screen.h * 0.03, screen.w * 1.2, screen.h * 1.06, screen.w * 0.17), tones.shadow, { alpha: 0.35 });
  phone(pen, screen, picture);
}

export function mug(pen, x, y, frame, { full = true, color = tones.red } = {}) {
  shadow(pen, x + 24, y + 50, 34, 6, 0.3);
  pen.shape([[x, y], [x + 48, y], [x + 46, y + 48], [x + 2, y + 48]], { fill: color, alpha: 0.6, smooth: false, width: 2.8 });
  pen.stroke([[x + 48, y + 10], [x + 64, y + 14], [x + 64, y + 32], [x + 47, y + 36]], { width: 2.8 });
  if (!full) return;
  // Steam, rising and swaying.
  for (const k of [0, 1]) {
    const sway = Math.sin(frame / 14 + k * 2) * 5;
    pen.stroke([[x + 16 + k * 16, y - 8], [x + 10 + k * 16 + sway, y - 26], [x + 18 + k * 16 - sway, y - 44], [x + 12 + k * 16 + sway, y - 62]], { width: 2, alpha: 0.55 });
  }
}

export function plant(pen, x, y, { height = 160 } = {}) {
  // The pot stands on `y`; the leaves fan out above it.
  shadow(pen, x, y + 4, 50, 8, 0.3);
  const leaves = [[-0.9, 0.85], [-0.45, 1], [0, 0.92], [0.45, 1.05], [0.95, 0.8], [-0.2, 0.7], [0.25, 0.65]];
  for (const [lean, size] of leaves) {
    const tipX = x + lean * height * 0.55;
    const tipY = y - 70 - height * size;
    const midX = x + lean * height * 0.3;
    const midY = y - 70 - height * size * 0.55;
    const across = 16 + 8 * size;
    pen.shape([[x, y - 66], [midX - across, midY], [tipX, tipY], [midX + across, midY + 6]], { fill: size > 0.8 ? tones.leaf : tones.leafDark, alpha: 0.6, width: 2.4 });
    pen.stroke([[x, y - 66], [midX, midY + 3], [tipX, tipY]], { width: 1.4, alpha: 0.6 });
  }
  pen.shape([[x - 46, y - 76], [x + 46, y - 76], [x + 36, y], [x - 36, y]], { fill: tones.pot, alpha: 0.65, smooth: false, width: 2.8 });
  pen.line([x - 44, y - 62], [x + 44, y - 62], { width: 2 });
}

/** A wall clock showing `minutes` past midnight. */
export function clock(pen, cx, cy, r, minutes) {
  pen.shape(oval(cx, cy, r, r, 20), { fill: tones.cream, alpha: 0.7, width: 3.2 });
  pen.ellipse(cx, cy, r - 6, r - 6, { width: 1.4, alpha: 0.6 });
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const inner = i % 3 === 0 ? r - 16 : r - 12;
    pen.line([cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner], [cx + Math.cos(angle) * (r - 8), cy + Math.sin(angle) * (r - 8)], { width: i % 3 === 0 ? 2.6 : 1.6, over: 0 });
  }
  const hour = ((minutes / 60) % 12) / 12 * Math.PI * 2 - Math.PI / 2;
  const minute = ((minutes % 60) / 60) * Math.PI * 2 - Math.PI / 2;
  pen.line([cx, cy], [cx + Math.cos(hour) * r * 0.5, cy + Math.sin(hour) * r * 0.5], { width: 4.2, over: 0 });
  pen.line([cx, cy], [cx + Math.cos(minute) * r * 0.74, cy + Math.sin(minute) * r * 0.74], { width: 2.6, over: 0 });
  pen.shape(oval(cx, cy, 4, 4, 8), { fill: inkColor, alpha: 1, width: 1.4 });
}

/** A sticky note on the wall, with a line of handwriting or two. */
export function sticky(pen, x, y, lines, { color = tones.sun, tilt = -0.05, size = 34, width = 150 } = {}) {
  const height = 30 + lines.length * size * 1.05;
  const corner = (u, v) => [x + Math.cos(tilt) * u - Math.sin(tilt) * v, y + Math.sin(tilt) * u + Math.cos(tilt) * v];
  pen.shape([corner(0, 0), corner(width, 0), corner(width, height - 14), corner(width - 16, height), corner(0, height)], { fill: color, alpha: 0.75, smooth: false, width: 2.4 });
  lines.forEach((text, i) => { const [tx, ty] = corner(width / 2, 22 + size * 0.8 + i * size * 1.02); pen.text(text, tx, ty, { size, align: "center", angle: tilt }); });
}

/** A window onto the outside: a sky that changes with the hour and a few buildings. */
export function windowView(pen, x, y, w, h, sky, { skyline = true, sun } = {}) {
  pen.shape([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { fill: sky, alpha: 0.55, smooth: false, width: 3.2 });
  if (sun) pen.shape(oval(sun[0], sun[1], 30, 30, 14), { fill: sun[2] ?? tones.sun, alpha: 0.8, width: 2.2 });
  if (skyline) {
    const towers = [[0.06, 0.42], [0.2, 0.62], [0.34, 0.36], [0.5, 0.55], [0.66, 0.3], [0.8, 0.5]];
    for (const [u, top] of towers) {
      const tx = x + w * u;
      const tw = w * 0.13;
      pen.shape([[tx, y + h], [tx, y + h * (1 - top * 0.8)], [tx + tw, y + h * (1 - top * 0.8)], [tx + tw, y + h]], { fill: "#9fb3c4", alpha: 0.45, smooth: false, width: 2 });
      for (let row = 0; row < 3; row++) pen.line([tx + tw * 0.3, y + h * (1 - top * 0.8) + 18 + row * 22], [tx + tw * 0.7, y + h * (1 - top * 0.8) + 18 + row * 22], { width: 1.2, alpha: 0.6, over: 0 });
    }
  }
  pen.line([x + w / 2, y], [x + w / 2, y + h], { width: 2.6 });
  pen.line([x, y + h * 0.48], [x + w, y + h * 0.48], { width: 2.6 });
  pen.line([x - 16, y + h + 8], [x + w + 16, y + h + 8], { width: 3.2 });
}

/** A framed print on the wall: mountains and a sun, in a thin frame with a mat. */
export function framedPrint(pen, x, y, w, h) {
  shadow(pen, x + w / 2 + 6, y + h + 8, w * 0.45, 5, 0.18);
  pen.shape([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { fill: "#fffaf0", alpha: 0.7, smooth: false, width: 3 });
  const m = 12;
  pen.shape([[x + m, y + m], [x + w - m, y + m], [x + w - m, y + h - m], [x + m, y + h - m]], { fill: "#cfe3ea", alpha: 0.6, smooth: false, width: 1.8 });
  pen.shape([[x + m, y + h - m], [x + w * 0.34, y + h * 0.42], [x + w * 0.52, y + h * 0.62], [x + w * 0.7, y + h * 0.36], [x + w - m, y + h - m]], { fill: "#7fae9b", alpha: 0.6, smooth: false, width: 1.8 });
  pen.shape(oval(x + w * 0.74, y + h * 0.3, 8, 8, 10), { fill: tones.sun, alpha: 0.85, width: 1.6 });
}

/** A short wall shelf on two brackets, with a row of books and a small pot. */
export function shelf(pen, x, y, w) {
  shadow(pen, x + w / 2, y + 10, w * 0.5, 5, 0.22);
  pen.shape([[x, y], [x + w, y], [x + w, y + 10], [x, y + 10]], { fill: tones.woodDark, alpha: 0.7, smooth: false, width: 2.6 });
  for (const bx of [x + 18, x + w - 18]) pen.stroke([[bx, y + 10], [bx, y + 26], [bx + 10, y + 10]], { width: 2, smooth: false });
  const books = [[16, 62, "#e8613c"], [14, 54, "#7fa6d9"], [18, 66, "#ffd77a"], [12, 50, "#8edbc4"], [16, 58, "#b39bff"]];
  let bx = x + 10;
  for (const [bw, bh, color] of books) {
    pen.shape([[bx, y], [bx + bw, y], [bx + bw, y - bh], [bx, y - bh]], { fill: color, alpha: 0.6, smooth: false, width: 2 });
    pen.line([bx + 3, y - bh + 10], [bx + bw - 3, y - bh + 10], { width: 1.2, alpha: 0.6, over: 0 });
    bx += bw + 2;
  }
  // A leaning book, and a succulent in a pot.
  pen.shape([[bx + 4, y], [bx + 18, y], [bx + 34, y - 50], [bx + 20, y - 54]], { fill: "#e98f6b", alpha: 0.6, smooth: false, width: 2 });
  const px = x + w - 30;
  pen.shape([[px - 16, y - 26], [px + 16, y - 26], [px + 12, y], [px - 12, y]], { fill: tones.pot, alpha: 0.7, smooth: false, width: 2.2 });
  for (const lean of [-0.8, -0.3, 0.3, 0.8]) pen.shape([[px, y - 26], [px + lean * 18 - 6, y - 40], [px + lean * 22, y - 52], [px + lean * 18 + 6, y - 40]], { fill: tones.leaf, alpha: 0.65, width: 1.8 });
}

/** A pendant lamp hanging from the top of the room, its shade warm. */
export function pendantLamp(pen, x, top, drop) {
  pen.stroke([[x, top], [x + 1, top + drop]], { width: 2, smooth: false });
  pen.shape([[x - 34, top + drop + 34], [x - 12, top + drop], [x + 12, top + drop], [x + 34, top + drop + 34]], { fill: "#2f6f60", alpha: 0.7, smooth: false, width: 2.6 });
  pen.shape(oval(x, top + drop + 36, 9, 6, 10), { fill: tones.sun, alpha: 0.9, width: 1.6 });
  pen.wash(oval(x, top + drop + 70, 70, 40, 16), tones.sun, { alpha: 0.18 });
}

/**
 * Light from a window, falling across the wall and the floor: a soft brightening shaped like the
 * window, stretched down and away, fading out. It comes on with its group's colour.
 */
export function windowLight(pen, glass, toward) {
  const lit = pen.colored();
  pen.paint(() => {
    const { ctx } = pen;
    const { x, y, w, h } = glass;
    const [dx, dy] = toward;
    ctx.globalCompositeOperation = "screen";
    const fade = ctx.createLinearGradient(x + w / 2, y + h, x + w / 2 + dx, y + h + dy);
    fade.addColorStop(0, `rgba(255, 244, 210, ${0.42 * lit})`);
    fade.addColorStop(1, "rgba(255, 244, 210, 0)");
    ctx.fillStyle = fade;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w + dx, y + h + dy);
    ctx.lineTo(x + dx * 0.6, y + h + dy);
    ctx.closePath();
    ctx.fill();
  });
}

/** A chalk menu board, its lines written small. */
export function menuBoard(pen, x, y, w, h) {
  pen.shape([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], { fill: "#3b4a44", alpha: 0.8, smooth: false, width: 3 });
  pen.text("Menu", x + w / 2, y + 34, { size: 30, align: "center", color: "#fff4dc" });
  for (let k = 0; k < 3; k++) {
    pen.line([x + 16, y + 56 + k * 22], [x + w * 0.62, y + 56 + k * 22], { width: 1.6, color: "#fff4dc", alpha: 0.75, over: 0 });
    pen.line([x + w * 0.74, y + 56 + k * 22], [x + w - 16, y + 56 + k * 22], { width: 1.6, color: "#ffd77a", alpha: 0.8, over: 0 });
  }
}

/** A string of warm bulbs, sagging between two points. */
export function stringLights(pen, from, to, count = 9) {
  const sag = 26;
  const at = (u) => [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u + Math.sin(u * Math.PI) * sag];
  pen.stroke(Array.from({ length: 9 }, (_, k) => at(k / 8)), { width: 1.6 });
  for (let k = 1; k < count; k++) {
    const [bx, by] = at(k / count);
    pen.shape(oval(bx, by + 9, 5, 7, 10), { fill: tones.sun, alpha: 0.9, width: 1.4 });
    pen.wash(oval(bx, by + 10, 16, 14, 12), tones.sun, { alpha: 0.16 });
  }
}

/** An office chair's back, seen behind a sitter. */
export function chairBack(pen, x, y, dir = 1) {
  pen.shape(roundRect(x - 40, y, 80, 150, 26).map(([px, py]) => [x + (px - x) * dir, py]), { fill: "#55606b", alpha: 0.55, width: 2.8 });
}

/** A cat asleep, curled up, breathing. */
export function cat(pen, x, y, frame) {
  const breath = 1 + 0.025 * Math.sin(frame / 18);
  shadow(pen, x, y + 6, 92, 10, 0.3);
  pen.shape([[x - 86, y], [x - 80, y - 46 * breath], [x - 30, y - 70 * breath], [x + 40, y - 64 * breath], [x + 82, y - 34], [x + 88, y]], { fill: "#e7a565", alpha: 0.6, width: 2.8 });
  pen.shape([[x + 42, y - 56], [x + 50, y - 92], [x + 66, y - 66], [x + 82, y - 94], [x + 92, y - 52], [x + 88, y - 26], [x + 52, y - 26]], { fill: "#e7a565", alpha: 0.7, width: 2.8 });
  pen.stroke([[x + 58, y - 48], [x + 64, y - 45], [x + 70, y - 48]], { width: 2 });
  pen.stroke([[x + 76, y - 48], [x + 82, y - 45], [x + 88, y - 48]], { width: 2 });
  pen.stroke([[x - 84, y - 6], [x - 40, y + 10], [x + 20, y + 4], [x + 40, y - 10]], { width: 2.6 });
  for (const k of [-40, -10, 20]) pen.stroke([[x + k, y - 58], [x + k + 8, y - 40]], { width: 1.6, alpha: 0.6 });
  // Zs rising.
  for (const k of [0, 1, 2]) {
    const rise = (frame / 50 + k / 3) % 1;
    pen.text("z", x + 100 + rise * 40 + k * 6, y - 100 - rise * 90, { size: 30 + k * 8, alpha: 0.7 * Math.sin(rise * Math.PI) });
  }
}

/** A small server box with blinking lights and vents. */
export function serverBox(pen, x, y, w, h, frame) {
  shadow(pen, x + w / 2, y + h + 4, w * 0.7, 8, 0.3);
  pen.shape(roundRect(x, y, w, h, 10), { fill: "#5d6872", alpha: 0.6, width: 3 });
  for (let row = 0; row < 5; row++) pen.line([x + 22, y + 60 + row * 16], [x + w - 22, y + 60 + row * 16], { width: 1.6, over: 0 });
  for (let k = 0; k < 3; k++) {
    const lit = (Math.floor(frame / 7) + k * 3) % 5 !== 0;
    pen.shape(oval(x + 26 + k * 22, y + 28, 6, 6, 8), { fill: lit ? tones.mint : "#2b3a36", alpha: 0.95, width: 1.6 });
  }
}
