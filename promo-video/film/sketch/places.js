// The sheet of Alex's Monday. Four places, laid out like a storyboard:
//
//     the café                 his home, with the server
//     his desk | Maya's desk   the train home
//
// with a pencil line through the day joining them. `world(t)` draws it for a film; `t` holds the
// film's frames: when each part is drawn, the poses, the clock, the lid.
import { alexLook, mayaLook, person, poseAt } from "./people.js";
import { inkColor, oval, roundRect } from "./ink.js";
import { backdrop, cat, clock, desk, floor, framedPrint, laptopBack, menuBoard, monitor, mug, phoneBack, plant, projection, screenProjection, serverBox, shadow, shelf, sticky, stringLights, tones, windowLight, windowView } from "./things.js";

// Where the screens are on the sheet. Cameras look into them, rings are drawn on them. A phone's
// screen is its projection beside the person (`projection` in things.js); the phone they hold is
// in `held`, at a real phone's size next to their head.
export const devices = {
  // Alex and Maya face us behind their laptops, so their screens are shown beside them.
  laptop: { x: 760, y: 396, w: 360, h: 225 },
  hers: { x: 1500, y: 396, w: 360, h: 225 },
  lunchPhone: { x: 1160, y: -800, w: 186, h: 404 },
  server: { x: 3000, y: -640, w: 304, h: 190 },
  trainPhone: { x: 3440, y: 330, w: 196, h: 426 },
};
// Held in both hands in front of his chest, where he can look down at it.
export const held = {
  lunchPhone: { x: 826, y: -470, w: 38, h: 82 },
  trainPhone: { x: 3134, y: 742, w: 40, h: 86 },
};
// The places, as rectangles of the sheet, for wide shots.
export const places = {
  title: { x: 150, y: 60, w: 900, h: 220 },
  office: { x: 150, y: 300, w: 1180, h: 760 },
  desk: { x: 440, y: 470, w: 600, h: 330 },
  both: { x: 330, y: 330, w: 1930, h: 700 },
  maya: { x: 1380, y: 300, w: 880, h: 760 },
  cafe: { x: 420, y: -980, w: 1080, h: 890 },
  home: { x: 2500, y: -980, w: 1220, h: 890 },
  train: { x: 2480, y: 260, w: 1480, h: 830 },
  sheet: { x: 120, y: -1000, w: 3870, h: 2110 },
};

