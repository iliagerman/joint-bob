import { api } from "./api.js";
import { registerCardAction } from "./control-cards.js";
import { refreshControlCenter } from "./control-center.js";
import { createControlViewElement, registerControlView, showControlView } from "./control-views.js";
import { openDashboardMode } from "./dashboards.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/*
 * The control center's Dashboards tab: the project and personal dashboards as cards, one click to look at one over the
 * board, a Dashboard button on every board card, and the "Open dashboards" button of Bob's messages. The dashboards
 * themselves are the existing dashboards feature: the page is its sandboxed frame, refresh is its refresh, and anything
 * beyond looking (editing, sharing, approving) opens its own full view.
 */

// A card has a fixed height and a minimum width, so how many fit a page is a sum rather than a guess.
const CARD_HEIGHT = 132;
const CARD_MIN_WIDTH = 260;
const GAP = 10;
/** A group's title and the gaps around it. */
const HEADING_HEIGHT = 40;
const GROUPS = [
  { id: "project", title: "Projects", hint: "" },
  { id: "me", title: "For me", hint: "not tied to a project" },
];
const MADE_BY = { bob: "made by Bob", you: "yours", shared: "shared with you" };

let cards = [];
let page = 0;
/** Each project's dashboard, for the Dashboard button on its board cards. */
let projectDashboards = new Map();

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
  node.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => toast(error.message, 6000)));
  return node;
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Puts a request into Bob's message box, with the project chosen, for the person to finish and send. */
function askBob(text, projectId) {
  if (projectId) elements.controlChatProject.value = projectId;
  elements.controlChatInput.value = text;
  elements.controlChatInput.focus();
  elements.controlChatInput.setSelectionRange(text.length, text.length);
}

const targetOf = (card) => ({ kind: card.entity.kind, id: card.entity.id, projectId: card.hostProjectId });

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────────

const root = createControlViewElement("dashboards");
root.classList.add("control-dash");
const list = el("div", "control-dash-list");
list.dataset.testid = "control-dashboards-list";
const pager = el("div", "control-dash-pager");
pager.dataset.testid = "control-dashboards-pager";
const heading = el("div", "control-dash-head");
const intro = el("div");
intro.append(el("h2", "", "Dashboards"), el("p", "control-hint", "For projects and for you. Click a card to see it."));
heading.append(intro, button("Ask Bob for a dashboard", "control-dashboards-new", () => askBob("Create a dashboard for ")));
root.append(heading, list, pager);
const tab = registerControlView({ id: "dashboards", title: "Dashboards", order: 40, element: root, onShow: () => { void load().catch((error) => toast(error.message)); } });

/** What the board's project filter leaves: a project's dashboards, and a personal one whose workspace holds a chosen project. */
function filtered() {
  const chosen = state.controlCenter.filter;
  if (!chosen.length) return cards;
  return cards.filter((card) => card.group === "project" ? chosen.includes(card.projectId) : card.projectIds.some((id) => chosen.includes(id)));
}

/** Splits the groups' cards into pages that fit `height`: a page is a few sections, each a title and rows of cards. */
function paginate(groups, columns, height) {
  const rowHeight = CARD_HEIGHT + GAP;
  const pages = [[]];
  let left = height;
  for (const items of groups) {
    let index = 0;
    while (index < items.length) {
      const page = pages.at(-1);
      let rows = Math.floor((left - HEADING_HEIGHT) / rowHeight);
      if (rows < 1 && page.length) { pages.push([]); left = height; continue; }
      rows = Math.max(rows, 1);
      const taken = items.slice(index, index + rows * columns);
      page.push(...taken);
      index += taken.length;
      left -= HEADING_HEIGHT + Math.ceil(taken.length / columns) * rowHeight;
    }
  }
  return pages;
}

function statusLine(card) {
  if (card.status === "building") return { text: "Bob is building it…", busy: true };
  if (card.status === "draft") return { text: "Not finished. Open it to carry on.", busy: false };
  if (card.changing) return { text: "Bob is changing it…", busy: true };
  if (card.origin === "received" && !card.approved) return { text: "Waiting for your approval before it runs here.", busy: false };
  if (card.lastRefresh && !card.lastRefresh.ok) return { text: `The last refresh failed ${ago(card.lastRefresh.at)}.`, busy: false };
  return { text: card.publishedAt || card.lastRefresh ? `Refreshed ${ago(card.publishedAt ?? card.lastRefresh.at)}` : "Not refreshed yet", busy: false };
}

