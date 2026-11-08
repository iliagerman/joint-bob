// Control center: incoming triggers. The calls webhooks receive are rated urgent or not on the server. An urgent one is a
// message in Bob's chat, with buttons. The rest wait here: a bell in Bob's header counts the new ones, and its panel lists
// them a page at a time with Open, Ask Bob to triage and Dismiss. The server tells open pages when one arrives.
import { api } from "./api.js";
import { elements } from "./elements.js";
import { createFittedList, makeButton, makeNode } from "./relay-ui.js";
import { toast } from "./shell.js";
import { openProjectWebhooks } from "./webhooks.js";

const BASE = "/api/control-center/triggers";

let newCount = 0;
/** What the open panel has shown that was new: it counts as seen when the panel closes. */
const shownNew = new Set();

const testid = (node, id) => { node.dataset.testid = id; return node; };

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// ── The bell and its panel ───────────────────────────────────────────────────────────────────────────────

function bellIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const bell = testid(makeNode("button", "ghost compact control-bell"), "control-triggers-bell");
bell.type = "button";
bell.title = "Incoming triggers that can wait";
bell.setAttribute("aria-haspopup", "true");
bell.setAttribute("aria-expanded", "false");
const badge = testid(makeNode("span", "control-bell-badge"), "control-triggers-count");
badge.hidden = true;
bell.append(bellIcon(), badge);
elements.controlChatMonitor.before(bell);

const panel = testid(makeNode("section", "control-triggers"), "control-triggers-panel");
panel.hidden = true;
panel.setAttribute("aria-label", "Incoming triggers that can wait");
const dismissAll = makeButton("Dismiss all", "control-triggers-dismiss-all", () => dismissEvery());
const head = makeNode("div", "control-triggers-head");
head.append(makeNode("b", "", "Incoming · can wait"), makeNode("span", "control-spacer"), dismissAll);
const list = testid(makeNode("div", "control-triggers-list"), "control-triggers-list");
const pager = testid(makeNode("div", "control-triggers-pager"), "control-triggers-pager");
const hint = testid(makeNode("p", "control-triggers-hint", "Bob follows each call to the conversation working on it: settled ones clear themselves, and what needs you goes to his chat."), "control-triggers-hint");
panel.append(head, list, pager, hint);
elements.controlChat.append(panel);

function setCount(count) {
  newCount = count;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  bell.setAttribute("aria-label", count ? `Incoming triggers, ${count} new` : "Incoming triggers");
  // The phone view shows the same bell, so it hears the count.
  window.dispatchEvent(new CustomEvent("control-triggers-changed", { detail: { count } }));
}

async function markSeen(ids) {
  if (!ids.length) return;
  try {
    const { marked } = await api(`${BASE}/seen`, { method: "POST", body: JSON.stringify({ ids }) });
    setCount(Math.max(0, newCount - marked));
  } catch (error) { console.warn("Could not mark triggers as seen", error); }
}

const isOpen = () => !panel.hidden;

function closePanel() {
  if (!isOpen()) return;
  panel.hidden = true;
  bell.setAttribute("aria-expanded", "false");
  const ids = [...shownNew];
  shownNew.clear();
  void markSeen(ids);
}

function openPanel() {
  panel.hidden = false;
  bell.setAttribute("aria-expanded", "true");
  fitted.first().catch((error) => toast.error(error.message));
}

bell.addEventListener("click", (event) => {
  event.stopPropagation();
  if (isOpen()) closePanel(); else openPanel();
});
document.addEventListener("click", (event) => {
  if (isOpen() && !panel.contains(event.target) && !bell.contains(event.target)) closePanel();
});
// Esc closes the panel first; the control center's own Esc handler leaves a default-prevented key alone.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !isOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  closePanel();
  bell.focus();
}, true);

// ── The list ─────────────────────────────────────────────────────────────────────────────────────────────

const fitted = createFittedList({
  list, pager, testPrefix: "control-triggers", initialSize: 4, maxSize: 20,
  emptyText: "Nothing is waiting. What the decision model rates urgent is in Bob's chat.",
  async fetchPage(page, size) {
    const body = await api(`${BASE}?page=${page}&size=${size}`);
    setCount(body.newCount);
    if (isOpen()) for (const trigger of body.triggers) if (trigger.state === "new") shownNew.add(trigger.id);
    dismissAll.disabled = body.total === 0;
    return { total: body.total, items: body.triggers };
  },
  renderItem: renderTrigger,
});

function ratingText(trigger) {
  return trigger.rating.label || "not rated yet: Bob was paused";
}

