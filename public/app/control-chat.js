import { harnessOption } from "../harness-metadata.js";
import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { appearanceContext, applyAppearance } from "./appearance.js";
import { attachmentsFromFiles, renderAttachmentChips } from "./attachments.js";
import { elements } from "./elements.js";
import { focusProject, newConversation, openConversation, projectColor, refreshControlCenter, saveControlCenter, seeCardOff } from "./control-center.js";
import { takeControl } from "./control-lease.js";
import { vanish } from "./control-vanish.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { state } from "./state.js";
import { formatDate, toast } from "./shell.js";

const MIN_WIDTH = 300;
const MAX_WIDTH = 820;

const IMPORTANCE_LABELS = { "needs-ok": "Needs OK", urgent: "Urgent", "needs-you": "Needs you", report: "Report", done: "Done", fyi: "FYI" };

let settings = null;
let messages = [];
const filter = { project: "", importance: "" };
let settingsLoaded = false;
let catalog = { harnesses: [], models: [] };
/** Files and images picked, pasted or dropped for the next message, read as the conversation composer reads them. */
let attachments = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyLayout() {
  const { chatRight, chatWidth } = state.controlCenter;
  elements.controlCenterMain.classList.toggle("chat-left", !chatRight);
  elements.controlChat.style.setProperty("--control-chat-width", `${chatWidth}px`);
}

const DECIDED_BY_BOB = /^(Decision model|No decision model|The decision model)/;

/** Who wrote a message: you, Bob answering you, or the part of Joint Bob its line names first (Review check, Guardian, Auto respond…). */
function sourceOf(message) {
  if (message.role === "user") return { label: "You", detail: null };
  if (!message.via || DECIDED_BY_BOB.test(message.via)) return { label: "Bob", detail: message.via };
  const [label, ...rest] = message.via.split(" · ");
  return { label, detail: rest.join(" · ") || null };
}

/** The conversation a message is about: its Open button names it; once the buttons are used, the title it starts with. */
function conversationOf(message) {
  const open = message.actions?.find((action) => action.data?.open)?.data.open;
  const quoted = message.text.match(/^"([^"\n]+)"/)?.[1];
  if (!open && !quoted) return null;
  return { open, title: open?.title ?? quoted ?? "the conversation" };
}

/**
 * Where each conversation on the board stands now, by project and conversation. The board is read again whenever anything
 * changes (and every few seconds while an agent runs), so a message about a conversation shows what it does now, with no
 * reading of its own.
 */
let boardNow = new Map();
const NOW_WORDS = { running: "Running now", "needs-you": "Waits for you", review: "Done · ready for review" };

/** The board column of the conversation an open message is about; null once the message is cleared, or off the board. */
function nowOf(message, about) {
  if (message.resolvedAt || !about?.open) return null;
  return boardNow.get(`${about.open.projectId}:${about.open.conversationId}`) ?? null;
}

function renderNow(column) {
  const now = element("span", `control-entry-now ${column}`);
  now.dataset.testid = "control-chat-now";
  now.dataset.column = column;
  now.title = "Where this conversation stands now, as on the board";
  now.append(element("span", `control-pulse ${column}`), element("span", "", NOW_WORDS[column] ?? column));
  return now;
}

/** What a source means, in words, for the line under a conversation's name. */
const SOURCE_WORDS = {
  "Review check": "Bob checked it when it stopped",
  Guardian: "Guardian holds a risky step for your OK",
  "Auto respond ended": "Auto respond stopped",
  Organize: "Bob",
};

/**
 * Opens the conversation a message is about. One that waits for the person (a question, a step to allow) opens with them in
 * control, ready to answer, as its card on the board does; anything else opens to read.
 */
function openFrom(message, open) {
  if (message.importance === "needs-you" || message.importance === "needs-ok") return takeControl({ ...open, projectName: message.projectName });
  return openConversation(open);
}

