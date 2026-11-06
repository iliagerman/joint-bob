// Drawing by hand, in code. A pen puts ink lines, watercolour washes and handwriting on a 2D
// canvas, and reveals each group of them over a stretch of frames, the way an artist draws a
// scene: ink first, in the order the lines are made, then colour. Every frame is a pure function
// of its number, because the render script draws frames out of order on several pages.

export const inkColor = "#2b2621";
export const paperColor = "#f4eee2";

// Seeded noise, so a line wobbles the same way every time its frame is drawn.
const hash = (i, seed) => {
  let h = Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
};
/** Smooth noise between -1 and 1. */
export function noise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - t) + hash(i + 1, seed) * t;
}
export function sequence(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frames a second: the films are drawn at 30, and the app counts its clock in the same frames. */
export const FPS = 30;
export const clamp = (value) => Math.min(1, Math.max(0, value));
export const progress = (frame, from, to) => clamp((frame - from) / (to - from));
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** A dense polyline through `points`: a Catmull-Rom curve when `smooth`, straight segments when not. */
export function trace(points, { closed = false, smooth = true, step = 4 } = {}) {
  const n = points.length;
  const out = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p0 = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const p3 = points[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
    const parts = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < parts; k++) {
      const t = k / parts;
      if (!smooth) { out.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]); continue; }
      const t2 = t * t;
      const t3 = t2 * t;
      const axis = (a) => 0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t3);
      out.push([axis(0), axis(1)]);
    }
  }
  out.push(closed ? points[0] : points[n - 1]);
  return out;
}

const lengthOf = (line) => { let total = 0; for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]); return total; };

/** The first `length` of a polyline. */
function cutAt(line, length) {
  const out = [line[0]];
  let travelled = 0;
  for (let i = 1; i < line.length; i++) {
    const step = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    if (travelled + step >= length) {
      const t = step === 0 ? 0 : (length - travelled) / step;
      out.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]);
      return out;
    }
    travelled += step;
    out.push(line[i]);
  }
  return out;
}

/**
 * Moves each point off the line by smooth noise of the distance along it: the hand's wobble.
 * `shimmer` adds a second, small wobble that changes every few frames, the boil of a drawn line.
 */
function wobble(line, seed, amount, shimmer = 0, phase = 0) {
  const out = [];
  let travelled = 0;
  for (let i = 0; i < line.length; i++) {
    if (i > 0) travelled += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const size = Math.hypot(dx, dy) || 1;
    const offset = amount * (noise(travelled / 70, seed) + 0.4 * noise(travelled / 19, seed + 5)) + (shimmer ? shimmer * noise(travelled / 30, seed + 17 + phase * 101) : 0);
    out.push([line[i][0] - (dy / size) * offset, line[i][1] + (dx / size) * offset, travelled]);
  }
  return out;
}

