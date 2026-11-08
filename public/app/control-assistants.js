import { api } from "./api.js";
import { createControlViewElement, currentControlView, registerControlView, showControlView } from "./control-views.js";
import { openAssistantChat, syncAssistantChat } from "./control-assistants-chat.js";
import { toast } from "./shell.js";

/*
 * The control center's Assistants: the person's own assistants on every machine of their cluster, as cards. Bob asks them
 * when a message needs what they have (there are no ask buttons here: the person just asks Bob), and a card's switch says
 * whether Bob may. A click opens the assistant's own chat. Below 1700 px the cards are a tab; from 1700 px the same list is
 * a column between the board and Bob's chat that can be folded away.
 */

// A card has a fixed height, so how many fit a page is a sum rather than a guess.
const CARD_HEIGHT = 128;
const CARD_MIN_WIDTH = 270;
const GAP = 10;
const WIDE = matchMedia("(min-width: 1700px)");
const STATE_LABEL = { idle: "idle", busy: "busy", "answering-bob": "answering Bob" };

let assistants = [];
let loaded = 0;
let loadCounter = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, testid, onClick, className = "ghost compact") {
  const node = el("button", className, label);
  node.type = "button";
  node.dataset.testid = testid;
  node.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => toast.error(error.message)));
  return node;
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

// ── Changing the switch ─────────────────────────────────────────────────────────────────────────────────

/** Turns Bob's "may ask" for one assistant on or off, then draws every list again. */
async function setMayAsk(card, enabled) {
  const { assistant } = await api(`/api/control-center/assistants/${encodeURIComponent(card.id)}/may-ask`, { method: "PUT", body: JSON.stringify({ enabled }) });
  assistants = assistants.map((candidate) => (candidate.id === assistant.id ? assistant : candidate));
  renderAll();
  syncAssistantChat(assistants);
  return assistant;
}

const handlers = { setMayAsk };

// ── A card ──────────────────────────────────────────────────────────────────────────────────────────────

function lastLine(card) {
  const ask = card.lastAsk;
  if (card.shared) return { text: card.reason, warn: true };
  if (card.state === "answering-bob" && ask) return { text: `Bob is asking “${clip(ask.question, 90)}”`, warn: false };
  if (!ask) return card.mayAsk ? { text: "Bob has not asked it yet.", warn: false } : { text: card.reason, warn: true };
  const outcome = ask.status === "failed" ? "no answer" : ask.status === "running" ? "still working" : `${ask.seconds ?? 1} s`;
  return { text: `Bob asked “${clip(ask.question, 80)}” · ${outcome} · ${ago(ask.startedAt)}`, warn: false };
}

function renderCard(card) {
  const node = el("article", "control-asst-card");
  node.dataset.testid = "control-assistant-card";
  node.dataset.id = card.id;
  node.dataset.name = card.name;
  node.dataset.state = card.state;
  node.dataset.askable = String(card.askable);
  node.classList.toggle("off", !card.askable);
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `Open ${card.name}`);

  const head = el("div", "control-asst-head");
  const name = el("div", "control-asst-name");
  const title = el("b");
  title.append(el("span", "control-asst-title", card.name));
  if (card.isDefault) title.append(el("span", "control-badge", "default"));
  const where = el("small");
  where.append(document.createTextNode(`${card.machine} · `), el("i", `control-asst-dot ${card.state}`), document.createTextNode(STATE_LABEL[card.state]));
  where.dataset.testid = "control-assistant-where";
  name.append(title, where);
  const toggle = el("button", "control-asst-switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(card.askable));
  toggle.setAttribute("aria-label", `Bob may ask ${card.name}`);
  toggle.title = card.askable ? "Bob may ask this assistant" : card.reason;
  toggle.disabled = card.shared;
  toggle.dataset.testid = "control-assistant-switch";
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setMayAsk(card, !card.askable).catch((error) => toast.error(error.message));
  });
  head.append(el("span", "control-asst-face", card.name.trim().slice(0, 1).toUpperCase() || "?"), name, el("span", "control-spacer"), toggle);

  const has = el("div", "control-asst-has");
  has.dataset.testid = "control-assistant-has";
  has.append(...card.has.slice(0, 3).map((label) => el("span", "", label)));
  if (card.has.length > 3) has.append(el("span", "", `+${card.has.length - 3}`));
  if (!card.has.length) has.append(el("span", "none", "nothing attached"));

  const last = lastLine(card);
  const line = el("div", `control-asst-last${last.warn ? " warn" : ""}`, last.text);
  line.dataset.testid = "control-assistant-last";
  line.title = last.text;
  node.append(head, has, line);

  const open = () => openAssistantChat(card, handlers).catch((error) => toast.error(error.message));
  node.addEventListener("click", open);
  node.addEventListener("keydown", (event) => {
    if (event.target === node && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); }
  });
  return node;
}

// ── The lists: the tab, and the column from 1700 px ─────────────────────────────────────────────────────────

/** Both show the same cards, as many as fit their height, paged. */
function makeSurface(list, pager, { single }) {
  return { list, pager, single, page: 0 };
}

