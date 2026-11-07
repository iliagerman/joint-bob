import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";
import { registerControlView } from "./control-views.js";
import { chooseConversationFeedback } from "./conversation-feedback.js";
import { boardTools, briefStatus, cardActionList, decorateCard, projectActionList, registerCardAction } from "./control-cards.js";
import { glide, positions, vanish } from "./control-vanish.js";

const DEFAULT_COLOR = "#3a3f46";
const COLUMNS = [
  { id: "needs-you", title: "Needs you", hint: "A step waiting for your OK, or an agent that stopped for you" },
  { id: "running", title: "Running", hint: "Where each one stands; hover a card for its summary" },
  { id: "review", title: "Done · ready for review", hint: "" },
];

let board = { cards: [], projects: [] };
let refreshing = null;
let refreshAgain = false;

let saveTimer = null;

// Colors and the filter belong to the account, so they follow the person to every browser.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => savePreferencesInBackground({ controlCenter: state.controlCenter }), 400);
}

const cardKey = (card) => `${card.projectId}:${card.conversationId}`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visibleCards() {
  const filter = new Set(state.controlCenter.filter);
  return board.cards.filter((card) => !filter.size || filter.has(card.projectId));
}

function renderFilters() {
  const chips = elements.controlCenterFilters;
  chips.replaceChildren();
  const all = element("button", "control-chip", "All");
  all.type = "button";
  all.classList.toggle("active", !state.controlCenter.filter.length);
  all.addEventListener("click", () => { state.controlCenter.filter = []; save(); render(); });
  chips.append(all);
  const withCards = new Set(board.cards.map((card) => card.projectId));
  for (const project of board.projects.filter((item) => withCards.has(item.id) || state.controlCenter.filter.includes(item.id))) {
    const chip = element("button", "control-chip", project.name);
    chip.type = "button";
    chip.classList.toggle("active", state.controlCenter.filter.includes(project.id));
    chip.addEventListener("click", () => {
      state.controlCenter.filter = state.controlCenter.filter.includes(project.id) ? state.controlCenter.filter.filter((id) => id !== project.id) : [...state.controlCenter.filter, project.id];
      save();
      render();
    });
    chips.append(chip);
  }
}

