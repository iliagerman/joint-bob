import { h } from "./git-story-dom.js";
import { mountStoryDiagram } from "./git-story-diagram.js";

// An animated walkthrough built from a saved story, for developers who need to review the change:
// the flow diagram, worked examples, the files, the design decisions and the review checklist.
// It has no dependency on the rest of the app, so the same code runs in the exported HTML file.
// Narration is optional: ElevenLabs when the app supplies `narrate`, otherwise (or when ElevenLabs
// fails) the computer's own voice through speechSynthesis.

const NARRATION_LIMIT = 2_400;
const SECONDS_PER_WORD = 0.4;
const SECONDS_PER_ITEM = 1.6;
const MIN_SCENE_SECONDS = 5;
const SPEECH_START_SECONDS = 4;
const FILE_ROWS = 8;

const trim = (text) => text.length > NARRATION_LIMIT ? `${text.slice(0, NARRATION_LIMIT - 1)}…` : text;
const list = (items) => items.map((text) => text.replace(/[.!?]$/, "")).join(". ");
const baseName = (path) => path.split("/").at(-1);
const item = (tag, content, attrs = {}) => h(tag, { class: "gsv-item", ...attrs }, content);
const mono = (text) => h("code", {}, text);
const noFiles = () => h("span");

function scene(title, narration, build) { return { title, narration: trim(narration), build }; }

function flowScene({ diagram }) {
  const spoken = diagram.nodes.map((node) => `${node.label}: ${node.text}`).join(" ");
  return scene("How it flows", `How it flows. ${spoken}`, () => {
    const canvas = h("div", { class: "gs-canvas", style: "bottom:0" });
    const wrap = h("div", { class: "gs-diagram is-compact gsv-diagram" }, canvas);
    // The diagram needs its size, so it is drawn once the stage is on screen.
    queueMicrotask(() => requestAnimationFrame(() => mountStoryDiagram(wrap, canvas, diagram, { fileLine: noFiles })));
    return h("div", { class: "gsv-example" }, wrap, h("ul", { class: "gsv-rows" }, diagram.nodes.map((node) =>
      item("li", [h("b", {}, node.label), ` · ${diagram.lanes.find((lane) => lane.id === node.lane).label}. ${node.text}`, node.files.length ? h("span", { class: "gsv-files" }, node.files.map(mono)) : null]))));
  });
}

function exampleScenes({ examples, diagram }) {
  return examples.flatMap((example) => example.steps.map((step, index) => {
    const last = index === example.steps.length - 1;
    const spoken = [index === 0 ? `${example.kind}: ${example.title}. ${example.start}` : "", step.you && `You: ${step.you}`, `The app: ${step.app}`, step.says && `On screen: ${step.says}`, last && `Result: ${example.result}`].filter(Boolean).join(" ");
    return scene(`${example.title} · step ${index + 1} of ${example.steps.length}`, spoken, () => {
      const canvas = h("div", { class: "gs-canvas", style: "bottom:0" });
      const wrap = h("div", { class: "gs-diagram is-compact gsv-diagram" }, canvas);
      const visited = { nodes: new Set(), edges: new Set() };
      for (const earlier of example.steps.slice(0, index)) { earlier.nodes.forEach((id) => visited.nodes.add(id)); earlier.edges.forEach((id) => visited.edges.add(id)); }
      const trace = { visited, current: { nodes: new Set(step.nodes), edges: new Set(step.edges) } };
      queueMicrotask(() => requestAnimationFrame(() => mountStoryDiagram(wrap, canvas, diagram, { trace, fileLine: noFiles })));
      return h("div", { class: "gsv-example" },
        h("p", { class: "gsv-eyebrow" }, `${example.kind} · ${example.title}`),
        wrap,
        h("div", { class: "gsv-beats" },
          step.you ? item("p", `You: ${step.you}`) : null,
          item("p", `App: ${step.app}`),
          step.says ? item("p", `On screen: “${step.says}”`, { class: "gsv-item gsv-says" }) : null,
          last ? item("p", `Result: ${example.result}`, { class: "gsv-item gsv-result" }) : null));
    });
  }));
}

