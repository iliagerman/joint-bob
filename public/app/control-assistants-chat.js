import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { toast } from "./shell.js";

/*
 * An assistant's own chat over the control center. It is the same conversation the assistants page shows (the same
 * transcript and turn routes), so the person can read it and message the assistant directly. What Bob asked it is
 * marked as Bob's, in the order it happened, and listed beside the chat with what the assistant has attached.
 */

const STATE_LABEL = { idle: "idle", busy: "busy", "answering-bob": "answering Bob now" };
/** A webhook's message holds its raw payload; the chat shows the start of it. */
const USER_CHARS = 1_000;
const RECENT_MESSAGES = 6;
const SIDE_ASKS = 8;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tagged(node, testid) {
  node.dataset.testid = testid;
  return node;
}

function ago(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// ── The dialog ──────────────────────────────────────────────────────────────────────────────────────────

const dialog = tagged(el("dialog", "control-asst-dialog"), "control-assistant-dialog");
dialog.id = "controlAssistantDialog";
dialog.setAttribute("aria-labelledby", "controlAssistantTitle");
const parts = {
  face: el("span", "control-asst-face"),
  title: Object.assign(tagged(el("b"), "control-assistant-title"), { id: "controlAssistantTitle" }),
  where: tagged(el("small"), "control-assistant-chat-where"),
  switchLabel: el("span", "control-hint", "Bob may ask"),
  toggle: tagged(el("button", "control-asst-switch"), "control-assistant-chat-switch"),
  page: tagged(el("a", "ghost compact control-asst-link", "Assistants page"), "control-assistant-open-page"),
  close: tagged(el("button", "usage-icon-button", "×"), "control-assistant-close"),
  timeline: tagged(el("div", "control-asst-timeline"), "control-assistant-timeline"),
  side: tagged(el("aside", "control-asst-side"), "control-assistant-side"),
  form: tagged(el("form", "control-asst-form"), "control-assistant-form"),
  input: tagged(el("textarea"), "control-assistant-input"),
  send: tagged(el("button", "primary compact", "Send"), "control-assistant-send"),
  note: tagged(el("p", "control-hint control-asst-note"), "control-assistant-note"),
};
parts.toggle.type = "button";
parts.toggle.setAttribute("role", "switch");
parts.page.target = "_blank";
parts.page.rel = "noopener";
parts.close.type = "button";
parts.close.title = "Close";
parts.close.setAttribute("aria-label", "Close");
parts.timeline.setAttribute("role", "log");
parts.input.rows = 2;
parts.input.maxLength = 20_000;
parts.input.placeholder = "Message this assistant directly…";
parts.send.type = "submit";
const headName = el("div", "control-asst-name");
headName.append(parts.title, parts.where);
const header = el("header", "control-asst-chat-head");
header.append(parts.face, headName, el("span", "control-spacer"), parts.switchLabel, parts.toggle, parts.page, parts.close);
const body = el("div", "control-asst-body");
body.append(parts.timeline, parts.side);
const box = el("div", "control-chat-box");
box.append(parts.input, parts.send);
parts.form.append(box);
const card = el("div", "dialog-card control-asst-viewer");
card.append(header, body, parts.form, parts.note);
dialog.append(card);
document.body.append(dialog);

parts.close.addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { clearInterval(open?.timer); open = null; });

/** The assistant that is open: its card, what the page lets it change, and what has been read of it. */
let open = null;

// ── Header and side ─────────────────────────────────────────────────────────────────────────────────────

function renderHeader() {
  const { card: assistant } = open;
  parts.face.textContent = assistant.name.trim().slice(0, 1).toUpperCase() || "?";
  parts.title.textContent = assistant.name;
  parts.where.replaceChildren(document.createTextNode(`${assistant.machine} · `), el("i", `control-asst-dot ${assistant.state}`), document.createTextNode(STATE_LABEL[assistant.state]));
  parts.toggle.setAttribute("aria-checked", String(assistant.askable));
  parts.toggle.setAttribute("aria-label", `Bob may ask ${assistant.name}`);
  parts.toggle.title = assistant.askable ? "Bob may ask this assistant" : assistant.reason;
  parts.toggle.disabled = assistant.shared;
  parts.page.href = `/assistant.html?id=${encodeURIComponent(assistant.id)}`;
}