function renderCard(card) {
  const node = el("article", "control-dash-card");
  node.dataset.testid = "control-dashboard-card";
  node.dataset.id = card.id;
  node.dataset.status = card.status;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  const top = el("div", "control-card-top");
  top.append(el("span", "control-project", card.group === "project" ? card.projectName : `Workspace · ${card.workspaceLabel}`), el("span", "control-spacer"), el("span", `control-badge ${card.madeBy}`, MADE_BY[card.madeBy]));
  const status = statusLine(card);
  const line = el("div", "control-dash-state");
  if (status.busy) line.append(el("span", "dashboard-spinner"));
  line.append(el("span", "", status.text));
  const method = card.refreshMethod === "ai" ? "AI refresh · costs AI" : card.refreshMethod === "script" ? "script · no AI" : "";
  node.append(top, el("h3", "control-title", card.title), line, el("div", "control-meta", method));
  const open = () => openCard(card).catch((error) => toast(error.message, 6000));
  node.addEventListener("click", open);
  node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  return node;
}

function renderPager(pages) {
  pager.hidden = pages <= 1;
  const previous = button("Prev", "control-dashboards-prev", () => { page -= 1; render(); });
  const next = button("Next", "control-dashboards-next", () => { page += 1; render(); });
  previous.disabled = page === 0;
  next.disabled = page >= pages - 1;
  const label = el("span", "control-hint", `Page ${page + 1} of ${pages}`);
  label.dataset.testid = "control-dashboards-page-label";
  pager.replaceChildren(previous, label, next);
}

function render() {
  const visible = filtered();
  tab.setBadge(visible.length);
  if (root.hidden) return;
  if (!visible.length) {
    const empty = el("p", "control-empty", cards.length ? "Nothing matches the project filter." : "No dashboards yet. Ask Bob for one, for a project or for you: “create a dashboard for Julian showing bugs per day”.");
    empty.dataset.testid = "control-dashboards-empty";
    list.replaceChildren(empty);
    pager.hidden = true;
    return;
  }
  const byGroup = Object.fromEntries(GROUPS.map((group) => [group.id, visible.filter((card) => card.group === group.id)]));
  const columns = Math.max(1, Math.floor((list.clientWidth + GAP) / (CARD_MIN_WIDTH + GAP)));
  const pages = paginate(GROUPS.map((group) => byGroup[group.id]), columns, list.clientHeight);
  page = Math.min(page, pages.length - 1);
  const onPage = new Set(pages[page]);
  const sections = [];
  for (const group of GROUPS) {
    const shown = byGroup[group.id].filter((card) => onPage.has(card));
    if (!shown.length) continue;
    const title = el("div", "control-lane");
    title.dataset.testid = `control-dashboards-group-${group.id}`;
    title.append(el("b", "", group.title), el("span", "", ` ${byGroup[group.id].length}${group.hint ? ` · ${group.hint}` : ""}`));
    const grid = el("div", "control-dash-grid");
    grid.append(...shown.map(renderCard));
    sections.push(title, grid);
  }
  list.replaceChildren(...sections);
  renderPager(pages.length);
}

async function load() {
  cards = (await api("/api/control-center/dashboards")).dashboards;
  const before = [...projectDashboards.keys()].sort().join();
  projectDashboards = new Map();
  for (const card of cards) if (card.group === "project" && (card.status === "ready" || !projectDashboards.has(card.projectId))) projectDashboards.set(card.projectId, card);
  render();
  // The Dashboard button of a board card depends on what the project has, so the board draws again when that changes.
  if ([...projectDashboards.keys()].sort().join() !== before) await refreshControlCenter();
}

function openCard(card) {
  // What is still being built, or was never finished, is followed and finished in the full view.
  return card.status === "ready" ? openViewer(card) : openDashboardMode(targetOf(card));
}

new ResizeObserver(() => render()).observe(list);
window.addEventListener("control-center-rendered", render);
window.addEventListener("control-center-activated", () => { void load().catch((error) => console.warn("Could not list the dashboards", error)); });
// Bob's message that a dashboard is ready arrives the same way as any message from him.
window.addEventListener("control-center-changed", () => {
  if (document.body.classList.contains("view-control")) void load().catch((error) => console.warn("Could not list the dashboards", error));
});
window.addEventListener("control-bob-action", (event) => {
  if (event.detail.actionId === "dashboards.open") showControlView("dashboards");
});