/** The message without the conversation's name it starts with: the card already shows it on top. */
function withoutTitle(text, title) {
  const prefix = `"${title}"`;
  if (!text.startsWith(prefix)) return text;
  const rest = text.slice(prefix.length).replace(/^:?\s*/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function importanceLabel(message) {
  return element("span", `control-label importance ${message.importance}`, IMPORTANCE_LABELS[message.importance] ?? message.importance);
}

function timeOf(message) {
  const time = element("time", "control-time", formatDate(message.createdAt));
  time.dateTime = message.createdAt;
  return time;
}

function renderBody(message, text) {
  const body = element("div", `control-msg ${message.role === "user" ? "user" : "bob"}`);
  // Bob's agent answers in Markdown. What the person typed, and system notices that quote commands, stay as written.
  if (message.role === "bob") { body.classList.add("markdown"); renderMarkdown(body, text); }
  else body.textContent = text;
  return body;
}

/** The quick reply being written: to which message, and what is typed so far, so drawing the chat again keeps it. */
let replying = null;

function openReply(message) {
  replying = { id: message.id, text: "", focus: true };
  renderMessages();
}

function closeReply() {
  replying = null;
  renderMessages();
}

/**
 * What the person can do with any message of Bob's besides its own buttons: reply (into the conversation it is about, or to
 * Bob), close that conversation, or clear the message. A Guardian step is answered only with its own buttons.
 */
function itemControls(message, about) {
  const control = (label, title, run) => {
    const button = element("button", "control-action quiet", label);
    button.type = "button";
    button.title = title;
    button.dataset.testid = `control-item-${label.toLowerCase()}`;
    button.addEventListener("click", () => run(button));
    return button;
  };
  const conversation = about?.open ? about : null;
  const controls = [control("Reply", conversation ? `Answer “${conversation.title}” in the conversation, as you` : "Answer Bob about this", () => openReply(message))];
  if (conversation && message.importance !== "report" && !message.actions.some((action) => action.id === "conversation.done")) {
    controls.push(control("Done", "Close this conversation, as marking it done in its project does, and clear the message", (button) => settle(message, conversation, "done", button)));
  }
  controls.push(control("Dismiss", "Clear it from the chat; it stays under ✓ Cleared", (button) => settle(message, conversation, "dismiss", button)));
  return controls;
}

function renderActions(message, about) {
  const settleable = message.role !== "user" && !message.resolvedAt && !message.actions.some((action) => action.id.startsWith("guardian."));
  if (!message.actions.length && !settleable) return null;
  const actions = element("div", "control-actions");
  for (const action of message.actions) {
    const button = element("button", `control-action ${action.style ?? ""}`, action.label);
    button.type = "button";
    button.addEventListener("click", () => runAction(message, action, button));
    actions.append(button);
  }
  if (settleable) actions.append(...itemControls(message, about));
  return actions;
}

/** The quick reply box under a message: Enter sends, Shift+Enter starts a new line, Esc closes it. */
function renderReply(message, about) {
  const form = element("form", "control-reply");
  form.dataset.testid = "control-chat-reply";
  const box = element("textarea");
  box.rows = 2;
  box.value = replying.text;
  box.placeholder = about?.open ? `Reply to “${about.title}”. It goes into the conversation, as you.` : "Reply to Bob about this";
  box.addEventListener("input", () => { replying.text = box.value; });
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    else if (event.key === "Escape") { event.preventDefault(); closeReply(); }
  });
  const send = element("button", "control-action primary", "Send");
  send.type = "submit";
  const cancel = element("button", "control-action", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", closeReply);
  const row = element("div", "control-actions");
  row.append(send, cancel);
  form.append(box, row);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = box.value.trim();
    if (text) void sendReply(message, about, text, send);
  });
  return form;
}

/** Buttons, the cleared line and the quick reply, in that order, under a message. */
function appendControls(wrap, message, about) {
  const actions = renderActions(message, about);
  if (actions) wrap.append(actions);
  if (message.resolvedAt) wrap.append(renderCleared(message));
  if (replying?.id === message.id) wrap.append(renderReply(message, about));
}

