import { oval, roundRect } from "./sketch/ink.js";
import { backdrop, clock, floor, framedPrint, menuBoard, mug, pendantLamp, plant, shadow, shelf, stringLights, tones, windowView } from "./sketch/things.js";

// The places an Activity overview chapter can happen in, drawn on paper with the films' pen. Each
// chapter gets a room of its own on one long sheet, side by side, and the camera travels from one
// to the next. Every room has the same bones: Maya on the left and Jonah on the right, sitting or
// standing behind something that hides their laps (a table, a desk, a ledge), and the board
// between them where the chapter's slide is drawn. A room draws its back (`back`, from layer 0)
// and its front (`front`, from layer 20); `t` is { frame, sunP } for what moves.

export const ROOM = { w: 1400, h: 880, top: 40, pitch: 1560 };
/** The top of the table, desk or ledge the hosts sit behind. */
export const FRONT = 722;
export const SEAT_Y = 780;
export const SEATS = { host: 250, cohost: 1150 };
export const roomX = (seg) => seg * ROOM.pitch;
export const boardRect = (ox) => ({ x: ox + 390, y: 90, w: 620, h: 420 });

const SANS = 'ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif';

/** The table or desk the hosts sit behind: a top they rest their hands on, and a front that hides their laps. */
function table(pen, ox, color, front = 0.5) {
  shadow(pen, ox + 700, 906, 640, 16);
  pen.shape([[ox + 70, FRONT], [ox + 1330, FRONT], [ox + 1330, FRONT + 20], [ox + 70, FRONT + 20]], { fill: color, alpha: 0.78, smooth: false, width: 3 });
  pen.shape([[ox + 90, FRONT + 20], [ox + 1310, FRONT + 20], [ox + 1310, 900], [ox + 90, 900]], { fill: color, alpha: front, smooth: false, width: 3 });
  pen.stroke([[ox + 160, 800], [ox + 360, 796], [ox + 520, 802]], { width: 1.3, alpha: 0.5 });
  pen.stroke([[ox + 880, 846], [ox + 1100, 842]], { width: 1.3, alpha: 0.5 });
}

/** A low wall in front of people standing: a coping on top and courses of brick. */
function ledge(pen, ox, top, face) {
  shadow(pen, ox + 700, 906, 640, 16);
  pen.shape([[ox + 60, FRONT], [ox + 1340, FRONT], [ox + 1340, FRONT + 22], [ox + 60, FRONT + 22]], { fill: top, alpha: 0.85, smooth: false, width: 3 });
  pen.shape([[ox + 80, FRONT + 22], [ox + 1320, FRONT + 22], [ox + 1320, 900], [ox + 80, 900]], { fill: face, alpha: 0.6, smooth: false, width: 3 });
  for (let row = 0; row < 3; row++) for (let k = 0; k < 9; k++) pen.line([ox + 100 + k * 136 + (row % 2) * 68, 780 + row * 40], [ox + 160 + k * 136 + (row % 2) * 68, 780 + row * 40], { width: 1.3, alpha: 0.45, over: 0 });
}

function microphones(pen, ox) {
  for (const [mx, lean] of [[ox + 372, 1], [ox + 1028, -1]]) {
    pen.shape([[mx - 26, FRONT], [mx + 26, FRONT], [mx + 20, FRONT - 10], [mx - 20, FRONT - 10]], { fill: tones.device, alpha: 0.7, smooth: false, width: 2.4 });
    pen.stroke([[mx, FRONT - 10], [mx + lean * 4, 700], [mx + lean * 10, 690]], { width: 3.2 });
    pen.shape(roundRect(mx + lean * 10 - 14, 650, 28, 42, 13), { fill: "#3d4348", alpha: 0.8, width: 2.4 });
    for (const k of [0, 1, 2]) pen.line([mx + lean * 10 - 8, 660 + k * 9], [mx + lean * 10 + 8, 660 + k * 9], { width: 1.2, color: "#c4c9ce", over: 0 });
  }
}

