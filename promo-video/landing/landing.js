// The page is one scroll, told as a journey into the app. Nothing here takes the scroll away
// from the reader: the window scrolls as it always does, and every movement on the page is a
// function of a smoothed copy of where it has got to, so things glide after the hand and settle.

// The seven use cases, in the order the line passes them. Each has what was asked, the film
// that answers, the machine it ran on, and three things that happened.
const cases = [
  { id: "lid", title: "Long-running tasks", time: "0:21", runsOn: "Home server", ask: "Migrate all 212 test files. I have to leave in five minutes.",
    steps: [["Runs on", "moved to your server"], ["Laptop", "closed"], ["Phone", "watched it finish, merged the PR"]] },
  { id: "team", title: "Teams", time: "0:24", runsOn: "Maya's MacBook", ask: "Maya should be in this conversation too.",
    steps: [["Invite", "one link, one use"], ["Shared", "one project, nothing else"], ["Maya", "wrote in, then forked it"]] },
  { id: "schedule", title: "Scheduled tasks", time: "0:22", runsOn: "Home server", ask: "Review our support calls every hour. Fix what keeps going wrong.",
    steps: [["Every hour", "42 calls reviewed"], ["Found", "a hold message that loops"], ["Opened", "PR #88"]] },
  { id: "alerts", title: "Alerts to pull requests", time: "0:18", runsOn: "Home server", ask: "When production breaks at night, don't wake me. Fix it.",
    steps: [["3 AM", "the alert calls a webhook"], ["Agent", "finds the bug, fixes it"], ["Morning", "PR #213 in your inbox"]] },
  { id: "browser", title: "Agent browser", time: "0:18", runsOn: "MacBook Pro", ask: "The promo code breaks checkout on staging. Reproduce it in the browser.",
    steps: [["Browser", "inside the conversation"], ["Agent", "clicks like a customer"], ["You", "take control any time"]] },
  { id: "secrets", title: "Secrets", time: "0:18", runsOn: "MacBook Pro", ask: "Open the pull request with the team's GitHub account.",
    steps: [["Added", "once"], ["Team", "can use it, read-only"], ["Chat", "never sees the token"]] },
  { id: "analytics", title: "Costs and analytics", time: "0:15", runsOn: "MacBook Pro", ask: "Why did we spend more this month?",
    steps: [["Costs", "by project, model and skill"], ["Changed", "in one sentence"], ["Skill", "the one that keeps failing"]] },
];

// A stop: the film on one side of the line, the words on the other, swapping sides each time.
document.querySelector("#stops").innerHTML = cases.map((item, index) => {
  const [film, words] = index % 2 ? ["left", "right"] : ["right", "left"];
  return `<article class="stop" id="${item.id}">
    <div class="film-card" data-flow="${film}" data-film="${item.id}">
      <div class="film-bar"><strong>${item.title}</strong><span>● Runs on ${item.runsOn}</span>
        <button class="ghost icon-button" type="button" data-watch="${item.id}" aria-label="Watch ${item.title} full size, with sound" title="Watch full size, with sound"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg></button>
      </div>
      <div class="screen"><video data-src="media/${item.id}.mp4" poster="media/${item.id}.jpg" muted loop playsinline aria-label="${item.title}, a ${item.time} film. Click to watch it full size with sound"></video><span class="hear"><i></i><i></i><i></i></span></div>
    </div>
    <div class="words">
      <p class="eyebrow" data-flow="${words}">Use case ${index + 1} of ${cases.length} · ${item.time}</p>
      <h3 data-split data-delay="0.08">${item.title}</h3>
      <p class="message user" data-flow="${words}" data-delay="0.16">${item.ask}</p>
      <div class="steps">${item.steps.map(([name, what], step) => `<span class="tool-output" data-flow="bottom" data-delay="${(0.12 + step * 0.06).toFixed(2)}"><i></i><b>${name}</b>${what}</span>`).join("")}</div>
    </div>
  </article>`;
}).join("");