function filesScene({ implementation }, facts) {
  const files = [...facts.files].sort((left, right) => right.add + right.del - (left.add + left.del));
  const add = files.reduce((total, file) => total + file.add, 0);
  const del = files.reduce((total, file) => total + file.del, 0);
  const shown = files.slice(0, FILE_ROWS);
  const spoken = `${files.length} files changed, ${add} lines added and ${del} removed. ${list(shown.map((file) => `${baseName(file.path)}: ${implementation.what[file.path] ?? file.kind}`))}.`;
  return scene("Files changed", spoken, () => h("ul", { class: "gsv-rows" },
    shown.map((file) => item("li", [mono(file.path), h("span", { class: "gsv-delta" }, h("i", { class: "gs-add" }, `+${file.add}`), " ", h("i", { class: "gs-del" }, `−${file.del}`)), implementation.what[file.path] ? h("p", {}, implementation.what[file.path]) : null])),
    files.length > shown.length ? item("li", `…and ${files.length - shown.length} more`, { class: "gsv-item gsv-more" }) : null));
}

function decisionsScene({ implementation }) {
  if (!implementation.decisions.length) return null;
  const spoken = implementation.decisions.map((decision) => `${decision.title}. ${decision.why} Instead: ${decision.instead}`).join(" ");
  return scene("Design decisions", `Design decisions. ${spoken}`, () => h("div", { class: "gsv-cards" }, implementation.decisions.map((decision) =>
    h("div", { class: "gsv-item gsv-card" }, h("small", {}, decision.turn ? `Decision · turn ${decision.turn}` : "Decision"), h("b", {}, decision.title), h("p", {}, decision.why), h("p", { class: "gsv-instead" }, `Instead: ${decision.instead}`)))));
}

function checksScene({ implementation }) {
  if (!implementation.checks.length) return null;
  const spoken = implementation.checks.map((check) => `${check.priority} priority: ${check.text}`).join(" ");
  return scene("Review checklist", `For the review. ${spoken}`, () => h("ul", { class: "gsv-rows" }, implementation.checks.map((check) =>
    item("li", [h("span", { class: `gsv-priority is-${check.priority}` }, check.priority), ` ${check.text}`, check.file ? h("span", { class: "gsv-files" }, mono(check.file)) : null]))));
}

function testsScene({ implementation }) {
  if (!implementation.tests.length) return null;
  const spoken = list(implementation.tests.map((test) => `${baseName(test.file)}: ${test.name}`));
  return scene("Tests", `Tests that cover it. ${spoken}.`, () => h("ul", { class: "gsv-rows" }, implementation.tests.map((test) => item("li", [mono(test.file), h("p", {}, test.name)]))));
}

