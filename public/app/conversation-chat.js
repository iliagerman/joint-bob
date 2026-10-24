import { harnessOption } from "../harness-metadata.js";
import { renderMarkdown } from "../markdown.js";
import { setActivityPanelOpen } from "./activity-panel.js";
import { api } from "./api.js";
import { fillModelOptions, selectedModel } from "./git-reviewer-options.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const byId = (id) => document.getElementById(id);
const panel = byId("conversationChat");
const activityTab = byId("activityActivityTab");
const chatTab = byId("activityChatTab");
const harnessSelect = byId("conversationChatHarness");
const modelSelect = byId("conversationChatModel");
const input = byId("conversationChatInput");
const send = byId("conversationChatSend");
const clear = byId("conversationChatClear");
const status = byId("conversationChatStatus");
// Reuse the model option builder; effort is the selected harness's default, not another control.
const unusedThinking = document.createElement("select");
const submitting = new Map();
let snapshot = { messages: [], queue: [], busy: false };
let choices;
let loadedUrl = null;
let generation = 0;
let refreshRequest = 0;
let busy = false;
let streaming = null;
let streamFrame = 0;
let defaults = { showSelectors: true, model: null };

function conversationUrl() {
  return state.activeProjectId && state.activeConversationId
    ? `/api/projects/${encodeURIComponent(state.activeProjectId)}/conversations/${encodeURIComponent(state.activeConversationId)}/chat` : null;
}

async function loadChoices() {
  if (!choices) {
    const [harnesses, models] = await Promise.all([api("/api/harnesses"), api("/api/models")]);
    choices = { harnesses: harnesses.harnesses.filter((item) => item.runtimeConfigured), models: models.models };
  }
  return choices;
}

function fillHarness(select, automatic) {
  select.replaceChildren(...(automatic ? [new Option("From conversation", "")] : []), ...choices.harnesses.map(harnessOption));
}

function fillModels(harness, model, preferred) {
  const descriptor = choices.harnesses.find((item) => item.id === harness.value);
  model.disabled = !descriptor;
  if (descriptor) fillModelOptions(descriptor, choices.models, model, unusedThinking, preferred);
  else model.replaceChildren(new Option("From conversation", ""));
}

function modelChoice(harness, model) {
  return harness.value ? { harnessId: harness.value, ...selectedModel(model) } : null;
}

function setBusy(value) {
  busy = value;
  send.disabled = !loadedUrl;
  send.textContent = value ? "Queue" : "Send";
  clear.disabled = value || !loadedUrl;
  harnessSelect.disabled = value;
  modelSelect.disabled = value || !harnessSelect.value;
}

function messageActions(message) {
  const actions = document.createElement("div");
  actions.className = "conversation-chat-message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost compact";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", "Copy message");
  copy.dataset.testid = "conversation-chat-copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(message.text); copy.textContent = "Copied"; }
    catch (error) { toast(`Could not copy message: ${error.message}`); }
  });
  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "ghost compact";
  quote.textContent = "Quote";
  quote.setAttribute("aria-label", "Quote message");
  quote.dataset.testid = "conversation-chat-quote";
  quote.addEventListener("click", () => {
    const author = message.role === "user" ? "You" : "Assistant";
    const quoted = [`> ${author}:`, ...message.text.split("\n").map((line) => `> ${line}`)].join("\n");
    input.value += `${input.value ? "\n\n" : ""}${quoted}\n\n`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  actions.append(copy, quote);
  return actions;
}

function renderMessages(messages) {
  const list = byId("conversationChatMessages");
  const scrollTop = list.scrollTop;
  const follow = list.scrollHeight - scrollTop - list.clientHeight < 32;
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "settings-hint";
    empty.textContent = "Ask about this conversation. Its original context stays unchanged.";
    list.append(empty);
  }
  for (const message of messages) {
    const entry = document.createElement("article");
    entry.className = `conversation-chat-message ${message.role}`;
    const label = document.createElement("strong");
    label.textContent = message.role === "user" ? (message.queued ? "You · Queued" : "You") : message.streaming ? "Assistant · Writing…" : "Assistant";
    const header = document.createElement("header");
    header.className = "conversation-chat-message-header";
    header.append(label, messageActions(message));
    const text = document.createElement("div");
    text.className = "md";
    if (message.role === "assistant") renderMarkdown(text, message.text);
    else { text.textContent = message.text; text.style.whiteSpace = "pre-wrap"; }
    entry.append(header, text);
    if (message.error) {
      const error = document.createElement("p");
      error.className = "settings-hint";
      error.textContent = `Answer failed: ${message.error}`;
      entry.append(error);
    }
    list.append(entry);
  }
  list.scrollTop = follow ? list.scrollHeight : scrollTop;
}

