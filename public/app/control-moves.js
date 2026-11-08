// Control center: moving conversations to another machine, and Story and Overview from a card.
import { api } from "./api.js";
import { openConversation, refreshControlCenter } from "./control-center.js";
import { registerBoardTool, registerCardAction, registerCardDecorator } from "./control-cards.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";

// ── Story and Overview ─────────────────────────────────────────────────────────────────────────────────────
// The story and the Activity overview read the conversation that is open (its project, its machine, its ticket), so a
// card opens its conversation first, the way clicking the card does, and then presses the same button the toolbar has.

const OPEN_WAIT_MS = 10_000;

async function untilActive(card) {
  const deadline = Date.now() + OPEN_WAIT_MS;
  while (Date.now() < deadline) {
    const session = activeChatSession();
    if (session && state.activeProjectId === card.projectId && (session.conversationId ?? session.id) === card.conversationId) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The conversation did not open, so there is nothing to explain yet");
}

async function showFor(card, button) {
  await openConversation(card);
  await untilActive(card);
  button.click();
}

registerCardAction({ id: "story", label: "Story", title: "Open this conversation's story: what changed, how it works and why", order: 40, run: (card) => showFor(card, elements.activityStoryButton) });
registerCardAction({ id: "overview", label: "Overview", title: "Watch two hosts explain what this conversation did", order: 50, run: (card) => showFor(card, elements.activityOverviewButton) });

// ── Moving ─────────────────────────────────────────────────────────────────────────────────────────────────

const PAGE = 5;
const POLL_MS = 1_500;
const STATUS = {
  waiting: "Waiting for its turn to end", stopping: "Stopping its turn", moving: "Moving", continuing: "Telling it to continue",
  moved: "Moved", there: "Already there", cannot: "Can't move", failed: "Failed", cancelled: "Not moved",
};
const FINISHED = new Set(["moved", "there", "cannot", "failed", "cancelled"]);

const board = elements.controlCenterBoard;
const key = (card) => `${card.projectId}:${card.conversationId}`;
const unfinished = (card) => card.column !== "review";

let nodes = [];
let selecting = false;
const picked = new Set();
/** The cards drawn by the latest render, with their elements. */
let drawn = [];
let job = null;
let jobPage = 0;
let pollTimer = null;

function node(tag, className, text) {
  const created = document.createElement(tag);
  if (className) created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function button(label, testid, className = "ghost compact") {
  const created = node("button", className, label);
  created.type = "button";
  created.dataset.testid = testid;
  return created;
}

const strip = node("div", "control-moves-strip");
strip.dataset.testid = "control-moves-strip";
strip.hidden = true;

const bar = node("div", "control-moves-bar");
bar.dataset.testid = "control-moves-bar";
bar.hidden = true;
const count = node("b", "", "0 selected");
count.dataset.testid = "control-moves-count";
const targetLabel = node("label", "control-moves-target", "Move to ");
const target = node("select");
target.dataset.testid = "control-moves-target";
targetLabel.append(target);
const stopAndMove = button("Stop and move now", "control-moves-now", "ghost compact control-moves-warn");
const moveLater = button("Move after current turn", "control-moves-later");
const cancelSelect = button("Cancel", "control-moves-cancel");
const preview = node("span", "control-moves-preview");
preview.dataset.testid = "control-moves-preview";
const hint = node("span", "control-moves-hint");
hint.dataset.testid = "control-moves-hint";
bar.append(count, targetLabel, stopAndMove, moveLater, cancelSelect, preview, hint);

const panel = node("section", "control-moves-job");
panel.dataset.testid = "control-moves-job";
panel.hidden = true;

elements.controlViewLive.append(strip, bar, panel);

const localId = () => nodes.find((candidate) => candidate.local)?.id ?? null;
const nodeOf = (card) => card.executionNodeId ?? localId();
const nodeName = (id) => nodes.find((candidate) => candidate.id === id)?.name ?? "another machine";
const pickedCards = () => drawn.filter(({ card }) => picked.has(key(card))).map(({ card }) => card);

async function loadNodes() {
  nodes = (await api("/api/control-center/moves/nodes")).nodes;
}

function fillTargets(preferNotId) {
  const chosen = target.value;
  target.replaceChildren(...nodes.map((candidate) => {
    const option = new Option(candidate.online ? candidate.name : `${candidate.name} (offline)`, candidate.id);
    option.disabled = !candidate.online;
    return option;
  }));
  const fallback = nodes.find((candidate) => candidate.online && candidate.id !== preferNotId) ?? nodes.find((candidate) => candidate.online);
  target.value = nodes.some((candidate) => candidate.id === chosen && candidate.online) ? chosen : fallback?.id ?? "";
}

function renderHint() {
  const sources = [...new Set(pickedCards().map((card) => nodeName(nodeOf(card))))];
  const to = nodes.find((candidate) => candidate.id === target.value)?.name ?? "the other machine";
  const message = `Continue where you stopped: you were moved from ${sources.join(" or ") || "its old machine"} to ${to}. Check what was half done before repeating anything.`;
  stopAndMove.title = `Stops each running turn, moves the conversation, then tells it: "${message}"`;
  hint.textContent = "Stop and move now stops each running turn, moves it, then tells it to continue and check what was half done. Move after current turn waits for each turn to end.";
}

let previewTimer = null;
let previewKey = "";
let previewRequest = 0;

/** Asks the server what would happen to the picked conversations, so what cannot move is known before a button is pressed. */
function showPreview(chosen) {
  const wanted = `${target.value}|${chosen.map(key).sort().join(",")}`;
  if (wanted === previewKey) return;
  previewKey = wanted;
  clearTimeout(previewTimer);
  preview.textContent = "";
  preview.classList.remove("blocked");
  if (!chosen.length || !target.value) return;
  previewTimer = setTimeout(async () => {
    const request = ++previewRequest;
    try {
      const plan = await api("/api/control-center/moves/plan", { method: "POST", body: JSON.stringify({ target: target.value, conversations: chosen.map((card) => ({ projectId: card.projectId, conversationId: card.conversationId })) }) });
      if (request !== previewRequest) return;
      const stuck = plan.entries.filter((entry) => entry.verdict === "cannot");
      preview.classList.toggle("blocked", stuck.length > 0);
      preview.textContent = stuck.length
        ? `Can't move: ${stuck.slice(0, 3).map((entry) => `${entry.title} (${entry.reasons.join("; ")})`).join(" · ")}${stuck.length > 3 ? ` and ${stuck.length - 3} more` : ""}.`
        : "Every one of them can move.";
    } catch (error) {
      if (request === previewRequest) preview.textContent = `Could not check: ${error.message}`;
    }
  }, 300);
}

/** Brings the checkboxes, the count and the bars in line with the selection and the cards on screen. */
function sync() {
  board.classList.toggle("selecting", selecting);
  for (const { card, root, box } of drawn) {
    const on = picked.has(key(card));
    box.checked = on;
    root.classList.toggle("control-picked", on);
  }
  const chosen = pickedCards();
  count.textContent = `${chosen.length} selected`;
  stopAndMove.disabled = moveLater.disabled = !chosen.length || !target.value;
  bar.hidden = !selecting;
  showPreview(selecting ? chosen : []);
  const select = document.querySelector('[data-board-tool="select"]');
  select?.classList.toggle("active", selecting);
  select?.setAttribute("aria-pressed", String(selecting));
  renderHint();
}

function renderStrip() {
  strip.replaceChildren();
  const counts = new Map();
  for (const { card } of drawn) if (unfinished(card)) counts.set(nodeOf(card), (counts.get(nodeOf(card)) ?? 0) + 1);
  strip.hidden = nodes.length < 2 || !counts.size;
  for (const candidate of nodes) {
    const running = counts.get(candidate.id);
    if (!running) continue;
    const item = node("span", "control-moves-node");
    item.dataset.testid = "control-moves-node";
    item.dataset.node = candidate.id;
    const all = button("Move all…", "control-moves-all", "control-moves-link");
    all.title = `Select every unfinished agent on ${candidate.name} and choose where to move them`;
    all.addEventListener("click", () => startSelecting(candidate.id).catch((error) => toast.error(error.message)));
    item.append(node("i", `control-moves-dot${candidate.online ? "" : " offline"}`), document.createTextNode(`${candidate.name} · ${running} running `), all);
    strip.append(item);
  }
}

let scheduled = false;
/** Cards are drawn one by one; the bars follow once, after the last one. */
function afterRender() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; renderStrip(); sync(); });
}