const lerp = (a, b, t) => a + (b - a) * t;
const mixColor = (a, b, t) => {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16));
  const pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `#${pa.map((v, i) => Math.round(lerp(v, pb[i], t)).toString(16).padStart(2, "0")).join("")}`;
};
/** A value from a list of [frame, value], eased from one to the next over `over` frames. */
export function keyed(keys, frame, over = 30) {
  let value = keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (frame < keys[i][0]) break;
    const t = Math.min(1, (frame - keys[i][0]) / over);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    value = lerp(keys[i - 1][1], keys[i][1], eased);
  }
  return value;
}
/** The sky at a time of day, in minutes past midnight. */
function skyAt(minutes) {
  const stops = [[540, "#fbe6b0"], [720, "#cfe5f6"], [900, "#d9e6f2"], [1020, "#f8cf9a"], [1080, "#f2a77c"], [1110, "#8f8fc8"]];
  if (minutes <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (minutes <= stops[i][0]) return mixColor(stops[i - 1][1], stops[i][1], (minutes - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  return stops.at(-1)[1];
}

/** An office chair seen from the front, behind the person sitting in it. */
function chair(pen, x, y) {
  pen.shape(roundRect(x - 80, y, 160, 156, 34), { fill: "#55606b", alpha: 0.55, width: 2.8 });
}

/**
 * The projection of a held phone's screen, drawn by the pen from `when.from` and gone at
 * `when.gone`. It is drawn in the measuring pass as well, so the pen knows how much ink it has.
 */
function showProjection(pen, frame, id, when, pictures) {
  if (!when || (frame >= (when.gone ?? Infinity) && !pen.measure)) return;
  pen.begin(`${id}-projection`, when.from, when.from + 30, 30);
  projection(pen, held[id], devices[id], pictures(id));
  pen.end();
}

export function world(t) {
  const title = (pen, frame) => {
    pen.begin("title", ...t.draw.title, 1);
    pen.text("Alex's Monday", 190, 196, { size: 120, speed: 1.2 });
    pen.text("release due at 6 PM", 214, 262, { size: 56, color: "#c4561f", speed: 1.2 });
    pen.stroke([[640, 214], [700, 210], [770, 216]], { width: 4, color: "#c4561f" });
    pen.end();
  };

  const office = (pen, frame, pictures) => {
    const minutes = keyed(t.clock, frame, 40);
    // In front: the desk and the laptop, drawn first.
    pen.begin("desk", ...t.draw.desk, 20);
    desk(pen, 380, 1200, 742, 1000);
    pen.on(22);
    // His laptop, its back to us; its screen drawn large beside him, folding back in as the lid shuts.
    const lidOpen = keyed(t.lid, frame, 18);
    const lid = laptopBack(pen, 580, 742, lidOpen);
    mug(pen, 1010, 694, frame, { full: minutes < 780 });
    plant(pen, 1150, 742, { height: 150 });
    pen.on(26);
    if (lidOpen > 0.02 || pen.measure) screenProjection(pen, lid, devices.laptop, pictures("laptop"), lidOpen);
    pen.end();
    // Then Alex, behind it, his hands on the keyboard behind the lid.
    pen.begin("alex", ...t.draw.alex, 10);
    person(pen, { at: [575, 800], look: alexLook, pose: poseAt(t.alex.office, frame), frame, layer: 10, nearLayer: 13, farLayer: 13, gripLayer: 23 });
    pen.on(9);
    chair(pen, 581, 596);
    pen.end();
    // Then the room behind them both.
    pen.begin("room", ...t.draw.room, 0);
    backdrop(pen, 150, 300, 1180, 760, tones.wall, 3);
    windowView(pen, 190, 380, 300, 250, skyAt(minutes), { sun: minutes < 1060 ? [300, 440 + (minutes - 540) * 0.1, tones.sun] : null });
    pen.on(1);
    windowLight(pen, { x: 190, y: 380, w: 300, h: 250 }, [260, 380]);
    framedPrint(pen, 560, 360, 120, 96);
    clock(pen, 940, 330, 44, minutes);
    sticky(pen, 1140, 300, ["Release", "6 PM!"], { tilt: 0.06 });
    shelf(pen, 1170, 520, 140);
    floor(pen, 170, 1300, 1004);
    pen.end();
  };

  const maya = (pen, frame, pictures) => {
    pen.begin("maya-desk", ...t.draw.mayaDesk, 20);
    desk(pen, 1480, 2140, 742, 1000, { drawers: "left" });
    pen.on(22);
    const hersLid = laptopBack(pen, 2004, 742, 1);
    // A desk lamp, at the free end of the desk, clear of her.
    pen.shape([[2096, 742], [2136, 742], [2132, 730], [2100, 730]], { fill: tones.device, alpha: 0.6, smooth: false, width: 2.4 });
    pen.stroke([[2116, 730], [2124, 640], [2150, 606]], { width: 3.4 });
    pen.shape([[2140, 592], [2184, 596], [2180, 628], [2132, 622]], { fill: tones.sun, alpha: 0.7, smooth: false, width: 2.6 });
    pen.on(26);
    screenProjection(pen, hersLid, devices.hers, pictures("hers"));
    pen.end();
    pen.begin("maya", ...t.draw.maya, 10);
    person(pen, { at: [2010, 800], look: mayaLook, dir: -1, pose: poseAt(t.maya, frame), frame, layer: 10, nearLayer: 13, farLayer: 13, gripLayer: 23 });
    pen.on(9);
    chair(pen, 2004, 596);
    pen.end();
    pen.begin("maya-room", ...t.draw.mayaRoom, 0);
    backdrop(pen, 1380, 300, 880, 760, tones.wall, 8);
    pen.on(1);
    pen.shape([[1940, 270], [2100, 270], [2100, 380], [1940, 380]], { fill: tones.cream, alpha: 0.6, smooth: false, width: 3 });
    pen.stroke([[1958, 364], [2004, 312], [2032, 340], [2060, 304], [2084, 364]], { width: 2.4, color: "#4f9c72" });
    pen.shape(oval(2064, 296, 11, 11, 10), { fill: tones.sun, alpha: 0.8, width: 2 });
    plant(pen, 2200, 1000, { height: 230 });
    floor(pen, 1390, 2250, 1004);
    pen.text("Maya", 2004, 448, { size: 54, align: "center", color: "#0f8a6c" });
    pen.end();
    // Her conversation is his conversation: a dashed line between the two screens.
    const linked = t.links.maya;
    pen.begin("maya-link", linked.from, linked.from + 24, 30);
    if (frame < linked.gone) {
      for (let k = 0; k < 12; k++) {
        const a = k / 12;
        const b = a + 0.045;
        const along = (u) => [lerp(1120, 1500, u), 500 - Math.sin(u * Math.PI) * 130];
        pen.stroke([along(a), along((a + b) / 2), along(b)], { width: 4, color: "#0f8a6c" });
      }
      pen.text("same conversation, live", 1310, 330, { size: 44, align: "center", color: "#0f8a6c" });
    }
    pen.end();
  };

  const cafe = (pen, frame, pictures) => {
    pen.begin("cafe-front", ...t.draw.cafeFront, 20);
    shadow(pen, 1080, -142, 110, 10);
    pen.shape(oval(1080, -380, 150, 20, 18), { fill: tones.cream, alpha: 0.7, width: 3 });
    pen.stroke([[1080, -360], [1080, -150]], { width: 4 });
    pen.stroke([[1020, -146], [1140, -146]], { width: 4 });
    pen.on(21);
    pen.shape([[1130, -400], [1220, -400], [1236, -388], [1114, -388]], { fill: "#ffffff", alpha: 0.5, smooth: false, width: 2.4 });
    pen.shape([[1140, -402], [1200, -440], [1214, -402]], { fill: "#f2cf8f", alpha: 0.8, smooth: false, width: 2.4 });
    pen.stroke([[1150, -410], [1200, -432]], { width: 2, color: "#4f9c72" });
    mugAt(pen, 1012, -432, frame);
    pen.end();
    pen.begin("cafe-alex", ...t.draw.cafeAlex, 10);
    person(pen, { at: [840, -300], look: alexLook, pose: poseAt(t.alex.cafe, frame), frame, layer: 10, legs: true, holding: held.lunchPhone });
    pen.on(12.5);
    phoneBack(pen, held.lunchPhone);
    pen.on(9);
    pen.stroke([[760, -300], [720, -520], [746, -540]], { width: 4 });
    pen.stroke([[770, -300], [760, -150]], { width: 4 });
    pen.stroke([[860, -300], [880, -150]], { width: 4 });
    pen.stroke([[740, -300], [900, -300]], { width: 5 });
    pen.end();
    // When the story looks at his phone, its screen is drawn large beside him, until the story moves on.
    showProjection(pen, frame, "lunchPhone", t.projections?.lunch, pictures);
    pen.begin("cafe-room", ...t.draw.cafeRoom, 0);
    backdrop(pen, 420, -980, 1080, 890, tones.warm, 5);
    // The awning, striped, with a scalloped edge.
    const scallops = Array.from({ length: 9 }, (_, i) => [480 + i * 120, -800]);
    pen.shape([[470, -900], [1450, -900], [1450, -800], ...scallops.flatMap(([x, y]) => [[x + 120, y], [x + 60, y + 30]]).reverse(), [470, -800]], { fill: "#f6a39a", alpha: 0.5, smooth: false, width: 3 });
    for (let i = 1; i < 8; i++) pen.line([470 + i * 122, -900], [470 + i * 122, -800], { width: 1.8, over: 0 });
    pen.on(1);
    windowView(pen, 540, -760, 430, 260, "#d8ecf5", { skyline: false });
    stringLights(pen, [480, -796], [1440, -796], 12);
    menuBoard(pen, 990, -760, 140, 130);
    pen.text("café", 755, -560, { size: 82, align: "center", color: "#c4561f" });
    plant(pen, 1370, -150, { height: 190 });
    floor(pen, 450, 1470, -142);
    pen.end();
  };

  const home = (pen, frame, pictures) => {
    pen.begin("home-front", ...t.draw.homeFront, 20);
    shadow(pen, 3280, -146, 380, 14);
    pen.shape([[2920, -380], [3640, -380], [3640, -150], [2920, -150]], { fill: tones.wood, alpha: 0.6, smooth: false, width: 3 });
    pen.line([3280, -380], [3280, -150], { width: 2.4 });
    pen.line([3160, -265], [3220, -265], { width: 3.2 });
    pen.line([3340, -265], [3400, -265], { width: 3.2 });
    pen.on(22);
    monitor(pen, devices.server, pictures("server"), { foot: -380 });
    serverBox(pen, 3410, -560, 150, 180, frame);
    pen.text("home server", 3486, -588, { size: 40, align: "center" });
    pen.end();
    pen.begin("home-room", ...t.draw.homeRoom, 0);
    backdrop(pen, 2500, -980, 1220, 890, tones.dusk, 11);
    windowView(pen, 2560, -860, 300, 280, "#c9a6c8", { sun: [2650, -780, "#fff2c2"] });
    pen.on(1);
    pen.shape([[2650, -150], [2870, -150], [2890, -128], [2630, -128]], { fill: "#b7a7d8", alpha: 0.5, smooth: false, width: 2.4 });
    cat(pen, 2760, -158, frame);
    // A floor lamp, lit.
    pen.stroke([[3690, -148], [3690, -620]], { width: 4 });
    pen.shape([[3640, -620], [3740, -620], [3716, -700], [3664, -700]], { fill: tones.sun, alpha: 0.7, smooth: false, width: 2.8 });
    pen.wash(oval(3690, -560, 110, 70, 14), tones.sun, { alpha: 0.25 });
    floor(pen, 2520, 3720, -148);
    pen.text("Alex's home", 2700, -920, { size: 54, color: "#6d5aa8" });
    pen.end();
  };

  const train = (pen, frame, pictures) => {
    pen.begin("train-front", ...t.draw.trainFront, 20);
    pen.shape(roundRect(2880, 856, 760, 44, 14), { fill: tones.seat, alpha: 0.65, width: 3 });
    pen.stroke([[2920, 900], [2920, 1000]], { width: 4 });
    pen.stroke([[3600, 900], [3600, 1000]], { width: 4 });
    pen.end();
    pen.begin("train-alex", ...t.draw.trainAlex, 10);
    person(pen, { at: [3150, 860], look: alexLook, pose: poseAt(t.alex.train, frame), frame, layer: 10, legs: true, holding: held.trainPhone });
    pen.on(12.5);
    phoneBack(pen, held.trainPhone);
    pen.end();
    showProjection(pen, frame, "trainPhone", t.projections?.train, pictures);
    pen.begin("train-room", ...t.draw.trainRoom, 0);
    backdrop(pen, 2480, 260, 1480, 830, tones.train, 17);
    pen.on(1);
    // The window: an evening sky, hills and poles sliding past.
    const glass = { x: 2560, y: 330, w: 1000, h: 320 };
    pen.shape(roundRect(glass.x, glass.y, glass.w, glass.h, 40), { fill: "#f4b183", alpha: 0.45, width: 3.4 });
    pen.wash([[glass.x + 20, glass.y + 10], [glass.x + glass.w - 20, glass.y + 10], [glass.x + glass.w - 10, glass.y + 150], [glass.x + 10, glass.y + 150]], "#8d97d6", { alpha: 0.45 });
    hills(pen, glass, frame);
    pen.on(5);
    pen.shape(roundRect(2880, 640, 760, 220, 30), { fill: tones.seat, alpha: 0.45, width: 3 });
    for (const x of [2700, 3050, 3400, 3750]) {
      pen.stroke([[x, 262], [x, 300]], { width: 2.6 });
      pen.ellipse(x, 318, 18, 20, { width: 3 });
    }
    floor(pen, 2500, 3940, 1002);
    pen.text("the train home", 2560, 300, { size: 50, color: "#4b6fa8" });
    pen.end();
  };

  const journey = (pen, frame) => {
    for (const [index, leg] of t.journey.entries()) {
      pen.begin(`journey-${index}`, leg.from, leg.to, 2);
      const points = leg.points;
      // Dashes along a smooth curve through the points.
      const dense = smoothPath(points);
      for (let k = 0; k + 1 < dense.length; k += 2) pen.stroke([dense[k], dense[k + 1]], { width: 3.2, color: "#8b7d6b", smooth: false, wobble: 0.6, taper: false });
      if (leg.label) pen.text(leg.label, leg.labelAt[0], leg.labelAt[1], { size: leg.size ?? 50, color: leg.color ?? inkColor, align: "center" });
      pen.end();
    }
    // The work moving to the home server: a mint arrow from the laptop up to the server.
    const moved = t.links.server;
    pen.begin("server-link", moved.from, moved.from + 30, 30);
    const arc = smoothPath([[990, 712], [1290, 660], [1440, 290], [1950, -120], [2990, -470]]);
    for (let k = 0; k + 1 < arc.length; k += 2) pen.stroke([arc[k], arc[k + 1]], { width: 5, color: "#0f8a6c", smooth: false, wobble: 0.6, taper: false });
    pen.stroke([[2950, -500], [2992, -472], [2944, -452]], { width: 5, color: "#0f8a6c", smooth: false });
    pen.text("Runs on: home server", 2160, -150, { size: 50, color: "#0f8a6c", align: "center", angle: -0.32 });
    pen.end();
  };

  return [title, cafe, home, office, maya, train, journey];
}

/** A mug on a café table, smaller than the office one. */
function mugAt(pen, x, y, frame) { mug(pen, x, y, frame, { color: "#7fa6d9" }); }

/** Hills and poles outside the train window, scrolling past, clipped to the glass. */
function hills(pen, glass, frame) {
  const shift = frame * 6;
  pen.paint(() => {
    const { ctx } = pen;
    ctx.beginPath();
    ctx.roundRect(glass.x + 4, glass.y + 4, glass.w - 8, glass.h - 8, 36);
    ctx.clip();
    ctx.globalCompositeOperation = "multiply";
    for (const [depth, color, height, speed] of [[0, "#b9a6cf", 120, 0.3], [1, "#8fb59a", 70, 1]]) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6 * pen.colored();
      ctx.beginPath();
      ctx.moveTo(glass.x, glass.y + glass.h);
      for (let x = glass.x; x <= glass.x + glass.w + 20; x += 20) {
        const u = (x + shift * speed) / 180;
        ctx.lineTo(x, glass.y + glass.h - height - Math.sin(u + depth * 2) * 26 - Math.sin(u * 2.3) * 12);
      }
      ctx.lineTo(glass.x + glass.w, glass.y + glass.h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = inkColor;
    ctx.lineWidth = 3;
    ctx.globalAlpha = pen.colored();
    for (let k = 0; k < 4; k++) {
      const x = glass.x + glass.w - (((shift * 1.6) + k * 330) % (glass.w + 200)) + 100;
      ctx.beginPath();
      ctx.moveTo(x, glass.y + 40);
      ctx.lineTo(x + 2, glass.y + glass.h);
      ctx.moveTo(x - 30, glass.y + 70);
      ctx.lineTo(x + 30, glass.y + 70);
      ctx.stroke();
    }
  });
}

/** Evenly spaced points along a smooth curve through `points`, for dashes. */
function smoothPath(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const steps = Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 18);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const axis = (a) => 0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t3);
      out.push([axis(0), axis(1)]);
    }
  }
  return out;
}
