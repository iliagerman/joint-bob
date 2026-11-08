// Slide 4 · Subscription pools, in the films' drawn office. Three teams work at their desks, drawn
// by the app's own pen (public/app/sketch); above them, two pools of seats feed the teams they are
// assigned to. When the Product pool's Claude seat runs out, its teams move to ChatGPT before any
// output, and the people at those desks frown for a moment and carry on.
import { createPen, paperTile, pencilSvg, FPS, roundRect } from "../public/app/sketch/ink.js";
import { alexLook, jonahLook, mayaLook, person } from "../public/app/sketch/people.js";
import { backdrop, desk, floor, laptopBack, mug, plant, tones, windowView } from "../public/app/sketch/things.js";

const WORLD_W = 3600;
const Y0 = -71;
const PODS = [600, 1800, 3000];
// Six people from the films' three, dressed differently so the teams read as different people.
const LOOKS = [
  [alexLook, mayaLook],
  [jonahLook, { ...mayaLook, name: "maya", skin: "#f2c9a8", skinShade: "#d9a582", hair: "#7a3f22", hairShade: "#5a2c16", hairLight: "#a8643c", top: "#c7b2f2", topShade: "#a48bd8" }],
  [{ ...alexLook, top: "#f3a98f", topShade: "#d9846a", hair: "#2b211c", hairShade: "#1b1410", hairLight: "#4e3d33" }, { ...jonahLook, skin: "#b9805c", skinShade: "#98623f", hair: "#1f1712", hairShade: "#120d0a", hairLight: "#3d2f26", top: "#9fd6a8", topShade: "#74b884" }],
];
const BASE = { lean: 0.02, nod: 0.04, gaze: [0.15, 0.75], worry: 0, raise: 0, frown: 0, smile: 0.4, open: 0, typing: 1, headphones: 0 };

function seatOf(pod, j) {
  const dir = j === 0 ? 1 : -1;
  return { x: PODS[pod] + (j === 0 ? -210 : 210), dir };
}

function drawOffice(pen, frame, moods) {
  pen.begin("wall", 0, 20, 0);
  backdrop(pen, 40, 300, 3520, 760, tones.wall, 3, 0.5);
  pen.end();
  pen.begin("windows", 6, 28, 1);
  windowView(pen, 1110, 380, 250, 200, "#cfe5f6", { sun: [1180, 440, tones.sun] });
  windowView(pen, 2310, 380, 250, 200, "#d9e6f2");
  floor(pen, 80, 3520, 1004);
  pen.end();
  PODS.forEach((cx, pod) => {
    const at = 10 + pod * 16;
    pen.begin(`desk-${pod}`, at, at + 26, 20);
    desk(pen, cx - 460, cx + 460, 742, 1000, { drawers: pod % 2 ? "left" : "right" });
    pen.on(22);
    for (let j = 0; j < 2; j++) { const { x, dir } = seatOf(pod, j); laptopBack(pen, x + 5 * dir, 742, 1); }
    mug(pen, cx - 10, 694, frame, { full: true, color: [tones.red, tones.blue, tones.mint][pod] });
    plant(pen, cx + (pod % 2 ? -415 : 415), 742, { height: 120 });
    pen.end();
    for (let j = 0; j < 2; j++) {
      const { x, dir } = seatOf(pod, j);
      const mood = moods[pod];
      const pose = {
        ...BASE,
        worry: mood.worry, smile: 0.4 + mood.joy * 0.6 - mood.worry * 0.9, raise: mood.joy * 0.5,
        typing: 1 - mood.worry * 0.8, gaze: mood.worry > 0.3 || mood.joy > 0.3 ? [0.1 * dir, 0.3] : [0.15, 0.75],
        near: [x + (dir > 0 ? 40 : -35), 728], far: [x + (dir > 0 ? -30 : 35), 728], nearHand: "hidden", farHand: "hidden",
      };
      pen.begin(`person-${pod}-${j}`, at + 8 + j * 8, at + 40 + j * 8, 10);
      person(pen, { at: [x, 800], look: LOOKS[pod][j], dir, pose, frame, layer: 10, nearLayer: 13, farLayer: 13, gripLayer: 23 });
      pen.on(9);
      pen.shape(roundRect(x - 80, 596, 160, 156, 34), { fill: "#55606b", alpha: 0.55, width: 2.8 });
      pen.end();
    }
  });
}

