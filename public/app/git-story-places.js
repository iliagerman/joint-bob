// The places a podcast chapter can happen in, drawn on a 960 x 540 canvas, and the mood effects laid over them.
// `view` is what the player knows each frame: { scene, mood, progress, storyP, sunP, scroll, playing, who, handsAt }.

export const W = 960;
export const H = 540;
export const GROUND = 470;
const { sin, cos } = Math;
const lerp = (a, b, k) => a + (b - a) * k;

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function makeSkyline(seed, minH, maxH) {
  const r = rng(seed); const list = []; let x = 0;
  while (x < 1500) {
    const w = 60 + r() * 80, h = minH + r() * (maxH - minH), cols = Math.floor(w / 14), rows = Math.floor(h / 18);
    list.push({ x, w, h, cols, wins: Array.from({ length: cols * rows }, () => r() > 0.55) });
    x += w + 6 + r() * 10;
  }
  return { list, width: x };
}
const FAR = makeSkyline(11, 70, 170), MID = makeSkyline(23, 110, 250);
function drawSkyline(g, sk, offset, base, color, winColor) {
  const o = -(offset % sk.width);
  for (let rep = 0; rep < 2; rep++) for (const b of sk.list) {
    const x = b.x + o + rep * sk.width;
    if (x > W || x + b.w < 0) continue;
    g.fillStyle = color; g.fillRect(x, base - b.h, b.w, b.h);
    g.fillStyle = winColor;
    b.wins.forEach((on, i) => { if (on) g.fillRect(x + 4 + (i % b.cols) * 14, base - b.h + 6 + Math.floor(i / b.cols) * 18, 6, 8); });
  }
}

function drawStreet(g, t, dt, v) {
  const sky = g.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, "#141a38"); sky.addColorStop(.6, "#2d2f55"); sky.addColorStop(1, "#6a4a6a");
  g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);
  g.fillStyle = "#ece8d6"; g.beginPath(); g.arc(830, 95, 24, 0, 7); g.fill();
  const halo = g.createRadialGradient(830, 95, 20, 830, 95, 110); halo.addColorStop(0, "rgba(236,232,214,.25)"); halo.addColorStop(1, "rgba(236,232,214,0)");
  g.fillStyle = halo; g.fillRect(700, 0, 260, 220);
  drawSkyline(g, FAR, v.scroll * 0.12, GROUND, "#1f2442", "#5d5f86");
  drawSkyline(g, MID, v.scroll * 0.35, GROUND, "#2a2e52", "#ffd98a");
  const off = v.scroll % 340;
  for (let i = -1; i < 4; i++) {
    const x = i * 340 - off + 70;
    const glow = g.createRadialGradient(x + 14, 352, 4, x + 14, 352, 120); glow.addColorStop(0, "rgba(255,214,120,.45)"); glow.addColorStop(1, "rgba(255,214,120,0)");
    g.fillStyle = glow; g.fillRect(x - 110, 232, 250, 240);
    g.fillStyle = "#10131f"; g.fillRect(x - 2, 350, 5, 120); g.fillRect(x - 2, 346, 22, 4);
    g.fillStyle = "#ffe3a1"; g.fillRect(x + 12, 348, 12, 6);
  }
  g.fillStyle = "#242835"; g.fillRect(0, GROUND, W, H - GROUND);
  g.fillStyle = "#4d5163"; g.fillRect(0, GROUND, W, 3);
  g.fillStyle = "#2d3140";
  const slab = v.scroll % 90;
  for (let x = -slab; x < W; x += 90) g.fillRect(x, GROUND + 3, 2, H - GROUND);
}