/** Every scene: `build` returns the stage content, whose `.gsv-item` children appear one by one. */
export function storyScenes(story, facts) {
  const { overview, timeline } = story;
  const add = facts.files.reduce((total, file) => total + file.add, 0);
  const del = facts.files.reduce((total, file) => total + file.del, 0);
  const visible = timeline.filter((phase) => !phase.quiet);
  return [
    scene(story.kind, `${story.kind}. ${story.title}.`, () => h("div", { class: "gsv-hero" }, item("span", story.kind, { class: "gsv-item gsv-kind" }), item("h2", story.title), item("p", `${facts.files.length} files · +${add} −${del}`))),
    scene("What changed and why", `${overview.what} ${overview.why}`, () => h("div", { class: "gsv-cards" }, h("div", { class: "gsv-item gsv-card" }, h("small", {}, "What changed"), h("p", {}, overview.what)), h("div", { class: "gsv-item gsv-card" }, h("small", {}, "Why"), h("p", {}, overview.why)))),
    scene("What you will notice", `What you will notice. ${list(overview.notice)}.${overview.unchanged ? ` ${overview.unchanged}` : ""}`, () => h("ul", { class: "gsv-list" }, overview.notice.map((text) => item("li", text)), overview.unchanged ? item("li", overview.unchanged, { class: "gsv-item gsv-more" }) : null)),
    flowScene(story),
    visible.length ? scene("How it evolved", `Here is how it evolved. ${visible.map((phase) => `${phase.title}. ${phase.did[0]}${phase.pivot ? ` Change of course: ${phase.pivot}` : ""}`).join(" ")}`, () =>
      h("ol", { class: "gsv-list is-steps" }, visible.map((phase) => item("li", [h("b", {}, phase.title), ` ${phase.did[0]}`, phase.decided.length ? h("p", { class: "gsv-instead" }, `Decided: ${phase.decided.join(" ")}`) : null, phase.pivot ? h("p", { class: "gsv-instead" }, `Change of course: ${phase.pivot}`) : null])))) : null,
    ...exampleScenes(story),
    filesScene(story, facts),
    decisionsScene(story),
    checksScene(story),
    testsScene(story),
  ].filter(Boolean);
}

const seconds = (narration, items) => Math.max(MIN_SCENE_SECONDS, narration.split(/\s+/).length * SECONDS_PER_WORD, 3 + items * SECONDS_PER_ITEM);

/**
 * Opens the player in `host`. `narrate(text)` returns an ElevenLabs audio Blob and is absent when no key is set up;
 * `notify(message)` shows why a voice was dropped. `voice` false starts silent.
 */