registerCardDecorator((root, card) => {
  const box = node("input", "control-pick");
  box.type = "checkbox";
  box.title = "Select to move";
  box.dataset.testid = "control-moves-pick";
  box.checked = picked.has(key(card));
  box.addEventListener("click", (event) => event.stopPropagation());
  box.addEventListener("change", () => {
    if (box.checked) picked.add(key(card)); else picked.delete(key(card));
    sync();
  });
  root.querySelector(".control-card-top")?.prepend(box);
  root.classList.toggle("control-picked", box.checked);
  // While picking, a click on the card picks it instead of opening it.
  root.addEventListener("click", (event) => {
    if (!selecting || event.target.closest("button, input, select, textarea, a, label")) return;
    event.stopImmediatePropagation();
    box.click();
  }, true);
  drawn.push({ card, root, box });
  afterRender();
});

window.addEventListener("control-center-rendered", () => { drawn = []; afterRender(); });

async function startSelecting(fromNodeId) {
  if (!nodes.length) await loadNodes();
  if (nodes.length < 2) { toast("This machine is the only one, so there is nowhere to move to"); return; }
  selecting = true;
  picked.clear();
  if (fromNodeId) for (const { card } of drawn) if (unfinished(card) && nodeOf(card) === fromNodeId) picked.add(key(card));
  fillTargets(fromNodeId ?? (pickedCards()[0] ? nodeOf(pickedCards()[0]) : localId()));
  sync();
}