function section(label, ...content) {
  const node = el("div", "control-asst-side-section");
  node.append(el("div", "control-asst-lbl", label), ...content);
  return node;
}

function renderSide() {
  const { card: assistant, asks } = open;
  const has = el("div", "control-asst-has");
  has.append(...(assistant.has.length ? assistant.has.map((label) => tagged(el("span", "", label), "control-assistant-side-has")) : [el("span", "none", "nothing attached")]));
  const sections = [section("Has", has)];
  if (!assistant.askable) sections.push(tagged(section("Why Bob can't ask it", el("p", "", assistant.reason)), "control-assistant-why"));
  const rows = asks.slice(0, SIDE_ASKS).map((ask) => {
    const row = tagged(el("button", "control-asst-ask-row"), "control-assistant-ask-row");
    row.type = "button";
    row.dataset.askId = ask.id;
    row.append(el("span", "", `${ago(ask.startedAt)} · ${ask.purpose}`), el("small", "", ask.status === "completed" ? `${ask.seconds ?? 1} s` : ask.status === "failed" ? "no answer" : "working…"));
    row.addEventListener("click", () => {
      const block = parts.timeline.querySelector(`[data-ask-id="${CSS.escape(ask.id)}"]`);
      if (!block) return;
      block.open = true;
      block.scrollIntoView({ block: "center" });
    });
    return row;
  });
  const count = assistant.askedLastDay;
  sections.push(section("Asked by Bob", el("p", "control-hint", asks.length ? `${count} in the last day` : "Bob has not asked it yet."), ...rows));
  sections.push(el("p", "control-hint", "Bob's asks run as you, with this assistant's own logins and tools."));
  parts.side.replaceChildren(...sections);
}

// ── The conversation, with Bob's asks where they happened ───────────────────────────────────────────────

function bubble(role, text) {
  const node = tagged(el("div", `control-asst-msg ${role}`), "control-assistant-message");
  if (role === "assistant") renderMarkdown(node, text);
  else node.textContent = text.length > USER_CHARS ? `${text.slice(0, USER_CHARS)}…` : text;
  return node;
}

function bobAsk(ask) {
  const node = tagged(el("details", "control-asst-bobq"), "control-assistant-bob-ask");
  node.dataset.askId = ask.id;
  node.dataset.status = ask.status;
  const outcome = ask.status === "completed" ? ` · ${ask.seconds ?? 1} s` : ask.status === "failed" ? " · no answer" : " · working…";
  const summary = el("summary", "control-asst-bobq-who", `Bob asked · ${ago(ask.startedAt)}${outcome}`);
  const question = el("div", "control-asst-bobq-q", ask.question);
  const answer = el("div", `control-asst-bobq-a${ask.status === "failed" ? " failed" : ""}`);
  if (ask.status === "completed") renderMarkdown(answer, `→ ${ask.answer}`);
  else answer.textContent = ask.status === "failed" ? `→ ${ask.error}` : "answering…";
  node.append(summary, question, answer);
  node.open = ask.status === "running";
  return node;
}