export function playStoryVideo({ story, facts, host, narrate = null, notify = () => {}, voice = true }) {
  const scenes = storyScenes(story, facts);
  const player = { index: 0, elapsed: 0, duration: 0, playing: true, voice, engine: narrate ? "eleven" : "system", token: 0, frame: 0, last: 0, revealed: 0, items: [], speaking: false, heard: false };
  const audio = new Audio();
  const audios = new Map();
  const urls = [];
  const stage = h("div", { class: "gsv-stage" });
  const caption = h("p", { class: "gsv-caption" });
  const bar = h("div", { class: "gsv-bar" }, scenes.map((_, index) => h("button", { type: "button", class: "gsv-seg", "aria-label": `Scene ${index + 1}`, onclick: () => go(index) }, h("i"))));
  const playButton = h("button", { type: "button", class: "ghost compact gs-boxed", onclick: () => toggle() }, "Pause");
  const voiceButton = h("button", { type: "button", class: "ghost compact gs-boxed", "data-testid": "git-story-video-voice", onclick: () => { player.voice = !player.voice; void go(player.index); } });
  const heading = h("p", { class: "gsv-title" });
  link();
  const overlay = h("div", { class: "git-story gsv", role: "dialog", "aria-modal": "true", "aria-label": "Story video", "data-testid": "git-story-video", tabindex: "-1", onkeydown: (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } } },
    h("header", {}, heading, h("span", { class: "gsv-controls" }, voiceButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Previous scene", onclick: () => go(player.index - 1) }, "‹"), playButton,
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Next scene", onclick: () => go(player.index + 1) }, "›"),
      h("button", { type: "button", class: "ghost compact gs-boxed", "aria-label": "Close video", onclick: () => close() }, "×"))),
    stage, caption, bar);
  host.append(overlay);
  overlay.focus();

  function link() {
    if (document.getElementById("gsvStyles")) return;
    document.head.append(h("link", { id: "gsvStyles", rel: "stylesheet", href: new URL("../git-story-video.css", import.meta.url).href }));
  }
  function showVoice() { voiceButton.textContent = !player.voice ? "Voice off" : player.engine === "eleven" ? "Voice: ElevenLabs" : "Voice: this computer"; }
  function silence() { audio.pause(); audio.removeAttribute("src"); window.speechSynthesis?.cancel(); player.speaking = false; }
  function close() { player.token += 1; cancelAnimationFrame(player.frame); silence(); urls.forEach((url) => URL.revokeObjectURL(url)); overlay.remove(); }
  function toggle() {
    player.playing = !player.playing;
    playButton.textContent = player.playing ? "Pause" : "Play";
    if (player.playing) { if (audio.src) void audio.play(); window.speechSynthesis?.resume(); player.last = performance.now(); } else { audio.pause(); window.speechSynthesis?.pause(); }
  }

  // Narration is fetched ahead so a scene starts without a pause.
  function fetchNarration(index) {
    if (!audios.has(index)) audios.set(index, narrate(scenes[index].narration).then((blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; }));
    return audios.get(index);
  }
  async function playEleven(index, token) {
    const url = await fetchNarration(index);
    if (token !== player.token) return;
    audio.src = url;
    await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error("The narration could not be played.")); });
    player.duration = audio.duration + 0.8;
    if (player.playing) await audio.play();
    if (index + 1 < scenes.length) void fetchNarration(index + 1).catch(() => {});
  }
  function dropVoice(token, message) {
    if (token !== player.token) return;
    silence();
    player.voice = false;
    showVoice();
    notify(message);
  }
  // The scene lasts until the voice finishes; speechSynthesis is a browser boundary and may never start.
  function speak(index, token) {
    if (!window.speechSynthesis) { dropVoice(token, "This browser has no speech voice, so the video plays silently."); return; }
    const utterance = new SpeechSynthesisUtterance(scenes[index].narration);
    utterance.lang = document.documentElement.lang || "en-US";
    utterance.onstart = () => { player.heard = true; };
    utterance.onend = () => { if (token === player.token) player.speaking = false; };
    utterance.onerror = (event) => { if (event.error !== "canceled" && event.error !== "interrupted") dropVoice(token, `The computer's voice failed (${event.error}), so the video plays silently.`); };
    player.heard = false;
    player.speaking = true;
    window.speechSynthesis.speak(utterance);
    setTimeout(() => { if (token === player.token && !player.heard && player.voice) dropVoice(token, "The computer's voice did not start, so the video plays silently."); }, SPEECH_START_SECONDS * 1000);
  }
  async function startVoice(index, token) {
    silence();
    if (!player.voice) return;
    if (player.engine === "eleven") {
      try { await playEleven(index, token); return; } catch (error) {
        if (token !== player.token) return;
        audios.delete(index);
        player.engine = "system";
        notify(`ElevenLabs narration failed: ${error.message} Using this computer's voice instead.`);
      }
    }
    if (token === player.token) speak(index, token);
  }

  async function go(index) {
    if (index < 0) index = 0;
    if (index >= scenes.length) { close(); return; }
    const token = ++player.token;
    cancelAnimationFrame(player.frame);
    player.index = index;
    player.elapsed = 0;
    player.revealed = 0;
    heading.textContent = scenes[index].title;
    caption.textContent = scenes[index].narration;
    bar.querySelectorAll(".gsv-seg").forEach((seg, at) => { seg.classList.toggle("is-done", at < index); seg.classList.toggle("is-current", at === index); seg.firstChild.style.width = at < index ? "100%" : "0"; });
    const content = scenes[index].build();
    stage.replaceChildren(content);
    player.items = [...content.querySelectorAll(".gsv-item")];
    if (!player.items.length && content.classList.contains("gsv-item")) player.items = [content];
    player.duration = seconds(scenes[index].narration, player.items.length);
    showVoice();
    await startVoice(index, token);
    if (token !== player.token) return;
    showVoice();
    player.last = performance.now();
    const tick = (now) => {
      if (token !== player.token) return;
      if (player.playing) player.elapsed += (now - player.last) / 1000;
      player.last = now;
      if (player.speaking && player.elapsed > player.duration * 2 + 10) player.speaking = false;
      const progress = Math.min(player.speaking ? 0.999 : 1, player.elapsed / player.duration);
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