function acceptSnapshot(body) {
  snapshot = body;
  if (body.stream && (!streaming || streaming.id !== body.stream.id || body.stream.text.length >= streaming.text.length)) streaming = body.stream;
  if (streaming && (body.messages.some((message) => message.id === streaming.id || (message.id === streaming.questionId && message.error)) || (!body.busy && !body.stream))) streaming = null;
}

function renderChat() {
  const historyIds = new Set(snapshot.messages.map((item) => item.id));
  const queued = snapshot.queue.filter((item) => !historyIds.has(item.id)).map((item) => ({ id: item.id, role: "user", text: item.question, queued: item.id !== streaming?.questionId }));
  const known = new Set([...snapshot.messages, ...queued].map((item) => item.id));
  const pending = [...submitting.values()].filter((item) => !known.has(item.id));
  const active = [...queued, ...pending].filter((item) => item.id === streaming?.questionId);
  const waitingMessages = [...queued, ...pending].filter((item) => item.id !== streaming?.questionId);
  const live = streaming ? [{ ...streaming, role: "assistant", streaming: true }] : [];
  renderMessages([...snapshot.messages, ...active, ...live, ...waitingMessages]);
  setBusy(snapshot.busy || snapshot.queue.length > 0 || submitting.size > 0);
  const waiting = queued.length + pending.filter((item) => item.queued).length;
  status.textContent = busy ? `${snapshot.busy ? "Answering…" : "Sending…"}${waiting ? ` · ${waiting} queued` : ""}` : "";
}

async function refreshChat() {
  const url = loadedUrl;
  if (!url || url !== conversationUrl()) return;
  const current = generation;
  const request = ++refreshRequest;
  try {
    const body = await api(url);
    if (current !== generation || request !== refreshRequest || url !== conversationUrl() || url !== loadedUrl) return;
    acceptSnapshot(body);
    renderChat();
  } catch (error) {
    if (current === generation && request === refreshRequest) status.textContent = error.message;
  }
}

function showTab(chat) {
  panel.hidden = !chat;
  byId("activityBody").hidden = chat;
  activityTab.setAttribute("aria-selected", String(!chat));
  chatTab.setAttribute("aria-selected", String(chat));
}

async function loadChat() {
  const url = conversationUrl();
  const current = ++generation;
  refreshRequest += 1;
  loadedUrl = null;
  setBusy(true);
  renderMessages([]);
  status.textContent = url ? "Loading…" : "Open a conversation first.";
  if (!url) return;
  try {
    const [body] = await Promise.all([api(url), loadChoices()]);
    if (current !== generation || url !== conversationUrl()) return;
    loadedUrl = url;
    defaults = body.defaults;
    const model = body.model ?? defaults.model;
    fillHarness(harnessSelect, true);
    harnessSelect.value = model?.harnessId ?? "";
    fillModels(harnessSelect, modelSelect, model ?? {});
    byId("conversationChatSelectors").hidden = !defaults.showSelectors;
    acceptSnapshot(body);
    renderChat();
    // A pushed completion may have arrived while the initial GET or model catalog was loading.
    await refreshChat();
  } catch (error) {
    if (current === generation) { status.textContent = error.message; setBusy(false); }
  }
}

export async function openConversationChat() {
  showTab(true);
  setActivityPanelOpen(true);
  await loadChat();
  input.focus();
}

chatTab.addEventListener("click", () => void openConversationChat());
activityTab.addEventListener("click", () => showTab(false));
harnessSelect.addEventListener("change", () => fillModels(harnessSelect, modelSelect, {}));
for (const tab of [activityTab, chatTab]) tab.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const next = tab === activityTab ? chatTab : activityTab;
  next.click();
  next.focus();
});