const towers = (pen, ox, list, color) => {
  for (const [tx, top, tw] of list) {
    pen.shape([[ox + tx, FRONT], [ox + tx, top], [ox + tx + tw, top], [ox + tx + tw, FRONT]], { fill: color, alpha: 0.5, smooth: false, width: 2.4 });
    for (let row = 0; row < 4; row++) pen.line([ox + tx + tw * 0.25, top + 30 + row * 40], [ox + tx + tw * 0.75, top + 30 + row * 40], { width: 1.3, alpha: 0.55, over: 0 });
  }
};

const podcast = {
  icon: "🎙", label: "Podcast studio", board: "pin", sit: true,
  back(pen, ox) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#e4def0", 3);
    pen.on(1);
    pen.shape(roundRect(ox + 110, 110, 170, 62, 12), { fill: "#e8613c", alpha: 0.75, width: 2.8 });
    pen.text("ON AIR", ox + 195, 154, { size: 30, align: "center", color: "#fff4dc", family: SANS, weight: 800 });
    for (const [px, py] of [[ox + 100, 220], [ox + 190, 220], [ox + 100, 310], [ox + 190, 310], [ox + 1120, 130], [ox + 1210, 130], [ox + 1120, 220], [ox + 1210, 220]]) {
      pen.shape(roundRect(px, py, 80, 80, 10), { fill: "#9c8fc4", alpha: 0.35, width: 2 });
      pen.stroke([[px + 16, py + 40], [px + 40, py + 30], [px + 64, py + 40]], { width: 1.4, alpha: 0.5 });
    }
    shelf(pen, ox + 1120, 380, 170);
    plant(pen, ox + 1345, 900, { height: 200 });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox, t) {
    table(pen, ox, "#c9b89f");
    pen.on(22);
    microphones(pen, ox);
    mug(pen, ox + 640, 676, t.frame, { color: tones.blue });
  },
};

const classroom = {
  icon: "🏫", label: "Classroom", board: "chalk", sit: true,
  back(pen, ox) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#e3ecd9", 11);
    pen.on(1);
    windowView(pen, ox + 70, 160, 240, 200, "#d8ecf5", { skyline: false, sun: [ox + 250, 210, tones.sun] });
    clock(pen, ox + 1210, 170, 46, 600);
    // Paper bunting across the top of the room.
    const colors = [tones.red, tones.sun, tones.mint, tones.blue];
    pen.stroke([[ox + 60, 70], [ox + 700, 92], [ox + 1340, 70]], { width: 1.6 });
    for (let k = 0; k < 18; k++) {
      const x = ox + 90 + k * 70;
      const y = 72 + Math.sin(((x - ox - 60) / 1280) * Math.PI) * 20;
      pen.shape([[x - 18, y], [x + 18, y], [x, y + 34]], { fill: colors[k % 4], alpha: 0.6, smooth: false, width: 1.8 });
    }
    shelf(pen, ox + 1090, 430, 190);
    // A globe on its stand.
    pen.shape(oval(ox + 1300, 330, 34, 34, 16), { fill: "#8fc3f0", alpha: 0.6, width: 2.4 });
    pen.stroke([[ox + 1270, 322], [ox + 1300, 312], [ox + 1330, 324]], { width: 1.4, color: "#4f9c72" });
    pen.ellipse(ox + 1300, 330, 14, 34, { width: 1.3, alpha: 0.6 });
    pen.stroke([[ox + 1300, 364], [ox + 1300, 384]], { width: 3 });
    pen.stroke([[ox + 1278, 386], [ox + 1322, 386]], { width: 3 });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox) {
    table(pen, ox, "#d9b48a");
    pen.on(22);
    // An apple, a stack of books and a cup of pencils on the teacher's desk.
    pen.shape(oval(ox + 1010, 698, 22, 22, 14), { fill: "#e8613c", alpha: 0.8, width: 2.4 });
    pen.stroke([[ox + 1010, 676], [ox + 1014, 664]], { width: 2.6 });
    pen.shape([[ox + 1016, 670], [ox + 1036, 660], [ox + 1026, 676]], { fill: tones.leaf, alpha: 0.8, width: 1.8 });
    for (const [k, color] of [[0, "#7fa6d9"], [1, "#ffd77a"], [2, "#e98f6b"]]) pen.shape([[ox + 380 - k * 4, FRONT - 16 - k * 16], [ox + 470 - k * 4, FRONT - 16 - k * 16], [ox + 470 - k * 4, FRONT - k * 16], [ox + 380 - k * 4, FRONT - k * 16]], { fill: color, alpha: 0.65, smooth: false, width: 2 });
    pen.shape([[ox + 520, FRONT - 40], [ox + 552, FRONT - 40], [ox + 548, FRONT], [ox + 524, FRONT]], { fill: tones.red, alpha: 0.6, smooth: false, width: 2.2 });
    for (const lean of [-6, 2, 10]) pen.stroke([[ox + 536 + lean / 2, FRONT - 40], [ox + 536 + lean, FRONT - 70]], { width: 3, color: "#f6c445" });
  },
};

