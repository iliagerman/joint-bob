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
  "Click once to play. When it ends, click for the next slide.",
  "Agents are fast, but cost piles up in four places, and each has a lever built in. Let it build by itself.",
  "A decision model scores each message 1 to 10 and Joint Bob picks the model and thinking effort for that level, per agent: Claude Haiku, Sonnet or Opus; OpenAI models through Pi; Kiro with your own mapping. When the score is unsure it does not switch.",
  "A pool puts several subscriptions in failover order, across providers on Pi. When one hits its limit the turn moves on before any output, so nothing is paid twice. A relay holds the sign-ins, and members never receive a token. Note: Claude Code stays on Claude, and Kiro profiles are private and cannot join a pool.",
  "Budgets nest: cluster, workspace, project, conversation. A turn starts only if every level has room. 80% gives a warning; at the limit the turn is refused with the reset time, and a runaway turn is stopped within about a minute. Be ready: Kiro spend is not priced yet, and costs are list-price estimates, not invoices.",
  "Agents repeat mistakes, and every retry costs tokens. Joint Bob spots a repeated problem and suggests a rule with its evidence. A person accepts it, and every later agent knows it. Agents open only the subject they need.",
  "Four levers: the right model, every seat used, hard limits, agents that learn. Ship faster. Stay in charge. Scan the code to open joint-bob.bobthebot.io.",
];

// When each build step appears, in ms after the slide starts.
const BUILD = { 2: [900, 5200], 3: [11000], 4: [7500, 11500], 5: [9000], 6: [4500, 9500] };

let current = 0;
let clockStart = 0;
let timers = [];
let frame = 0;
let filmStarted = false;

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
function stopAll() { timers.forEach(clearTimeout); timers = []; cancelAnimationFrame(frame); }

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
  if (scene) later(1000, scene);
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
  leave(current);
  const slide = slides[current];
  slide.classList.remove("active");
  void slide.offsetWidth;
  setTimeout(() => start(current), 60);
}

function next() {
  if (slides[current].hasAttribute("data-film") && !filmStarted) { playFilm(); return; }
  go(current + 1, 1);
}
function back() { go(current - 1, -1); }

// ---- The film: one click to start, never automatic ----
function prepareFilm() {
  filmStarted = false;
  film.pause();
  film.currentTime = 0;
  filmPlay.classList.remove("hidden");
  slides[current].classList.add("idle");
  document.getElementById("filmProgress").style.width = "0";
}
function playFilm() {
  filmStarted = true;
  filmPlay.classList.add("hidden");
  slides[current].classList.remove("idle");
  document.body.classList.add("film-on");
  film.muted = false;
  film.play();
}
filmPlay.addEventListener("click", (event) => { event.stopPropagation(); playFilm(); });
film.addEventListener("timeupdate", () => {
  document.getElementById("filmProgress").style.width = `${(film.currentTime / film.duration) * 100}%`;
});

// ---- 3 · Router: a mix of Claude, OpenAI and Kiro ----
const AGENTS = { c: "Claude Code", o: "Pi · OpenAI", k: "Kiro" };
const ROUTES = [
  { text: "Commit the fix and push it to main", level: 2, conf: 0.93, lane: "light", agent: "c", task: "Terminal and git work" },
  { text: "Add CSV export to the reports page, with tests", level: 6, conf: 0.86, lane: "standard", agent: "o", task: "Complex coding across several files, verified by tests" },
  { text: "What does the retryBudget flag do?", level: 1, conf: 0.95, lane: "light", agent: "o", task: "A question answered by reading, no code change" },
  { text: "Checkout fails only in Safari. Find out why and fix it", level: 8, conf: 0.81, lane: "deep", agent: "c", task: "Debugging: reproduce, trace the root cause, fix" },
  { text: "hmm, maybe the other way?", level: 5, conf: 0.22, lane: null, agent: "k", task: "Unsure (22%, under the 30% threshold): stays on the current model" },
  { text: "Rename userId to accountId in this file", level: 4, conf: 0.9, lane: "light", agent: "k", task: "Simple coding: a small, well-scoped change" },
  { text: "Plan the move to multi-region failover", level: 10, conf: 0.88, lane: "deep", agent: "o", task: "Planning: architecture and high-risk design" },
];