const BOKEH = (r => Array.from({ length: 16 }, (_, i) => ({ x: 70 + r() * 170, y: 100 + r() * 220, r: 6 + r() * 14, c: ["255,200,120", "255,140,120", "150,190,255", "255,235,170"][i % 4], p: r() * 6 })))(rng(40));
function drawCafe(g, t, dt, v) {
  const wall = g.createLinearGradient(0, 0, 0, GROUND); wall.addColorStop(0, "#271c15"); wall.addColorStop(1, "#3d2b1f");
  g.fillStyle = wall; g.fillRect(0, 0, W, GROUND);
  g.fillStyle = "#120e0b"; g.fillRect(56, 76, 198, 258);
  const night = g.createLinearGradient(0, 80, 0, 330); night.addColorStop(0, "#182046"); night.addColorStop(1, "#3a2c4e");
  g.fillStyle = night; g.fillRect(62, 82, 186, 246);
  for (const b of BOKEH) { g.fillStyle = `rgba(${b.c},${0.28 + 0.14 * sin(t * 1.3 + b.p)})`; g.beginPath(); g.arc(b.x, b.y, b.r, 0, 7); g.fill(); }
  g.fillStyle = "#120e0b"; g.fillRect(153, 82, 4, 246); g.fillRect(62, 200, 186, 4);
  for (const x of [300, 480, 660]) {
    g.strokeStyle = "#120e0b"; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 62); g.stroke();
    const cone = g.createLinearGradient(0, 70, 0, 400); cone.addColorStop(0, "rgba(255,205,130,.22)"); cone.addColorStop(1, "rgba(255,205,130,0)");
    g.fillStyle = cone; g.beginPath(); g.moveTo(x - 16, 72); g.lineTo(x + 16, 72); g.lineTo(x + 110, 400); g.lineTo(x - 110, 400); g.fill();
    g.fillStyle = "#c98a3c"; g.beginPath(); g.moveTo(x - 20, 74); g.lineTo(x + 20, 74); g.lineTo(x + 9, 58); g.lineTo(x - 9, 58); g.fill();
    g.fillStyle = "#ffe2a8"; g.fillRect(x - 12, 74, 24, 4);
  }
  g.fillStyle = "#18211d"; g.fillRect(782, 74, 130, 150); g.strokeStyle = "#6b5a45"; g.lineWidth = 4; g.strokeRect(782, 74, 130, 150);
  g.fillStyle = "#d9d6c8"; g.font = '14px "Segoe Print","Comic Sans MS",cursive';
  ["MENU", "espresso  3", "flat white  4", "why? because."].forEach((tx, i) => g.fillText(tx, 796, 104 + i * 30));
  g.fillStyle = "#5a4330"; g.fillRect(280, 296, 400, 6);
  for (let i = 0; i < 7; i++) { g.fillStyle = ["#e8d9c4", "#c9b79f", "#d9c7a8"][i % 3]; g.fillRect(296 + i * 56, 280, 18, 16); }
  g.fillStyle = "#3a2a1e"; g.fillRect(0, GROUND, W, H - GROUND);
  g.fillStyle = "#2d2016";
  for (let x = 0; x < W; x += 70) g.fillRect(x, GROUND, 2, H - GROUND);
  g.fillStyle = "#7a5a3a"; g.fillRect(420, 436, 120, 8); g.fillRect(432, 444, 6, 26); g.fillRect(522, 444, 6, 26);
  for (const cx of [452, 508]) { g.fillStyle = "#efe3cf"; g.fillRect(cx - 7, 421, 14, 15);
    for (let k = 0; k < 5; k++) { const ph = (t * 0.45 + k / 5) % 1; g.fillStyle = `rgba(255,255,255,${(1 - ph) * 0.35})`; g.beginPath(); g.arc(cx + sin((t + k) * 3) * 5 * ph, 416 - ph * 56, 3 + ph * 5, 0, 7); g.fill(); } }
}

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅ0123456789";
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
const RAIN = Array.from({ length: 60 }, (_, i) => ({ x: i * 16 + 4, y: -Math.random() * H, speed: 70 + Math.random() * 170, len: 10 + Math.floor(Math.random() * 16), chars: Array.from({ length: 28 }, glyph) }));
function drawMatrix(g, t, dt, v) {
  g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
  g.font = "14px ui-monospace,monospace";
  for (const col of RAIN) {
    col.y += col.speed * dt / 1000;
    if (col.y - col.len * 16 > H) { col.y = -Math.random() * 200; col.speed = 70 + Math.random() * 170; }
    if (Math.random() < 0.04) col.chars[Math.floor(Math.random() * col.chars.length)] = glyph();
    for (let k = 0; k < col.len; k++) {
      const y = col.y - k * 16;
      if (y < -16 || y > H) continue;
      g.fillStyle = k === 0 ? "#d9ffe0" : `rgba(40,255,100,${(1 - k / col.len) * 0.85})`;
      g.fillText(col.chars[k % col.chars.length], col.x, y);
    }
  }
  g.fillStyle = "rgba(0,12,4,.3)"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#0a2a14"; g.fillRect(0, GROUND, W, H - GROUND);
}