const lecture = {
  icon: "🎓", label: "Lecture hall", board: "roll", sit: true,
  back(pen, ox) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#efe1d4", 13);
    pen.on(1);
    // Red curtains drawn back on both sides, under a scalloped valance.
    for (const side of [-1, 1]) {
      const edge = side < 0 ? ox + 40 : ox + 1360;
      const inner = side < 0 ? ox + 300 : ox + 1100;
      pen.shape([[edge, 100], [inner, 100], [inner + side * 34, 420], [inner - side * 10, FRONT], [edge, FRONT]], { fill: "#c9524a", alpha: 0.5, width: 2.6 });
      for (let k = 1; k < 4; k++) {
        const x = edge + (inner - edge) * (k / 4);
        pen.stroke([[x, 110], [x + side * 10, 400], [x - side * 6, FRONT - 10]], { width: 1.6, alpha: 0.55, color: "#8a2f29" });
      }
    }
    const scallops = Array.from({ length: 10 }, (_, k) => [ox + 40 + k * 132, 110]);
    pen.shape([[ox + 40, 50], [ox + 1360, 50], [ox + 1360, 110], ...scallops.flatMap(([x, y]) => [[x + 132, y], [x + 66, y + 26]]).reverse(), [ox + 40, 110]], { fill: "#b8443d", alpha: 0.6, smooth: false, width: 2.8 });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox) {
    table(pen, ox, "#a9805c", 0.6);
    pen.on(22);
    // A reading lamp and a glass of water on the lectern.
    pen.shape([[ox + 880, FRONT], [ox + 920, FRONT], [ox + 916, FRONT - 8], [ox + 884, FRONT - 8]], { fill: tones.device, alpha: 0.7, smooth: false, width: 2.2 });
    pen.stroke([[ox + 900, FRONT - 8], [ox + 904, FRONT - 64], [ox + 930, FRONT - 84]], { width: 3 });
    pen.shape([[ox + 918, FRONT - 98], [ox + 960, FRONT - 92], [ox + 952, FRONT - 66], [ox + 910, FRONT - 74]], { fill: "#2f6f60", alpha: 0.7, smooth: false, width: 2.4 });
    pen.wash(oval(ox + 936, FRONT - 40, 60, 30, 14), tones.sun, { alpha: 0.2 });
    pen.shape([[ox + 470, FRONT - 52], [ox + 500, FRONT - 52], [ox + 496, FRONT], [ox + 474, FRONT]], { fill: "#cfe5f6", alpha: 0.6, smooth: false, width: 2 });
  },
};

const coffeehouse = {
  icon: "☕", label: "Coffee house", board: "stand", sit: true,
  back(pen, ox) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, tones.warm, 5);
    pen.on(1);
    windowView(pen, ox + 90, 150, 260, 220, "#d8ecf5", { skyline: true, sun: [ox + 300, 200, tones.sun] });
    stringLights(pen, [ox + 60, 70], [ox + 1340, 70], 12);
    pendantLamp(pen, ox + 1080, 40, 110);
    menuBoard(pen, ox + 1110, 240, 160, 150);
    framedPrint(pen, ox + 130, 420, 110, 86);
    plant(pen, ox + 1350, 900, { height: 170 });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox, t) {
    table(pen, ox, tones.wood);
    pen.on(22);
    mug(pen, ox + 440, 676, t.frame, { color: tones.red });
    mug(pen, ox + 900, 676, t.frame, { color: tones.mint });
    pen.shape(oval(ox + 700, FRONT - 6, 70, 10, 16), { fill: "#ffffff", alpha: 0.6, width: 2.4 });
    pen.shape([[ox + 650, FRONT - 10], [ox + 680, FRONT - 42], [ox + 720, FRONT - 46], [ox + 754, FRONT - 14]], { fill: "#f2cf8f", alpha: 0.85, width: 2.4 });
  },
};