function routerScene() {
  const slide = slides[current];
  const counts = { light: 0, standard: 0, deep: 0 };
  const card = document.getElementById("promptCard");
  const text = document.getElementById("promptText");
  const task = document.getElementById("taskText");
  const who = card.querySelector(".who");
  let n = 0;
  const one = () => {
    const route = ROUTES[n % ROUTES.length];
    n += 1;
    card.classList.remove("out");
    text.textContent = "";
    who.textContent = `Developer · ${AGENTS[route.agent]}`;
    task.style.opacity = 0;
    slide.querySelectorAll(".lane").forEach((lane) => lane.classList.remove("hit"));
    slide.querySelectorAll(".prov i").forEach((chip) => chip.classList.remove("on"));
    [...route.text].forEach((ch, i) => later(i * 28, () => { text.textContent += ch; }));
    const typed = route.text.length * 28 + 250;
    later(typed, () => {
      document.getElementById("needle").style.transform = `rotate(${-90 + route.level * 18}deg)`;
      document.getElementById("dialArc").setAttribute("stroke-dasharray", `${route.level * 10} 100`);
      document.getElementById("levelNum").textContent = route.level;
      document.getElementById("confText").textContent = `confidence ${Math.round(route.conf * 100)}%`;
      task.textContent = route.task;
      task.style.opacity = 1;
    });
    later(typed + 900, () => {
      if (route.lane) {
        const lane = slide.querySelector(`[data-lane="${route.lane}"]`);
        lane.classList.add("hit");
        lane.querySelector(`.prov .${route.agent}`).classList.add("on");
        counts[route.lane] += 1;
        lane.querySelector(".count").textContent = counts[route.lane];
      }
      card.classList.add("out");
    });
    later(typed + 2600, one);
  };
  one();
}

// ---- 4 · Pools: Claude first, then OpenAI ----
function poolsScene() {
  const slide = slides[current];
  const accounts = [...slide.querySelectorAll(".account")];
  const hops = [...slide.querySelectorAll(".hop")];
  const token = document.getElementById("turnToken");
  const log = document.getElementById("poolLog");
  const state = (acc, text) => { acc.querySelector(".acc-state").textContent = text; };
  const fill = (acc, width) => { acc.querySelector(".quota i").style.width = width; };
  const place = (i) => {
    const acc = accounts[i];
    token.style.left = `${acc.offsetLeft + acc.offsetWidth / 2 - token.offsetWidth / 2}px`;
  };
  const run = () => {
    accounts.forEach((acc) => { acc.className = "account"; fill(acc, "0"); state(acc, "ready"); });
    hops.forEach((hop) => hop.classList.remove("lit"));
    fill(accounts[0], "62%"); fill(accounts[1], "18%"); fill(accounts[2], "5%");
    log.textContent = "A new turn starts on the Claude account";
    place(0);
    token.style.opacity = 1;
    later(500, () => { accounts[0].classList.add("busy"); state(accounts[0], "working"); fill(accounts[0], "100%"); });
    later(2300, () => {
      accounts[0].className = "account full";
      state(accounts[0], "limit reached");
      log.textContent = "Limit hit before any output → next provider, with its own mapped model";
      hops[0].classList.add("lit");
    });
    later(3300, () => { place(1); accounts[1].classList.add("busy"); state(accounts[1], "working"); fill(accounts[1], "46%"); });
    later(5000, () => { log.textContent = "The turn finishes on ChatGPT. Nothing replayed, nothing paid twice."; state(accounts[1], "done"); });
    later(8500, () => { token.style.opacity = 0; });
    later(9300, run);
  };
  run();
}

// ---- 5 · Budget ----
function budgetScene() {
  const arc = document.getElementById("ringArc");
  const num = document.getElementById("spendNum");
  const warn = document.getElementById("warn80");
  const refusal = document.getElementById("refusal");
  const run = () => {
    warn.classList.remove("on");
    refusal.classList.remove("on");
    const started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / 6500);
      const spend = 20 * (1 - Math.pow(1 - t, 1.6));
      num.textContent = `$${spend.toFixed(2)}`;
      arc.setAttribute("stroke-dasharray", `${spend * 5} 100`);
      arc.setAttribute("stroke", spend >= 20 ? "#e0564e" : spend >= 16 ? "#d0a63c" : "#37cfab");
      if (spend >= 16) warn.classList.add("on");
      if (t < 1) { frame = requestAnimationFrame(tick); return; }
      warn.classList.remove("on");
      refusal.classList.add("on");
      later(6000, run);
    };
    frame = requestAnimationFrame(tick);
  };
  run();
}

// ---- 6 · Learn ----
function learnScene() {
  const slide = slides[current];
  const dot = document.getElementById("loopDot");
  const stops = [...slide.querySelectorAll(".stop")];
  const angles = [-90, -18, 54, 126, 198];
  const waste = document.getElementById("waste");
  const note = document.getElementById("wasteNote");
  const weeks = [[12, "turns this week"], [7, "next week"], [3, "the week after"], [1, "a month in"]];
  let lap = -1;
  const started = performance.now();
  const tick = (now) => {
    const turn = (now - started) / 4200;
    const deg = -90 + (turn % 1) * 360;
    const rad = (deg * Math.PI) / 180;
    dot.setAttribute("cx", 260 + 200 * Math.cos(rad));
    dot.setAttribute("cy", 260 + 200 * Math.sin(rad));
    stops.forEach((stop, i) => stop.classList.toggle("lit", Math.abs(((deg - angles[i] + 540) % 360) - 180) > 150));
    const nowLap = Math.min(Math.floor(turn), weeks.length - 1);
    if (nowLap !== lap) {
      lap = nowLap;
      const [value, label] = weeks[lap];
      waste.textContent = value;
      note.textContent = label;
      waste.style.color = value <= 3 ? "#37cfab" : "";
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

const SCENES = { router: routerScene, pools: poolsScene, budget: budgetScene, learn: learnScene };

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
