import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";
import { registerControlView } from "./control-views.js";
import { boardTools, cardActionList, decorateCard } from "./control-cards.js";

const DEFAULT_COLOR = "#3a3f46";
const COLUMNS = [
  { id: "needs-you", title: "Needs you", hint: "A step waiting for your OK, or an agent that stopped for you" },
  { id: "running", title: "Running", hint: "The live line is each conversation's running summary" },
  { id: "review", title: "Done · ready for review", hint: "" },
];

let board = { cards: [], projects: [] };
let refreshing = null;
let refreshAgain = false;

let saveTimer = null;

// Colors, positions and the filter belong to the account, so they follow the person to every browser.
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
  const grip = element("span", "control-grip", "⠿");
  grip.title = "Drag to move (Free layout)";
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
  top.append(grip, element("span", "control-project", card.projectName));
  if (card.startedBy === "bob") top.append(element("span", "control-badge", "started by Bob"));
  if (card.autoRespondActive) top.append(element("span", "control-badge", "auto respond"));
  top.append(element("span", "control-spacer"), picker);

  if (card.pendingReviews?.length || card.autoRespondStop) root.append(renderNeed(card));
  const live = element("div", "control-live");
  live.append(element("span", `control-pulse ${card.column === "running" ? "running" : "review"}`));
  live.append(element("span", "", card.summary ?? (card.column === "running" ? "Working…" : "Finished. Open it to review.")));

  const meta = [card.agentLabel, card.agentModel, card.backgroundRunning && !card.turnRunning ? "background tasks" : null, card.updatedAt ? formatDate(card.updatedAt) : null].filter(Boolean).join(" · ");
  root.append(top, element("h3", "control-title", card.title), live, element("div", "control-meta", meta));
  const buttons = cardActionList(card);
  if (buttons.length) {
    const row = element("div", "control-card-actions");
    for (const action of buttons) {
      const button = element("button", "control-card-action", action.label);
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

function renderNeed(card) {
  const need = element("div", "control-need");
  need.dataset.testid = "control-center-need";
  for (const review of card.pendingReviews ?? []) {
    need.append(element("div", "control-need-title", review.title), element("div", "control-need-subject", review.subject), element("div", "control-meta", review.detail));
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
  }
  if (card.autoRespondStop) need.append(element("div", "control-need-title", "Auto respond stopped"), element("div", "control-need-subject", card.autoRespondStop.reason || card.autoRespondStop.kind));
  return need;
}

function renderGrouped(container, cards) {
  for (const column of COLUMNS) {
    const inColumn = cards.filter((card) => card.column === column.id);
    if (!inColumn.length) continue;
    const heading = element("div", "control-lane");
    heading.append(element("b", "", column.title), element("span", "", ` ${inColumn.length}${column.hint ? ` · ${column.hint}` : ""}`));
    const grid = element("div", "control-grid");
    grid.append(...inColumn.map(renderCard));
    container.append(heading, grid);
  }
}

function renderFree(container, cards) {
  container.classList.add("free");
  const columns = Math.max(1, Math.floor((container.clientWidth || 900) / 290));
  cards.forEach((card, index) => {
    const node = renderCard(card);
    const saved = state.controlCenter.positions[cardKey(card)] ?? { x: (index % columns) * 290, y: Math.floor(index / columns) * 190 };
    node.style.left = `${saved.x}px`;
    node.style.top = `${saved.y}px`;
    node.querySelector(".control-grip").addEventListener("mousedown", (event) => dragCard(event, node, card));
    container.append(node);
  });
}

function dragCard(event, node, card) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX - node.offsetLeft;
  const startY = event.clientY - node.offsetTop;
  const move = (moveEvent) => {
    node.style.left = `${Math.max(0, moveEvent.clientX - startX)}px`;
    node.style.top = `${Math.max(0, moveEvent.clientY - startY)}px`;
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    state.controlCenter.positions[cardKey(card)] = { x: node.offsetLeft, y: node.offsetTop };
    save();
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
}

function render() {
  window.dispatchEvent(new CustomEvent("control-center-rendered", { detail: { projects: board.projects, cards: board.cards } }));
  renderFilters();
  for (const button of elements.controlCenterLayout.querySelectorAll("button")) button.classList.toggle("active", button.dataset.layout === state.controlCenter.layout);
  const container = elements.controlCenterBoard;
  container.replaceChildren();
  container.classList.remove("free");
  const cards = visibleCards();
  const waiting = cards.filter((card) => card.column === "needs-you").length;
  elements.controlCenterCount.textContent = `${cards.filter((card) => card.column === "running").length} running${waiting ? ` · ${waiting} need you` : ""}`;
  liveView.setBadge(cards.filter((card) => card.column !== "review").length);
  if (!cards.length) {
    container.append(element("p", "control-empty", board.cards.length ? "Nothing matches the project filter." : "No conversations are running and nothing is waiting for review."));
    return;
  }
  if (state.controlCenter.layout === "free") renderFree(container, cards);
  else renderGrouped(container, cards);
}

export function refreshControlCenter() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      board = await api("/api/control-center/board");
      render();
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

function resetLayout() {
  const { chatSide, chatWidth } = state.controlCenter;
  state.controlCenter = { colors: {}, positions: {}, layout: "grouped", filter: [], chatSide, chatWidth };
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

for (const button of elements.controlCenterLayout.querySelectorAll("button")) {
  button.addEventListener("click", () => { state.controlCenter.layout = button.dataset.layout; save(); render(); });
}
elements.controlCenterReset.addEventListener("click", resetLayout);
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