// The same seven as small pictures near the top, for whoever would rather pick one than scroll to it.
document.querySelector("#tiles").innerHTML = cases.map((item, index) => `<button class="tile" type="button" data-watch="${item.id}" style="--i:${index}" aria-label="Watch ${item.title} with sound">
  <span class="thumb"><img src="media/${item.id}.jpg" alt="" loading="lazy"><i></i></span><strong>${item.title}</strong><span>${item.time}</span></button>`).join("");

// On a narrow screen those pictures are a carousel. The dots under it say which one is in the
// middle, and take you to another.
const tiles = document.querySelector("#tiles");
const dots = document.querySelector("#dots");
dots.innerHTML = cases.map((item) => `<button type="button" aria-label="Show ${item.title}"></button>`).join("");
function markDot() {
  const middle = tiles.getBoundingClientRect().left + tiles.clientWidth / 2;
  const away = [...tiles.children].map((tile) => { const box = tile.getBoundingClientRect(); return Math.abs(box.left + box.width / 2 - middle); });
  [...dots.children].forEach((dot, index) => dot.classList.toggle("on", away[index] === Math.min(...away)));
}
tiles.addEventListener("scroll", () => requestAnimationFrame(markDot), { passive: true });
dots.addEventListener("click", (event) => {
  const tile = tiles.children[[...dots.children].indexOf(event.target.closest("button"))];
  if (tile) tiles.scrollTo({ left: tile.offsetLeft - tiles.offsetLeft - (tiles.clientWidth - tile.offsetWidth) / 2, behavior: "smooth" });
});
markDot();

// A heading marked to be split arrives a word at a time, each rising out of its own line.
for (const heading of document.querySelectorAll("[data-split]")) {
  const delay = Number(heading.dataset.delay ?? 0);
  heading.innerHTML = heading.textContent.trim().split(/\s+/).map((word, index) => `<span class="word"><span data-flow="word" data-delay="${(delay + index * 0.035).toFixed(3)}">${word}</span></span>`).join(" ");
}

const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (value) => Math.min(1, Math.max(0, value));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** How far down the page an element starts, whatever it is being moved by. */
const pageTop = (element) => { let top = 0; for (let node = element; node; node = node.offsetParent) top += node.offsetTop; return top; };

const flows = [...document.querySelectorAll("[data-flow]")].map((element) => ({ element, from: element.dataset.flow, delay: Number(element.dataset.delay ?? 0), card: element.classList.contains("film-card"), top: 0, height: 0 }));
const stops = [...document.querySelectorAll(".stop")].map((element, index) => ({ element, title: cases[index].title, id: cases[index].id, middle: 0 }));
const page = document.querySelector("main");
const pill = document.querySelector("#watchPill");
const progress = document.querySelector("#progress");
const sky = document.querySelector("#sky");
const pen = sky.getContext("2d");
// Motes of light behind the page, as in the films. Their places come from a fixed sequence.
let seed = 7;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const motes = Array.from({ length: 120 }, () => ({ x: random(), y: random(), depth: 0.15 + random() * 0.85 }));
const copy = document.querySelector("#enterCopy");
const film = document.querySelector("#enterFilm");
const frame = film.querySelector(".frame");
const heroFilm = film.querySelector("video");
const hint = document.querySelector("#hint");
const line = document.querySelector("#line");
const machines = document.querySelector("#machines");
const topbar = document.querySelector("#topbar");
let view = { width: 0, height: 0 };
let filmBox = { centre: 0, width: 0, height: 0 };
let journey = { top: 0, height: 1 };
let machinesTop = 0;
let furthest = 0;

