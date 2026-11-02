// A film drawn on paper. The world is one long sheet: the places of the day drawn on it by a
// pencil, the real recordings playing inside the screens drawn there, and a camera that travels
// over the sheet and pushes into those screens. `defineSketch` turns a description into a film
// the page can draw and the render script can read, like `defineFeature` does for the 3D films.
import { captionWords, clamp, element, fade, fill, sequence } from "../overlay.js";
import { easeInOut, easeOut, FPS, HEIGHT, pop, progress, WIDTH } from "../timeline.js";
import { screenSources } from "../feature.js";
import { createPen, inkColor, noise, paperColor, paperTile } from "./ink.js";

/** Where the camera is: the point of the sheet at the middle of the frame, how close, and a slight turn. */
export const view = (x, y, zoom, tilt = 0) => ({ x, y, zoom, tilt });
/** A view that fits a rectangle of the sheet, with a margin around it. */
export const frameRect = (x, y, w, h, margin = 0.06) => view(x + w / 2, y + h / 2, Math.min(WIDTH / (w * (1 + margin)), HEIGHT / (h * (1 + margin))));
/**
 * A view into a screen drawn on the sheet: `u`, `v` is the point of the screen to look at, in
 * fractions from its top left, and `span` how much of the screen's width fills the frame. The
 * point sits a little above the middle, clear of the subtitles.
 */
export const onScreen = (device, u, v, span = 1, tilt = 0) => {
  const zoom = WIDTH / (device.w * span);
  return view(device.x + device.w * u, device.y + device.h * v + (0.07 * HEIGHT) / zoom, zoom, tilt);
};
/** A rectangle of a screen, in fractions from its top left, for a ring drawn around it. */
export const part = (device, u1, v1, u2, v2) => ({ device, u1, v1, u2, v2 });

const lerp = (a, b, t) => a + (b - a) * t;

function between(a, b, t) {
  const zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), t));
  // Pushing in keeps the point it pushes towards gliding steadily to the middle; pulling out does the same for the point it leaves.
  const x = b.zoom >= a.zoom ? b.x - (1 - t) * (b.x - a.x) * (a.zoom / zoom) : a.x + t * (b.x - a.x) * (b.zoom / zoom);
  const y = b.zoom >= a.zoom ? b.y - (1 - t) * (b.y - a.y) * (a.zoom / zoom) : a.y + t * (b.y - a.y) * (b.zoom / zoom);
  // A long move rises off the paper and comes down again, so the eye can follow where it goes.
  const travel = (Math.hypot(b.x - a.x, b.y - a.y) * Math.min(a.zoom, b.zoom)) / WIDTH;
  const hop = Math.max(0, travel - 0.45) * 0.8;
  return { x, y, zoom: zoom / (1 + hop * Math.sin(Math.PI * t)), tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t) };
}

function createCamera(shots) {
  const pose = (shot, frame) => between(shot.start, shot.end ?? shot.start, (shot.ease ?? easeInOut)(progress(frame, shot.from, shot.to)));
  return (frame) => {
    let index = shots.findIndex((candidate) => frame >= candidate.from && frame < candidate.to);
    if (index === -1) index = frame < shots[0].from ? 0 : shots.length - 1;
    const shot = shots[index];
    let at = pose(shot, frame);
    // A new shot never jumps: the camera glides from where the last one left it.
    const glide = shot.glide ?? 30;
    if (index > 0 && glide > 0 && frame < shot.from + glide) at = between(pose(shots[index - 1], shots[index - 1].to), at, easeInOut(progress(frame, shot.from, shot.from + glide)));
    // A hand-held drift, so a held shot breathes.
    return { x: at.x + (Math.sin(frame / 37) * 5 + Math.sin(frame / 13) * 1.2) / at.zoom, y: at.y + (Math.sin(frame / 29) * 4) / at.zoom, zoom: at.zoom * (1 + Math.sin(frame / 61) * 0.004), tilt: at.tilt + Math.sin(frame / 53) * 0.0025 };
  };
}

