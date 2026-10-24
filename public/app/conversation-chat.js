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
let choices;
let loadedUrl = null;
let generation = 0;
let busy = false;
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
  send.disabled = value || !loadedUrl;
  clear.disabled = value || !loadedUrl;
  harnessSelect.disabled = value;
  modelSelect.disabled = value || !harnessSelect.value;
}

function renderMessages(messages) {
  const list = byId("conversationChatMessages");
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
    label.textContent = message.role === "user" ? "You" : "Assistant";
    const text = document.createElement("div");
    text.className = "md";
    if (message.role === "assistant") renderMarkdown(text, message.text);
    else { text.textContent = message.text; text.style.whiteSpace = "pre-wrap"; }
    entry.append(label, text);
    list.append(entry);
  }
  list.scrollTop = list.scrollHeight;
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
    renderMessages(body.messages);
    status.textContent = body.busy ? "An answer is running. Reopen Chat to refresh." : "";
    setBusy(body.busy);
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
  if (!question || busy || !url || url !== conversationUrl()) return;
  const current = generation;
  setBusy(true);
  status.textContent = "Answering…";
  try {
    const body = await api(url, { method: "POST", body: JSON.stringify({ question, model: modelChoice(harnessSelect, modelSelect) }) });
    if (current !== generation || url !== conversationUrl()) return;
    renderMessages(body.messages);
    input.value = "";
    status.textContent = "";
  } catch (error) {
    if (current === generation) status.textContent = error.message;
  } finally {
    if (current === generation) setBusy(false);
    else if (url === conversationUrl() && !panel.hidden) void loadChat();
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
  setBusy(true);
  try {
    const body = await api(url, { method: "DELETE" });
    if (current === generation && url === conversationUrl()) {
      renderMessages(body.messages);
      status.textContent = "";
    }
  } catch (error) {
    if (current === generation) status.textContent = error.message;
  } finally { if (current === generation) setBusy(false); }
});
document.addEventListener("activity-show-steps", () => showTab(false));
document.addEventListener("activity-conversation-changed", () => {
  generation += 1;
  loadedUrl = null;
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