function entry(message, className) {
  const wrap = element("div", `control-entry ${message.role}${className ? ` ${className}` : ""}`);
  wrap.dataset.testid = "control-chat-entry";
  wrap.dataset.id = message.id;
  wrap.dataset.importance = message.importance;
  wrap.dataset.project = message.projectId ?? "";
  return wrap;
}

/** In the cleared view, when an item was cleared and why, in place of its buttons. */
function renderCleared(message) {
  const line = element("div", "control-cleared", `✓ Cleared ${formatDate(message.resolvedAt)} · ${message.resolution}`);
  line.dataset.testid = "control-chat-cleared";
  return line;
}

/** The few words shown as an item leaves: the button pressed, or why Bob found it settled. */
const settledWord = (message) => message.resolution.match(/^You chose “(.+)”\.$/)?.[1] ?? message.resolution;

/**
 * A message about one conversation is a card in its project's color. On top, the project and the conversation's name (click it
 * to open the conversation); under them, how much it matters, who raised it and when; then what it says and its buttons.
 */
function renderConversationNotice(message, about) {
  const wrap = entry(message, "about");
  // In its project's color, as on the board; what belongs to no project is slate.
  wrap.dataset.color = message.projectId ? projectColor(message.projectId) : "slate";
  const source = element("div", "control-entry-source");
  const name = element(about.open ? "button" : "span", "control-entry-conversation", about.title);
  name.dataset.testid = "control-chat-about";
  if (about.open) {
    name.type = "button";
    name.title = "Open this conversation";
    name.addEventListener("click", () => { openFrom(message, about.open).catch((error) => toast.error(error.message)); });
  }
  source.append(element("span", "control-entry-project", message.projectName ?? "General"), name);
  const { label, detail } = sourceOf(message);
  const raised = element("div", "control-entry-event");
  raised.append(importanceLabel(message), element("span", "control-entry-raised", SOURCE_WORDS[label] ?? label), timeOf(message));
  const now = nowOf(message, about);
  if (now) raised.append(renderNow(now));
  wrap.append(source, raised, renderBody(message, withoutTitle(message.text, about.title)));
  appendControls(wrap, message, about);
  if (detail) wrap.append(element("div", "control-via", detail));
  return wrap;
}

/** Any other message reads as chat: who wrote it, its project, how much it matters and when, over what it says. */
function renderChatMessage(message) {
  const wrap = entry(message, "");
  const head = element("div", "control-entry-head");
  const { label, detail } = sourceOf(message);
  head.append(element("b", "control-source", label), element("span", "control-label project", message.projectName ?? "General"), importanceLabel(message), timeOf(message));
  wrap.append(head, renderBody(message, message.text));
  // How it was decided goes under the message, small: the head already says where it came from.
  if (detail) wrap.append(element("div", "control-via", detail));
  appendControls(wrap, message, null);
  return wrap;
}

function renderMessage(message) {
  const about = message.role === "user" ? null : conversationOf(message);
  return about ? renderConversationNotice(message, about) : renderChatMessage(message);
}

/**
 * What was sent and not answered yet, and what could not be sent. They are kept here, not in the timeline, so reading the
 * timeline again (which happens as soon as the server saves the message) does not take them away.
 */
const pending = new Map();
let sendError = null;
let pendingTicker = null;