const street = {
  icon: "🌃", label: "Street walk", board: "poster", sit: false,
  back(pen, ox) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#e2e8ef", 17);
    pen.on(1);
    // Shop fronts on either side, the middle one behind the poster.
    const fronts = [[40, 140, 340, "#e9c9a8"], [370, 70, 660, "#e6d6c8"], [1020, 170, 340, "#cfd8e6"]];
    for (const [x, top, w, color] of fronts) {
      pen.shape([[ox + x, FRONT], [ox + x, top], [ox + x + w, top], [ox + x + w, FRONT]], { fill: color, alpha: 0.55, smooth: false, width: 2.6 });
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) pen.shape(roundRect(ox + x + 30 + col * (w - 60) / 3, top + 40 + row * 110, (w - 60) / 3 - 20, 70, 6), { fill: "#cfe5f6", alpha: 0.5, width: 1.8 });
    }
    // A striped awning over the left shop, and a lamp post on each side.
    pen.shape([[ox + 30, 400], [ox + 390, 400], [ox + 370, 460], [ox + 50, 460]], { fill: "#f6a39a", alpha: 0.6, smooth: false, width: 2.6 });
    for (let k = 1; k < 6; k++) pen.line([ox + 30 + k * 60, 400], [ox + 40 + k * 56, 460], { width: 1.6, over: 0 });
    for (const lx of [ox + 340, ox + 1060]) {
      pen.stroke([[lx, FRONT], [lx, 300], [lx + (lx < ox + 700 ? -20 : 20), 270]], { width: 4 });
      pen.shape(roundRect(lx + (lx < ox + 700 ? -44 : 4), 254, 40, 30, 8), { fill: tones.sun, alpha: 0.8, width: 2.4 });
      pen.wash(oval(lx + (lx < ox + 700 ? -24 : 24), 290, 60, 40, 14), tones.sun, { alpha: 0.2 });
    }
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox) {
    ledge(pen, ox, "#cbbfae", "#d9b39a");
    pen.on(22);
    // Flowers along the top of the planter.
    const blossoms = ["#e8613c", "#ffd77a", "#f6a39a", "#b39bff"];
    for (let k = 0; k < 22; k++) {
      const x = ox + 100 + k * 56;
      if (x > ox + 180 && x < ox + 330) continue;
      if (x > ox + 1070 && x < ox + 1230) continue;
      pen.stroke([[x, FRONT], [x + 3, FRONT - 26]], { width: 2, color: tones.leafDark });
      pen.shape(oval(x + 3, FRONT - 30, 8, 7, 10), { fill: blossoms[k % 4], alpha: 0.85, width: 1.6 });
    }
  },
};

const train = {
  icon: "🚆", label: "Train ride", board: "screen", bezel: "#3d4348", sit: true, chair: "#6f8fc4",
  back(pen, ox, t) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#dbe4ee", 19);
    pen.on(1);
    // The window band, with hills and poles going past outside.
    pen.shape(roundRect(ox + 50, 170, 1300, 300, 30), { fill: "#cfe5f6", alpha: 0.6, width: 3 });
    pen.wash([[ox + 60, 470], [ox + 60, 410], [ox + 300, 380], [ox + 560, 420], [ox + 860, 370], [ox + 1150, 410], [ox + 1340, 390], [ox + 1340, 470]], "#a9c9a0", { alpha: 0.5 });
    for (let k = 0; k < 6; k++) {
      const x = ox + 70 + ((k * 260 - t.frame * 9) % 1300 + 1300) % 1300;
      pen.line([x, 300], [x, 466], { width: 2.4, over: 0 });
      pen.line([x - 16, 312], [x + 16, 312], { width: 2, over: 0 });
    }
    for (const mx of [ox + 370, ox + 1030]) pen.line([mx, 172], [mx, 468], { width: 4, over: 0 });
    // The rail along the ceiling, with straps hanging from it.
    pen.line([ox + 60, 120], [ox + 1340, 120], { width: 3.4 });
    for (let k = 0; k < 9; k++) {
      const x = ox + 100 + k * 150;
      pen.stroke([[x, 120], [x, 146]], { width: 2.2 });
      pen.ellipse(x, 156, 10, 12, { width: 2.2 });
    }
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox) {
    // The backs of the seats in the row in front of them.
    shadow(pen, ox + 700, 906, 640, 16);
    pen.shape(roundRect(ox + 70, FRONT - 14, 1260, 190, 30), { fill: "#6f8fc4", alpha: 0.6, width: 3 });
    for (const x of [ox + 490, ox + 910]) pen.line([x, FRONT - 6], [x, 868], { width: 2, alpha: 0.6 });
    pen.stroke([[ox + 100, FRONT + 20], [ox + 1300, FRONT + 18]], { width: 1.6, alpha: 0.5 });
  },
};