function measure() {
  view = { width: innerWidth, height: innerHeight };
  for (const flow of flows) { flow.top = pageTop(flow.element); flow.height = flow.element.offsetHeight; }
  const ratio = Math.min(2, devicePixelRatio);
  Object.assign(sky, { width: innerWidth * ratio, height: innerHeight * ratio });
  pen.setTransform(ratio, 0, 0, ratio, 0, 0);
  for (const stop of stops) stop.middle = pageTop(stop.element) + stop.element.offsetHeight / 2;
  // Where the hero film rests inside its pinned screen, before anything moves it.
  filmBox = { centre: film.offsetTop + film.offsetHeight / 2, width: film.offsetWidth, height: frame.offsetHeight };
  journey = { top: pageTop(line), height: line.offsetHeight };
  machinesTop = pageTop(machines);
  furthest = document.documentElement.scrollHeight - innerHeight;
}

let sound = false;
let smooth = scrollY;
let drawn = -1;
function draw() {
  // The smoothed scroll: a twelfth of the remaining distance each frame.
  smooth += (scrollY - smooth) * (still.matches ? 1 : 0.085);
  if (Math.abs(scrollY - smooth) < 0.1) smooth = scrollY;
  if (smooth !== drawn) {
    drawn = smooth;
    const { width, height } = view;
    // On a narrow screen a film or a line of words coming in from the side travels a short way,
    // so that it is never cut by the edge of the screen while it arrives.
    const reach = width < 820 ? 0.17 : 1;

    // The way in: words lift away, the film comes up to the middle and grows past the window's edges.
    const into = clamp(smooth / (height * 1.35));
    const grow = inOut(clamp((into - 0.08) / 0.8));
    // On an upright screen a wide film cannot fill the window without losing its sides, so it only steps forward.
    const cover = Math.min(width > height ? 4 : 1.3, Math.max(width / filmBox.width, height / filmBox.height) * 1.04);
    copy.style.transform = `translate3d(0, ${-into * 260}px, 0) scale(${1 - into * 0.12})`;
    copy.style.opacity = String(clamp(1 - into * 2.6));
    film.style.transform = `translate3d(0, ${(height / 2 - filmBox.centre) * grow}px, 0) scale(${1 + (cover - 1) * grow})`;
    frame.style.borderRadius = `${16 * (1 - grow)}px`;
    // It darkens as it comes, like a screen you are passing through.
    frame.style.filter = `brightness(${1 - grow * 0.6})`;
    hint.style.opacity = String(clamp(1 - into * 6));
    // Once it has filled the window it thins out, and the inside of the page shows through.
    film.parentElement.style.opacity = String(clamp((1.72 - smooth / height) / 0.34));
    topbar.classList.toggle("sunk", smooth > height * 1.5);

    // How far the smoothed scroll trails the real one: the speed of the hand, more or less.
    const lag = scrollY - smooth;
    // Things flow in as they come up from under the fold: from the left, the right, below, or growing.
    const span = height * 0.46;
    for (const flow of flows) {
      let begin = flow.top - height * 0.98 + flow.delay * 1.4 * span;
      // The foot of the page cannot scroll far enough for a late entrance, so there it starts sooner.
      if (begin + span > furthest) begin = furthest - span;
      const t = ease(clamp((smooth - begin) / span));
      const rest = 1 - t;
      if (flow.card) {
        // A film swings in from its side like a door, then keeps a little depth for as long as it is on
        // screen: it leans with its height in the window, drifts slower than the words, and sinks back as it leaves.
        const side = flow.from === "left" ? -1 : 1;
        const place = Math.max(-1, Math.min(1, (flow.top + flow.height / 2 - smooth - height / 2) / height));
        const leaving = clamp((-place - 0.4) / 0.45);
        flow.element.style.transform = `perspective(1400px) translate3d(${side * rest * 240 * reach}px, ${rest * 40 + place * -38}px, 0) rotateY(${-side * rest * 34}deg) rotateX(${place * 9}deg) scale(${0.82 + 0.18 * t - leaving * 0.07})`;
        flow.element.style.opacity = String(clamp(t * 1.4) * (1 - leaving * 0.55));
        continue;
      }
      const move = flow.from === "left" ? `translate3d(${-rest * 190 * reach}px, ${rest * 30}px, 0) rotate(${-rest * 2.5}deg)`
        : flow.from === "right" ? `translate3d(${rest * 190 * reach}px, ${rest * 30}px, 0) rotate(${rest * 2.5}deg)`
        : flow.from === "zoom" ? `translate3d(0, ${rest * 60}px, 0) scale(${0.78 + 0.22 * t})`
        // The tour's screen lies back and comes up to face the reader.
        : flow.from === "tilt" ? `perspective(1300px) translate3d(0, ${rest * 90}px, 0) rotateX(${rest * 46}deg) scale(${0.8 + 0.2 * t})`
        : flow.from === "word" ? `translate3d(0, ${rest * 115}%, 0) rotate(${rest * 7}deg)`
        : `translate3d(0, ${rest * 90}px, 0)`;
      flow.element.style.transform = t >= 1 ? "" : move;
      flow.element.style.opacity = t >= 1 || flow.from === "word" ? "" : String(clamp(t * 1.4));
    }
    // The stops lean with the speed of the scroll and stand straight again when it stops.
    page.style.setProperty("--skew", `${Math.max(-2.2, Math.min(2.2, lag * 0.004))}deg`);

    // The motes drift up as the page goes down, the near ones faster, and stretch into streaks at speed.
    pen.clearRect(0, 0, width, height);
    pen.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
    pen.lineCap = "round";
    for (const mote of motes) {
      const y = (((mote.y * height - smooth * mote.depth * 0.3) % height) + height) % height;
      const streak = Math.min(70, Math.abs(lag) * mote.depth * 0.22);
      pen.globalAlpha = 0.1 + mote.depth * 0.32;
      pen.lineWidth = 0.8 + mote.depth * 1.4;
      pen.beginPath();
      pen.moveTo(mote.x * width, y - streak / 2);
      pen.lineTo(mote.x * width, y + streak / 2 + 0.1);
      pen.stroke();
    }
    progress.style.transform = `scaleX(${furthest ? clamp(smooth / furthest) : 0})`;

    // The line runs ahead of the reader's eye, and each stop lights as the line reaches it.
    const along = clamp((smooth + height * 0.56 - journey.top) / journey.height);
    line.firstElementChild.style.transform = `scaleY(${along})`;
    line.lastElementChild.style.top = `${along * 100}%`;
    line.lastElementChild.style.opacity = String(clamp(along * 40) * clamp((1 - along) * 40));
    for (const stop of stops) stop.element.classList.toggle("reached", smooth + height * 0.56 >= stop.middle);
    // The offer at the foot of the window names the use case nearest the middle of it.
    const nearest = stops.reduce((best, stop) => (Math.abs(stop.middle - smooth - height / 2) < Math.abs(best.middle - smooth - height / 2) ? stop : best), stops[0]);
    if (pill.dataset.watch !== nearest.id) { pill.dataset.watch = nearest.id; pill.lastElementChild.textContent = `Watch “${nearest.title}” with sound`; pill.setAttribute("aria-label", pill.lastElementChild.textContent); }
    pill.classList.toggle("show", smooth > journey.top - height * 0.55 && smooth < journey.top + journey.height - height * 0.6);

    // The row of machines slides sideways as the page goes down.
    machines.style.transform = `translate3d(${(machinesTop - smooth - height * 0.5) * 0.35}px, 0, 0)`;
  }
  const showing = smooth < view.height * 1.75 && !watching;
  if (showing && heroFilm.paused && heroFilm.src && !still.matches) heroFilm.play().then(tune, () => {});
  else if (!showing && !heroFilm.paused) { heroFilm.pause(); tune(); }
  if (seen.get(heroFilm) !== (showing ? 0.8 : 0)) seen.set(heroFilm, showing ? 0.8 : 0);
  if (grown !== smooth > view.height * 0.1) { grown = !grown; tune(); }
  requestAnimationFrame(draw);
}