const VIS = { x: 290, y: 50, w: 460, h: 360 }; // the frame each location draws around the slide
const mix = (a, b, k) => {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return `rgb(${pa.map((v, i) => Math.round(lerp(v, pb[i], k))).join(",")})`;
};
function frame(g, fill, stroke, width = 4) {
  g.fillStyle = fill; g.beginPath(); g.roundRect(VIS.x, VIS.y, VIS.w, VIS.h, 10); g.fill();
  g.strokeStyle = stroke; g.lineWidth = width; g.stroke();
}
function floor(g, base, seamColor, seam = 70) {
  g.fillStyle = base; g.fillRect(0, GROUND, W, H - GROUND);
  g.fillStyle = seamColor;
  for (let x = 0; x < W; x += seam) g.fillRect(x, GROUND, 2, H - GROUND);
}

// Seen from behind along the bottom edge; some raise a hand when a question is asked.
function drawCrowd(g, v, t, rows) {
  const hands = t - v.handsAt < 3.5;
  let k = 0;
  for (const row of rows) for (let x = row.x0; x <= row.x1; x += row.step, k++) {
    const y = row.y + (v.playing ? sin(t * 2.1 + k * 1.7) * 1.6 : 0);
    if (hands && k % 3 === 1) {
      const wave = sin(t * 6 + k) * 6;
      g.strokeStyle = row.rim; g.lineWidth = row.r * 0.45; g.lineCap = "round";
      g.beginPath(); g.moveTo(x + row.r * 0.9, y + row.r * 0.8); g.lineTo(x + row.r * 1.3 + wave * 0.3, y - row.r * 1.6); g.lineTo(x + row.r * 1.2 + wave, y - row.r * 3.1); g.stroke();
    }
    g.fillStyle = row.fill; g.strokeStyle = row.rim; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(x, y + row.r * 2.1, row.r * 1.9, row.r * 1.3, 0, Math.PI, 0); g.fill(); g.stroke();
    g.beginPath(); g.arc(x, y, row.r, 0, 7); g.fill(); g.stroke();
  }
}

function drawPodcast(g, t, dt, v) {
  const wall = g.createLinearGradient(0, 0, 0, GROUND); wall.addColorStop(0, "#16131f"); wall.addColorStop(1, "#221d2e");
  g.fillStyle = wall; g.fillRect(0, 0, W, GROUND);
  for (let i = 0; 10 + i * 44 < W; i++) for (let j = 0; 40 + j * 44 < GROUND - 40; j++) {
    const x = 10 + i * 44, y = 40 + j * 44;
    g.fillStyle = (i + j) % 2 ? "#1d1928" : "#252032"; g.fillRect(x, y, 40, 40);
    g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(x + 8, y + 8, 24, 24);
  }
  frame(g, "#0c0b14", "#3a3550");
  const live = v.playing;
  g.save();
  if (live) { g.shadowColor = "#ff4b55"; g.shadowBlur = 22; }
  g.fillStyle = live ? "#e0474c" : "#3d2326"; g.beginPath(); g.roundRect(52, 56, 118, 36, 6); g.fill();
  g.restore();
  g.fillStyle = live ? "#fff" : "#7a5a5c"; g.font = "700 17px ui-monospace,monospace"; g.fillText("ON AIR", 80, 80);
  floor(g, "#18151f", "#221d2c");
  // console with a level meter per host
  g.fillStyle = "#3a3449"; g.fillRect(360, 428, 240, 6); g.fillStyle = "#2b2638"; g.fillRect(360, 434, 240, 36);
  const who = v.who;
  for (const [k, x0] of [["host", 380], ["cohost", 490]]) for (let b = 0; b < 8; b++) {
    const level = v.playing && who === k ? Math.abs(sin(t * (7 + b) + b)) * 8 : 1;
    g.fillStyle = b >= level ? "#1b1826" : b > 5 ? "#e0474c" : b > 3 ? "#f3bd72" : "#7ddc9a";
    g.fillRect(x0 + b * 12, 446, 9, 14);
  }
  for (const [sx, mx] of [[250, 226], [710, 734]]) {
    g.fillStyle = "#2c2c36"; g.beginPath(); g.ellipse(sx, GROUND - 2, 18, 4, 0, 0, 7); g.fill();
    g.strokeStyle = "#4a4a55"; g.lineWidth = 4; g.beginPath(); g.moveTo(sx, GROUND); g.lineTo(sx, 404); g.lineTo(mx, 378); g.stroke();
    g.fillStyle = "#9a9aa8"; g.beginPath(); g.roundRect(mx - 6, 352, 12, 26, 6); g.fill();
  }
}