function renderCard(card) {
  const root = element("article", "control-card");
  root.dataset.testid = "control-center-card";
  root.dataset.key = cardKey(card);
  root.dataset.column = card.column;
  const color = state.controlCenter.colors[cardKey(card)];
  if (color) {
    root.style.setProperty("--card-color", color);
    root.classList.add("colored");
  }

  const top = element("div", "control-card-top");
  const picker = element("input", "control-color");
  picker.type = "color";
  picker.value = color ?? DEFAULT_COLOR;
  picker.title = "Pick a color for this card";
  picker.dataset.testid = "control-center-color";
  picker.addEventListener("click", (event) => event.stopPropagation());
  picker.addEventListener("input", () => {
    state.controlCenter.colors[cardKey(card)] = picker.value;
    root.style.setProperty("--card-color", picker.value);
    root.classList.add("colored");
    save();
  });
  const driver = driverOf(card);
  root.dataset.driver = driver?.id ?? "you";
  if (driver) {
    const ribbon = element("span", `control-driver ${driver.id}`, driver.label);
    ribbon.title = driver.title;
    ribbon.dataset.testid = "control-card-driver";
    top.append(ribbon);
  }
  if (card.column === "review") top.append(element("span", "control-badge review", "To review"));
  top.append(element("span", "control-spacer"), picker);

  // A step waiting for the person takes the status's place, so every card keeps the same size.
  const body = element("div", "control-card-body");
  if (card.pendingReviews?.length || card.autoRespondStop) body.append(renderNeed(card));
  else {
    body.append(renderLive(card));
    const checked = checkLine(card);
    if (checked) body.append(checked);
  }

  const meta = [card.agentLabel, card.agentModel, card.backgroundRunning && !card.turnRunning ? "background tasks" : null, card.updatedAt ? formatDate(card.updatedAt) : null].filter(Boolean).join(" · ");
  const title = element("h3", "control-title", card.title);
  const metaLine = element("div", "control-meta", meta);
  metaLine.title = meta;
  root.append(top, title, body, metaLine);
  const buttons = cardActionList(card);
  if (buttons.length) {
    const row = element("div", "control-card-actions");
    for (const action of buttons) {
      const button = element("button", "control-card-action", action.label);
      // Not a class: the app's own `.primary` buttons are taller than a card's row.
      if (action.style) button.dataset.style = action.style;
      button.type = "button";
      button.title = action.title;
      button.dataset.testid = `control-card-action-${action.id}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        Promise.resolve(action.run(card)).catch((error) => toast(error.message));
      });
      row.append(button);
    }
    root.append(row);
  }
  decorateCard(root, card);
  root.addEventListener("click", () => openCard(card).catch((error) => toast(error.message)));
  return root;
}

/**
 * Where the conversation stands: what a running turn is doing now (its tool, or the last line it wrote), over the first sentence
 * of the summary's current state. Hover for the whole summary.
 */
function renderLive(card) {
  const live = element("div", "control-live");
  live.append(element("span", `control-pulse ${card.column === "running" ? "running" : "review"}`));
  const lines = element("div", "control-live-lines");
  const status = briefStatus(card.summary);
  if (card.activity) {
    live.classList.add("has-now");
    const now = element("span", "control-live-now", card.activity);
    now.dataset.testid = "control-card-activity";
    lines.append(now);
  }
  if (status || !card.activity) lines.append(element("span", "control-live-text", status ?? (card.column === "running" ? "Working…" : "Finished. Open it to review.")));
  live.append(lines);
  return live;
}

/** The first step waiting for the person, in the card's status room: the others follow once it is answered. */
function renderNeed(card) {
  const need = element("div", "control-need");
  need.dataset.testid = "control-center-need";
  const [review] = card.pendingReviews ?? [];
  if (review) {
    const more = card.pendingReviews.length - 1;
    need.title = [review.title, review.subject, review.detail].filter(Boolean).join("\n");
    need.append(element("div", "control-need-title", more ? `${review.title} · ${more} more` : review.title), element("div", "control-need-subject", review.subject));
    const buttons = element("div", "control-need-actions");
    for (const [decision, label, className] of [["allow", "Allow once", "control-action warn"], ["block", "Block", "control-action"]]) {
      const button = element("button", className, label);
      button.type = "button";
      button.dataset.testid = `control-review-${decision}`;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        button.disabled = true;
        api("/api/control-center/guardian/decide", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, reviewId: review.id, decision }) })
          .then(() => refreshControlCenter()).catch((error) => { toast(error.message); button.disabled = false; });
      });
      buttons.append(button);
    }
    need.append(buttons);
    return need;
  }
  const reason = card.autoRespondStop.reason || card.autoRespondStop.kind;
  need.title = `Auto respond stopped\n${reason}`;
  need.append(element("div", "control-need-title", "Auto respond stopped"), element("div", "control-need-subject", reason));
  return need;
}

/** What Bob found when the conversation stopped: done, told to go on, or waiting for the person. */
function checkLine(card) {
  const check = card.reviewCheck;
  if (!check) return null;
  const text = check.needsYou && card.column === "needs-you" ? `✋ Not done, waits for you${check.reason ? `: ${check.reason}` : ""}`
    : check.pushPending && card.column === "running" ? `↻ Bob told it to go on (${check.pushes} of 3)`
    : check.verdict === "done" && card.column === "review" ? "✓ Bob checked: done"
    : null;
  if (!text) return null;
  const line = element("div", `control-check ${check.needsYou ? "needs" : check.verdict}`, text);
  line.title = check.by;
  line.dataset.testid = "control-card-check";
  return line;
}

/**
 * Who moves a conversation forward when the person is not in it: the system answering for the agent (auto respond), or Bob
 * watching it because he started it. Null for the person's own conversations.
 */
function driverOf(card) {
  if (card.controlledBy === "you") return { id: "you-in", label: "✋ You're in it", title: "You took control; Bob and auto respond stay out" };
  if (card.autoRespondActive) return { id: "system", label: "⚙ System drives", title: "Auto respond answers this agent for you, and Bob is told when it stops" };
  if (card.reviewCheck?.pushPending && card.column === "running") return { id: "system", label: "⚙ System drives", title: "It stopped before it was done, so Bob told it to go on" };
  if (card.startedBy === "bob") return { id: "watched", label: "👁 Bob watches", title: "Bob started this and tells you when it needs you" };
  return null;
}

// Each lane groups its conversations by project, projects in name order and the newest conversation first, so a project's work sits together.
const byProjectThenNewest = (a, b) => a.projectName.localeCompare(b.projectName) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

function renderProjectGroup(cards) {
  const [first] = cards;
  const group = element("div", "control-project-group");
  group.dataset.testid = "control-project-group";
  group.dataset.project = first.projectId;
  const header = element("div", "control-project-head");
  header.append(element("b", "", first.projectName), element("span", "control-project-count", String(cards.length)));
  const project = { projectId: first.projectId, projectName: first.projectName };
  for (const action of projectActionList(project)) {
    const button = element("button", "control-card-action", action.label);
    button.type = "button";
    button.title = action.title;
    button.dataset.testid = `control-project-action-${action.id}`;
    button.addEventListener("click", () => Promise.resolve(action.run(project)).catch((error) => toast(error.message)));
    header.append(button);
  }
  const list = element("div", "control-project-cards");
  list.append(...cards.map(renderCard));
  group.append(header, list);
  return group;
}

function renderLanes(container, cards) {
  for (const column of COLUMNS) {
    const inColumn = cards.filter((card) => card.column === column.id).sort(byProjectThenNewest);
    if (!inColumn.length) continue;
    const heading = element("div", "control-lane");
    heading.dataset.column = column.id;
    heading.append(element("b", "", column.title), element("span", "control-lane-count", String(inColumn.length)), element("span", "", column.hint));
    const groups = element("div", "control-lane-groups");
    for (let index = 0; index < inColumn.length;) {
      const end = inColumn.findIndex((card, at) => at > index && card.projectId !== inColumn[index].projectId);
      const stop = end < 0 ? inColumn.length : end;
      groups.append(renderProjectGroup(inColumn.slice(index, stop)));
      index = stop;
    }
    container.append(heading, groups);
  }
}

function render() {
  // The chat follows the board's focus: one project chosen here filters it to that project.
  window.dispatchEvent(new CustomEvent("control-center-rendered", { detail: { projects: board.projects, cards: board.cards, focus: [...state.controlCenter.filter] } }));
  renderFilters();
  const container = elements.controlCenterBoard;
  container.replaceChildren();
  const cards = visibleCards();
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  const driven = cards.filter((card) => driverOf(card)?.id === "system").length;
  const watched = cards.filter((card) => driverOf(card)?.id === "watched").length;
  elements.controlCenterCount.textContent = [
    `${cards.filter((card) => card.column === "running").length} running`, waiting ? `${waiting} need you` : "",
    driven ? `${driven} driven by the system` : "", watched ? `${watched} watched by Bob` : "",
  ].filter(Boolean).join(" · ");
  liveView.setBadge(cards.filter((card) => card.column !== "review").length);
  if (!cards.length) {
    container.append(element("p", "control-empty", board.cards.length ? "Nothing matches the project filter." : "No conversations are running and nothing is waiting for review."));
    return;
  }
  renderLanes(container, cards);
}

/** Cards marked done here, with the word their way out shows. */
const settledHere = new Map();

/**
 * Cards no longer on the board leave with an animation, all together: a check and what settled them for one marked done here,
 * a fade for the rest. The cards that stay then glide to their new places.
 */
async function drawBoard(next) {
  const container = elements.controlCenterBoard;
  if (isControlCenterOpen()) {
    const keys = new Set(next.cards.map(cardKey));
    const gone = [...container.querySelectorAll(".control-card")].filter((node) => !keys.has(node.dataset.key));
    await Promise.all(gone.map((node) => vanish(node, settledHere.get(node.dataset.key))));
    for (const node of gone) settledHere.delete(node.dataset.key);
  }
  const before = positions(container, ".control-card");
  board = next;
  render();
  glide(container, ".control-card", before);
}

export function refreshControlCenter() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await drawBoard(await api("/api/control-center/board"));
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/**
 * Opens a conversation by its project and conversation id (or its path), the way a card does. From the control center it
 * opens over the board, to read; replying needs Take control. Closing it goes back to the board.
 */
export async function openConversation(card) {
  const overBoard = isControlCenterOpen();
  state.keepControlView = overBoard;
  try {
    if (state.activeProjectId !== card.projectId) await selectProject(card.projectId);
    const session = state.sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === card.conversationId) ?? (card.path ? state.sessions.find((candidate) => candidate.path === card.path) : undefined);
    if (!session) {
      toast("That conversation is no longer listed");
      await refreshControlCenter();
      return;
    }
    if (overBoard) {
      document.body.classList.add("control-popup");
      window.dispatchEvent(new CustomEvent("control-popup-opened", { detail: card }));
    }
    await openListedSession(session);
  } finally {
    state.keepControlView = false;
  }
}

export function closeConversationPopup() {
  if (!document.body.classList.contains("control-popup")) return;
  document.body.classList.remove("control-popup");
  window.dispatchEvent(new CustomEvent("control-popup-closed"));
}

const openCard = openConversation;

/** Focuses the board on one project, or on all of them with null. Bob's chat calls it when its project filter changes. */
export function focusProject(projectId) {
  state.controlCenter.filter = projectId ? [projectId] : [];
  save();
  render();
}

/** Closes a finished conversation as its project's list does: the same question about what to learn, and the same request. */
async function markDone(card) {
  const feedback = await chooseConversationFeedback(card);
  if (!feedback) return;
  await api(`/api/projects/${encodeURIComponent(card.projectId)}/sessions/done`, {
    method: "PUT", body: JSON.stringify({ sessionId: card.conversationId, engine: card.harnessId, done: true, feedback }),
  });
  settledHere.set(cardKey(card), "Done");
  await refreshControlCenter();
}

// Reviewing a finished conversation is reading it: opening it marks it reviewed, and it leaves the review lane.
registerCardAction({
  id: "review", label: "Review", style: "primary", order: 1, title: "Open it to read what it did; once you have looked, it leaves Done · ready for review",
  visible: (card) => card.column === "review", run: (card) => openConversation(card),
});
// Done or Abandon pressed in Bob's chat: the conversation's card goes with the same check as the message.
window.addEventListener("control-bob-action", ({ detail }) => {
  if (detail.actionId === "conversation.done" || detail.actionId === "conversation.abandon") settledHere.set(`${detail.data.projectId}:${detail.data.conversationId}`, detail.label);
});
registerCardAction({ id: "done", label: "Done", order: 2, title: "Close it: it leaves the board, and you can open it again from its project", visible: (card) => card.column === "review", run: markDone });

function resetBoard() {
  const { chatSide, chatWidth } = state.controlCenter;
  state.controlCenter = { colors: {}, filter: [], chatSide, chatWidth };
  save();
  render();
}

export function isControlCenterOpen() {
  return document.body.classList.contains("view-control");
}

/** Called by the chat to save the chat's side and width with the rest of the board's settings. */
export function saveControlCenter() { save(); }

export function activateControlCenter() {
  window.dispatchEvent(new CustomEvent("control-center-activated"));
  return refreshControlCenter();
}

const liveView = registerControlView({ id: "live", title: "Live agents", order: 0, element: elements.controlViewLive });

elements.controlCenterReset.addEventListener("click", resetBoard);
function renderBoardTools() {
  for (const old of elements.controlViewLive.querySelectorAll("[data-board-tool]")) old.remove();
  for (const tool of boardTools()) {
    const button = element("button", "ghost compact", tool.label);
    button.type = "button";
    button.title = tool.title;
    button.dataset.boardTool = tool.id;
    button.dataset.testid = `control-board-tool-${tool.id}`;
    button.addEventListener("click", () => Promise.resolve(tool.run()).catch((error) => toast(error.message)));
    elements.controlCenterReset.before(button);
  }
}
window.addEventListener("control-board-tools-changed", renderBoardTools);
renderBoardTools();
elements.controlCenterRefresh.addEventListener("click", () => refreshControlCenter().catch((error) => toast(error.message)));
// What waits for the person shows on the toolbar icon, so they know without opening the control center.
const badge = element("span", "control-icon-badge");
badge.hidden = true;
badge.dataset.testid = "control-center-waiting-badge";
elements.openControlCenterButton.append(badge);
let waitingChecked = Promise.resolve();
function refreshWaiting() {
  waitingChecked = waitingChecked.then(() => api("/api/control-center/summary")).then(({ waiting }) => {
    badge.textContent = waiting > 99 ? "99+" : String(waiting);
    badge.hidden = waiting === 0;
    elements.openControlCenterButton.setAttribute("aria-label", waiting ? `Open the control center, ${waiting} waiting for you` : "Open the control center");
  }).catch((error) => console.warn("Could not read what waits for you", error));
}
// The running list and the server already announce every change; the board and the badge follow the same signals.
function onChanged() {
  if (isControlCenterOpen()) refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
  refreshWaiting();
}
window.addEventListener("running-refreshed", onChanged);
// What a running turn is doing changes all the time, so while the board is in view and something runs it is read again.
const LIVE_REFRESH_MS = 10_000;
setInterval(() => {
  if (!isControlCenterOpen() || document.hidden || !board.cards.some((card) => card.column === "running")) return;
  refreshControlCenter().catch((error) => console.warn("Could not refresh the control center", error));
}, LIVE_REFRESH_MS);
window.addEventListener("control-center-changed", onChanged);
// Leaving the control center closes the conversation over it.
window.addEventListener("app-view-changed", () => { if (!isControlCenterOpen()) closeConversationPopup(); });
// Esc closes the conversation over the board before it can leave the control center.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !document.body.classList.contains("control-popup")) return;
  if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select")) return;
  event.preventDefault();
  closeConversationPopup();
}, true);