// The row of pictures arrives when it is a third of the way up the window.
new IntersectionObserver(([entry], observer) => { if (entry.isIntersecting) { entry.target.classList.add("in"); observer.disconnect(); } }, { rootMargin: "0px 0px -18% 0px" }).observe(document.querySelector("#tiles"));

// A film plays while most of it is on screen, and is fetched as it comes near.
const films = [...document.querySelectorAll("video[data-src]")];
const seen = new Map();
// A browser keeps a film for an hour, so a film is asked for by the time the page was published:
// after a new publish the address differs and the old copy is not shown.
const published = Date.parse(document.lastModified) || 0;
const fresh = (address) => `${address}?v=${published}`;
const near = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting && !entry.target.src) entry.target.src = fresh(entry.target.dataset.src);
}, { rootMargin: "600px" });
const playing = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    seen.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
    if (entry.isIntersecting && !still.matches && !watching) {
      // A jump down the page can bring a film on screen before it was ever near.
      if (!entry.target.src) entry.target.src = fresh(entry.target.dataset.src);
      entry.target.play().then(tune, () => {});
    } else entry.target.pause();
  }
  tune();
}, { threshold: 0.55 });
// The hero's film is the exception: it grows past the window on the way in, so it is played by where the scroll is.
for (const item of films) { near.observe(item); if (item !== heroFilm) playing.observe(item); }