const server = {
  icon: "🖥", label: "Server room", board: "screen", bezel: "#2f3a42", sit: true,
  back(pen, ox, t) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#dbe3ea", 23);
    pen.on(1);
    // Racks along the back wall, their lights blinking.
    for (const rx of [60, 200, 1070, 1210]) {
      const x = ox + rx;
      pen.shape(roundRect(x, 140, 130, 580, 10), { fill: "#5d6872", alpha: 0.55, width: 2.8 });
      for (let unit = 0; unit < 11; unit++) {
        const y = 170 + unit * 50;
        pen.line([x + 14, y + 30], [x + 116, y + 30], { width: 1.3, alpha: 0.6, over: 0 });
        for (let k = 0; k < 3; k++) {
          const lit = (Math.floor(t.frame / 7) + unit * 3 + k * 5 + rx) % 7 !== 0;
          pen.dot(x + 22 + k * 14, y + 14, 3.4, { color: lit ? (k === 2 ? tones.sun : tones.mint) : "#2b3a36" });
        }
      }
    }
    // A cable tray along the ceiling.
    pen.line([ox + 40, 100], [ox + 1360, 100], { width: 3 });
    for (let k = 0; k < 26; k++) pen.line([ox + 60 + k * 50, 100], [ox + 70 + k * 50, 114], { width: 1.4, alpha: 0.6, over: 0 });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox, t) {
    table(pen, ox, "#b7bec6", 0.55);
    pen.on(22);
    pen.shape([[ox + 600, FRONT - 4], [ox + 800, FRONT - 4], [ox + 812, FRONT + 6], [ox + 588, FRONT + 6]], { fill: "#5d6872", alpha: 0.6, smooth: false, width: 2.2 });
    mug(pen, ox + 980, 676, t.frame, { color: tones.mint });
  },
};

// Green code falling down the walls, written straight onto the canvas: it changes every frame.
const GLYPHS = "01{}<>/=;アイウエオカキクケコサシスセソ";
const matrix = {
  icon: "💻", label: "The matrix", board: "screen", bezel: "#1f7a3a", sit: false,
  back(pen, ox, t) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#d9ecdc", 29);
    pen.on(1);
    const lit = pen.colored();
    pen.paint(() => {
      const { ctx } = pen;
      ctx.font = '600 24px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = "center";
      for (let column = 0; column < 30; column++) {
        const x = ox + 60 + column * 44;
        const speed = 3 + (column * 7) % 5;
        const head = (t.frame * speed + column * 131) % 900;
        for (let k = 0; k < 12; k++) {
          const y = 60 + ((head - k * 32 + 900) % 900);
          if (y > FRONT) continue;
          ctx.globalAlpha = lit * Math.max(0, 0.42 - k * 0.035);
          ctx.fillStyle = k === 0 ? "#0f8a6c" : "#1f7a3a";
          ctx.fillText(GLYPHS[(column * 13 + k * 7 + Math.floor(t.frame / 6)) % GLYPHS.length], x, y);
        }
      }
    });
    floor(pen, ox + 20, ox + 1380, 904);
  },
  front(pen, ox) {
    ledge(pen, ox, "#5f9a76", "#2f5d44");
    pen.on(22);
    pen.line([ox + 70, FRONT + 2], [ox + 1330, FRONT + 2], { width: 3, color: "#37cfab", over: 0 });
  },
};