function stopSelecting() {
  selecting = false;
  picked.clear();
  sync();
}

registerBoardTool({
  id: "select", label: "Select", title: "Pick agents to move to another machine together", order: 20,
  run: () => (selecting ? stopSelecting() : startSelecting()),
});
cancelSelect.addEventListener("click", stopSelecting);
target.addEventListener("change", sync);

// ── Running a batch and following it ───────────────────────────────────────────────────────────────────────

function renderJob() {
  panel.hidden = !job;
  if (!job) return;
  panel.replaceChildren();
  const finished = Boolean(job.finishedAt);
  const heading = node("div", "control-moves-job-head");
  const moved = job.entries.filter((entry) => entry.status === "moved").length;
  heading.append(
    node("b", "", `${finished ? "Moved" : "Moving"} ${finished ? `${moved} of ${job.entries.length}` : job.entries.length} to ${job.targetName}`),
    node("span", "control-moves-mode", job.mode === "now" ? "stop and move now" : "after the current turn"),
  );
  const close = button("Close", "control-moves-job-close");
  close.addEventListener("click", dismissJob);
  const stopWaiting = button("Stop waiting", "control-moves-job-cancel");
  stopWaiting.hidden = finished || !job.entries.some((entry) => entry.status === "waiting");
  stopWaiting.title = "Conversations still waiting for a turn to end stay where they are";
  stopWaiting.addEventListener("click", () => api(`/api/control-center/moves/${encodeURIComponent(job.id)}/cancel`, { method: "POST" }).then(() => poll(job.id)).catch((error) => toast.error(error.message)));
  heading.append(node("span", "control-spacer"), stopWaiting, close);
  const pages = Math.max(1, Math.ceil(job.entries.length / PAGE));
  jobPage = Math.min(jobPage, pages - 1);
  const list = node("ul", "control-moves-entries");
  for (const entry of job.entries.slice(jobPage * PAGE, (jobPage + 1) * PAGE)) {
    const item = node("li", `control-moves-entry ${entry.status}`);
    item.dataset.testid = "control-moves-entry";
    item.dataset.status = entry.status;
    item.append(node("b", "", entry.title), node("span", "control-moves-status", ` ${STATUS[entry.status]}${entry.detail ? `: ${entry.detail}` : ""}`));
    list.append(item);
  }
  panel.append(heading, list);
  if (pages > 1) {
    const nav = node("div", "control-moves-pages");
    const previous = button("Previous", "control-moves-job-previous");
    const next = button("Next", "control-moves-job-next");
    previous.disabled = jobPage === 0;
    next.disabled = jobPage === pages - 1;
    previous.addEventListener("click", () => { jobPage -= 1; renderJob(); });
    next.addEventListener("click", () => { jobPage += 1; renderJob(); });
    nav.append(previous, node("span", "", `${jobPage + 1} of ${pages}`), next);
    panel.append(nav);
  }
}