function renderTrigger(trigger) {
  const row = testid(makeNode("div", "control-trigger"), "control-trigger");
  row.dataset.id = trigger.id;
  row.dataset.state = trigger.state;
  row.dataset.urgency = trigger.urgency;
  const title = testid(makeNode("b", "control-trigger-title", trigger.title), "control-trigger-title");
  title.append(makeNode("span", "control-trigger-project", ` · ${trigger.projectName}`));
  row.append(title);
  if (trigger.summary) row.append(testid(makeNode("span", "control-trigger-summary", trigger.summary), "control-trigger-summary"));
  const meta = testid(makeNode("small", "control-trigger-meta", `webhook ${trigger.webhookName} · ${ago(trigger.receivedAt)} · ${ratingText(trigger)}`), "control-trigger-meta");
  meta.title = [new Date(trigger.receivedAt).toLocaleString(), trigger.rating.confidence === null ? "" : `Decision model: ${Math.round(trigger.rating.confidence * 100)}% sure`, trigger.rating.reason].filter(Boolean).join("\n");
  row.append(meta);
  const actions = makeNode("div", "control-trigger-actions");
  actions.append(
    makeButton("Open", "control-trigger-open", () => openWebhook(trigger)),
    makeButton("Ask Bob to triage", "control-trigger-triage", (event) => triage(trigger, event.currentTarget), "primary compact"),
    makeButton("Dismiss", "control-trigger-dismiss", (event) => dismiss(trigger, event.currentTarget)),
  );
  row.append(actions);
  return row;
}

// ── What each button does ────────────────────────────────────────────────────────────────────────────────

/** The webhook lives in its project's Webhooks screen, which is also where the Automations tab sends the person. */
function openWebhook(trigger) {
  closePanel();
  openProjectWebhooks({ id: trigger.projectId, name: trigger.projectName }).catch((error) => toast.error(error.message));
}

/**
 * Says the triage question in Bob's chat the way the person would type it: it goes through the chat's own form, so it
 * shows as their message, Bob answers below it, and the same route and labels apply. What they had typed stays.
 */
function sayToBob(message, projectId) {
  const input = elements.controlChatInput;
  const project = elements.controlChatProject;
  const draft = input.value;
  const chosen = project.value;
  input.value = message;
  if ([...project.options].some((option) => option.value === projectId)) project.value = projectId;
  // The payload came from outside: Bob answers it and starts nothing.
  elements.controlChatForm.dataset.answerOnly = "1";
  elements.controlChatForm.requestSubmit();
  // The form read the text and cleared the box before this line.
  input.value = draft;
  project.value = chosen;
}

async function triage(trigger, button) {
  button.disabled = true;
  try {
    const { message, projectId } = await api(`${BASE}/${encodeURIComponent(trigger.id)}/triage`);
    closePanel();
    sayToBob(message, projectId);
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

async function dismiss(trigger, button) {
  button.disabled = true;
  try {
    await api(`${BASE}/dismiss`, { method: "POST", body: JSON.stringify({ ids: [trigger.id] }) });
    shownNew.delete(trigger.id);
    await fitted.reload();
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

async function dismissEvery() {
  dismissAll.disabled = true;
  try {
    await api(`${BASE}/dismiss`, { method: "POST", body: JSON.stringify({ all: true }) });
    shownNew.clear();
    await fitted.first();
  } catch (error) {
    toast.error(error.message);
    dismissAll.disabled = false;
  }
}

// ── Staying current ──────────────────────────────────────────────────────────────────────────────────────

let refreshing = null;
let refreshAgain = false;

/** Reads the count for the bell, or the whole page when the panel is open. Calls while one is running fold into one more. */
function refresh() {
  if (refreshing) { refreshAgain = true; return refreshing; }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      if (isOpen()) await fitted.reload();
      else setCount((await api(`${BASE}?size=1`)).newCount);
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const whenShown = () => document.body.classList.contains("view-control");
window.addEventListener("control-center-activated", () => { refresh().catch((error) => console.warn("Could not read the incoming triggers", error)); });
// The server sends this when a trigger arrives or is rated, and when Bob has anything new.
window.addEventListener("control-center-changed", () => {
  if (whenShown()) refresh().catch((error) => console.warn("Could not read the incoming triggers", error));
});

// The urgent ones are Bob's messages. Their Open button is answered by the server, and the page opens the webhook here.
window.addEventListener("control-bob-action", (event) => {
  if (event.detail.actionId !== "trigger.open") return;
  const { projectId, projectName } = event.detail.data;
  openProjectWebhooks({ id: projectId, name: projectName }).catch((error) => toast.error(error.message));
});