// Hearing. One film is heard at a time: the one the mouse was moved onto or, where there is no
// mouse, the one most on screen. A browser lets a page make sound only after a click, so
// the first click on a film (or on the speaker in the bar) is what turns the sound on.
const cards = [...document.querySelectorAll("[data-film]")].map((element) => ({ element, video: element.querySelector("video") }));
const pointed = matchMedia("(hover: hover)");
const levels = new Map();
const fades = new Map();
let hovered = null;
let watching = false;
// The hero's film once the scroll has started to grow it. From there it is the backdrop of the
// page and always under the mouse, so it is heard in the theater only.
let grown = false;

function heard() {
  if (!sound || watching) return null;
  if (pointed.matches) return hovered && !hovered.paused && !(grown && hovered === heroFilm) ? hovered : null;
  let most = null;
  for (const { video } of cards) if (!video.paused && (seen.get(video) ?? 0) > (most ? seen.get(most) : 0.5)) most = video;
  return most;
}
/** Brings a film's sound up or down over a third of a second, so nothing starts or stops with a click. */
function fade(video, up) {
  cancelAnimationFrame(fades.get(video));
  if (up) video.muted = false;
  const step = () => {
    const level = clamp((levels.get(video) ?? 0) + (up ? 0.06 : -0.08));
    levels.set(video, level);
    video.volume = level;
    if (up ? level < 1 : level > 0) fades.set(video, requestAnimationFrame(step));
    else if (!up) video.muted = true;
  };
  step();
}
function tune() {
  const target = heard();
  for (const { element, video } of cards) {
    const state = !sound ? "off" : video === target ? "on" : "ready";
    if (element.dataset.hear !== state) { element.dataset.hear = state; fade(video, state === "on"); }
  }
  document.querySelector("#soundButton").setAttribute("aria-pressed", String(sound));
}
// Pointing at a film means moving the mouse onto it. A film that slides under a resting mouse
// as the page scrolls was not pointed at, and the browser reports that as the mouse entering
// it all the same, so only a move to a new place on the screen counts.
let mouseAt = null;
addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse") return;
  const at = `${event.screenX},${event.screenY}`;
  const moved = mouseAt !== null && at !== mouseAt;
  mouseAt = at;
  if (!moved) return;
  const over = cards.find(({ element }) => element.contains(event.target))?.video ?? null;
  if (over !== hovered) { hovered = over; tune(); }
});
for (const { element, video } of cards) {
  element.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse" && hovered === video) { hovered = null; tune(); } });
  // A click on a film opens it in the theater; having been asked for once, sound stays on for the page.
  video.addEventListener("click", () => watch(element.dataset.film));
}