function renderPager(surface, pages) {
  surface.pager.hidden = pages <= 1;
  const previous = button("Prev", "control-assistants-prev", () => { surface.page -= 1; renderSurface(surface); });
  const next = button("Next", "control-assistants-next", () => { surface.page += 1; renderSurface(surface); });
  previous.disabled = surface.page === 0;
  next.disabled = surface.page >= pages - 1;
  const label = el("span", "control-hint", `${surface.page + 1} / ${pages}`);
  label.dataset.testid = "control-assistants-page-label";
  surface.pager.replaceChildren(previous, label, next);
}

function renderSurface(surface) {
  const { list } = surface;
  // A hidden list has no height: it is drawn when it is shown.
  if (!list.clientHeight) return;
  if (!assistants.length) {
    const empty = el("p", "control-empty", loaded ? "No assistants yet. Open a conversation and choose Create assistant in its toolbar; Bob can then ask it." : "Loading…");
    empty.dataset.testid = "control-assistants-empty";
    list.replaceChildren(empty);
    surface.pager.hidden = true;
    return;
  }
  const columns = surface.single ? 1 : Math.max(1, Math.floor((list.clientWidth + GAP) / (CARD_MIN_WIDTH + GAP)));
  const rows = Math.max(1, Math.floor((list.clientHeight + GAP) / (CARD_HEIGHT + GAP)));
  const size = rows * columns;
  const pages = Math.max(1, Math.ceil(assistants.length / size));
  surface.page = Math.min(surface.page, pages - 1);
  const grid = el("div", `control-asst-grid${surface.single ? " single" : ""}`);
  grid.append(...assistants.slice(surface.page * size, (surface.page + 1) * size).map(renderCard));
  list.replaceChildren(grid);
  renderPager(surface, pages);
}

// The tab.
const root = createControlViewElement("assistants");
root.classList.add("control-asst");
root.dataset.testid = "control-assistants";
const tabList = el("div", "control-asst-list");
tabList.dataset.testid = "control-assistants-list";
const tabPager = el("div", "control-asst-pager");
tabPager.dataset.testid = "control-assistants-pager";
const heading = el("div", "control-asst-heading");
const intro = el("div");
intro.append(el("h2", "", "Assistants"), el("p", "control-hint", "Your own assistants on every machine of your cluster. Just ask Bob: he asks them when your message needs what they have. Click one to open its chat."));
const manage = el("a", "ghost compact control-asst-link", "Assistants page");
manage.href = "/assistant.html";
manage.target = "_blank";
manage.rel = "noopener";
manage.dataset.testid = "control-assistants-manage";
heading.append(intro, manage);
root.append(heading, tabList, tabPager);
const tab = registerControlView({ id: "assistants", title: "Assistants", order: 50, element: root, onShow: () => { void load().catch((error) => toast.error(error.message)); } });
const tabSurface = makeSurface(tabList, tabPager, { single: false });

// The column.
const rail = el("aside", "control-asst-rail");
rail.dataset.testid = "control-assistants-rail";
rail.setAttribute("aria-label", "Assistants");
const railHead = el("div", "control-asst-rail-head");
const railTitle = el("b", "", "Assistants");
const railCount = el("span", "control-badge", "0");
railCount.dataset.testid = "control-assistants-rail-count";
const fold = el("button", "ghost compact control-asst-fold", "‹");
fold.type = "button";
fold.dataset.testid = "control-assistants-rail-toggle";
fold.setAttribute("aria-expanded", "true");
fold.title = "Fold the assistants column";
railHead.append(railTitle, railCount, el("span", "control-spacer"), fold);
const railList = el("div", "control-asst-list");
railList.dataset.testid = "control-assistants-rail-list";
const railPager = el("div", "control-asst-pager");
const railHint = el("p", "control-hint control-asst-hint", "Just ask Bob: he asks them when your message needs what they have. Other people's assistants only through what they publish.");
rail.append(railHead, railList, railPager, railHint);
document.querySelector("#controlViews").after(rail);
const railSurface = makeSurface(railList, railPager, { single: true });
fold.addEventListener("click", () => {
  const folded = rail.classList.toggle("folded");
  fold.textContent = folded ? "›" : "‹";
  fold.setAttribute("aria-expanded", String(!folded));
  fold.title = folded ? "Show the assistants column" : "Fold the assistants column";
  renderAll();
});

function renderAll() {
  tab.setBadge(assistants.length);
  railCount.textContent = String(assistants.length);
  renderSurface(tabSurface);
  renderSurface(railSurface);
}

async function load() {
  const mine = ++loadCounter;
  const { assistants: found } = await api("/api/control-center/assistants");
  if (mine !== loadCounter) return;
  assistants = found;
  loaded += 1;
  renderAll();
  syncAssistantChat(assistants);
}

new ResizeObserver(() => renderSurface(tabSurface)).observe(tabList);
new ResizeObserver(() => renderSurface(railSurface)).observe(railList);
// The column replaces the tab on a wide screen, so a tab that is open then goes back to the board.
WIDE.addEventListener("change", () => {
  if (WIDE.matches && currentControlView() === "assistants") showControlView("live");
  renderAll();
});
window.addEventListener("control-center-activated", () => { void load().catch((error) => console.warn("Could not list the assistants", error)); });
// An ask starting or ending, and Bob's replies, arrive the way any news for the control center does.
window.addEventListener("control-center-changed", () => {
  if (document.body.classList.contains("view-control")) void load().catch((error) => console.warn("Could not list the assistants", error));
});