byId("conversationChatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = input.value.trim();
  const url = loadedUrl;
  if (!question || !url || url !== conversationUrl()) return;
  const id = crypto.randomUUID();
  const model = modelChoice(harnessSelect, modelSelect);
  submitting.set(id, { id, role: "user", text: question, queued: busy });
  input.value = "";
  renderChat();
  try {
    await api(url, { method: "POST", body: JSON.stringify({ id, question, model }) });
    submitting.delete(id);
    if (url === conversationUrl() && url === loadedUrl) await refreshChat();
  } catch (error) {
    submitting.delete(id);
    if (url === conversationUrl() && url === loadedUrl) {
      await refreshChat();
      if (!input.value) input.value = question;
      status.textContent = error.message;
    }
  }
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    byId("conversationChatForm").requestSubmit();
  }
});
clear.addEventListener("click", async () => {
  const url = loadedUrl;
  if (busy || !url || url !== conversationUrl()) return;
  const current = generation;
  let failure = "";
  // Do not allow a new question or an older history read to race the clear request.
  refreshRequest += 1;
  loadedUrl = null;
  setBusy(true);
  try {
    const body = await api(url, { method: "DELETE" });
    if (current === generation && url === conversationUrl()) {
      acceptSnapshot({ ...body, busy: false });
      status.textContent = "";
    }
  } catch (error) {
    failure = error.message;
  } finally {
    if (current === generation) {
      loadedUrl = url;
      renderChat();
      if (failure) status.textContent = failure;
    }
  }
});
document.addEventListener("conversation-chat-stream", (event) => {
  const payload = event.detail;
  if (payload.projectId !== state.activeProjectId || payload.conversationId !== state.activeConversationId || loadedUrl !== conversationUrl()) return;
  if (snapshot.messages.some((message) => message.id === payload.stream.id)) return;
  refreshRequest += 1;
  streaming = payload.stream;
  if (payload.messages) snapshot.messages = payload.messages;
  snapshot.busy = true;
  if (!streamFrame) streamFrame = requestAnimationFrame(() => { streamFrame = 0; renderChat(); });
});
document.addEventListener("conversation-chat-changed", (event) => {
  if (event.detail.projectId !== state.activeProjectId || event.detail.conversationId !== state.activeConversationId) return;
  void refreshChat().then(() => { if (event.detail.error && loadedUrl === conversationUrl()) status.textContent = event.detail.error; });
});
document.addEventListener("conversation-chat-reconnected", () => { if (!panel.hidden) void refreshChat(); });
document.addEventListener("activity-show-steps", () => showTab(false));
document.addEventListener("activity-conversation-changed", () => {
  generation += 1;
  loadedUrl = null;
  submitting.clear();
  streaming = null;
  snapshot = { messages: [], queue: [], busy: false };
  input.value = "";
  renderMessages([]);
  setBusy(false);
  showTab(false);
});

const settingsHarness = byId("settingsSideChatHarness");
const settingsModel = byId("settingsSideChatModel");
const settingsShow = byId("settingsSideChatSelectors");
export async function loadConversationChatSettings() {
  const [saved] = await Promise.all([api("/api/conversation-chat/settings"), loadChoices()]);
  defaults = saved;
  settingsShow.checked = saved.showSelectors;
  fillHarness(settingsHarness, true);
  settingsHarness.value = saved.model?.harnessId ?? "";
  fillModels(settingsHarness, settingsModel, saved.model ?? {});
  byId("settingsSideChatModelLabel").hidden = !settingsHarness.value;
}
async function saveDefaults() {
  try {
    defaults = await api("/api/conversation-chat/settings", { method: "PUT", body: JSON.stringify({
      showSelectors: settingsShow.checked, model: modelChoice(settingsHarness, settingsModel),
    }) });
    byId("conversationChatSelectors").hidden = !defaults.showSelectors;
    if (!panel.hidden && !busy) await loadChat();
  } catch (error) { toast(error.message); }
}
settingsHarness.addEventListener("change", () => {
  fillModels(settingsHarness, settingsModel, {});
  byId("settingsSideChatModelLabel").hidden = !settingsHarness.value;
  void saveDefaults();
});
settingsModel.addEventListener("change", () => void saveDefaults());
settingsShow.addEventListener("change", () => void saveDefaults());