registerCardAction({
  id: "dashboard", label: "Dashboard", title: "Show this project's dashboard", order: 60,
  visible: (card) => projectDashboards.has(card.projectId),
  run: (card) => openCard(projectDashboards.get(card.projectId)),
});
registerCardAction({
  id: "dashboard-create", label: "Create dashboard", title: "Ask Bob to create a dashboard for this project", order: 61,
  visible: (card) => !projectDashboards.has(card.projectId),
  run: (card) => askBob(`Create a dashboard for ${card.projectName} showing `, card.projectId),
});

// ── The dashboard over the board ──────────────────────────────────────────────────────────────────────────

const dialog = el("dialog", "control-dash-dialog");
dialog.id = "controlDashboardDialog";
dialog.dataset.testid = "control-dashboard-dialog";
dialog.setAttribute("aria-labelledby", "controlDashboardTitle");
const viewer = { card: null, detail: null, frameKey: "", timer: null };
const parts = {
  eyebrow: el("span", "eyebrow"), title: Object.assign(el("h2"), { id: "controlDashboardTitle" }), status: el("div", "dashboard-status"),
  actions: el("div", "dashboard-actions"), ask: el("form", "control-dash-ask"), notices: el("div", "dashboard-notices"), stage: el("div", "dashboard-view-stage"),
};
parts.title.dataset.testid = "control-dashboard-title";
parts.status.dataset.testid = "control-dashboard-status";
parts.status.setAttribute("role", "status");
parts.notices.dataset.testid = "control-dashboard-notices";
parts.ask.hidden = true;
const askText = el("textarea");
askText.rows = 3;
askText.placeholder = "What should change?";
askText.dataset.testid = "control-dashboard-ask-text";
const askSend = el("button", "primary compact", "Send to Bob");
askSend.type = "submit";
askSend.dataset.testid = "control-dashboard-ask-send";
const askCancel = button("Cancel", "control-dashboard-ask-cancel", () => { parts.ask.hidden = true; });
parts.ask.append(askText, el("div", "control-dash-ask-actions"));
parts.ask.lastChild.append(askCancel, askSend);
const close = el("button", "usage-icon-button");
close.type = "button";
close.title = "Close";
close.setAttribute("aria-label", "Close");
close.dataset.testid = "control-dashboard-close";
close.textContent = "×";
close.addEventListener("click", () => dialog.close());
const header = el("header", "dashboard-heading");
const headingText = el("div", "dashboard-heading-text");
headingText.append(parts.eyebrow, parts.title);
header.append(headingText, parts.status, parts.actions, close);
const body = el("div", "control-dash-viewer-body");
body.append(parts.ask, parts.notices, parts.stage);
const dialogCard = el("div", "dialog-card dashboard-card");
dialogCard.append(header, body);
dialog.append(dialogCard);
document.body.append(dialog);
dialog.addEventListener("close", () => { clearTimeout(viewer.timer); viewer.card = null; parts.stage.replaceChildren(); viewer.frameKey = ""; });

const dashboardPath = (suffix = "") => `/api/dashboards/${encodeURIComponent(viewer.card.id)}${suffix}`;
const hostQuery = () => `projectId=${encodeURIComponent(viewer.card.hostProjectId)}`;

function renderStatus() {
  const { dashboard } = viewer.detail;
  const running = dashboard.running;
  const pill = el("span", "dashboard-pill");
  if (running) {
    pill.classList.add("busy");
    pill.append(el("span", "dashboard-spinner"), document.createTextNode("Refreshing"));
  } else {
    const last = dashboard.lastRefresh;
    pill.classList.add(!last ? "idle" : last.ok ? "good" : "bad");
    pill.append(el("span", "dashboard-dot"), document.createTextNode(last ? `${last.ok ? "Refreshed" : "Refresh failed"} ${ago(last.at)}` : dashboard.publishedAt ? `Owner published ${ago(dashboard.publishedAt)}` : "Not refreshed yet"));
  }
  parts.status.replaceChildren(pill, el("span", "dashboard-method", dashboard.refreshMethod === "ai" ? "AI refresh" : "Script, no AI"));
}

