import { api, savePreferencesInBackground } from "./api.js";
import { syncBrowserButton } from "./browser.js";
import { clearThinkingBubble } from "./chat-transcript.js";
import { changeReasoningLevel, hideCommandAutocomplete, PI_MODEL_PROVIDERS, renderCommandAutocomplete, renderReasoningOptions, renderToolsDialog, syncModelButton } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { syncChatTitleFromSessions } from "./layout.js";
import { renderSessions } from "./session-list.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { shared, state } from "./state.js";
import { activeChatSession, continueTaskOnNode } from "./terminal.js";

function conversationIsReadOnly() {
  return state.conversationReadOnly || conversationTask()?.status === "done";
}

export function setComposerEnabled(enabled) {
  // Ownership and completed tickets both fence writes, regardless of socket health.
  const allowed = enabled && !state.conversationLock && !conversationIsReadOnly();
  elements.messageInput.disabled = !allowed;
  elements.sendButton.disabled = !allowed;
  elements.attachButton.disabled = !allowed;
  elements.attachmentInput.disabled = !allowed;
  elements.renameSessionButton.disabled = !allowed;
  elements.modelButton.disabled = !allowed;
  elements.reasoningLevelSelect.disabled = !allowed;
  // Putting a conversation on the canvas reads it; a lock must not hide the action.
  elements.addToCanvasButton.disabled = !enabled;
  if (!allowed) hideCommandAutocomplete();
}

export function renderConversationLock() {
  const lock = state.conversationLock;
  const readOnly = conversationIsReadOnly();
  elements.conversationLock.hidden = !lock;
  elements.doneConversationNotice.hidden = !readOnly;
  elements.composer.hidden = Boolean(lock) || readOnly;
  elements.commandStrip.hidden = Boolean(lock) || readOnly;
  if (!lock) {
    elements.conversationLockStatus.textContent = "";
    return;
  }
  const takeable = !state.activeTaskId;
  elements.conversationLockDetail.textContent = lock.status === "conflict"
    ? `Ownership is conflicted between this node and ${lock.nodeName}. Writes stay fenced until one node takes ownership.`
    : takeable
      ? `This conversation is owned by ${lock.nodeName}. Anything you send from here is rejected until you take ownership.`
      : `This conversation is owned by ${lock.nodeName}. Open it there to continue \u2014 a ticket conversation stays on its node.`;
  elements.conversationLockTakeButton.hidden = !takeable;
  elements.conversationLockTakeButton.disabled = !takeable || shared.ownershipTaking || Boolean(shared.ownershipWait);
  elements.conversationLockTakeButton.title = takeable ? `Move ownership to this node from ${lock.nodeName}` : "";
}

export function sendSocket(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(payload));
  return true;
}

/**
 * The ticket a conversation belongs to. A ticket owns its session file, so the
 * link holds however the conversation was reached - from the board card, or
 * straight from the Chats list, which never sets an active ticket.
 */
export function conversationTask() {
  const opened = state.tasks.find((candidate) => candidate.id === state.activeTaskId);
  if (opened) return opened;
  return state.tasks.find((candidate) => candidate.sessionPath && candidate.sessionPath === state.activeSessionPath);
}

function renderTaskBacklink() {
  const task = conversationTask();
  elements.taskBacklinkButton.hidden = !task;
  if (!task) return;
  elements.taskBacklinkButton.textContent = `◂ ${task.title}`;
  elements.taskBacklinkButton.title = `Back to ticket: ${task.title}`;
  elements.taskBacklinkButton.setAttribute("aria-label", `Back to ticket ${task.title}`);
}

/**
 * Replacing a <select>'s options closes it if the user has it open, and these
 * controls are redrawn on every background refresh - about once a second while an
 * agent is streaming. The options themselves only change when nodes or harnesses
 * do, so the rebuild is skipped unless they actually differ.
 */
function syncSelectOptions(select, options) {
  const signature = JSON.stringify(options);
  if (select.dataset.optionsSignature === signature) return;
  select.replaceChildren(...options.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    option.disabled = Boolean(entry.disabled);
    return option;
  }));
  select.dataset.optionsSignature = signature;
}

export function renderChatSessionControls() {
  syncBrowserButton();
  syncSelectOptions(elements.chatNodeSelect, state.sessionNodes.map((node) => ({
    value: node.id,
    label: `${node.name}${node.local ? " · local" : ""}${!node.online ? " · offline" : !node.mapped ? " · map required" : ""}`,
    disabled: !node.online || !node.mapped,
  })));
  elements.chatNodeSelect.value = state.activeNodeId || "";
  const activeTicket = state.activeTaskId ? state.tasks.find((task) => task.id === state.activeTaskId) : null;
  elements.chatNodeSelect.disabled = !state.activeProjectId || !state.sessionNodes.length || conversationIsReadOnly();

  syncSelectOptions(elements.chatHarnessSelect, state.harnesses.map((harness) => ({ value: harness.id, label: harness.label })));
  elements.chatHarnessSelect.value = state.engine;
  elements.chatHarnessSelect.disabled = !state.activeProjectId || !state.harnesses.length || conversationIsReadOnly();

  // Conversations are picked in the conversations panel; the toolbar no longer duplicates it.

  const terminalNode = state.sessionNodes.find((node) => node.id === state.activeNodeId);
  elements.openTerminalButton.disabled = !state.activeProjectId || !terminalNode?.online || !terminalNode.mapped || conversationIsReadOnly();
  elements.openTerminalButton.title = terminalNode
    ? activeTicket
      ? `Open this ticket's folder in Terminal on ${terminalNode.name}`
      : `Open the project folder in Terminal on ${terminalNode.name}`
    : "Select an execution node first";
  renderTaskBacklink();
}

