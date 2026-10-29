import { api, apiBlob } from "./api.js";
import { h } from "./git-story-dom.js";
import { mountStoryDiagram } from "./git-story-diagram.js";
import { toast } from "./shell.js";

// An animated walkthrough built from a saved story: the same words and diagram, played as
// scenes. Narration is optional and comes from ElevenLabs through the server.

const NARRATION_LIMIT = 2_400;
const SECONDS_PER_WORD = 0.4;
const MIN_SCENE_SECONDS = 5;

export const VOICE_SETUP = [
  "Create a free account at elevenlabs.io, open Developers → API Keys, and create a key. Allow it to use Text to Speech.",
  "In Joint Bob open Settings → Secrets, press + to add a custom account named ElevenLabs, and add a variable named ELEVENLABS_API_KEY with your key.",
  "Attach that account to a workspace or this project under Secret accounts, then reopen the story.",
];

export async function storyVoiceConfigured(apiUrl) {
  try { return (await api(apiUrl("story-voice"))).configured; } catch { return false; }
}

const trim = (text) => text.length > NARRATION_LIMIT ? `${text.slice(0, NARRATION_LIMIT - 1)}…` : text;
const list = (items) => items.map((item) => item.replace(/[.!?]$/, "")).join(". ");
const item = (tag, text, attrs = {}) => h(tag, { class: "gsv-item", ...attrs }, text);

function scene(title, narration, build) { return { title, narration: trim(narration), build }; }

/** Every scene: `build` returns the stage content, whose `.gsv-item` children appear one by one. */
export function storyScenes(story, facts) {
  const { overview, diagram, timeline, examples, implementation } = story;
  const scenes = [
    scene(story.kind, `${story.kind}. ${story.title}.`, () => h("div", { class: "gsv-hero" }, item("span", story.kind, { class: "gsv-item gsv-kind" }), item("h2", story.title))),
    scene("What changed and why", `${overview.what} ${overview.why}`, () => h("div", { class: "gsv-cards" }, h("div", { class: "gsv-item gsv-card" }, h("small", {}, "What changed"), h("p", {}, overview.what)), h("div", { class: "gsv-item gsv-card" }, h("small", {}, "Why"), h("p", {}, overview.why)))),
    scene("What you will notice", `What you will notice. ${list(overview.notice)}.`, () => h("ul", { class: "gsv-list" }, overview.notice.map((text) => item("li", text)))),
  ];
  const visible = timeline.filter((phase) => !phase.quiet);
  if (visible.length) scenes.push(scene("How it evolved", `Here is how it evolved. ${visible.map((phase) => `${phase.title}. ${phase.did[0]}`).join(" ")}`, () =>
    h("ol", { class: "gsv-list is-steps" }, visible.map((phase) => item("li", `${phase.title}: ${phase.did[0]}`)))));
  for (const example of examples) example.steps.forEach((step, index) => {
    const last = index === example.steps.length - 1;
    const spoken = [index === 0 ? `${example.kind}: ${example.title}. ${example.start}` : "", step.you && `You: ${step.you}`, `The app: ${step.app}`, step.says && `On screen: ${step.says}`, last && `Result: ${example.result}`].filter(Boolean).join(" ");
    scenes.push(scene(`${example.title} · step ${index + 1} of ${example.steps.length}`, spoken, () => {
      const canvas = h("div", { class: "gs-canvas", style: "bottom:0" });
      const wrap = h("div", { class: "gs-diagram is-compact gsv-diagram" }, canvas);
      const visited = { nodes: new Set(), edges: new Set() };
      for (const earlier of example.steps.slice(0, index)) { earlier.nodes.forEach((id) => visited.nodes.add(id)); earlier.edges.forEach((id) => visited.edges.add(id)); }
      // The diagram needs its size, so it is drawn once the stage is on screen.
      queueMicrotask(() => requestAnimationFrame(() => mountStoryDiagram(wrap, canvas, diagram, { trace: { visited, current: { nodes: new Set(step.nodes), edges: new Set(step.edges) } }, fileLine: () => h("span") })));
      return h("div", { class: "gsv-example" },
        h("p", { class: "gsv-eyebrow" }, `${example.kind} · ${example.title}`),
        wrap,
        h("div", { class: "gsv-beats" },
          step.you ? item("p", `You: ${step.you}`) : null,
          item("p", `App: ${step.app}`),
          step.says ? item("p", `On screen: “${step.says}”`, { class: "gsv-item gsv-says" }) : null,
          last ? item("p", `Result: ${example.result}`, { class: "gsv-item gsv-result" }) : null));
    }));
  });
  if (implementation.decisions.length) scenes.push(scene("Decisions", `Decisions we made. ${implementation.decisions.map((decision) => `${decision.title}. ${decision.why}`).join(" ")}`, () =>
    h("ul", { class: "gsv-list" }, implementation.decisions.map((decision) => item("li", `${decision.title} — ${decision.why}`)))));
  const high = implementation.checks.filter((check) => check.priority === "high");
  scenes.push(scene("Worth checking", `${facts.files.length} files changed. ${high.length ? `Worth checking: ${list(high.map((check) => check.text))}.` : "Nothing is flagged as high risk."}`, () =>
    h("div", { class: "gsv-hero" }, item("h2", `${facts.files.length} files changed`), ...high.map((check) => item("p", `Check: ${check.text}`)))));
  return scenes;
}

