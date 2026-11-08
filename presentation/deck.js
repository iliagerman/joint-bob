import dispatchScene from "./scene-dispatch.js";
import officeScene from "./scene-office.js";
import budgetScene from "./scene-budget.js";
import hiveScene from "./scene-hive.js";
// The deck. Each slide is one click: arriving on a slide starts it, and everything on it builds on
// its own timeline. The film waits for one more click. Keys: → / Space / click next, ← back,
// R restart the slide, N notes, F fullscreen, V feature clip, 1–8 jump.
const TALK_SECONDS = 7 * 60;
const stage = document.getElementById("stage");
const sky = document.getElementById("sky");
const slides = [...stage.querySelectorAll(".slide")];
const film = document.getElementById("film");
const filmPlay = document.getElementById("filmPlay");

const NOTES = [
  "Joint Bob runs coding agents (Claude Code, Pi with OpenAI, and Kiro) on machines the team owns. Today: how it keeps their cost under control. One click, and the film starts.",
  "The film starts by itself. When it ends, click for the next slide.",
  "Agents are fast, but cost piles up in four places, and each has a lever built in. Let it build by itself.",
  "Think of a taxi rank. Every message is a passenger: the dispatcher, a decision model, judges its difficulty from 1 to 10 and sends it in the cab sized for that level. Questions and git work ride the light cab, features the standard one, debugging and planning the deep one, on Claude, OpenAI or Kiro. When the dispatcher is unsure, the conversation stays in its cab. (Facts appear on their own.)",
  "Each team works from a pool assigned to it: Payments and Mobile share the Product pool, Platform has its own. When Claude runs out, the Product pool moves its teams to ChatGPT before any output, so nothing is paid twice, and the people barely notice. Be ready to say what ships today: pools hold Claude, ChatGPT and Pi provider profiles; Bedrock is reached through Kiro, whose sign-ins stay on their machine; a local model is shown as the idea, not a pool member.",
  "Every level has its own tank: the cluster's month, each team's month, each project's day, each conversation. A turn starts only if every tank has room. Checkout warns at 80%, locks at its $20, and the next turn is refused with the reason and the reset time; queued prompts wait. Be ready: Kiro spend is not priced yet, and costs are list-price estimates, not invoices.",
  "Every lesson the team pays for once floats into the project's hive. When the same problem shows up twice, Joint Bob suggests a rule with its evidence; a person accepts it, and every later agent knows it. Agents read only the subject they need, so the hive grows without growing every prompt. Retries on known problems fall.",
  "The four cost levers come first, then the rest of what Joint Bob does: machines, phone, teams, schedules, Guardian, Story, the agent browser, secrets. Ship faster. Stay in charge. Scan the code to open joint-bob.bobthebot.io.",
];

// When each build step appears, in ms after the slide starts.
const BUILD = { 2: [900, 5200], 3: [11000], 4: [9000], 5: [8000], 6: [4800, 9500] };

let current = 0;
let clockStart = 0;
let timers = [];

// ---- Fit the 1920×1080 stage to the window ----
function fit() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  sky.width = innerWidth * devicePixelRatio;
  sky.height = innerHeight * devicePixelRatio;
}
addEventListener("resize", fit);