const SMUDGE = (r => Array.from({ length: 14 }, () => ({ x: 300 + r() * 440, y: 60 + r() * 340, r: 20 + r() * 50 })))(rng(70));
function drawClassroom(g, t, dt, v) {
  const wall = g.createLinearGradient(0, 0, 0, GROUND); wall.addColorStop(0, "#34423c"); wall.addColorStop(1, "#3f4d46");
  g.fillStyle = wall; g.fillRect(0, 0, W, GROUND);
  const day = g.createLinearGradient(0, 80, 0, 300); day.addColorStop(0, "#9cc8ea"); day.addColorStop(1, "#d9ecf7");
  g.fillStyle = "#2a332f"; g.fillRect(28, 76, 200, 232);
  g.fillStyle = day; g.fillRect(34, 82, 188, 220);
  g.fillStyle = "#2a332f"; g.fillRect(126, 82, 4, 220); g.fillRect(34, 190, 188, 4);
  g.fillStyle = "rgba(255,250,220,.07)"; g.beginPath(); g.moveTo(34, 82); g.lineTo(222, 82); g.lineTo(420, GROUND); g.lineTo(120, GROUND); g.fill();
  // chalkboard around the slide
  g.fillStyle = "#6b4a2b"; g.beginPath(); g.roundRect(VIS.x - 12, VIS.y - 12, VIS.w + 24, VIS.h + 24, 6); g.fill();
  g.fillStyle = "#1f3a2c"; g.fillRect(VIS.x, VIS.y, VIS.w, VIS.h);
  for (const s of SMUDGE) { g.fillStyle = "rgba(255,255,255,.015)"; g.beginPath(); g.arc(s.x, s.y, s.r * 0.7, 0, 7); g.fill(); }
  g.fillStyle = "#5a3e24"; g.fillRect(VIS.x - 4, VIS.y + VIS.h + 12, VIS.w + 8, 9);
  g.fillStyle = "#eee"; g.fillRect(VIS.x + 40, VIS.y + VIS.h + 8, 16, 5);
  g.fillStyle = "#f3bd72"; g.fillRect(VIS.x + 70, VIS.y + VIS.h + 8, 12, 5);
  // the clock moves on as the story goes
  const cx = 872, cy = 96, minutes = 9 * 60 + v.storyP * 55;
  g.fillStyle = "#e9e4d6"; g.beginPath(); g.arc(cx, cy, 30, 0, 7); g.fill();
  g.strokeStyle = "#2a332f"; g.lineWidth = 3; g.stroke();
  const hand = (a, len, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + sin(a) * len, cy - cos(a) * len); g.stroke(); };
  hand((minutes % 60) / 60 * Math.PI * 2, 22, 2);
  hand((minutes / 60 % 12) / 12 * Math.PI * 2, 14, 3.5);
  g.fillStyle = "#e8e2c8"; g.fillRect(800, 170, 130, 90);
  g.fillStyle = "#3b4a43"; g.font = '15px "Segoe Print","Comic Sans MS",cursive';
  g.fillText("ask WHY", 822, 205); g.fillText("then HOW", 820, 235);
  floor(g, "#4a3b2c", "#3d3024", 80);
  drawCrowd(g, v, t, [{ y: 506, x0: 260, x1: 700, step: 73, r: 14, fill: "#1c2420", rim: "#6b7a72" }]);
}