/** A recording inside a screen drawn on the sheet: the frame it shows, the one it is leaving, and how dark the glass is. */
export function drawScreen(pen, rect, picture, { power = 1, glass = "#1d2226", radius = 6 } = {}) {
  const lit = pen.colored();
  const on = lit * power;
  pen.paint(() => {
    const { ctx } = pen;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
    ctx.clip();
    ctx.fillStyle = glass;
    ctx.globalAlpha = Math.min(1, lit * 1.4);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.imageSmoothingQuality = "high";
    const show = (image, alpha) => {
      if (!image || alpha <= 0) return;
      ctx.globalAlpha = alpha;
      // Cover the screen, keeping the recording's shape.
      const scale = Math.max(rect.w / image.width, rect.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
    };
    if (picture?.previous) { show(picture.previous, on); show(picture.image, on * picture.mix); } else show(picture?.image, on);
    // A soft sheen across the glass.
    ctx.globalAlpha = 0.07 * lit;
    const sheen = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w * 0.6, rect.y + rect.h);
    sheen.addColorStop(0, "#ffffff");
    sheen.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  });
}

/** A ring in marker pen around part of a screen: drawn in a quick loop, then held. */
function drawRing(ctx, ring, frame, zoom) {
  const { device, u1, v1, u2, v2 } = ring.part;
  const x1 = device.x + device.w * u1;
  const y1 = device.y + device.h * v1;
  const x2 = device.x + device.w * u2;
  const y2 = device.y + device.h * v2;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const pad = 16 / zoom;
  const rx = (x2 - x1) / 2 + pad;
  const ry = (y2 - y1) / 2 + pad;
  const drawn = easeOut(progress(frame, ring.from, ring.from + 12));
  const shown = fade(frame, ring.from, ring.to, 6);
  if (shown <= 0) return;
  const seed = Math.round(ring.from);
  ctx.save();
  ctx.globalAlpha = 0.9 * clamp(shown * 2);
  ctx.strokeStyle = ring.tone === "sun" ? "#e8613c" : "#119c7a";
  ctx.lineWidth = 7 / zoom;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const count = 64;
  const turn = 1.1 * drawn;
  for (let i = 0; i <= count; i++) {
    const angle = -2.4 + (i / count) * Math.PI * 2 * turn;
    // A rounded box rather than an ellipse, so a wide ring hugs what it marks.
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const squircle = (value) => Math.sign(value) * Math.pow(Math.abs(value), 0.55);
    const wobbleBy = 1 + 0.025 * noise(i * 0.35, seed) + (i / count) * 0.04;
    const point = [cx + squircle(c) * rx * wobbleBy, cy + squircle(s) * ry * wobbleBy];
    if (i === 0) ctx.moveTo(...point); else ctx.lineTo(...point);
  }
  ctx.stroke();
  ctx.restore();
}

const notePaints = {
  sun: { background: "#ffe27a", color: inkColor },
  mint: { background: "#bdeedd", color: "#11392f" },
  pink: { background: "#ffc9c2", color: "#4a1712" },
  paper: { background: "#fffaf0", color: inkColor },
};

