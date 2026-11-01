import { h, s } from "./git-story-dom.js";
import { PLACES, actorColor, drawScene, H, W } from "./git-story-places.js";
import { Stick } from "./git-story-stick.js";
import { diffClass, renderSlide, revealSlide } from "./git-story-slides.js";

// The story as a podcast: two stick-figure hosts talk in a place that follows each chapter, while its slide builds.
// Like the video it needs nothing from the rest of the app. The app supplies:
//   narrate(text, who) -> Promise<Blob>   a clip of one line, absent when no voice is available
//   ask(question, onProgress) -> Promise<script>   appends the answer to the story as new chapters, absent when asking is off
//   rewrite(onProgress) -> Promise<script>   writes the story again
//   notify(message)   says why the voice was dropped

const SECONDS_PER_WORD = 0.4;
const MIN_LINE_SECONDS = 3;
const PREFETCH = 2;
const CLIP_START_MS = 6000;
const NAMES = { host: "Maya", cohost: "Jonah" };
const OTHER = { host: "cohost", cohost: "host" };
const STUDIO = "podcast";

const wordCount = (text) => text.split(/\s+/).length;

// `audio` should be an element first played inside the viewer's click: Safari only lets such an element make sound later.
export function playStoryPodcast({ script: first, host, settings, narrate = null, ask = null, rewrite = null, notify = () => {}, audio = new Audio() }) {
  const player = {
    script: first, chapters: [], lines: [], index: -1, chapter: -1, playing: false, finished: false, speed: 1, muted: false,
    voice: Boolean(narrate), clips: new Map(), urls: [], busy: false, token: 0, frame: 0, lastFrame: 0, silentLeft: 0,
    view: { scene: STUDIO, mood: "calm", progress: 0, storyP: 0, sunP: 0, scroll: 0, playing: false, who: null, handsAt: -1e9 },
    sceneAt: 0, place: PLACES[STUDIO], actors: null, slide: null,
  };

  const canvas = h("canvas", { class: "gsp-backdrop", width: W, height: H });
  const g = canvas.getContext("2d");
  const actorLayer = s("svg", { class: "gsp-actors", viewBox: `0 0 ${W} ${H}` });
  const titleChip = h("div", { class: "gsp-chip gsp-title-chip" });
  const sceneChip = h("div", { class: "gsp-chip gsp-scene-chip" });
  const visual = h("div", { class: "gsp-vis" });
  const travel = h("div", { class: "gsp-travel" });
  const stage = h("div", { class: "gsp-stage" }, canvas, titleChip, sceneChip, visual, actorLayer, travel);
  const progress = h("div", { class: "gsp-progress", role: "status", hidden: true });
  const wrap = h("div", { class: "gsp-stage-wrap" }, stage, progress);
  const chapterStrip = h("div", { class: "gsp-chapters", "aria-label": "Story so far" });
  const who = h("span", { class: "gsp-who" });
  const caption = h("p", { class: "gsp-caption", "aria-live": "polite" }, who, h("span"));
  const voiceNote = h("span", { class: "gsp-voice-note", hidden: true }, "Preparing voice…");
  const playButton = h("button", { type: "button", class: "ghost compact gs-boxed gsp-play", onclick: () => toggle() }, "▶ Play");
  const muteButton = h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => { player.muted = !player.muted; audio.muted = player.muted; showMute(); } });
  const speedSelect = h("select", { "aria-label": "Speed", onchange: () => { player.speed = Number(speedSelect.value); audio.playbackRate = player.speed; } },
    [["1", "1×"], ["1.25", "1.25×"], ["0.8", "0.8×"]].map(([value, label]) => h("option", { value }, label)));
  const askInput = h("input", { type: "text", placeholder: "Ask a question about this change…", "aria-label": "Ask a question", autocomplete: "off", maxlength: 200, "data-testid": "git-story-podcast-question" });
  const askForm = h("form", { class: "gsp-ask", hidden: !(ask && settings.ask), onsubmit: (event) => { event.preventDefault(); void follow(askInput.value.trim()); } },
    askInput, h("button", { type: "submit", class: "primary compact", "data-testid": "git-story-podcast-ask" }, "Ask"));
  const writeup = h("div", { class: "gsp-writeup", hidden: true, "data-testid": "git-story-podcast-writeup" });
  const body = h("div", { class: "gsp-player" }, wrap, chapterStrip, caption,
    h("div", { class: "gsp-controls" },
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Previous line", onclick: () => go(player.index - 1) }, "⏮"), playButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Next line", onclick: () => go(player.index + 1) }, "⏭"),
      voiceNote, h("span", { class: "gsp-grow" }), h("label", { class: "gsp-speed" }, "Speed ", speedSelect), muteButton),
    askForm);
  const podcastTab = h("button", { type: "button", class: "ghost compact gs-boxed", "aria-pressed": "true", onclick: () => showView("podcast") }, "Podcast");
  const writeupTab = h("button", { type: "button", class: "ghost compact gs-boxed", "aria-pressed": "false", "data-testid": "git-story-podcast-writeup-tab", onclick: () => showView("writeup") }, "Implementation and reasoning");
  const rewriteButton = h("button", { type: "button", class: "ghost compact gs-boxed", hidden: !rewrite, "data-testid": "git-story-podcast-rewrite", onclick: () => void again() }, "Rewrite");
  const overlay = h("div", { class: "git-story gsp", role: "dialog", "aria-modal": "true", "aria-label": "Activity overview", "data-testid": "git-story-podcast", tabindex: "-1", onkeydown: (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } } },
    h("header", {}, h("span", { class: "gsp-tabs" }, podcastTab, writeupTab), h("span", { class: "gsp-controls" }, rewriteButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Close Activity overview", onclick: () => close() }, "×"))),
    body, writeup);
  link();
  host.append(overlay);
  overlay.focus();
  const resize = new ResizeObserver(() => { stage.style.transform = `scale(${wrap.clientWidth / W})`; });
  resize.observe(wrap);
  load(first, 0);
  showMute();
  player.frame = requestAnimationFrame(tick);

  function link() {
    if (document.getElementById("gspStyles")) return;
    document.head.append(h("link", { id: "gspStyles", rel: "stylesheet", href: new URL("../git-story-podcast.css", import.meta.url).href }));
  }

  function placeOf(chapter) { return PLACES[settings.backdrops && settings.locations.includes(chapter.location) ? chapter.location : STUDIO]; }
  function moodOf(chapter) { return settings.moods ? chapter.mood : "calm"; }

  // Chapters and lines are rebuilt whenever the script changes. Code chapters drop out when code slides are off.
  function load(script, startChapter) {
    player.script = script;
    player.chapters = script.chapters.filter((chapter) => settings.codeSlides || chapter.visual.kind !== "code");
    player.lines = player.chapters.flatMap((chapter, seg) => chapter.lines.map((line) => ({ ...line, seg })));
    player.clips.clear();
    actorLayer.replaceChildren();
    player.actors = {
      host: new Stick(actorLayer, { home: 190, face: 1, color: actorColor(player.place, "host"), label: NAMES.host, seed: 1 }),
      cohost: new Stick(actorLayer, { home: 770, face: -1, color: actorColor(player.place, "cohost"), label: NAMES.cohost, seed: 2 }),
    };
    titleChip.textContent = script.title;
    renderChapters();
    renderWriteup();
    player.chapter = -1;
    player.index = -1;
    player.finished = false;
    go(player.lines.findIndex((line) => line.seg >= startChapter));
  }

  function renderChapters() {
    chapterStrip.replaceChildren(...player.chapters.map((chapter, seg) =>
      h("button", { type: "button", class: `gsp-chap${chapter.question ? " is-question" : ""}`, title: placeOf(chapter).label, onclick: () => go(player.lines.findIndex((line) => line.seg === seg)) },
        h("span", { "aria-hidden": "true" }, placeOf(chapter).icon), chapter.question ? "Q · " : "", chapter.title)));
  }

  function showMark() {
    chapterStrip.querySelectorAll(".gsp-chap").forEach((chip, seg) => { chip.classList.toggle("is-done", seg < player.chapter); chip.classList.toggle("is-on", seg === player.chapter); });
  }

  // Entering a chapter: draw its slide, move to its place, and show the travel card.
  function enter(seg) {
    const chapter = player.chapters[seg];
    player.chapter = seg;
    player.slide = renderSlide(chapter.visual);
    visual.replaceChildren(player.slide);
    const place = placeOf(chapter);
    player.place = place;
    player.view.scene = Object.keys(PLACES).find((key) => PLACES[key] === place);
    player.view.mood = moodOf(chapter);
    player.view.sunP = 0;
    player.sceneAt = performance.now();
    stage.className = `gsp-stage gsp-scene-${player.view.scene}`;
    for (const key of ["host", "cohost"]) player.actors[key].setLook({ home: place.homes[key], face: place.faces[key], color: actorColor(place, key), treadmill: Boolean(place.treadmill), cup: Boolean(place.cup), glow: Boolean(place.glow) });
    travel.textContent = `${place.icon}  ${place.label} · ${chapter.title}`;
    travel.classList.remove("is-go");
    void travel.offsetWidth;
    travel.classList.add("is-go");
  }

  // Who moves, who gestures and who reacts for this line; the chapter's mood colours the reactions.
  function direct(line, moved) {
    const speaker = player.actors[line.who];
    const listener = player.actors[OTHER[line.who]];
    const previous = player.lines[player.index - 1];
    const next = player.lines[player.index + 1];
    const question = line.text.trim().endsWith("?");
    const newSlide = !previous || previous.seg !== line.seg || line.reveal > previous.reveal;
    const closing = !next || next.seg !== line.seg;
    const peak = Math.max(...player.chapters[line.seg].lines.map((item) => item.reveal));
    const now = performance.now();
    if (moved) for (const actor of Object.values(player.actors)) actor.x = actor.home - actor.face * 150;
    speaker.act(question ? "ask" : newSlide ? "pointThenExplain" : "explain", speaker.home + speaker.face * (question ? 30 : newSlide ? 100 : 60) * player.place.reach);
    let reaction = question ? "think" : "listen";
    if (player.view.mood === "tension" && newSlide && !question) reaction = "worry";
    if (closing && (player.view.mood === "resolved" || !next)) reaction = "cheer";
    listener.act(reaction, listener.home);
    if (question) { speaker.emote("?", now); player.view.handsAt = now / 1000; } else if (player.view.mood === "insight" && newSlide && line.reveal === peak) speaker.emote("💡", now);
    if (reaction === "cheer") listener.emote("!", now);
  }

  function go(index) {
    if (index < 0) index = 0;
    if (index >= player.lines.length) { player.finished = true; setPlaying(false); return; }
    const line = player.lines[index];
    const moved = line.seg !== player.chapter;
    if (moved) enter(line.seg);
    const inChapter = player.lines.filter((item) => item.seg === line.seg);
    player.view.progress = inChapter.length > 1 ? inChapter.indexOf(line) / (inChapter.length - 1) : 1;
    player.view.storyP = player.lines.length > 1 ? index / (player.lines.length - 1) : 1;
    player.view.who = line.who;
    player.index = index;
    player.finished = false;
    revealSlide(player.slide, line.reveal);
    direct(line, moved);
    who.textContent = NAMES[line.who];
    who.className = `gsp-who${line.who === "cohost" ? " is-cohost" : ""}`;
    caption.lastChild.textContent = line.text;
    sceneChip.textContent = `${line.seg + 1} / ${player.chapters.length} · ${player.place.label}`;
    showMark();
    void speak(index);
  }

  // Each line is spoken by its own clip, fetched ahead so the next one starts without a pause.
  function clip(index) {
    if (!player.clips.has(index)) player.clips.set(index, narrate(player.lines[index].text, player.lines[index].who).then((blob) => { const url = URL.createObjectURL(blob); player.urls.push(url); return url; }));
    return player.clips.get(index);
  }

  async function speak(index) {
    const token = ++player.token;
    audio.pause();
    audio.removeAttribute("src");
    voiceNote.hidden = true;
    player.silentLeft = Math.max(MIN_LINE_SECONDS, wordCount(player.lines[index].text) * SECONDS_PER_WORD);
    if (!player.voice) return;
    try {
      voiceNote.hidden = false;
      const url = await clip(index);
      if (token !== player.token) return;
      voiceNote.hidden = true;
      audio.src = url;
      audio.playbackRate = player.speed;
      audio.muted = player.muted;
      if (player.playing) await startClip();
      for (let ahead = 1; ahead <= PREFETCH && index + ahead < player.lines.length; ahead += 1) clip(index + ahead).catch(() => {});
    } catch (error) {
      if (token === player.token) dropVoice(error);
    }
  }

  function dropVoice(error) {
    voiceNote.hidden = true;
    player.voice = false;
    audio.pause();
    notify(`The narration failed: ${error.message} The podcast plays silently.`);
  }

  // A clip that loads but never starts would hold the movie on one line, so it gets a few seconds before narration stops.
  function startClip() {
    const started = new Promise((resolve, reject) => {
      // A pause before the clip starts is the viewer's choice, not a failure.
      const timer = setTimeout(() => (player.playing ? reject(new Error("This browser did not start the narration clip.")) : resolve()), CLIP_START_MS);
      audio.addEventListener("playing", () => { clearTimeout(timer); resolve(); }, { once: true });
      audio.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`This browser could not play the narration${audio.error?.message ? ` (${audio.error.message})` : ""}.`)); }, { once: true });
    });
    // Both settle together, so a refused play() never leaves the start timer to reject unhandled.
    return Promise.all([audio.play(), started]);
  }

  audio.onended = () => go(player.index + 1);

  function setPlaying(on) {
    player.playing = on;
    player.view.playing = on;
    playButton.textContent = on ? "⏸ Pause" : player.finished ? "↺ Replay" : "▶ Play";
    if (!on || !audio.hasAttribute("src")) { audio.pause(); return; }
    const token = player.token;
    startClip().catch((error) => { if (token === player.token && player.voice) dropVoice(error); });
  }

  function toggle() {
    if (player.finished) { go(0); setPlaying(true); return; }
    setPlaying(!player.playing);
  }

  function showMute() { muteButton.textContent = player.muted ? "Sound off" : "Sound on"; muteButton.hidden = !narrate; }

  // Without a voice a line lasts as long as it takes to read.
  function tick(now) {
    const dt = Math.min(64, now - player.lastFrame || 16);
    player.lastFrame = now;
    const { view } = player;
    view.scroll += dt * 0.055 * (player.playing ? 1 : 0.15);
    const sunGoal = view.mood === "resolved" ? 0.35 + 0.65 * view.progress : 0.12 + 0.2 * view.progress;
    view.sunP += (sunGoal - view.sunP) * (1 - Math.exp(-dt / 900));
    g.clearRect(0, 0, W, H);
    drawScene(g, player.place, now / 1000, dt, view);
    const fade = 1 - Math.min(1, (now - player.sceneAt) / 700);
    if (fade > 0) { g.fillStyle = `rgba(0,0,0,${fade})`; g.fillRect(0, 0, W, H); }
    const speaker = player.lines[player.index]?.who;
    for (const [key, actor] of Object.entries(player.actors)) actor.update(now, dt, player.playing && key === speaker, player.playing);
    if (player.playing && !player.voice && !player.busy) {
      player.silentLeft -= dt / 1000 * player.speed;
      if (player.silentLeft <= 0) go(player.index + 1);
    }
    player.frame = requestAnimationFrame(tick);
  }

  // A follow-up or a rewrite: the writer works while the stage waits, then the new story plays from where it grew.
  async function work(title, run) {
    if (player.busy) return;
    player.busy = true;
    setPlaying(false);
    progress.hidden = false;
    progress.textContent = title;
    try { await run((step) => { progress.textContent = `${title} ${step}`; }); } catch (error) { notify(error.message); } finally { player.busy = false; progress.hidden = true; }
  }

  async function follow(question) {
    if (!question) return;
    await work(`Continuing the story with “${question}”.`, async (onProgress) => {
      const before = player.chapters.length;
      const script = await ask(question, onProgress);
      askInput.value = "";
      load(script, before);
      showView("podcast");
      setPlaying(true);
    });
  }

  async function again() {
    await work("Writing the story again.", async (onProgress) => {
      load(await rewrite(onProgress), 0);
      setPlaying(true);
    });
  }

  function showView(name) {
    const podcast = name === "podcast";
    body.hidden = !podcast;
    writeup.hidden = podcast;
    podcastTab.setAttribute("aria-pressed", String(podcast));
    writeupTab.setAttribute("aria-pressed", String(!podcast));
    if (!podcast) setPlaying(false);
  }

  function renderWriteup() {
    const { writeup: text, followUps } = player.script;
    const list = (tag, items) => h(tag, {}, items.map((item) => h("li", {}, item)));
    const section = (title, body) => h("div", {}, h("h3", {}, title), body);
    writeup.replaceChildren(
      h("h2", {}, `Implementation and reasoning · ${player.script.title}`),
      h("div", { class: "gsp-wgrid" },
        section("What changed", list("ul", text.changed)),
        section("How it works", list("ol", text.how)),
        section("Why this way", list("ul", text.why)),
        text.rejected.length ? section("What we rejected", h("ul", {}, text.rejected.map((item) => h("li", {}, h("b", {}, item.option), `: ${item.why}`)))) : null,
        text.limits.length ? section("Limits and risks", list("ul", text.limits)) : null,
        followUps.length ? section("Your follow-up questions", h("ul", {}, followUps.map((item) => h("li", {}, h("b", {}, item.question), ` ${item.answer}`)))) : null),
      ...(settings.codeWriteup ? player.chapters.filter((chapter) => chapter.visual.kind === "code").map((chapter) => codeFigure(chapter.visual)) : []));
  }

  function codeFigure({ file, lines, steps }) {
    const range = ({ from, to }) => (from === to ? `line ${from}` : `lines ${from}–${to}`);
    return h("figure", { class: "gsp-wcode" },
      h("figcaption", {}, file), h("pre", {}, lines.map((line) => h("span", { class: diffClass(line) }, line))),
      h("ol", { class: "gsp-wsteps" }, steps.map((step) => h("li", {}, h("code", {}, range(step)), ` ${step.note}`))));
  }

  function close() {
    cancelAnimationFrame(player.frame);
    resize.disconnect();
    player.token += 1;
    audio.pause();
    audio.removeAttribute("src");
    player.urls.forEach((url) => URL.revokeObjectURL(url));
    overlay.remove();
  }

  return { close };
}