function drawLecture(g, t, dt, v) {
  const wall = g.createLinearGradient(0, 0, 0, GROUND); wall.addColorStop(0, "#0d0f17"); wall.addColorStop(1, "#191c28");
  g.fillStyle = wall; g.fillRect(0, 0, W, GROUND);
  for (const [a, b] of [[0, 250], [790, W]]) for (let x = a; x < b; x += 26) { g.fillStyle = (x / 26) % 2 ? "#2a1f1a" : "#30241d"; g.fillRect(x, 40, 24, GROUND - 40); }
  const flick = 0.07 + 0.015 * sin(t * 40) * sin(t * 3.3);
  g.fillStyle = `rgba(200,220,255,${flick})`;
  g.beginPath(); g.moveTo(470, H); g.lineTo(490, H); g.lineTo(VIS.x + VIS.w, VIS.y + VIS.h); g.lineTo(VIS.x + VIS.w, VIS.y); g.lineTo(VIS.x, VIS.y); g.lineTo(VIS.x, VIS.y + VIS.h); g.fill();
  frame(g, "#161b25", "#cfd6e2", 2);
  g.fillStyle = "#cfd6e2"; g.fillRect(VIS.x + VIS.w / 2 - 1, 0, 2, VIS.y);
  floor(g, "#1e1a24", "#262130", 120);
  drawCrowd(g, v, t, [
    { y: 490, x0: 240, x1: 720, step: 54, r: 10, fill: "#0b0d13", rim: "#3a4152" },
    { y: 516, x0: 270, x1: 690, step: 70, r: 14, fill: "#0b0d13", rim: "#4a5266" },
  ]);
}

function windowView(g, v, x, y, w, h) {
  g.save(); g.beginPath(); g.roundRect(x, y, w, h, 14); g.clip();
  const tense = v.mood === "tension";
  const sky = g.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, tense ? "#59606b" : "#6fa8dc"); sky.addColorStop(1, tense ? "#8a8f96" : "#f6d6a8");
  g.fillStyle = sky; g.fillRect(x, y, w, h);
  const off = v.scroll * 0.6;
  for (const [base, amp, period, speed, color] of [[0.62, 14, 70, 1, tense ? "#4a5a4c" : "#5d8c5a"], [0.8, 8, 40, 2, tense ? "#3a473b" : "#43703f"]]) {
    g.fillStyle = color; g.beginPath(); g.moveTo(x, y + h);
    for (let px = x; px <= x + w; px += 8) g.lineTo(px, y + h * base + sin((px + off * speed) / period) * amp);
    g.lineTo(x + w, y + h); g.fill();
  }
  g.fillStyle = "#2b2b2b";
  for (let px = x - (v.scroll * 4) % 260; px < x + w; px += 260) g.fillRect(px, y + 10, 5, h);
  g.restore();
  g.strokeStyle = "#5a4d40"; g.lineWidth = 6; g.beginPath(); g.roundRect(x, y, w, h, 14); g.stroke();
}
function drawTrain(g, t, dt, v) {
  g.save(); g.translate(0, sin(t * 1.4) * 1.5);
  g.fillStyle = "#3b332c"; g.fillRect(0, -4, W, GROUND + 4);
  g.fillStyle = "#4a4038"; g.fillRect(0, 30, W, 14);
  for (let x = 60; x < W; x += 180) { g.fillStyle = "rgba(255,240,200,.85)"; g.fillRect(x, 12, 90, 6); }
  windowView(g, v, 26, 90, 236, 210);
  windowView(g, v, 778, 90, 158, 210);
  windowView(g, v, VIS.x, VIS.y, VIS.w, VIS.h);
  g.fillStyle = "rgba(20,16,12,.55)"; g.fillRect(VIS.x, VIS.y, VIS.w, VIS.h);
  for (const x of [276, 684]) { g.fillStyle = "#c8cdd2"; g.fillRect(x, 44, 6, GROUND - 44); }
  for (let x = 20; x < W; x += 120) {
    g.fillStyle = "#6a2f33"; g.beginPath(); g.roundRect(x, 418, 96, 52, 8); g.fill();
    g.fillStyle = "#7d3a3f"; g.fillRect(x + 8, 426, 80, 6);
  }
  g.restore();
  floor(g, "#24201c", "#2c2722", 60);
}