/** Fills a line of varying width: thin where the pen lands and lifts, a little uneven between. */
function ribbon(ctx, line, width, taper, seed, whole) {
  if (line.length < 2) return;
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const size = Math.hypot(dx, dy) || 1;
    const t = line[i][2] / whole;
    const ends = taper ? 0.32 + 0.68 * Math.pow(clamp(Math.min(t / 0.07, (1 - t) / 0.1)), 0.6) : 1;
    const half = (width * ends * (0.88 + 0.24 * noise(line[i][2] / 45, seed + 9))) / 2;
    left.push([line[i][0] - (dy / size) * half, line[i][1] + (dx / size) * half]);
    right.push([line[i][0] + (dy / size) * half, line[i][1] - (dx / size) * half]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const point of left) ctx.lineTo(point[0], point[1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fill();
}

const boundsOf = (points) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { x1, y1, x2, y2 };
};

/**
 * A pen for one frame. `begin(id, from, to, layer)` starts or resumes a group: its ink is laid
 * down over the first seventy percent of those frames, in the order the lines are drawn, and its
 * colour over the last half. Drawing order is the order things are revealed in; `layer` is the
 * order they are stacked in, so a man can be drawn after the desk in front of him. A shape's paper
 * knock-out, which hides what is behind it, arrives when the pen starts that shape. `totals` are
 * the group lengths a measuring pass found; with `measure` set the pen only counts. Nothing is put
 * on the canvas until `finish()`.
 */
export function createPen(ctx, { frame, zoom, view, paper, totals, measure = false }) {
  // The boil changes five times a second, as a drawing re-traced on every sixth frame would.
  const boil = Math.floor(frame / 6) % 3;
  const groups = new Map();
  const queue = [];
  let group = null;
  let layer = 0;
  let tip = null;
  const visible = (bounds, margin) => !view || (bounds.x2 + margin >= view.x1 && bounds.x1 - margin <= view.x2 && bounds.y2 + margin >= view.y1 && bounds.y1 - margin <= view.y2);
  const step = Math.min(6, Math.max(0.6, 5 / zoom));
  const always = { started: true, done: true, ink: 0, washes: 0, seed: 1, known: { ink: 1, washes: 1 }, from: -Infinity, inkTo: -Infinity, colorFrom: -Infinity, to: -Infinity };
  const current = () => group ?? always;
  const put = (draw) => queue.push({ layer, order: queue.length, draw });

  function begin(id, from, to, onLayer = 0) {
    layer = onLayer;
    if (!groups.has(id)) {
      const span = to - from;
      groups.set(id, { id, from, to, ink: 0, washes: 0, seed: [...id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 100003, 7), known: totals?.get(id) ?? { ink: 1, washes: 1 }, inkTo: from + 0.7 * span, colorFrom: from + 0.45 * span, started: frame >= from, done: frame >= to });
    }
    group = groups.get(id);
  }
  function end() { group = null; layer = 0; }
  /** Stack what follows on another layer, within the same group. */
  const on = (onLayer) => { layer = onLayer; };
  /** How much of the group's ink is down at this frame. */
  const laid = (g) => (g.done ? Infinity : g.known.ink * progress(frame, g.from, g.inkTo));

  function stroke(points, options = {}) {
    const { width = 3, color = inkColor, closed = false, smooth = true, wobble: amount = 1.3, taper = true, alpha = 1, speed = 1 } = options;
    const g = current();
    const seed = (g.seed += 1);
    const path = trace(points, { closed, smooth, step });
    const length = lengthOf(path);
    const before = g.ink;
    g.ink += length / speed;
    if (measure || !g.started) return;
    const shown = Math.min(length, (laid(g) - before) * speed);
    if (shown <= 0) return;
    const partial = shown < length;
    // The boil is just over half a pixel on the frame, however close the camera is: alive, not shaking.
    const line = wobble(partial ? cutAt(path, shown) : path, seed * 13, amount, amount > 0 ? 0.6 / zoom : 0, boil);
    if (partial) tip = line.at(-1);
    if (!visible(boundsOf(points), 40)) return;
    put(() => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ribbon(ctx, line, width, taper, seed, length);
    });
  }

  /** A straight line, overshooting its ends a little, as quick lines do. */
  function line(a, b, options = {}) {
    const over = options.over ?? 4;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const size = Math.hypot(dx, dy) || 1;
    const g = current();
    const jitter = (k) => over * (0.6 + 0.4 * noise(k, g.seed + 3));
    stroke([[a[0] - (dx / size) * jitter(1), a[1] - (dy / size) * jitter(1)], [b[0] + (dx / size) * jitter(2), b[1] + (dy / size) * jitter(2)]], { smooth: false, ...options });
  }

  /** A box drawn as four quick lines, or as one rounded loop when `round` is set. */
  function box(x, y, w, h, options = {}) {
    if (options.round) { stroke(roundRect(x, y, w, h, options.round), { closed: true, ...options }); return; }
    line([x, y], [x + w, y], options);
    line([x + w, y], [x + w, y + h], options);
    line([x + w, y + h], [x, y + h], options);
    line([x, y + h], [x, y], options);
  }

  /** An ellipse that goes a little past where it started. */
  function ellipse(cx, cy, rx, ry, options = {}) {
    const start = options.start ?? -2.2;
    const turn = options.turn ?? 1.05;
    const g = current();
    const count = Math.max(10, Math.ceil((Math.max(rx, ry) * 2 * Math.PI * turn) / 18));
    const points = Array.from({ length: count + 1 }, (_, i) => {
      const angle = start + (i / count) * Math.PI * 2 * turn;
      const r = 1 + 0.02 * noise(i * 0.7, g.seed + 2);
      return [cx + Math.cos(angle) * rx * r, cy + Math.sin(angle) * ry * r];
    });
    stroke(points, options);
  }

  /** Watercolour: two uneven layers of pigment and a darker edge, spreading from `origin` when it arrives. */
  function wash(points, color, options = {}) {
    const { smooth = true, alpha = 0.5, origin } = options;
    const g = current();
    const index = g.washes++;
    const seed = (g.seed += 1);
    if (measure || !g.started) return;
    const span = g.to - g.colorFrom;
    const at = g.colorFrom + (index / g.known.washes) * span * 0.6;
    const arrived = g.done ? 1 : easeOut(progress(frame, at, at + span * 0.4 + 4));
    if (arrived <= 0) return;
    const bounds = boundsOf(points);
    if (!visible(bounds, 40)) return;
    const outline = trace(points, { closed: true, smooth, step: Math.max(step, 3) });
    const size = Math.min(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1);
    const layers = [0, 1].map((k) => wobble(outline, seed * 7 + k * 31, Math.min(2.2, size * 0.06)));
    put(() => {
      if (arrived < 1) {
        const [ox, oy] = origin ?? [(bounds.x1 + bounds.x2) / 2, (bounds.y1 + bounds.y2) / 2];
        const reach = Math.hypot(bounds.x2 - bounds.x1, bounds.y2 - bounds.y1) * arrived;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) {
          const angle = (i / 40) * Math.PI * 2;
          const r = reach * (0.85 + 0.15 * noise(i * 0.6, seed));
          ctx.lineTo(ox + Math.cos(angle) * r, oy + Math.sin(angle) * r);
        }
        ctx.clip();
      }
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = color;
      for (const spread of layers) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.beginPath();
        spread.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = alpha * 0.32;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });
  }

  /** Paper over whatever is behind a shape, so the shape hides it. It arrives when the pen starts the shape. */
  function knock(points, options = {}) {
    const g = current();
    const before = g.ink;
    if (measure || !g.started || laid(g) <= before) return;
    const bounds = boundsOf(points);
    if (!visible(bounds, 40)) return;
    const outline = trace(points, { closed: true, smooth: options.smooth ?? true, step: Math.max(step, 3) });
    put(() => {
      ctx.fillStyle = options.color ?? paper();
      ctx.beginPath();
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    });
  }

  /** A closed shape: knocked out, washed with `fill`, and outlined. */
  function shape(points, options = {}) {
    const { fill, knockout = true, outline = true, alpha, smooth = true } = options;
    if (knockout) knock(points, { smooth });
    if (fill) wash(points, fill, { alpha, smooth, origin: options.origin });
    if (outline) stroke(points, { closed: true, smooth, ...options });
  }

  /** Handwriting, written left to right while the group's ink goes down. */
  function text(words, x, y, options = {}) {
    const { size = 40, color = inkColor, align = "left", angle = 0, weight = 700, family = "Caveat", alpha = 1, speed = 1.6 } = options;
    const g = current();
    ctx.save();
    ctx.font = `${weight} ${size}px ${family}`;
    const width = ctx.measureText(words).width;
    ctx.restore();
    const before = g.ink;
    g.ink += width * speed;
    if (measure || !g.started) return;
    const shown = clamp((laid(g) - before) / (width * speed));
    if (shown <= 0) return;
    const left = align === "center" ? -width / 2 : align === "right" ? -width : 0;
    if (shown < 1) {
      const along = left + width * shown;
      tip = [x + Math.cos(angle) * along + Math.sin(angle) * size * 0.25, y + Math.sin(angle) * along - Math.cos(angle) * size * 0.25];
    }
    if (!visible({ x1: x + left - size, y1: y - size, x2: x + left + width + size, y2: y + size }, 40)) return;
    put(() => {
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.font = `${weight} ${size}px ${family}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.textBaseline = "alphabetic";
      if (shown < 1) {
        ctx.beginPath();
        ctx.rect(left - size, -size * 1.4, size + width * shown, size * 2.2);
        ctx.clip();
      }
      ctx.fillText(words, left, 0);
    });
  }

  /** A solid dot of ink, for eyes and buttons. */
  function dot(x, y, r, options = {}) {
    const g = current();
    const before = g.ink;
    g.ink += r * 4;
    if (measure || !g.started || laid(g) <= before) return;
    if (!visible({ x1: x - r, y1: y - r, x2: x + r, y2: y + r }, 20)) return;
    put(() => {
      ctx.fillStyle = options.color ?? inkColor;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Anything else, drawn straight onto the canvas on the current layer once the group has started. */
  function paint(draw) {
    if (measure || !current().started) return;
    put(draw);
  }

  /** How far a group's colour has come, for things that switch on with it (a screen lighting up). */
  const colored = () => { const g = current(); return g.done ? 1 : progress(frame, g.colorFrom, g.to); };
  const started = () => current().started;

  /** Puts everything on the canvas, layer by layer, and in measuring mode records each group's length. */
  function finish() {
    if (measure) { for (const g of groups.values()) totals.set(g.id, { ink: Math.max(1, g.ink), washes: Math.max(1, g.washes) }); return; }
    queue.sort((a, b) => a.layer - b.layer || a.order - b.order);
    for (const item of queue) { ctx.save(); item.draw(); ctx.restore(); }
  }

  return { begin, end, on, stroke, line, box, ellipse, wash, knock, shape, text, dot, paint, colored, started, finish, ctx, frame, zoom, measure, tip: () => tip };
}

/**
 * A rounded rectangle, as points for a closed smooth stroke. Each corner is a quarter circle, and the
 * straight edges are split into steps about as long as the corner's, because the smooth pen
 * overshoots into a spike where a long edge meets a short corner.
 */
export function roundRect(x, y, w, h, r) {
  const corners = [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]];
  const points = [];
  for (const [index, [cx, cy, start]] of corners.entries()) {
    for (let k = 0; k <= 3; k++) points.push([cx + Math.cos(start + (k / 3) * (Math.PI / 2)) * r, cy + Math.sin(start + (k / 3) * (Math.PI / 2)) * r]);
    const [nx, ny, next] = corners[(index + 1) % 4];
    const from = points.at(-1);
    const to = [nx + Math.cos(next) * r, ny + Math.sin(next) * r];
    const parts = Math.max(1, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(4, r * 0.8)));
    for (let k = 1; k < parts; k++) points.push([from[0] + ((to[0] - from[0]) * k) / parts, from[1] + ((to[1] - from[1]) * k) / parts]);
  }
  return points;
}

/** Points around an ellipse, for shapes. */
export const oval = (cx, cy, rx, ry, count = 14, turn = 0) => Array.from({ length: count }, (_, i) => {
  const angle = turn + (i / count) * Math.PI * 2;
  return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
});

/**
 * A sheet of paper, as a tile: warm white, faint blotches, fine grain and a few fibres. The tile
 * wraps at its edges, so it repeats without seams.
 */
export function paperTile(size = 768) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const random = sequence(5);
  const cells = [6, 13, 29];
  const lattice = cells.map((count, octave) => Array.from({ length: count * count }, (_, i) => hash(i, 40 + octave)));
  const smooth = (u, v, octave) => {
    const count = cells[octave];
    const x = u * count;
    const y = v * count;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const at = (a, b) => lattice[octave][((b % count) * count) + (a % count)];
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
  const base = [244, 238, 226];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const blotch = smooth(u, v, 0) * 4 + smooth(u, v, 1) * 2.5 + smooth(u, v, 2) * 1.5;
      const grain = (random() - 0.5) * 9;
      const shade = blotch + grain;
      const index = (y * size + x) * 4;
      image.data[index] = base[0] + shade;
      image.data[index + 1] = base[1] + shade;
      image.data[index + 2] = base[2] + shade * 1.1;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // Fibres, drawn three times over so the ones crossing an edge come back on the other side.
  for (let i = 0; i < 70; i++) {
    const x = random() * size;
    const y = random() * size;
    const angle = random() * Math.PI;
    const length = 8 + random() * 26;
    const light = random() > 0.5;
    ctx.strokeStyle = light ? "rgba(255,255,250,0.55)" : "rgba(150,130,100,0.16)";
    ctx.lineWidth = 0.8;
    for (const [ox, oy] of [[0, 0], [-size, 0], [size, 0], [0, -size], [0, size]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(x + ox + Math.cos(angle) * length * 0.5 + 3, y + oy + Math.sin(angle) * length * 0.5 - 2, x + ox + Math.cos(angle) * length, y + oy + Math.sin(angle) * length);
      ctx.stroke();
    }
  }
  return canvas;
}

/** The pencil that draws, as SVG: its point at the origin and its length running up and to the right. */
export function pencilSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="560" viewBox="0 0 560 560" style="overflow:visible">
    <g transform="rotate(38)">
      <ellipse cx="18" cy="-250" rx="30" ry="270" fill="rgba(60,40,20,0.13)" transform="translate(26 20)"/>
      <path d="M0 0 L-13 -46 L13 -46 Z" fill="#e9c9a1" stroke="#2b2621" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M0 0 L-4.5 -15 L4.5 -15 Z" fill="#2b2621"/>
      <path d="M-13 -46 Q-6 -52 0 -46 Q6 -52 13 -46 L16 -400 L-16 -400 Z" fill="#f6c445" stroke="#2b2621" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M-3 -50 L-4 -400" stroke="#d9a520" stroke-width="5"/>
      <path d="M-17 -400 L17 -400 L17 -446 L-17 -446 Z" fill="#c9ccd0" stroke="#2b2621" stroke-width="2.5"/>
      <path d="M-17 -416 L17 -416 M-17 -430 L17 -430" stroke="#8d9297" stroke-width="2"/>
      <path d="M-17 -446 L17 -446 L17 -478 Q0 -492 -17 -478 Z" fill="#f29a9a" stroke="#2b2621" stroke-width="2.5" stroke-linejoin="round"/>
    </g></svg>`;
}
