import { harnessOption } from "../harness-metadata.js";
import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { appearanceContext, applyAppearance } from "./appearance.js";
import { attachmentsFromFiles, renderAttachmentChips } from "./attachments.js";
import { elements } from "./elements.js";
import { focusProject, openConversation, refreshControlCenter, saveControlCenter } from "./control-center.js";
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
  const { chatSide, chatWidth } = state.controlCenter;
  elements.controlCenterMain.classList.toggle("chat-left", chatSide === "left");
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

/** What a source means, in words, for the line under a conversation's name. */
const SOURCE_WORDS = {
  "Review check": "Bob checked it when it stopped",
  Guardian: "Guardian holds a risky step for your OK",
  "Auto respond ended": "Auto respond stopped",
  Organize: "Bob",
};

/** A steady color for each project, so its messages are told apart at a glance: an FNV-1a hash, so like ids get unlike hues. */
function projectHue(key) {
  let hash = 0x811c9dc5;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0) % 360;
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

function renderActions(message) {
  const actions = element("div", "control-actions");
  for (const action of message.actions) {
    const button = element("button", `control-action ${action.style ?? ""}`, action.label);
    button.type = "button";
    button.addEventListener("click", () => runAction(message, action, button));
    actions.append(button);
  }
  return actions;
}

function entry(message, className) {
  const wrap = element("div", `control-entry ${message.role}${className ? ` ${className}` : ""}`);
  wrap.dataset.testid = "control-chat-entry";
  wrap.dataset.importance = message.importance;
  wrap.dataset.project = message.projectId ?? "";
  return wrap;
}

/**
 * A message about one conversation is a card in its project's color. On top, the project and the conversation's name (click it
 * to open the conversation); under them, how much it matters, who raised it and when; then what it says and its buttons.
 */
function renderConversationNotice(message, about) {
  const wrap = entry(message, "about");
  wrap.style.setProperty("--project-hue", String(projectHue(message.projectId ?? message.projectName ?? "")));
  const source = element("div", "control-entry-source");
  const name = element(about.open ? "button" : "span", "control-entry-conversation", about.title);
  name.dataset.testid = "control-chat-about";
  if (about.open) {
    name.type = "button";
    name.title = "Open this conversation";
    name.addEventListener("click", () => { openConversation(about.open).catch((error) => toast(error.message)); });
  }
  source.append(element("span", "control-entry-project", message.projectName ?? "General"), name);
  const { label, detail } = sourceOf(message);
  const raised = element("div", "control-entry-event");
  raised.append(importanceLabel(message), element("span", "control-entry-raised", SOURCE_WORDS[label] ?? label), timeOf(message));
  wrap.append(source, raised, renderBody(message, withoutTitle(message.text, about.title)));
  if (message.actions?.length) wrap.append(renderActions(message));
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
  if (message.actions?.length) wrap.append(renderActions(message));
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

function renderMessages() {
  const extra = [...[...pending.values()].map(renderPending), ...(sendError ? [element("div", "control-msg error", sendError)] : [])];
  elements.controlChatMessages.replaceChildren(...messages.map(renderMessage), ...extra);
  elements.controlChatMessages.scrollTop = elements.controlChatMessages.scrollHeight;
  clearInterval(pendingTicker);
  pendingTicker = pending.size ? setInterval(tickPending, 1000) : null;
}

function matchesFilter(message) {
  if (filter.project === "general" && message.projectId) return false;
  if (filter.project && filter.project !== "general" && message.projectId !== filter.project) return false;
  const levels = { important: ["needs-ok", "urgent", "needs-you"], reports: ["report", "done"], fyi: ["fyi"] }[filter.importance];
  return !levels || levels.includes(message.importance);
}

async function loadMessages() {
  const query = new URLSearchParams();
  if (filter.project) query.set("project", filter.project);
  if (filter.importance) query.set("importance", filter.importance);
  messages = (await api(`/api/control-center/bob/messages?${query}`)).messages;
  renderMessages();
}

async function runAction(message, action, button) {
  // Opening a conversation and undoing a display change happen in the page; every other button is answered by the server.
  if (action.data?.open) { openConversation(action.data.open).catch((error) => toast(error.message)); return; }
  if (action.data?.appearance) { applyAppearance(action.data.appearance); toast("Display settings put back"); return; }
  button.disabled = true;
  try {
    const result = await api("/api/control-center/bob/action", { method: "POST", body: JSON.stringify({ messageId: message.id, actionId: action.id }) });
    // A button runs once: the server took the pressed message's buttons away, and so does the page.
    message.actions = [];
    if (result.messages?.length) messages.push(...result.messages.filter(matchesFilter));
    renderMessages();
    // Features whose button also changes the page (open a tab) listen for the one that ran.
    window.dispatchEvent(new CustomEvent("control-bob-action", { detail: { actionId: action.id, data: action.data } }));
    void refreshControlCenter().catch(() => undefined);
  } catch (error) {
    toast(error.message);
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
    toast(error.message);
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
    toast(error.message);
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
  api("/api/control-center/guardian/protect", { method: "POST", body: "{}" }).then(showGuard).catch((error) => toast(error.message));
});

async function openSettings() {
  showGuard().catch((error) => toast(error.message));
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

elements.controlChatSettingsButton.addEventListener("click", () => { void openSettings().catch((error) => toast(error.message)); });
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
  void loadMessages().catch((error) => toast(error.message));
});
for (const chip of elements.controlChatFilters.querySelectorAll("[data-importance]")) {
  chip.addEventListener("click", () => {
    filter.importance = chip.dataset.importance;
    for (const other of elements.controlChatFilters.querySelectorAll("[data-importance]")) other.classList.toggle("active", other === chip);
    void loadMessages().catch((error) => toast(error.message));
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

// The project lists follow the board's, so a person can pick or filter by project.
window.addEventListener("control-center-rendered", (event) => {
  const choose = (select, first) => {
    const chosen = select.value;
    select.replaceChildren(...first, ...event.detail.projects.map((project) => new Option(project.name, project.id)));
    select.value = chosen;
  };
  choose(elements.controlChatProject, [new Option("Auto", "")]);
  choose(elements.controlChatFilterProject, [new Option("All projects", ""), new Option("General", "general")]);
  applyLayout();
  // The board's own project chips focus the chat too: one project chosen there filters it here.
  const focus = event.detail.focus.length === 1 ? event.detail.focus[0] : "";
  if (focus === boardFocus) return;
  boardFocus = focus;
  if (filter.project === "general" && !focus) return;
  filter.project = focus;
  elements.controlChatFilterProject.value = focus;
  elements.controlChatProject.value = focus;
  void loadMessages().catch((error) => toast(error.message));
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
  })().catch((error) => toast(error.message));
});

elements.controlChatSide.addEventListener("click", () => {
  state.controlCenter.chatSide = state.controlCenter.chatSide === "left" ? "right" : "left";
  applyLayout();
  saveControlCenter();
});

elements.controlChatResize.addEventListener("mousedown", (event) => {
  event.preventDefault();
  elements.controlChatResize.classList.add("dragging");
  const bounds = elements.controlCenterMain.getBoundingClientRect();
  const move = (moveEvent) => {
    const fromEdge = state.controlCenter.chatSide === "left" ? moveEvent.clientX - bounds.left : bounds.right - moveEvent.clientX;
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