const seconds = (narration) => Math.max(MIN_SCENE_SECONDS, narration.split(/\s+/).length * SECONDS_PER_WORD);

/** Opens the player. `voice` is "on" only when the server holds an ElevenLabs key. */
export function playStoryVideo({ story, facts, apiUrl, voice, host }) {
  const scenes = storyScenes(story, facts);
  const player = { index: 0, elapsed: 0, duration: 0, playing: true, voice, token: 0, frame: 0, last: 0, revealed: 0, items: [] };
  const audio = new Audio();
  const audios = new Map();
  const urls = [];
  const stage = h("div", { class: "gsv-stage" });
  const caption = h("p", { class: "gsv-caption" });
  const bar = h("div", { class: "gsv-bar" }, scenes.map((_, index) => h("button", { type: "button", class: "gsv-seg", "aria-label": `Scene ${index + 1}`, onclick: () => go(index) }, h("i"))));
  const playButton = h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => toggle() }, "Pause");
  const voiceButton = h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => { player.voice = !player.voice; void go(player.index); } });
  const heading = h("p", { class: "gsv-title" });
  link();
  const overlay = h("div", { class: "git-story gsv", role: "dialog", "aria-modal": "true", "aria-label": "Story video", "data-testid": "git-story-video", tabindex: "-1", onkeydown: (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } } },
    h("header", {}, heading, h("span", { class: "gsv-controls" }, voiceButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => go(player.index - 1) }, "‹"), playButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => go(player.index + 1) }, "›"),
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Close video", onclick: () => close() }, "×"))),
    stage, caption, bar);
  host.append(overlay);
  overlay.focus();

  function link() {
    if (document.getElementById("gsvStyles")) return;
    document.head.append(h("link", { id: "gsvStyles", rel: "stylesheet", href: new URL("../git-story-video.css", import.meta.url).href }));
  }
  function close() { player.token += 1; cancelAnimationFrame(player.frame); audio.pause(); urls.forEach((url) => URL.revokeObjectURL(url)); overlay.remove(); }
  function toggle() {
    player.playing = !player.playing;
    playButton.textContent = player.playing ? "Pause" : "Play";
    if (player.playing) { if (audio.src) void audio.play(); player.last = performance.now(); } else audio.pause();
  }

  // Narration is fetched ahead so a scene starts without a pause. A failure is shown once and the video plays silently.
  function narration(index) {
    if (!audios.has(index)) audios.set(index, apiBlob(apiUrl("story-voice"), { method: "POST", body: JSON.stringify({ text: scenes[index].narration }) }).then((blob) => { const url = URL.createObjectURL(blob); urls.push(url); return { url }; }));
    return audios.get(index);
  }
  async function loadAudio(index, token) {
    audio.pause();
    audio.removeAttribute("src");
    if (!player.voice) return;
    try {
      const { url } = await narration(index);
      if (token !== player.token) return;
      audio.src = url;
      await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error("The narration could not be played.")); });
      player.duration = audio.duration + 0.8;
      if (player.playing) await audio.play();
      if (index + 1 < scenes.length) void narration(index + 1).catch(() => {});
    } catch (error) {
      if (token !== player.token) return;
      player.voice = false;
      voiceButton.textContent = "Voice off";
      audios.delete(index);
      toast(`Narration stopped: ${error.message}`);
    }
  }

  async function go(index) {
    if (index < 0) index = 0;
    if (index >= scenes.length) { close(); return; }
    const token = ++player.token;
    cancelAnimationFrame(player.frame);
    player.index = index;
    player.elapsed = 0;
    player.duration = seconds(scenes[index].narration);
    player.revealed = 0;
    voiceButton.textContent = player.voice ? "Voice on" : "Voice off";
    heading.textContent = scenes[index].title;
    caption.textContent = scenes[index].narration;
    bar.querySelectorAll(".gsv-seg").forEach((seg, at) => { seg.classList.toggle("is-done", at < index); seg.classList.toggle("is-current", at === index); seg.firstChild.style.width = at < index ? "100%" : "0"; });
    const content = scenes[index].build();
    stage.replaceChildren(content);
    player.items = [...content.querySelectorAll(".gsv-item")];
    if (!player.items.length && content.classList.contains("gsv-item")) player.items = [content];
    await loadAudio(index, token);
    if (token !== player.token) return;
    player.last = performance.now();
    const tick = (now) => {
      if (token !== player.token) return;
      if (player.playing) player.elapsed += (now - player.last) / 1000;
      player.last = now;
      const progress = Math.min(1, player.elapsed / player.duration);
      const shown = Math.floor(progress / 0.75 * player.items.length) + 1;
      while (player.revealed < Math.min(shown, player.items.length)) player.items[player.revealed++].classList.add("is-on");
      bar.children[index].firstChild.style.width = `${progress * 100}%`;
      if (progress >= 1) { void go(index + 1); return; }
      player.frame = requestAnimationFrame(tick);
    };
    player.frame = requestAnimationFrame(tick);
  }
  void go(0);
  return { close };
}