const LEDS = (r => Array.from({ length: 200 }, () => ({ red: r(), speed: 2 + r() * 9, phase: r() * 6 })))(rng(300));
function drawServer(g, t, dt, v) {
  g.fillStyle = "#0a0e13"; g.fillRect(0, 0, W, GROUND);
  g.fillStyle = "#121820"; g.fillRect(0, 18, W, 6);
  for (let x = 0; x < W; x += 60) g.fillRect(x, 24, 2, 30);
  // red lights while it is broken; they turn green as an insight chapter goes on
  const redShare = { tension: 0.5, insight: 0.5 * (1 - v.progress), resolved: 0, calm: 0.06 }[v.mood];
  let k = 0;
  for (const rx of [20, 100, 180, 760, 840]) {
    g.fillStyle = "#141b23"; g.fillRect(rx, 80, 72, 390);
    g.strokeStyle = "#2b3642"; g.lineWidth = 2; g.strokeRect(rx, 80, 72, 390);
    for (let u = 0; u < 18; u++, k += 2) {
      const y = 92 + u * 20;
      g.fillStyle = "#1b232d"; g.fillRect(rx + 6, y, 60, 16);
      for (let j = 0; j < 2; j++) {
        const led = LEDS[k + j], on = sin(t * led.speed + led.phase) > -0.2;
        g.fillStyle = on ? (led.red < redShare ? "#ff4d4d" : "#4dff88") : "#1f2a24";
        g.fillRect(rx + 50 + j * 7, y + 6, 4, 4);
      }
    }
  }
  frame(g, "#0d131a", "#24425a", 2);
  const aisle = g.createLinearGradient(0, GROUND - 60, 0, GROUND); aisle.addColorStop(0, "rgba(60,140,255,0)"); aisle.addColorStop(1, "rgba(60,140,255,.18)");
  g.fillStyle = aisle; g.fillRect(0, GROUND - 60, W, 60);
  floor(g, "#151b22", "#1f2832", 40);
}

const STARS = (r => Array.from({ length: 70 }, () => ({ x: r() * W, y: r() * 260, s: r() * 1.6 + 0.4 })))(rng(500));
function drawRooftop(g, t, dt, v) {
  const k = v.sunP; // dawn breaks as the chapter goes on
  const sky = g.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, mix("#0b1026", "#4a6fa5", k)); sky.addColorStop(0.6, mix("#22224a", "#f2a65a", k)); sky.addColorStop(1, mix("#3a2a55", "#ffd59a", k));
  g.fillStyle = sky; g.fillRect(0, 0, W, GROUND);
  for (const s of STARS) { g.fillStyle = `rgba(255,255,255,${(1 - k) * (0.5 + 0.5 * sin(t * 2 + s.x))})`; g.fillRect(s.x, s.y, s.s, s.s); }
  const sunY = 430 - k * 210;
  const glow = g.createRadialGradient(820, sunY, 10, 820, sunY, 160); glow.addColorStop(0, `rgba(255,214,140,${0.5 * k})`); glow.addColorStop(1, "rgba(255,214,140,0)");
  g.fillStyle = glow; g.fillRect(600, sunY - 170, 360, 340);
  g.fillStyle = "#ffcf7a"; g.beginPath(); g.arc(820, sunY, 30, 0, 7); g.fill();
  drawSkyline(g, FAR, 300, 420, mix("#141634", "#5a4a6a", k * 0.8), `rgba(255,217,138,${0.7 * (1 - k)})`);
  g.fillStyle = mix("#1c1b26", "#3b3440", k); g.fillRect(0, 420, W, 50);
  g.fillStyle = mix("#14131b", "#2b2530", k);
  g.fillRect(866, 300, 64, 60); g.beginPath(); g.moveTo(862, 300); g.lineTo(898, 276); g.lineTo(934, 300); g.fill();
  g.fillRect(872, 360, 5, 70); g.fillRect(918, 360, 5, 70);
  g.strokeStyle = mix("#2a2833", "#6a5a5a", k); g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 440); g.lineTo(W, 440); g.stroke();
  for (let x = 10; x < W; x += 46) { g.beginPath(); g.moveTo(x, 440); g.lineTo(x, GROUND); g.stroke(); }
  floor(g, mix("#24222c", "#4a4048", k), mix("#2c2a34", "#544850", k), 90);
}