export default function officeScene(slide, { later, loop }) {
  const office = slide.querySelector(".office");
  const canvas = office.querySelector("canvas");
  const pencil = office.querySelector(".office-pencil");
  const ctx = canvas.getContext("2d");
  const pattern = ctx.createPattern(paperTile(), "repeat");
  const k = canvas.width / WORLD_W;
  const cssScale = office.clientWidth / WORLD_W;
  const paper = () => pattern;
  const totals = new Map();
  const moods = PODS.map(() => ({ worry: 0, joy: 0, target: { worry: 0, joy: 0 } }));
  if (!pencil.firstChild) pencil.replaceChildren(document.importNode(new DOMParser().parseFromString(pencilSvg(), "image/svg+xml").documentElement, true));

  // One measuring pass, so each group knows how much ink it has to lay down.
  const measure = createPen(ctx, { frame: 0, zoom: k, view: null, paper, totals, measure: true });
  drawOffice(measure, 0, moods);
  measure.finish();

  const started = performance.now();
  let last = 0;
  loop((now) => {
    if (now - last < 1000 / 24) return;
    const steps = last ? (now - last) / (1000 / FPS) : 1;
    last = now;
    for (const mood of moods) {
      mood.worry += (mood.target.worry - mood.worry) * (1 - Math.exp(-steps / 5));
      mood.joy += (mood.target.joy - mood.joy) * (1 - Math.exp(-steps / 7));
    }
    const frame = ((now - started) * FPS) / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, -Y0 * k);
    const pen = createPen(ctx, { frame, zoom: k, view: null, paper, totals });
    drawOffice(pen, frame, moods);
    pen.finish();
    const tip = pen.tip();
    pencil.hidden = !tip || frame > 110;
    if (tip && frame <= 110) pencil.style.transform = `translate(${tip[0] * cssScale}px, ${(tip[1] - Y0) * cssScale}px) scale(0.42)`;
  });

  // The pools above the desks.
  const seats = [...office.querySelectorAll(".seat")];
  const teams = [...office.querySelectorAll(".team")];
  const pipes = (name) => [...office.querySelectorAll(`.pipe[data-from="${name}"]`)];
  const log = slide.querySelector(".office-log");
  const fill = (seat, value) => { seat.querySelector(".quota i").style.width = value; };
  const state = (seat, text) => { seat.querySelector(".seat-state").textContent = text; };
  const spend = (team, dollars) => {
    team.querySelector(".spend").textContent = `$${dollars.toFixed(2)} today`;
    team.querySelector(".team-meter i").style.width = `${Math.min(100, (dollars / 20) * 100)}%`;
  };
  office.classList.remove("shown");
  const run = () => {
    seats.forEach((seat) => seat.classList.remove("busy", "full"));
    office.querySelectorAll(".pipe").forEach((pipe) => pipe.classList.remove("live"));
    fill(seats[0], "58%"); fill(seats[1], "12%"); fill(seats[2], "30%"); fill(seats[3], "100%");
    state(seats[0], "ready"); state(seats[1], "ready"); state(seats[2], "ready"); state(seats[3], "no limit");
    spend(teams[0], 6.1); spend(teams[1], 3.4); spend(teams[2], 8.8);
    log.textContent = "";
    later(900, () => office.classList.add("shown"));
    later(2200, () => {
      seats[0].classList.add("busy"); seats[2].classList.add("busy");
      [...pipes("claude"), ...pipes("bedrock")].forEach((pipe) => pipe.classList.add("live"));
      state(seats[0], "working"); state(seats[2], "working");
      fill(seats[0], "100%"); fill(seats[2], "47%");
      log.textContent = "Each team draws from the pool assigned to it";
      spend(teams[0], 11.2); spend(teams[1], 6.9); spend(teams[2], 12.4);
    });
    later(4600, () => {
      seats[0].classList.remove("busy"); seats[0].classList.add("full");
      state(seats[0], "limit reached");
      pipes("claude").forEach((pipe) => pipe.classList.remove("live"));
      log.textContent = "Claude hit its limit before any output → the Product pool moves to ChatGPT";
      moods[0].target = { worry: 1, joy: 0 }; moods[1].target = { worry: 1, joy: 0 };
    });
    later(5600, () => {
      seats[1].classList.add("busy");
      pipes("chatgpt").forEach((pipe) => pipe.classList.add("live"));
      state(seats[1], "working"); fill(seats[1], "41%");
      moods[0].target = { worry: 0, joy: 1 }; moods[1].target = { worry: 0, joy: 1 };
      spend(teams[0], 14.6); spend(teams[1], 9.8); spend(teams[2], 15.1);
    });
    later(7600, () => {
      log.textContent = "Nothing replayed, nothing paid twice. Every seat in use.";
      moods[0].target = { worry: 0, joy: 0 }; moods[1].target = { worry: 0, joy: 0 };
    });
    later(14000, run);
  };
  run();
}