// ---- Timers: everything a slide does goes through these, so leaving cancels it all ----
function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
let generation = 0;
/** Runs `fn` every animation frame until the slide is left, or until it returns false. */
function loop(fn) {
  const mine = generation;
  const tick = (now) => {
    if (mine !== generation || fn(now) === false) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopAll() { timers.forEach(clearTimeout); timers = []; generation += 1; }
const kit = { later, loop };

function resetBuilds(slide) {
  for (const el of slide.querySelectorAll("[data-step]")) el.classList.remove("shown");
  slide.classList.remove("solved");
}

function scheduleBuilds(index) {
  const slide = slides[index];
  (BUILD[index] || []).forEach((ms, i) => later(ms, () => {
    for (const el of slide.querySelectorAll(`[data-step="${i + 1}"]`)) el.classList.add("shown");
    if (index === 2 && i === 1) slide.classList.add("solved");
  }));
}

// ---- Start, leave and restart a slide ----
function start(index) {
  const slide = slides[index];
  resetBuilds(slide);
  slide.classList.add("active");
  if (slide.hasAttribute("data-film")) { prepareFilm(); return; }
  scheduleBuilds(index);
  const scene = SCENES[slide.dataset.scene];
  if (scene) later(1000, () => scene(slide, kit));
}

function leave(index) {
  stopAll();
  if (slides[index].hasAttribute("data-film")) film.pause();
  document.body.classList.remove("film-on");
}

function go(index, direction = 1) {
  if (index < 0 || index >= slides.length || index === current) return;
  if (!clockStart && index > 0) clockStart = Date.now();
  leave(current);
  const old = slides[current];
  old.classList.remove("active");
  old.classList.toggle("gone", direction > 0);
  current = index;
  slides[current].classList.remove("gone");
  history.replaceState(null, "", `#${current + 1}`);
  start(current);
  drawHud();
}

function restart() {
  clockStart = 0;
  if (current !== 0) { go(0, -1); clockStart = 0; return; }
  leave(0);
  slides[0].classList.remove("active");
  void slides[0].offsetWidth;
  setTimeout(() => start(0), 60);
}

function next() {
  go(current + 1, 1);
}
function back() { go(current - 1, -1); }

// ---- The film: one click to start, never automatic ----
function prepareFilm() {
  film.currentTime = 0;
  document.getElementById("filmProgress").style.width = "0";
  filmPlay.classList.add("hidden");
  document.body.classList.add("film-on");
  film.muted = false;
  // The click that brought us here allows sound; if the browser still refuses (the page was
  // opened straight on this slide), play without sound and offer one click to turn it on.
  film.play().catch(() => {
    film.muted = true;
    film.play();
    filmPlay.querySelector("span").textContent = "Click for sound";
    filmPlay.classList.remove("hidden");
  });
}
filmPlay.addEventListener("click", (event) => {
  event.stopPropagation();
  film.muted = false;
  filmPlay.classList.add("hidden");
});
film.addEventListener("timeupdate", () => {
  document.getElementById("filmProgress").style.width = `${(film.currentTime / film.duration) * 100}%`;
});

const SCENES = { router: dispatchScene, pools: officeScene, budget: budgetScene, learn: hiveScene };

// ---- Feature clip ----
const clip = document.getElementById("clip");
const clipVideo = document.getElementById("clipVideo");
function openClip(name) {
  clipVideo.src = `../promo-video/landing/media/${name}-1080.mp4`;
  clip.hidden = false;
  clipVideo.play();
}
function closeClip() { clipVideo.pause(); clip.hidden = true; }
document.querySelectorAll("[data-clip]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); openClip(button.dataset.clip); }));
document.getElementById("clipClose").addEventListener("click", closeClip);

// ---- Presenter aids ----
const dots = document.getElementById("dots");
slides.forEach((_, i) => {
  const dot = document.createElement("i");
  dot.addEventListener("click", () => go(i, i > current ? 1 : -1));
  dots.append(dot);
});
const notes = document.getElementById("notes");
function drawHud() {
  [...dots.children].forEach((dot, i) => dot.classList.toggle("on", i === current));
  notes.innerHTML = `<b>Slide ${current + 1} · about ${slides[current].dataset.time}s</b><br>${NOTES[current]}`;
  document.getElementById("btnBack").disabled = current === 0;
}
function format(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
setInterval(() => {
  const elapsed = clockStart ? (Date.now() - clockStart) / 1000 : 0;
  const clock = document.getElementById("clock");
  clock.textContent = `${format(elapsed)} / ${format(TALK_SECONDS)}`;
  clock.classList.toggle("late", elapsed > TALK_SECONDS);
  document.getElementById("timeline").style.width = `${Math.min(100, (elapsed / TALK_SECONDS) * 100)}%`;
}, 500);

document.getElementById("btnBack").addEventListener("click", back);
document.getElementById("btnNext").addEventListener("click", next);
document.getElementById("btnRestart").addEventListener("click", restart);

addEventListener("keydown", (event) => {
  if (!clip.hidden) { if (event.key === "Escape" || event.key === "v" || event.key === "V") closeClip(); return; }
  if (["ArrowRight", "PageDown", " ", "Enter"].includes(event.key)) { event.preventDefault(); next(); }
  else if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); back(); }
  else if (event.key === "n" || event.key === "N") notes.hidden = !notes.hidden;
  else if (event.key === "f" || event.key === "F") (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  else if ((event.key === "v" || event.key === "V") && slides[current].querySelector("[data-clip]")) openClip(slides[current].querySelector("[data-clip]").dataset.clip);
  else if (event.key === "r" || event.key === "R") restart();
  else if (/^[1-8]$/.test(event.key)) go(Number(event.key) - 1, Number(event.key) - 1 > current ? 1 : -1);
});
// A click on a slide moves on, like a clicker.
stage.addEventListener("click", (event) => { if (!event.target.closest("button, a")) next(); });

// ---- Background: slow aurora and drifting dust ----
const ctx = sky.getContext("2d");
fit();
const motes = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + 0.3, v: Math.random() * 0.00012 + 0.00003 }));
function drawSky(now) {
  const w = sky.width;
  const h = sky.height;
  ctx.clearRect(0, 0, w, h);
  const blobs = [
    [0.2 + 0.08 * Math.sin(now / 9000), 0.25 + 0.06 * Math.cos(now / 11000), "rgba(55,207,171,0.13)"],
    [0.82 + 0.06 * Math.cos(now / 10000), 0.7 + 0.08 * Math.sin(now / 8000), "rgba(179,155,255,0.12)"],
    [0.55 + 0.1 * Math.sin(now / 13000), 0.95, "rgba(60,180,116,0.08)"],
  ];
  for (const [x, y, color] of blobs) {
    const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, Math.max(w, h) * 0.55);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = "rgba(235,236,237,0.5)";
  for (const m of motes) {
    m.y -= m.v * 16;
    if (m.y < 0) m.y = 1;
    ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(now / 2000 + m.x * 20));
    ctx.beginPath();
    ctx.arc(m.x * w, m.y * h, m.r * devicePixelRatio, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(drawSky);
}
requestAnimationFrame(drawSky);

// ---- Start where the address says ----
current = Math.min(slides.length - 1, Math.max(0, Number(location.hash.slice(1)) - 1 || 0));
start(current);
drawHud();