function pencilSvg() {
  // A yellow pencil, drawn with its point at the origin and its length running up and to the right.
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

function createOverlay(spec, root) {
  // A soft band of paper under the subtitles, so they read over anything behind them.
  const band = element("div", { ...fill, background: "linear-gradient(to top, rgba(244,238,226,0.97) 0%, rgba(244,238,226,0.9) 11%, rgba(244,238,226,0.55) 19%, rgba(244,238,226,0) 30%)" }, root);

  const brand = element("div", { position: "absolute", left: "40px", top: "34px", display: "flex", alignItems: "center", gap: "14px", padding: "8px 22px 8px 9px", borderRadius: "18px", background: "rgba(250,246,238,0.9)", boxShadow: "0 6px 18px rgba(60,40,20,0.16)" }, root);
  Object.assign(element("img", { width: "44px", height: "44px", borderRadius: "11px" }, brand), { src: "/public/icon.svg" });
  element("span", { fontFamily: 'ui-serif, "Iowan Old Style", Palatino, Georgia, serif', fontSize: "29px", fontWeight: "600", color: inkColor }, brand, "Joint Bob");
  element("span", { width: "1px", height: "28px", background: "rgba(43,38,33,0.25)", margin: "0 2px" }, brand);
  element("span", { fontFamily: "Caveat", fontSize: "36px", fontWeight: "700", color: "#0f8a6c" }, brand, spec.kicker);

  const notes = (spec.notes ?? []).map((note) => {
    const paint = notePaints[note.paint ?? "sun"];
    const node = element("div", { position: "absolute", padding: "0.3em 0.62em 0.36em", background: paint.background, color: paint.color, fontFamily: "Caveat", fontSize: `${note.size ?? 58}px`, fontWeight: "700", lineHeight: "1.05", whiteSpace: "nowrap", boxShadow: "0 14px 22px -8px rgba(60,40,20,0.38), 0 2px 4px rgba(60,40,20,0.12)", borderRadius: "3px 3px 18px 3px / 3px 3px 10px 3px" }, root, note.text);
    // A strip of tape holding it on.
    element("div", { position: "absolute", left: "50%", top: "-14px", width: "92px", height: "28px", marginLeft: "-46px", background: "rgba(255,255,255,0.55)", boxShadow: "0 1px 2px rgba(60,40,20,0.12)", transform: "rotate(-4deg)" }, node);
    return node;
  });

  const random = sequence(11);
  const confettiColors = ["#37cfab", "#ffb454", "#ff7a6e", "#7aa2ff", "#ffe27a"];
  const confetti = Array.from({ length: 120 }, (_, index) => ({
    node: element("div", { position: "absolute", width: `${10 + random() * 12}px`, height: `${14 + random() * 14}px`, background: confettiColors[index % confettiColors.length], borderRadius: "2px" }, root),
    angle: -Math.PI / 2 + (random() - 0.5) * 2.4, speed: 16 + random() * 26, spin: (random() - 0.5) * 40, drift: (random() - 0.5) * 3,
  }));

  const captionArea = element("div", { ...fill, display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: "56px" }, root);
  const captions = spec.lines.filter((line) => line.text).map((line) => {
    const row = element("div", { display: "none", flexWrap: "wrap", justifyContent: "center", gap: "0 0.24em", maxWidth: "1560px", fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif', fontSize: "48px", lineHeight: "1.22", fontWeight: "680", letterSpacing: "-0.012em", color: inkColor, textShadow: "0 0 14px rgba(244,238,226,0.95), 0 0 3px rgba(244,238,226,0.9)" }, captionArea);
    const marked = line.tone === "sun" ? "#c4561f" : "#0c8466";
    return { line, row, words: captionWords(line.text).map((word) => element("span", { display: "inline-block", color: word.marked ? marked : inkColor }, row, word.text)) };
  });

  const pencil = element("div", { position: "absolute", left: "0", top: "0", width: "0", height: "0", display: "none" }, root);
  pencil.innerHTML = pencilSvg();
  const opening = element("div", { ...fill, background: paperColor }, root);

  return { draw(frame, project, tip) {
    brand.style.opacity = String(fade(frame, 10, spec.end + 6, 12));

    (spec.notes ?? []).forEach((note, index) => {
      const node = notes[index];
      const shown = fade(frame, note.from, note.to, 6);
      if (shown <= 0) { node.style.display = "none"; return; }
      const point = Array.isArray(note.at) ? project(note.at) : note.at;
      const land = pop(progress(frame, note.from, note.from + 10));
      Object.assign(node.style, { display: "block", opacity: String(clamp(shown * 1.5)), left: `${point.x}px`, top: `${point.y}px`, transform: `translate(-50%, -50%) rotate(${(note.tilt ?? 0) + (1 - land) * 6}deg) scale(${1.25 - 0.25 * land})` });
    });

    const party = (spec.confetti ?? []).find((candidate) => frame >= candidate.at && frame < Math.min(candidate.at + 75, candidate.until ?? Infinity));
    const origin = party ? (Array.isArray(party.origin) ? project(party.origin) : party.origin) : null;
    for (const piece of confetti) {
      piece.node.style.display = origin ? "block" : "none";
      if (!origin) continue;
      const burst = frame - party.at;
      const x = origin.x + Math.cos(piece.angle) * piece.speed * burst + piece.drift * burst;
      const y = origin.y + Math.sin(piece.angle) * piece.speed * burst + 0.62 * burst * burst;
      Object.assign(piece.node.style, { left: `${x}px`, top: `${Math.min(HEIGHT + 60, y)}px`, opacity: String(clamp((75 - burst) / 18)), transform: `rotate(${piece.spin * burst}deg)` });
    }

    // The band fades away when nothing is being said, so a wide view shows all of the sheet.
    band.style.opacity = String(Math.max(0, ...captions.map(({ line }) => fade(frame, line.at - 14, line.until + 10, 14))));
    for (const { line, row, words } of captions) {
      const shown = frame >= line.at - 6 && frame < line.until;
      row.style.display = shown ? "flex" : "none";
      if (!shown) continue;
      const rise = easeOut(progress(frame, line.at - 6, line.at + 6));
      row.style.opacity = String(clamp(rise) * clamp((line.until - frame) / 8));
      row.style.transform = `translateY(${(1 - rise) * 14}px)`;
      const speaking = line.length ?? words.length * 9;
      words.forEach((word, index) => {
        const said = progress(frame, line.at + (index / words.length) * speaking * 0.94 - 3, line.at + (index / words.length) * speaking * 0.94 + 3);
        word.style.opacity = String(0.4 + 0.6 * said);
      });
    }

    pencil.style.display = tip ? "block" : "none";
    if (tip) pencil.style.transform = `translate(${tip.x}px, ${tip.y}px)`;
    opening.style.opacity = String(clamp(1 - frame / 10));
  } };
}

/** The end card, on the paper itself: the name, then the tagline written out by the pencil. */
function drawCard(ctx, spec, frame, logo, totals, measure) {
  const pen = createPen(ctx, { frame, zoom: 1, view: null, paper: () => paperColor, totals, measure });
  const veil = easeInOut(progress(frame, spec.end, spec.end + 16));
  if (!measure) {
    ctx.save();
    ctx.globalAlpha = 0.86 * veil;
    ctx.fillStyle = paperColor;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
  }
  const arrive = pop(progress(frame, spec.end + 8, spec.end + 26));
  if (!measure && frame >= spec.end + 8 && logo.complete) {
    ctx.save();
    ctx.globalAlpha = clamp(arrive * 1.4);
    const size = 150 * (0.82 + 0.18 * arrive);
    ctx.drawImage(logo, 600 - size / 2, 400 - size / 2, size, size);
    ctx.restore();
  }
  pen.begin("card-name", spec.end + 12, spec.end + 36);
  pen.text("Joint Bob", 700, 446, { size: 132, family: 'ui-serif, "Iowan Old Style", Palatino, Georgia, serif', weight: 600, speed: 1 });
  pen.end();
  pen.begin("card-tagline", spec.end + 30, spec.end + 78);
  pen.text(spec.tagline[0], WIDTH / 2, 610, { size: 92, align: "center", speed: 1.2 });
  pen.text(spec.tagline[1], WIDTH / 2, 712, { size: 92, align: "center", color: "#0f8a6c", speed: 1.2 });
  pen.end();
  pen.begin("card-underline", spec.end + 74, spec.end + 92);
  pen.stroke([[WIDTH / 2 - 300, 742], [WIDTH / 2 - 40, 736], [WIDTH / 2 + 300, 744]], { width: 5, color: "#0f8a6c" });
  pen.end();
  pen.finish();
  return pen.tip();
}

/**
 * A film drawn on paper. `places` draw the sheet, each with the frame and the pictures for its
 * screens; `screens` say which stretch of which recording each screen shows, as in a 3D film.
 */
export function defineSketch(spec) {
  const camera = createCamera(spec.shots);
  let screens;
  return {
    id: spec.id,
    duration: spec.duration,
    frameAt: (frame) => frame,
    sounds: spec.sounds,
    dip: paperColor,
    sources(frame, meta, counts) {
      screens ??= spec.screens(meta);
      return screenSources(screens, frame, counts);
    },
    create(canvas, root) {
      const scale = window.devicePixelRatio || 1;
      canvas.width = WIDTH * scale;
      canvas.height = HEIGHT * scale;
      const ctx = canvas.getContext("2d");
      const tile = paperTile();
      const pattern = ctx.createPattern(tile, "repeat");
      const overlay = createOverlay(spec, root);
      const logo = Object.assign(new Image(), { src: "/public/icon.svg" });
      const totals = new Map();
      const font = new FontFace("Caveat", "url(/public/fonts/caveat.ttf)", { weight: "400 700" });
      document.fonts.add(font);

      const draw = (frame, textures, mixes, measure) => {
        const at = camera(frame);
        const offset = new DOMMatrix([1, 0, 0, 1, (-at.x * at.zoom * scale) % tile.width, (-at.y * at.zoom * scale) % tile.height]);
        const paper = () => { pattern.setTransform(ctx.getTransform().invertSelf().multiplySelf(offset)); return pattern; };
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (!measure) { ctx.fillStyle = paper(); ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.translate(WIDTH / 2, HEIGHT / 2);
        ctx.rotate(at.tilt);
        ctx.scale(at.zoom, at.zoom);
        ctx.translate(-at.x, -at.y);
        const reach = (Math.hypot(WIDTH, HEIGHT) / 2) / at.zoom;
        const pen = createPen(ctx, { frame, zoom: at.zoom, view: { x1: at.x - reach, x2: at.x + reach, y1: at.y - reach, y2: at.y + reach }, paper, totals, measure });
        const pictures = (id) => ({ image: textures[id]?.image ?? null, previous: textures[`${id}~`]?.image ?? null, mix: mixes[id] ?? 1 });
        for (const place of spec.places) place(pen, frame, pictures);
        pen.finish();
        if (!measure) for (const ring of spec.rings ?? []) drawRing(ctx, ring, frame, at.zoom);
        const worldTip = pen.tip();

        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        if (!measure) {
          // The light of the hour, and a vignette, over the whole frame.
          const light = lightAt(spec.light ?? [], frame);
          if (light) {
            ctx.save();
            ctx.globalCompositeOperation = "multiply";
            const wash = ctx.createRadialGradient(WIDTH * light.x, HEIGHT * light.y, 0, WIDTH * light.x, HEIGHT * light.y, WIDTH * 1.1);
            wash.addColorStop(0, light.near);
            wash.addColorStop(1, light.far);
            ctx.fillStyle = wash;
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
            ctx.restore();
          }
          ctx.save();
          ctx.globalCompositeOperation = "multiply";
          const vignette = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.45, WIDTH / 2, HEIGHT / 2, WIDTH * 0.75);
          vignette.addColorStop(0, "rgba(255,255,255,0)");
          vignette.addColorStop(1, "rgba(196,178,150,0.55)");
          ctx.fillStyle = vignette;
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
          ctx.restore();
        }
        const cardTip = frame >= spec.end || measure ? drawCard(ctx, spec, frame, logo, totals, measure) : null;
        const project = ([x, y]) => {
          const dx = (x - at.x) * at.zoom;
          const dy = (y - at.y) * at.zoom;
          return { x: WIDTH / 2 + dx * Math.cos(at.tilt) - dy * Math.sin(at.tilt), y: HEIGHT / 2 + dx * Math.sin(at.tilt) + dy * Math.cos(at.tilt) };
        };
        const tip = cardTip ? { x: cardTip[0], y: cardTip[1] } : worldTip ? project(worldTip) : null;
        if (!measure) overlay.draw(frame, project, tip && tip.x > -100 && tip.x < WIDTH + 100 && tip.y > -100 && tip.y < HEIGHT + 100 ? tip : null);
      };

      return {
        renderer: null,
        // The groups are measured once, with every line drawn, so each knows how much ink it has to lay down.
        ready: font.load().then(() => { draw(spec.duration + 1000, {}, {}, true); }),
        draw(frame, textures, out, mixes = {}) { draw(frame, textures, mixes, false); },
      };
    },
    blurAt: () => 0,
  };
}

/** The colour of the light at a frame, blended between the hours listed in `light`. */
function lightAt(changes, frame) {
  if (changes.length === 0) return null;
  let index = changes.findLastIndex((change) => frame >= change.at);
  if (index === -1) index = 0;
  const current = changes[index];
  const previous = changes[Math.max(0, index - 1)];
  const t = index === 0 ? 1 : progress(frame, current.at, current.at + (current.over ?? 45));
  const mix = (a, b) => a.map((value, i) => lerp(value, b[i], t));
  const near = mix(previous.near, current.near);
  const far = mix(previous.far, current.far);
  const rgba = (c) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;
  return { x: lerp(previous.x, current.x, t), y: lerp(previous.y, current.y, t), near: rgba(near), far: rgba(far) };
}

export { FPS };