function renderActions() {
  const { dashboard } = viewer.detail;
  const ai = dashboard.refreshMethod === "ai";
  const refresh = button(ai ? "Refresh with AI" : "Refresh", "control-dashboard-refresh", startRefresh, "primary compact");
  refresh.title = ai ? "Runs the dashboard agent once. This uses AI and costs tokens." : "Runs the dashboard's script. No AI is used.";
  refresh.disabled = Boolean(dashboard.running) || !dashboard.approved;
  const ask = button("Ask Bob to change it", "control-dashboard-ask-bob", () => { parts.ask.hidden = false; askText.focus(); });
  ask.disabled = !viewer.card.canChange || Boolean(dashboard.running) || viewer.card.changing;
  ask.title = viewer.card.canChange ? "Bob changes it with the dashboard agent and tells you in the chat" : "Make your own copy in the full view first; Bob changes only dashboards this node owns";
  const full = button("Full view", "control-dashboard-full", () => { const target = targetOf(viewer.card); dialog.close(); return openDashboardMode(target); });
  full.title = "Edit, share or approve it in the dashboard view";
  parts.actions.replaceChildren(refresh, ask, full);
}

function renderNotices() {
  const { dashboard } = viewer.detail;
  const notes = [];
  if (dashboard.origin === "received" && !dashboard.approved) {
    const banner = el("div", "dashboard-banner");
    banner.dataset.testid = "control-dashboard-approval";
    banner.append(el("span", "", "This dashboard was shared from another node. It runs here only after you read its files and approve them."),
      button("Review and approve", "control-dashboard-review", () => { const target = targetOf(viewer.card); dialog.close(); return openDashboardMode(target); }, "primary compact"));
    notes.push(banner);
  }
  if (dashboard.refreshMethod === "ai") {
    const note = el("p", "dashboard-note", "This dashboard refreshes with AI: each refresh runs the dashboard agent and uses AI.");
    note.dataset.testid = "control-dashboard-ai-note";
    notes.push(note);
  }
  if (dashboard.lastRefresh && !dashboard.lastRefresh.ok) notes.push(el("p", "dashboard-error", `The last refresh failed: ${dashboard.lastRefresh.error}. The data shown is from the last good refresh.`));
  parts.notices.replaceChildren(...notes);
}

/** The frame reloads only when the page or its data changed. */
function renderFrame() {
  const { dashboard } = viewer.detail;
  const key = `${dashboard.definitionDigest}:${dashboard.lastRefresh?.at ?? ""}:${dashboard.approved}`;
  if (key === viewer.frameKey && parts.stage.firstChild) return;
  viewer.frameKey = key;
  const frame = el("iframe", "dashboard-frame");
  frame.dataset.testid = "control-dashboard-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = "Dashboard";
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  frame.src = `${dashboardPath("/frame")}?${hostQuery()}&theme=${theme}&v=${Date.now()}`;
  parts.stage.replaceChildren(frame);
}

function renderViewer() {
  renderStatus();
  renderActions();
  renderNotices();
  renderFrame();
}

async function loadDetail() {
  viewer.detail = await api(`${dashboardPath()}?${hostQuery()}`);
  renderViewer();
}

/** While a refresh runs the view follows it, and shows the new data when it ends. */
async function follow() {
  clearTimeout(viewer.timer);
  const opened = viewer.card;
  while (viewer.card === opened && viewer.detail.dashboard.running) {
    await new Promise((resolve) => { viewer.timer = setTimeout(resolve, 1000); });
    if (viewer.card !== opened) return;
    await loadDetail();
  }
}

async function startRefresh() {
  await api(dashboardPath("/refresh"), { method: "POST", body: JSON.stringify({ target: "live", projectId: viewer.card.hostProjectId }) });
  await loadDetail();
  await follow();
  await load();
}

async function openViewer(opened) {
  viewer.card = opened;
  viewer.detail = null;
  viewer.frameKey = "";
  parts.ask.hidden = true;
  askText.value = "";
  parts.eyebrow.textContent = opened.group === "project" ? "Project dashboard" : "Workspace dashboard";
  parts.title.textContent = opened.title;
  parts.stage.replaceChildren(el("p", "dashboard-note", "Loading…"));
  parts.status.replaceChildren();
  parts.actions.replaceChildren();
  parts.notices.replaceChildren();
  if (!dialog.open) dialog.showModal();
  await loadDetail();
  await follow();
}

parts.ask.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = askText.value.trim();
  if (!text) { toast("Write what should change"); return; }
  askSend.disabled = true;
  api(`/api/control-center/dashboards/${encodeURIComponent(viewer.card.id)}/ask-bob`, { method: "POST", body: JSON.stringify({ text }) })
    .then(() => {
      dialog.close();
      toast("Bob is changing the dashboard. He will say so in the chat when it is done.");
      // The request and Bob's answer are already in his timeline: the chat reloads it.
      window.dispatchEvent(new CustomEvent("control-center-changed"));
      return load();
    })
    .catch((error) => toast(error.message, 6000))
    .finally(() => { askSend.disabled = false; });
});