function renderTimeline() {
  const { timeline, asks, error, pending } = open;
  const atEnd = parts.timeline.scrollHeight - parts.timeline.scrollTop - parts.timeline.clientHeight < 40;
  const wasOpen = new Set([...parts.timeline.querySelectorAll("details[open]")].map((node) => node.dataset.askId));
  const items = [
    ...timeline.map((entry) => ({ at: entry.createdAt ?? "", node: () => bubble(entry.role === "user" ? "user" : "assistant", entry.text) })),
    ...asks.map((ask) => ({ at: ask.startedAt, node: () => bobAsk(ask) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const nodes = items.map((item) => item.node());
  for (const node of nodes) if (node.dataset.askId && wasOpen.has(node.dataset.askId)) node.open = true;
  if (error) nodes.unshift(tagged(el("p", "control-asst-error", error), "control-assistant-error"));
  if (!items.length && !error) nodes.push(el("p", "control-empty", "Nothing here yet."));
  if (pending) nodes.push(bubble("user", pending.message), pending.status);
  parts.timeline.replaceChildren(...nodes);
  if (atEnd || open.firstRender) parts.timeline.scrollTop = parts.timeline.scrollHeight;
  open.firstRender = false;
}

async function load() {
  const current = open;
  const id = encodeURIComponent(current.card.id);
  const [asked, transcript] = await Promise.all([
    api(`/api/control-center/assistants/${id}/asks`),
    current.card.local ? api(`/api/personal-assistants/${id}/transcript`).catch((error) => ({ failed: error.message })) : { timeline: [] },
  ]);
  if (open !== current) return;
  current.asks = asked.asks;
  current.timeline = transcript.timeline ?? [];
  current.error = transcript.failed ? `Could not read its chat: ${transcript.failed}` : "";
  renderTimeline();
  renderSide();
}

// ── Messaging the assistant directly ────────────────────────────────────────────────────────────────────

/** Until the answer arrives, the sent message and how long the assistant has been at it stay in the chat. */
function showWorking(message) {
  const status = tagged(el("div", "control-asst-working", "Working on it…"), "control-assistant-working");
  status.setAttribute("role", "status");
  const started = Date.now();
  open.pending = { message, status };
  open.timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    status.textContent = `Working on it… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  renderTimeline();
}

async function send(event) {
  event.preventDefault();
  const current = open;
  const message = parts.input.value.trim();
  if (!message || parts.send.disabled) return;
  // An unsent message is sent again as the same turn, so a retry never runs twice.
  if (current.unsent && current.unsent.message !== message) { toast("Retry the message that was not sent before writing another."); return; }
  current.unsent ??= { requestId: crypto.randomUUID(), message };
  parts.send.disabled = true;
  parts.input.value = "";
  const recentMessages = current.timeline.slice(-RECENT_MESSAGES).map((entry) => entry.text.slice(0, 4_000));
  showWorking(message);
  try {
    await api(`/api/personal-assistants/${encodeURIComponent(current.card.id)}/turn`, { method: "POST", body: JSON.stringify({ requestId: current.unsent.requestId, message, recentMessages }) });
    current.unsent = null;
  } catch (error) {
    parts.input.value = parts.input.value.trim() ? `${message}\n\n${parts.input.value}` : message;
    toast(error.message, 6000);
  } finally {
    clearInterval(current.timer);
    current.pending = null;
    parts.send.disabled = false;
  }
  if (open === current) await load().catch((error) => toast(error.message));
}

parts.form.addEventListener("submit", (event) => { void send(event); });
parts.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); parts.form.requestSubmit(); }
});
parts.toggle.addEventListener("click", () => {
  const { card: assistant, handlers } = open;
  handlers.setMayAsk(assistant, !assistant.askable).catch((error) => toast(error.message, 6000));
});

function renderComposer() {
  const { card: assistant } = open;
  parts.form.hidden = !assistant.local;
  parts.note.textContent = assistant.local
    ? "This is the assistant's own chat. What Bob asked it shows in blue; you can talk to it here directly."
    : `${assistant.name} runs on ${assistant.machine}. Open Joint Bob there to talk to it directly; Bob can still ask it from here.`;
  parts.note.dataset.testid = assistant.local ? "control-assistant-note" : "control-assistant-remote-note";
}

// ── Opening and keeping it current ──────────────────────────────────────────────────────────────────────

/** Opens the assistant's chat. `handlers.setMayAsk(card, enabled)` changes Bob's switch and returns the new card. */
export async function openAssistantChat(assistant, handlers) {
  clearInterval(open?.timer);
  open = { card: assistant, handlers, timeline: [], asks: [], error: "", pending: null, unsent: null, timer: null, firstRender: true };
  parts.input.value = "";
  parts.send.disabled = false;
  renderHeader();
  renderComposer();
  parts.side.replaceChildren();
  parts.timeline.replaceChildren(el("p", "control-empty", "Loading…"));
  if (!dialog.open) dialog.showModal();
  await load();
}

/** The lists changed (a switch, an ask began or ended): the open chat follows the card. */
export function syncAssistantChat(cards) {
  if (!open) return;
  const fresh = cards.find((candidate) => candidate.id === open.card.id);
  if (!fresh) { dialog.close(); return; }
  open.card = fresh;
  renderHeader();
  renderComposer();
  renderSide();
}

// What Bob asked and what the assistant answered change with the control center's news.
window.addEventListener("control-center-changed", () => {
  if (open && dialog.open) void load().catch((error) => console.warn("Could not refresh the assistant's chat", error));
});