export function syncEngineUI() {
  elements.chatHarnessSelect.value = state.engine;
  renderChatSessionControls();
  renderReasoningOptions();
  syncModelButton();
}

function syncReasoningControls(status) {
  state.thinkingLevel = status.thinkingLevel || (state.engine === "claude" ? "default" : "off");
  Object.assign(state, { availableThinkingLevels: status.availableThinkingLevels || [] });
  if (state.engine === "claude") state.claudeEffort = state.thinkingLevel;
  renderReasoningOptions();
}

// Both harnesses report the same {usedTokens, contextWindow, percent} reading, so
// the gauge does not care which engine is driving the conversation.
function syncContextUsage(usage) {
  if (!usage) {
    elements.contextUsage.hidden = true;
    return;
  }
  const percent = Math.max(0, Math.min(100, Math.round(usage.percent)));
  elements.contextUsage.hidden = false;
  elements.contextUsage.classList.toggle("warn", percent >= 75 && percent < 90);
  elements.contextUsage.classList.toggle("danger", percent >= 90);
  elements.contextUsageFill.style.width = `${percent}%`;
  elements.contextUsageText.textContent = `${percent}%`;
  elements.contextUsage.title = `Context: ${usage.usedTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${percent}%)`;
}

export function updateStatus(status) {
  if (!status) return;
  if (!status.isStreaming) clearThinkingBubble();
  state.sessionBusy = Boolean(status.isStreaming || status.isBashRunning || status.isCompacting || status.isRetrying);
  elements.abortButton.disabled = !status.isStreaming && !status.isBashRunning && !status.isCompacting && !status.isRetrying;
  if (status.sessionName) syncChatTitleFromSessions(status.sessionName);
  state.activeModelKey = status.model ? `${status.model.provider}/${status.model.id}` : "";
  state.activeModelLabel = status.model ? status.model.label : "";
  syncReasoningControls(status);
  syncContextUsage(status.contextUsage);
  syncModelButton();
  if (elements.toolsDialog.open) renderToolsDialog();
}

function piUiModels(models) {
  const ordered = [];
  for (const { provider } of PI_MODEL_PROVIDERS) {
    ordered.push(...models.filter((model) => model.provider === provider));
  }
  return ordered;
}

export function setModels(models) {
  state.models = piUiModels(models);
  syncModelButton();
}

export async function loadHarnesses() {
  const body = await api("/api/harnesses");
  state.harnesses = body.harnesses || [];
  renderChatSessionControls();
}

export async function loadSessionNodes(projectId) {
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/session-nodes`);
  if (state.activeProjectId !== projectId) return;
  state.sessionNodes = body.nodes;
  const previousNodeId = state.activeNodeId;
  const selected = state.sessionNodes.find((node) => node.id === state.activeNodeId && node.online && node.mapped)
    || state.sessionNodes.find((node) => node.local);
  state.activeNodeId = selected?.id || null;
  if (state.preferencesLoaded && state.activeNodeId !== previousNodeId) savePreferencesInBackground({ activeNodeId: state.activeNodeId });
  renderSessions();
}
elements.chatNodeSelect.addEventListener("change", async () => {
  const destination = state.sessionNodes.find((node) => node.id === elements.chatNodeSelect.value);
  const task = state.activeTaskId ? state.tasks.find((candidate) => candidate.id === state.activeTaskId) : null;
  if (state.activeTaskId) {
    if (!task || !destination) {
      toast(!task ? "Active ticket was not found" : "Destination node was not found");
      return;
    }
    const ownerId = task.currentNodeId;
    if (destination.id === ownerId) return;
    try {
      if (await continueTaskOnNode(task, destination)) return;
      state.activeNodeId = ownerId;
      elements.chatNodeSelect.value = ownerId;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: ownerId });
    } catch (error) {
      state.activeNodeId = ownerId;
      elements.chatNodeSelect.value = ownerId;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: ownerId });
      toast(error.message, 8000);
    }
    return;
  }
  state.activeNodeId = elements.chatNodeSelect.value;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: state.activeNodeId });
  if (!activeChatSession()) {
    state.activeSessionId = null;
    return;
  }
  openSession(state.activeSessionPath, elements.sessionTitle.textContent || "Conversation", false);
});
elements.chatHarnessSelect.addEventListener("change", () => {
  const harness = state.harnesses.find((candidate) => candidate.id === elements.chatHarnessSelect.value);
  if (!harness || harness.id === state.engine) return;
  state.activeTaskId = null;
  state.engine = harness.id;
  state.activeSessionPath = harness.newSessionPath;
  state.activeSessionId = null;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: state.activeSessionPath, activeSessionId: null });
  syncEngineUI();
  state.commands = [];
  state.commandsLoading = false;
  state.commandsKey = null;
  state.commandAutocompleteIndex = 0;
  renderCommandAutocomplete();
  if (!sendSocket({ type: "setEngine", engine: harness.id })) {
    openSession(harness.newSessionPath, `New ${harness.label} conversation`);
  }
});
elements.reasoningLevelSelect.addEventListener("change", changeReasoningLevel);