const elapsed = (since) => {
  const seconds = Math.floor((Date.now() - since) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Bob's acknowledgement: he has the message and is working on it, for how long so far. */
function renderPending({ text, startedAt }) {
  const wrap = element("div", "control-entry bob control-pending");
  wrap.dataset.testid = "control-chat-pending";
  const line = element("div", "control-msg bob");
  line.append(element("span", "control-pulse running"), element("span", "", `Got it. Working on “${text.length > 80 ? `${text.slice(0, 77)}…` : text}”`));
  const time = element("span", "control-pending-time", elapsed(startedAt));
  time.dataset.since = String(startedAt);
  line.append(time);
  wrap.append(line);
  return wrap;
}

function tickPending() {
  for (const time of elements.controlChatMessages.querySelectorAll(".control-pending-time")) time.textContent = elapsed(Number(time.dataset.since));
}

// The chat is drawn again only when what it shows changed: it is read again whenever anything changes, and drawing it anew
// would take the focus and the scroll away from a reply being written.
let drawnMessages = "";
// The place being read stays when an item is cleared or one arrives. The chat goes to its end for another filter, for
// something sent, or when it was at the end already.
let drawnView = "";
let drawnPending = 0;

function renderMessages() {
  const visible = messages.filter(matchesFilter);
  const drawing = JSON.stringify([visible, [...pending.keys()], sendError, replying?.id ?? null, filter.importance]);
  if (drawing === drawnMessages) return;
  drawnMessages = drawing;
  const list = elements.controlChatMessages;
  const view = JSON.stringify(filter);
  const follow = view !== drawnView || pending.size > drawnPending || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const top = list.scrollTop;
  drawnView = view;
  drawnPending = pending.size;
  const writing = Boolean(document.activeElement?.closest?.(".control-reply"));
  const extra = [...[...pending.values()].map(renderPending), ...(sendError ? [element("div", "control-msg error", sendError)] : [])];
  const shown = visible.map(renderMessage);
  const empty = !shown.length && filter.importance === "cleared" ? [element("p", "control-empty", "Nothing was cleared yet.")] : [];
  list.replaceChildren(...shown, ...empty, ...extra);
  list.scrollTop = follow ? list.scrollHeight : top;
  const box = list.querySelector(".control-reply textarea");
  if (box) {
    if (writing || replying.focus) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); replying.focus = false; }
    box.closest(".control-entry").scrollIntoView({ block: "nearest" });
  }
  clearInterval(pendingTicker);
  pendingTicker = pending.size ? setInterval(tickPending, 1000) : null;
}

/** Whether the chat shows a message: a cleared item only in the cleared view, which shows nothing else. */
function matchesFilter(message) {
  if (filter.importance === "cleared") return Boolean(message.resolvedAt);
  if (message.resolvedAt) return false;
  if (filter.project === "general" && message.projectId) return false;
  if (filter.project && filter.project !== "general" && message.projectId !== filter.project) return false;
  const levels = { important: ["needs-ok", "urgent", "needs-you"], reports: ["report", "done"], fyi: ["fyi"] }[filter.importance];
  return !levels || levels.includes(message.importance);
}

const entryOf = (id) => elements.controlChatMessages.querySelector(`.control-entry[data-id="${CSS.escape(id)}"]`);

/**
 * Puts where each message's conversation stands now in step with the board, in place: the chat is not drawn again for it, so
 * an item on its way out, a reply being written and the scroll are left alone.
 */
function updateNow() {
  for (const message of messages) {
    const entry = message.role === "user" || message.resolvedAt ? null : entryOf(message.id);
    const about = entry && conversationOf(message);
    if (!about) continue;
    const column = nowOf(message, about);
    const shown = entry.querySelector('[data-testid="control-chat-now"]');
    if ((shown?.dataset.column ?? null) === column) continue;
    if (!column) shown.remove();
    else if (shown) shown.replaceWith(renderNow(column));
    else entry.querySelector(".control-entry-event")?.append(renderNow(column));
  }
}

/** Items on screen that were cleared since leave with their animation (all together), then the chat is drawn again. */
async function readMessages() {
  const query = new URLSearchParams();
  if (filter.project) query.set("project", filter.project);
  if (filter.importance === "cleared") query.set("cleared", "1");
  else if (filter.importance) query.set("importance", filter.importance);
  const next = (await api(`/api/control-center/bob/messages?${query}`)).messages;
  const leaving = filter.importance === "cleared" ? [] : next.filter((message) => message.resolvedAt && entryOf(message.id));
  await Promise.all(leaving.map((message) => vanish(entryOf(message.id), settledWord(message), { collapse: true })));
  messages = next;
  renderMessages();
}

// One reading at a time, so an animation is not cut short by the next drawing. Asks that come while one runs share one more
// reading after it, so a busy server cannot pile them up and a change of filter is never stuck behind them.
let reading = null;
let readAgain = false;
function loadMessages() {
  if (reading) { readAgain = true; return reading; }
  reading = (async () => {
    do {
      readAgain = false;
      await readMessages();
    } while (readAgain);
  })().finally(() => { reading = null; });
  return reading;
}