const rooftop = {
  icon: "🌅", label: "Rooftop at dawn", board: "stand", sit: false,
  back(pen, ox, t) {
    backdrop(pen, ox, ROOM.top, ROOM.w, ROOM.h, "#f3d6dc", 7);
    // Dawn: the sun comes up behind the towers as the chapter goes on.
    const sunY = 560 - 220 * t.sunP;
    pen.on(0.5);
    pen.wash(oval(ox + 1120, sunY, 190, 150, 20), tones.sun, { alpha: 0.5 });
    pen.shape(oval(ox + 1120, sunY, 70, 70, 16), { fill: "#ffc36b", alpha: 0.85, width: 2.6 });
    pen.on(1);
    towers(pen, ox, [[60, 330, 120], [200, 250, 100], [1000, 300, 110], [1130, 420, 90], [1240, 280, 120]], "#a7a0c4");
    // A water tower on the left.
    pen.shape([[ox + 70, 160], [ox + 160, 160], [ox + 156, 250], [ox + 74, 250]], { fill: tones.woodDark, alpha: 0.55, smooth: false, width: 2.6 });
    pen.stroke([[ox + 62, 164], [ox + 115, 124], [ox + 168, 164]], { width: 2.8, smooth: false });
    stringLights(pen, [ox + 40, 70], [ox + 1360, 70], 14);
  },
  front(pen, ox, t) {
    ledge(pen, ox, "#cbbfae", "#d9b39a");
    pen.on(22);
    mug(pen, ox + 380, 676, t.frame, { color: tones.blue });
    mug(pen, ox + 980, 676, t.frame, { color: tones.red });
  },
};

export const ROOMS = { podcast, classroom, lecture, coffeehouse, street, train, server, matrix, rooftop };

/** The board between the hosts, framed the way the room would frame it: pinned up, on an easel, in a screen. */
export function drawBoard(pen, rect, room) {
  const { x, y, w, h } = rect;
  shadow(pen, x + w / 2 + 10, y + h + 14, w * 0.46, 8, 0.22);
  if (room.board === "chalk") pen.shape(roundRect(x - 16, y - 16, w + 32, h + 32, 16), { fill: tones.woodDark, alpha: 0.7, width: 3 });
  if (room.board === "screen") pen.shape(roundRect(x - 18, y - 18, w + 36, h + 36, 22), { fill: room.bezel, alpha: 0.85, width: 3 });
  if (room.board === "roll") {
    pen.shape(roundRect(x - 26, y - 30, w + 52, 24, 10), { fill: tones.device, alpha: 0.75, width: 2.6 });
    pen.stroke([[x + w + 10, y - 6], [x + w + 14, y + 120], [x + w + 8, y + 150]], { width: 1.6 });
  }
  pen.shape(roundRect(x, y, w, h, 14), { fill: "#fffaf0", alpha: 0.92, width: 3.4 });
  pen.wash(roundRect(x + 6, y + 6, w - 12, 64, 10), tones.cream, { alpha: 0.6 });
  if (room.board === "pin") pen.shape(oval(x + w / 2, y - 4, 9, 9, 10), { fill: tones.red, alpha: 0.9, width: 2 });
  if (room.board === "stand") for (const lx of [x + 70, x + w - 70]) pen.line([lx, y + h], [lx + (lx < x + w / 2 ? -34 : 34), FRONT], { width: 3.4 });
  if (room.board === "chalk") {
    pen.shape([[x - 10, y + h + 4], [x + w + 10, y + h + 4], [x + w + 4, y + h + 18], [x - 4, y + h + 18]], { fill: tones.woodDark, alpha: 0.8, smooth: false, width: 2.4 });
    pen.shape(roundRect(x + 60, y + h - 2, 46, 8, 4), { fill: "#ffffff", alpha: 0.9, width: 1.4 });
  }
  if (room.board === "poster") for (const [tx, ty, turn] of [[x + 20, y - 6, -0.4], [x + w - 20, y - 6, 0.4]]) {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const at = (u, v) => [tx + u * c - v * s, ty + u * s + v * c];
    pen.shape([at(-34, -10), at(34, -10), at(34, 10), at(-34, 10)], { fill: "#ffffff", alpha: 0.55, smooth: false, width: 1.2 });
  }
  if (room.board === "screen") pen.dot(x + w / 2, y + h + 9, 3.6, { color: tones.mint });
}