// The theater: one film at a time, large, with sound and its controls, and the next one after it.
const playlist = [
  { id: "hero", title: "The short version", text: "An agent dies with the laptop. Then the same task, in Joint Bob." },
  ...cases.map((item) => ({ id: item.id, title: item.title, text: item.ask })),
  { id: "teaser", title: "The whole tour", text: "All of it in 50 seconds." },
];
const theater = document.querySelector("#theater");
const theaterFilm = document.querySelector("#theaterFilm");
let showingAt = 0;
function screenFilm(at) {
  showingAt = (at + playlist.length) % playlist.length;
  const item = playlist[showingAt];
  const next = playlist[(showingAt + 1) % playlist.length];
  document.querySelector("#theaterTitle").textContent = item.title;
  document.querySelector("#theaterCount").textContent = `${showingAt + 1} of ${playlist.length}`;
  document.querySelector("#theaterText").textContent = item.text;
  document.querySelector("#theaterNext").textContent = `Next: ${next.title}`;
  Object.assign(theaterFilm, { poster: `media/${item.id}-1080.jpg`, src: fresh(`media/${item.id}-1080.mp4`), muted: false, volume: 1 });
  theaterFilm.play().catch(() => {});
}
function watch(id) {
  watching = true;
  sound = true;
  // Once a film has been watched the page stops waving at the reader.
  document.body.classList.add("watched");
  for (const item of films) item.pause();
  tune();
  theater.showModal();
  screenFilm(Math.max(0, playlist.findIndex((item) => item.id === id)));
}
theater.addEventListener("close", () => {
  theaterFilm.pause();
  theaterFilm.removeAttribute("src");
  watching = false;
  // What was playing on the page behind carries on.
  for (const item of films) if (item !== heroFilm && (seen.get(item) ?? 0) >= 0.55 && !still.matches) item.play().catch(() => {});
  tune();
});
theaterFilm.addEventListener("ended", () => screenFilm(showingAt + 1));
document.querySelector("#theaterNext").addEventListener("click", () => screenFilm(showingAt + 1));
document.querySelector("#theaterPrevious").addEventListener("click", () => screenFilm(showingAt - 1));
document.querySelector("#theaterClose").addEventListener("click", () => theater.close());
// A click on the dark around the film closes it too.
theater.addEventListener("click", (event) => { if (event.target === theater) theater.close(); });
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-watch]");
  if (button) watch(button.dataset.watch);
});

function toast(text) {
  const note = document.querySelector("#toast");
  note.textContent = text;
  note.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => note.classList.remove("show"), 1800);
}
document.querySelector("#soundButton").addEventListener("click", () => {
  sound = !sound;
  toast(sound ? (pointed.matches ? "Sound on. Point at a film to hear it" : "Sound on") : "Sound off");
  tune();
});
document.querySelector("#themeButton").addEventListener("click", () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
});
for (const button of document.querySelectorAll("[data-copy]")) button.addEventListener("click", () => {
  navigator.clipboard.writeText(document.querySelector("#installCommand").textContent).then(() => toast("Command copied"), () => toast("Select the command and copy it"));
});
// A link down the page travels there slowly enough for the page to flow past.
for (const link of document.querySelectorAll('a[href^="#"]')) {
  link.addEventListener("click", (event) => {
    const target = document.querySelector(link.getAttribute("href"));
    if (!target) return;
    event.preventDefault();
    // The hero is the top of the page; everything else is aimed a little above itself.
    scrollTo({ top: target.id === "top" ? 0 : pageTop(target) - 70, behavior: still.matches ? "instant" : "smooth" });
  });
}

addEventListener("resize", () => { measure(); drawn = -1; });
addEventListener("load", () => { measure(); drawn = -1; });
measure();
requestAnimationFrame(draw);