async function runAction(message, action, button) {
  // Opening a conversation, undoing a display change and the New conversation form happen in the page; every other button is
  // answered by the server.
  if (action.data?.open) { openFrom(message, action.data.open).catch((error) => toast.error(error.message)); return; }
  if (action.data?.appearance) { applyAppearance(action.data.appearance); toast("Display settings put back"); return; }
  if (action.data?.create) { newConversation(action.data.create.content).catch((error) => toast.error(error.message)); return; }
  button.disabled = true;
  try {
    const result = await api("/api/control-center/bob/action", { method: "POST", body: JSON.stringify({ messageId: message.id, actionId: action.id }) });
    // A button runs once: the server took the pressed message's buttons away, and so does the page.
    Object.assign(message, result.pressed);
    if (result.messages?.length) messages.push(...result.messages.filter((added) => matchesFilter(added) && !messages.some((shown) => shown.id === added.id)));
    // Features whose button also changes the page (open a tab, see a card off the board) listen for the one that ran.
    window.dispatchEvent(new CustomEvent("control-bob-action", { detail: { actionId: action.id, label: action.label, data: action.data } }));
    void refreshControlCenter().catch(() => undefined);
    // A settled item leaves, while the board changes beside it.
    if (message.resolvedAt && entryOf(message.id)) await vanish(entryOf(message.id), settledWord(message), { collapse: true });
    renderMessages();
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

/** Dismiss clears a message; Done also closes the conversation it is about, whose card leaves the board with the same check. */
async function settle(message, conversation, how, button) {
  button.disabled = true;
  try {
    const result = await api("/api/control-center/bob/item", { method: "POST", body: JSON.stringify({ messageId: message.id, how }) });
    Object.assign(message, result.pressed);
    if (replying?.id === message.id) replying = null;
    if (how === "done") {
      seeCardOff(conversation.open.projectId, conversation.open.conversationId, "Done");
      void refreshControlCenter().catch(() => undefined);
    }
    if (entryOf(message.id)) await vanish(entryOf(message.id), how === "done" ? "Done" : "Dismissed", { collapse: true });
    renderMessages();
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

/**
 * Sends a quick reply. About a conversation, it goes into that conversation as the person, and the message is cleared. About
 * anything else, it is a message to Bob that says what it answers, and the message is marked answered.
 */
async function sendReply(message, about, text, button) {
  button.disabled = true;
  try {
    if (about?.open) {
      Object.assign(message, (await api("/api/control-center/bob/reply", { method: "POST", body: JSON.stringify({ messageId: message.id, text }) })).pressed);
      toast(`Sent to “${about.title}”`);
    } else {
      Object.assign(message, (await api("/api/control-center/bob/item", { method: "POST", body: JSON.stringify({ messageId: message.id, how: "answered" }) })).pressed);
    }
    replying = null;
    if (message.resolvedAt && entryOf(message.id)) await vanish(entryOf(message.id), "Replied", { collapse: true });
    renderMessages();
    if (!about?.open) {
      const asked = message.text.split("\n")[0].trim();
      void send(`About “${asked.length > 120 ? `${asked.slice(0, 117)}…` : asked}”: ${text}`, [], false);
    }
  } catch (error) {
    toast.error(error.message);
    button.disabled = false;
  }
}

function renderChatAttachments() {
  renderAttachmentChips(elements.controlChatAttachments, attachments, (id) => {
    attachments = attachments.filter((attachment) => attachment.id !== id);
    renderChatAttachments();
  });
}

async function addChatAttachments(files) {
  if (!files.length) return;
  try {
    attachments = await attachmentsFromFiles(files, attachments);
    renderChatAttachments();
  } catch (error) {
    toast.error(error.message);
  } finally {
    elements.controlChatFiles.value = "";
  }
}

const ofKind = (list, kind) => list.filter((attachment) => attachment.kind === kind).map(({ name, mimeType, data }) => ({ name, mimeType, data }));

async function send(text, sent, answerOnly) {
  const projectId = elements.controlChatProject.value || undefined;
  elements.controlChatSend.disabled = true;
  const key = crypto.randomUUID();
  pending.set(key, { text, startedAt: Date.now() });
  sendError = null;
  renderMessages();
  const files = sent.length ? { images: ofKind(sent, "image"), files: ofKind(sent, "file") } : {};
  try {
    // The display settings go along, so Bob's display agent can change them in this page.
    const result = await api("/api/control-center/bob/message", { method: "POST", body: JSON.stringify({ message: text, ...files, appearance: appearanceContext(), ...(projectId ? { projectId } : {}), ...(answerOnly ? { answerOnly: true } : {}) }) });
    if (result.appearance) applyAppearance(result.appearance);
    // The timeline may already hold the person's message: it was read again while Bob worked.
    for (const message of [result.user, result.reply]) if (matchesFilter(message) && !messages.some((shown) => shown.id === message.id)) messages.push(message);
    if (result.action === "started") void refreshControlCenter().catch(() => undefined);
  } catch (error) {
    sendError = error.message;
    // Nothing reached Bob, so what was sent comes back to the box unless the person already wrote something new.
    if (!elements.controlChatInput.value) elements.controlChatInput.value = text;
    if (!attachments.length) { attachments = sent; renderChatAttachments(); }
  } finally {
    pending.delete(key);
    renderMessages();
    elements.controlChatSend.disabled = false;
  }
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────

function renderMonitoring() {
  const on = settings?.monitoring !== false;
  elements.controlChatMonitor.textContent = on ? "Monitoring" : "Paused";
  elements.controlChatMonitor.classList.toggle("paused", !on);
  elements.controlChatPaused.hidden = on;
  elements.controlChatState.textContent = on ? "Acts as you in every project" : "Paused";
  window.dispatchEvent(new CustomEvent("control-bob-settings", { detail: settings }));
}

function fillSettingsForm() {
  const harness = catalog.harnesses.find((candidate) => candidate.id === settings.harnessId);
  elements.controlBobHarness.value = harness ? harness.id : "";
  if (harness) fillModelOptions(harness, catalog.models, elements.controlBobModel, elements.controlBobThinking, settings);
  elements.controlBobModel.parentElement.hidden = !harness;
  elements.controlBobThinking.parentElement.hidden = !harness;
  elements.controlBobClassifier.value = settings.classifier;
  elements.controlBobThreshold.value = String(Math.round(settings.threshold * 100));
  elements.controlBobAutoRespond.value = settings.autoRespond;
  elements.controlBobReviewCheck.value = settings.reviewCheck;
  elements.controlBobAsk.checked = settings.askBeforeSaving;
}

async function saveSettings(change) {
  try {
    settings = await api("/api/control-center/bob/settings", { method: "PUT", body: JSON.stringify(change) });
    renderMonitoring();
  } catch (error) {
    toast.error(error.message);
  }
}

const GUARD_TEXT = {
  on: "🔒 Production or destructive steps ask you first (Guardian). Bob never answers them for you.",
  "guardian-off": "Guardian is off on this machine, so production or destructive steps do not ask first.",
  "rule-missing": "Guardian is on, but nothing asks before production or destructive steps.",
  "rule-off": "The production rule in Guardian is off or does not ask.",
};

async function showGuard() {
  const { status } = await api("/api/control-center/guardian");
  elements.controlBobGuardText.textContent = GUARD_TEXT[status];
  elements.controlBobGuardButton.hidden = status === "on";
}

elements.controlBobGuardButton.addEventListener("click", () => {
  api("/api/control-center/guardian/protect", { method: "POST", body: "{}" }).then(showGuard).catch((error) => toast.error(error.message));
});

async function openSettings() {
  showGuard().catch((error) => toast.error(error.message));
  if (!settingsLoaded) {
    const [harnessBody, modelBody] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
    catalog = { harnesses: harnessBody.harnesses.filter((harness) => harness.runtimeConfigured), models: modelBody.models };
    elements.controlBobHarness.replaceChildren(new Option("The node's usual helper agent", ""), ...catalog.harnesses.map(harnessOption));
    settingsLoaded = true;
  }
  fillSettingsForm();
  elements.controlChatSettings.hidden = !elements.controlChatSettings.hidden;
  // Rows other modules add to the panel (Telegram) read their own state when it opens.
  if (!elements.controlChatSettings.hidden) window.dispatchEvent(new CustomEvent("control-settings-opened"));
}

function chosenAgent() {
  const harness = catalog.harnesses.find((candidate) => candidate.id === elements.controlBobHarness.value);
  if (!harness) return { harnessId: "", provider: "", modelId: "", thinkingLevel: "" };
  const { provider, modelId } = selectedModel(elements.controlBobModel);
  return { harnessId: harness.id, provider, modelId, thinkingLevel: elements.controlBobThinking.value };
}

elements.controlChatSettingsButton.addEventListener("click", () => { void openSettings().catch((error) => toast.error(error.message)); });
elements.controlBobHarness.addEventListener("change", () => {
  const harness = catalog.harnesses.find((candidate) => candidate.id === elements.controlBobHarness.value);
  elements.controlBobModel.parentElement.hidden = !harness;
  elements.controlBobThinking.parentElement.hidden = !harness;
  if (harness) fillModelOptions(harness, catalog.models, elements.controlBobModel, elements.controlBobThinking);
  void saveSettings(chosenAgent());
});
elements.controlBobModel.addEventListener("change", () => {
  const harness = catalog.harnesses.find((candidate) => candidate.id === elements.controlBobHarness.value);
  fillThinkingOptions(harness, catalog.models, elements.controlBobModel, elements.controlBobThinking, elements.controlBobThinking.value);
  void saveSettings(chosenAgent());
});
elements.controlBobThinking.addEventListener("change", () => { void saveSettings(chosenAgent()); });
elements.controlBobClassifier.addEventListener("change", () => { void saveSettings({ classifier: elements.controlBobClassifier.value }); });
elements.controlBobAutoRespond.addEventListener("change", () => { void saveSettings({ autoRespond: elements.controlBobAutoRespond.value }); });
elements.controlBobReviewCheck.addEventListener("change", () => { void saveSettings({ reviewCheck: elements.controlBobReviewCheck.value }); });
elements.controlBobAsk.addEventListener("change", () => { void saveSettings({ askBeforeSaving: elements.controlBobAsk.checked }); });
elements.controlBobThreshold.addEventListener("change", () => {
  const percent = Number(elements.controlBobThreshold.value);
  if (Number.isFinite(percent) && percent >= 0 && percent <= 100) void saveSettings({ threshold: percent / 100 });
});
elements.controlChatMonitor.addEventListener("click", () => { void saveSettings({ monitoring: settings?.monitoring === false }); });
elements.controlChatRestore.addEventListener("click", () => { void saveSettings({ monitoring: true }); });

// ── Filters and sending ──────────────────────────────────────────────────────────────────────────────────

// Choosing a project here focuses the whole control center on it: the board shows only its cards, and new messages go to it.
let boardFocus = "";
elements.controlChatFilterProject.addEventListener("change", () => {
  filter.project = elements.controlChatFilterProject.value;
  const project = filter.project === "general" ? "" : filter.project;
  boardFocus = project;
  elements.controlChatProject.value = project;
  focusProject(project || null);
  void loadMessages().catch((error) => toast.error(error.message));
});
for (const chip of elements.controlChatFilters.querySelectorAll("[data-importance]")) {
  chip.addEventListener("click", () => {
    filter.importance = chip.dataset.importance;
    for (const other of elements.controlChatFilters.querySelectorAll("[data-importance]")) other.classList.toggle("active", other === chip);
    void loadMessages().catch((error) => toast.error(error.message));
  });
}

elements.controlChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.controlChatInput.value.trim();
  if (!text) {
    if (attachments.length) toast("Say what Bob should do with what you attached.");
    return;
  }
  elements.controlChatInput.value = "";
  const sent = attachments;
  attachments = [];
  renderChatAttachments();
  // Text that came from outside (a webhook's payload) may only be answered, never acted on.
  const answerOnly = elements.controlChatForm.dataset.answerOnly === "1";
  delete elements.controlChatForm.dataset.answerOnly;
  void send(text, sent, answerOnly);
});
elements.controlChatAttach.addEventListener("click", () => elements.controlChatFiles.click());
elements.controlChatFiles.addEventListener("change", (event) => { void addChatAttachments(event.target.files ?? []); });
// A pasted screenshot is attached; pasted text stays text.
elements.controlChatInput.addEventListener("paste", (event) => {
  const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  void addChatAttachments(images);
});
elements.controlChatForm.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  elements.controlChatForm.classList.add("dragging");
});
elements.controlChatForm.addEventListener("dragleave", (event) => {
  if (!elements.controlChatForm.contains(event.relatedTarget)) elements.controlChatForm.classList.remove("dragging");
});
elements.controlChatForm.addEventListener("drop", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  elements.controlChatForm.classList.remove("dragging");
  void addChatAttachments(event.dataTransfer.files);
});
elements.controlChatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.controlChatForm.requestSubmit();
  }
});