const DROPS = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: Math.random() * H, len: 10 + Math.random() * 14, v: 500 + Math.random() * 300 }));
const SPARKS = (r => Array.from({ length: 30 }, () => ({ x: r() * W, y: r() * H, v: 12 + r() * 25, s: 1 + r() * 2.5, p: r() * 6 })))(rng(900));
const OUTDOOR = new Set(["street", "rooftop"]);
function rain(g, dt, x, y, w, h) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.strokeStyle = "rgba(170,190,220,.45)"; g.lineWidth = 1.2; g.beginPath();
  for (const d of DROPS) {
    d.y += d.v * dt / 1000; d.x -= d.v * dt / 6000;
    if (d.y > H) { d.y = -20; d.x = Math.random() * (W + 80); }
    g.moveTo(d.x, d.y); g.lineTo(d.x - d.len * 0.2, d.y + d.len);
  }
  g.stroke(); g.restore();
}
function drawMood(g, t, dt, v) {
  if (v.mood === "tension") {
    if (OUTDOOR.has(v.scene)) rain(g, dt, 0, 0, W, GROUND);
    if (v.scene === "coffeehouse") rain(g, dt, 62, 82, 186, 246);
    const vignette = g.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 620); vignette.addColorStop(0, "rgba(120,20,20,0)"); vignette.addColorStop(1, "rgba(140,25,25,.38)");
    g.fillStyle = vignette; g.fillRect(0, 0, W, H);
    if (!OUTDOOR.has(v.scene) && sin(t * 13) * sin(t * 2.7) > 0.93) { g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(0, 0, W, H); }
  } else if (v.mood === "insight") {
    const glow = g.createRadialGradient(520, 230, 40, 520, 230, 420); glow.addColorStop(0, `rgba(163,223,189,${0.10 + 0.05 * sin(t * 2)})`); glow.addColorStop(1, "rgba(163,223,189,0)");
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
  } else if (v.mood === "resolved") {
    const warm = g.createRadialGradient(W / 2, H / 2, 220, W / 2, H / 2, 620); warm.addColorStop(0, "rgba(255,190,110,0)"); warm.addColorStop(1, "rgba(255,190,110,.18)");
    g.fillStyle = warm; g.fillRect(0, 0, W, H);
    for (const s of SPARKS) {
      s.y -= s.v * dt / 1000;
      if (s.y < -10) s.y = H + 10;
      g.fillStyle = `rgba(255,222,150,${0.35 + 0.35 * sin(t * 3 + s.p)})`;
      g.beginPath(); g.arc(s.x + sin(t + s.p) * 8, s.y, s.s, 0, 7); g.fill();
    }
  }
}


const DEFAULT_COLORS = { host: "#a3dfbd", cohost: "#8fc3f0" };
const FACING = { host: 1, cohost: -1 };
const HOMES = { host: 190, cohost: 770 };

/** How the hosts behave in each place: where they stand, how far they step toward the slide, and what they carry. */
export const PLACES = {
  podcast: { icon: "🎙", label: "Podcast studio", ground: "#3a3449", homes: HOMES, faces: FACING, reach: 0.2, draw: drawPodcast },
  classroom: { icon: "🏫", label: "Classroom", ground: "#5a4632", homes: HOMES, faces: FACING, reach: 1, draw: drawClassroom },
  lecture: { icon: "🎓", label: "Lecture hall", ground: "#3a3346", homes: HOMES, faces: FACING, reach: 0.8, draw: drawLecture },
  coffeehouse: { icon: "☕", label: "Coffee house", ground: "#6a5038", homes: HOMES, faces: FACING, reach: 0.6, cup: true, draw: drawCafe },
  street: { icon: "🌃", label: "Street walk", ground: "#4d5163", homes: { host: 110, cohost: 215 }, faces: { host: 1, cohost: 1 }, reach: 0.25, treadmill: true, draw: drawStreet },
  train: { icon: "🚆", label: "Train ride", ground: "#3a332c", homes: HOMES, faces: FACING, reach: 0.3, draw: drawTrain },
  server: { icon: "🖥", label: "Server room", ground: "#24425a", homes: HOMES, faces: FACING, reach: 1, draw: drawServer },
  matrix: { icon: "💻", label: "The matrix", ground: "#1f7a3a", homes: HOMES, faces: FACING, reach: 1, glow: true, colors: { host: "#7dff9b", cohost: "#6fe3ff" }, draw: drawMatrix },
  rooftop: { icon: "🌅", label: "Rooftop at dawn", ground: "#4a4048", homes: HOMES, faces: FACING, reach: 0.6, draw: drawRooftop },
};

export const actorColor = (place, who) => place.colors?.[who] ?? DEFAULT_COLORS[who];

export function drawScene(g, place, t, dt, view) {
  place.draw(g, t, dt, view);
  drawMood(g, t, dt, view);
}
