import { harnessOption } from "../harness-metadata.js";
import { renderMarkdown } from "../markdown.js";
import { api } from "./api.js";
import { elements } from "./elements.js";
import { openConversation, refreshControlCenter, saveControlCenter } from "./control-center.js";
import { fillModelOptions, fillThinkingOptions, selectedModel } from "./git-reviewer-options.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

const MIN_WIDTH = 300;
const MAX_WIDTH = 820;

const IMPORTANCE_LABELS = { "needs-ok": "Needs OK", urgent: "Urgent", "needs-you": "Needs you", report: "Report", done: "Done", fyi: "FYI" };

let settings = null;
let messages = [];
const filter = { project: "", importance: "" };
let settingsLoaded = false;
let catalog = { harnesses: [], models: [] };

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

function renderMessage(message) {
  const wrap = element("div", `control-entry ${message.role}`);
  wrap.dataset.testid = "control-chat-entry";
  wrap.dataset.importance = message.importance;
  wrap.dataset.project = message.projectId ?? "";
  const labels = element("div", "control-labels");
  labels.append(element("span", "control-label project", message.projectName ?? "General"));
  labels.append(element("span", `control-label importance ${message.importance}`, IMPORTANCE_LABELS[message.importance] ?? message.importance));
  if (message.role === "user") labels.classList.add("right");
  const body = element("div", `control-msg ${message.role === "user" ? "user" : "bob"}`);
  // Bob's agent answers in Markdown. What the person typed, and system notices that quote commands, stay as written.
  if (message.role === "bob") { body.classList.add("markdown"); renderMarkdown(body, message.text); }
  else body.textContent = message.text;
  wrap.append(labels);
  if (message.via) wrap.append(element("div", "control-via", message.via));
  wrap.append(body);
  if (message.actions?.length) {
    const actions = element("div", "control-actions");
    for (const action of message.actions) {
      const button = element("button", `control-action ${action.style ?? ""}`, action.label);
      button.type = "button";
      button.addEventListener("click", () => runAction(message, action, button));
      actions.append(button);
    }
    wrap.append(actions);
  }
  return wrap;
}

function renderMessages() {
  elements.controlChatMessages.replaceChildren(...messages.map(renderMessage));
  elements.controlChatMessages.scrollTop = elements.controlChatMessages.scrollHeight;
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
  // Opening a conversation happens in the page; every other button is answered by the server.
  if (action.data?.open) { openConversation(action.data.open).catch((error) => toast(error.message)); return; }
  button.disabled = true;
  try {
    const result = await api("/api/control-center/bob/action", { method: "POST", body: JSON.stringify({ messageId: message.id, actionId: action.id }) });
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

async function send(text, answerOnly) {
  const projectId = elements.controlChatProject.value || undefined;
  elements.controlChatSend.disabled = true;
  const waiting = element("div", "control-msg bob", "…");
  elements.controlChatMessages.append(waiting);
  elements.controlChatMessages.scrollTop = elements.controlChatMessages.scrollHeight;
  try {
    const result = await api("/api/control-center/bob/message", { method: "POST", body: JSON.stringify({ message: text, ...(projectId ? { projectId } : {}), ...(answerOnly ? { answerOnly: true } : {}) }) });
    waiting.remove();
    for (const message of [result.user, result.reply]) if (matchesFilter(message)) messages.push(message);
    renderMessages();
    if (result.action === "started") void refreshControlCenter().catch(() => undefined);
  } catch (error) {
    waiting.remove();
    elements.controlChatMessages.append(element("div", "control-msg error", error.message));
  } finally {
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

elements.controlChatFilterProject.addEventListener("change", () => {
  filter.project = elements.controlChatFilterProject.value;
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
  if (!text) return;
  elements.controlChatInput.value = "";
  // Text that came from outside (a webhook's payload) may only be answered, never acted on.
  const answerOnly = elements.controlChatForm.dataset.answerOnly === "1";
  delete elements.controlChatForm.dataset.answerOnly;
  void send(text, answerOnly);
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