// The project lists follow the board's, so a person can pick or filter by project. They are filled again only when the
// projects changed: the board is drawn every few seconds while agents run, and refilling a list closes it on a phone.
let listedProjects = "";
window.addEventListener("control-center-rendered", (event) => {
  boardNow = new Map(event.detail.cards.map((card) => [`${card.projectId}:${card.conversationId}`, card.column]));
  const choose = (select, first) => {
    const chosen = select.value;
    select.replaceChildren(...first, ...event.detail.projects.map((project) => new Option(project.name, project.id)));
    select.value = chosen;
  };
  const projects = JSON.stringify(event.detail.projects.map((project) => [project.id, project.name, project.color]));
  if (projects !== listedProjects) {
    listedProjects = projects;
    choose(elements.controlChatProject, [new Option("Auto", "")]);
    choose(elements.controlChatFilterProject, [new Option("All projects", ""), new Option("General", "general")]);
    // A project's color is known once the board has its projects, or changed in its settings: the messages take it.
    drawnMessages = "";
    renderMessages();
  }
  updateNow();
  applyLayout();
  // The board's own project chips focus the chat too: one project chosen there filters it here.
  const focus = event.detail.focus.length === 1 ? event.detail.focus[0] : "";
  if (focus === boardFocus) return;
  boardFocus = focus;
  if (filter.project === "general" && !focus) return;
  filter.project = focus;
  elements.controlChatFilterProject.value = focus;
  elements.controlChatProject.value = focus;
  void loadMessages().catch((error) => toast.error(error.message));
});

// A new message from Bob (a question for you, a report) appears while the chat is open.
window.addEventListener("control-center-changed", () => {
  if (document.body.classList.contains("view-control")) void loadMessages().catch((error) => console.warn("Could not refresh Bob's chat", error));
});

window.addEventListener("control-center-activated", () => {
  void (async () => {
    settings = await api("/api/control-center/bob/settings");
    renderMonitoring();
    await loadMessages();
  })().catch((error) => toast.error(error.message));
});

elements.controlChatSide.addEventListener("click", () => {
  state.controlCenter.chatRight = !state.controlCenter.chatRight;
  applyLayout();
  saveControlCenter();
});

elements.controlChatResize.addEventListener("mousedown", (event) => {
  event.preventDefault();
  elements.controlChatResize.classList.add("dragging");
  const bounds = elements.controlCenterMain.getBoundingClientRect();
  const move = (moveEvent) => {
    const fromEdge = state.controlCenter.chatRight ? bounds.right - moveEvent.clientX : moveEvent.clientX - bounds.left;
    state.controlCenter.chatWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, fromEdge)));
    applyLayout();
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    elements.controlChatResize.classList.remove("dragging");
    saveControlCenter();
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

applyLayout();