function dismissJob() {
  clearTimeout(pollTimer);
  job = null;
  renderJob();
}

async function poll(id) {
  clearTimeout(pollTimer);
  try {
    const wasFinished = Boolean(job?.finishedAt);
    job = (await api(`/api/control-center/moves/${encodeURIComponent(id)}`)).job;
    renderJob();
    if (job.finishedAt) {
      if (!wasFinished) void refreshControlCenter().catch(() => undefined);
      return;
    }
  } catch (error) {
    toast.error(error.message);
    return;
  }
  pollTimer = setTimeout(() => poll(id), POLL_MS);
}

async function start(mode) {
  const cards = pickedCards();
  if (!cards.length || !target.value) return;
  const to = nodeName(target.value);
  if (mode === "now" && !await confirmAction({
    title: "Stop and move now?", eyebrow: "Move to another machine", confirmLabel: "Stop and move", destructive: true,
    message: `Stops the running turns of ${cards.length} conversation${cards.length === 1 ? "" : "s"}, moves ${cards.length === 1 ? "it" : "them"} to ${to}, then tells each one to continue and check what was half done before repeating anything.`,
  })) return;
  const started = await api("/api/control-center/moves", {
    method: "POST",
    body: JSON.stringify({ target: target.value, mode, conversations: cards.map((card) => ({ projectId: card.projectId, conversationId: card.conversationId })) }),
  });
  job = started.job;
  jobPage = 0;
  stopSelecting();
  renderJob();
  void poll(job.id);
}

stopAndMove.addEventListener("click", () => start("now").catch((error) => toast.error(error.message)));
moveLater.addEventListener("click", () => start("after-turn").catch((error) => toast.error(error.message)));

// A batch that is already going (started from Bob's chat, or before the page was reloaded) is followed too.
let lastLookedAt = 0;
async function followRunningBatch() {
  lastLookedAt = Date.now();
  if (job) return;
  const running = (await api("/api/control-center/moves")).jobs.find((candidate) => !candidate.finishedAt);
  if (running && !job) { job = running; jobPage = 0; renderJob(); void poll(running.id); }
}

window.addEventListener("control-center-rendered", () => {
  if (!job && Date.now() - lastLookedAt > 10_000) void followRunningBatch().catch((error) => console.warn("Could not look for a running move", error));
});

// Opening the control center shows which machines there are.
window.addEventListener("control-center-activated", () => {
  void (async () => {
    await loadNodes();
    renderStrip();
    await followRunningBatch();
  })().catch((error) => console.warn("Could not load the machines to move to", error));
});
