import { harnessIdFromPath, harnessLabel } from "../harness-metadata.js";
import { api, loadPins, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { syncBackgroundTasks } from "./background-tasks.js";
import { renderChatSessionControls, renderConversationLock, sendSocket, setComposerEnabled, setModels, syncEngineUI, updateRoutingMode, updateStatus } from "./chat-controls.js";
import { appendMessage, appendToolMessage, clearChat, clearQueuedMark, clearThinkingBubble, finalizeAssistantBubble, finishTurnTimer, markMessageQueued, markPromptRouted, appendErrorMessage, markQueuedMessageFailed, markUserMessagesRead, removeQueuedMessage, renderBubbleContent, requestPinChat, rerenderChatTranscript, resetQueuedForceStart, restoreChatScrollTop, showChatEmptyState, startDurationTicker, startHarnessSegment, syncQueuedMessageOrder, updateQueuedMessage, updateToolMessage } from "./chat-transcript.js";
import { rememberDraft, restoreDraft, seedPromptHistory, setActiveSessionPath } from "./composer.js";
import { renderToolsDialog } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { setMobileView, shortSessionTitle, syncChatTitleFromSessions } from "./layout.js";
import { refreshProjectsQuietly } from "./project-selection.js";
import { loadRecentSessions } from "./recents.js";
import { schedulePendingReviewsRefresh } from "./reviews.js";
import { saveSessionColor, saveSessionTitle } from "./session-identity.js";
import { renderSessions } from "./session-list.js";
import { maybeNotifyTurnComplete, playCompletionSound, setConnecting, setStatus, subscribeToPush, toast } from "./shell.js";
import { state } from "./state.js";
import { loadTasks } from "./tasks.js";

const GOAL_COMPLETE_MARKER = "BOB_GOAL_COMPLETE";

function visibleAssistantText(text, streaming = false) {
  const complete = text.replace(/\n?BOB_GOAL_COMPLETE\s*$/, "");
  if (!streaming || complete !== text) return complete;
  const lineStart = text.lastIndexOf("\n") + 1;
  const trailingLine = text.slice(lineStart);
  return trailingLine && GOAL_COMPLETE_MARKER.startsWith(trailingLine) ? text.slice(0, lineStart) : text;
}

export function socketOpen() {
  return Boolean(state.socket && state.socket.readyState === WebSocket.OPEN);
}

export function closeSocket() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopHeartbeat();
  const socket = state.socket;
  state.socket = null;
  if (socket) socket.close();
  setStatus("Idle");
  setConnecting(false);
}

function scheduleReconnect(sessionPath, delay = 1500) {
  if (!state.activeProjectId || !sessionPath) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    openSession(sessionPath, elements.sessionTitle.textContent || "Conversation", true, Boolean(state.activeTaskId));
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  state.lastPongAt = Date.now();
  state.heartbeatTimer = setInterval(() => {
    if (!state.socket) return;
    if (state.socket.readyState === WebSocket.OPEN) {
      if (Date.now() - state.lastPongAt > 45000) {
        // Connection looks dead (no pong in 3+ intervals). Force a reconnect.
        resumeConnection(true);
        return;
      }
      state.socket.send(JSON.stringify({ type: "ping" }));
    } else if (state.socket.readyState === WebSocket.CLOSING || state.socket.readyState === WebSocket.CLOSED) {
      resumeConnection(true);
    }
  }, 15000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

// Proactively restore the session connection. Mobile browsers freeze JS timers
// and kill sockets when the app is backgrounded or the screen locks, so the
// WebSocket "close" event often only fires after the user returns. This is
// called on visibilitychange / pageshow / online and from the heartbeat.
function resumeConnection(force = false) {
  if (!state.activeProjectId || !state.activeSessionPath) return;
  const fresh = Date.now() - state.lastPongAt < 40000;
  if (!force && socketOpen() && fresh) {
    // Looks healthy — probe anyway so we notice zombies quickly.
    sendSocket({ type: "ping" });
    return;
  }
  if (state.socket) {
    const stale = state.socket;
    state.socket = null;
    try {
      stale.close();
    } catch {
      /* ignore */
    }
  }
  setStatus("Connecting…", false, true);
  setConnecting(true, "Connecting…");
  setComposerEnabled(false);
  scheduleReconnect(state.activeSessionPath, 250);
}

function websocketUrl(sessionPath) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", sessionPath || "new");
  if (state.activeSessionId) url.searchParams.set("sessionId", state.activeSessionId);
  if (state.activeNodeId && !state.activeTaskId) url.searchParams.set("nodeId", state.activeNodeId);
  if (state.activeTaskId) url.searchParams.set("taskId", state.activeTaskId);
  if (state.spinOffSourceTaskId) url.searchParams.set("sourceTaskId", state.spinOffSourceTaskId);
  if (state.newSessionSecretAccountIds.length) url.searchParams.set("secretAccountIds", state.newSessionSecretAccountIds.join(","));
  return url.toString();
}

export function openSession(sessionPath, title = "New conversation", preserveChat = false, preserveTask = false, reviewHighlightAfter = null) {
  rememberDraft();
  // Opening a conversation that already exists drops the picks made for a new one.
  if (sessionPath && !state.harnesses.some(({ newSessionPath }) => newSessionPath === sessionPath)) {
    state.newSessionSecretAccountIds = [];
    state.spinOffSourceTaskId = null;
  }
  // A turn left running on the conversation being left must not keep counting
  // up in the header of the one being opened.
  state.lastTurnStartedAt = 0;
  if (!preserveTask) state.activeTaskId = null;
  if (!preserveChat) state.conversationReadOnly = false;
  if (state.activeTaskId) {
    const task = state.tasks.find((candidate) => candidate.id === state.activeTaskId);
    if (task) state.activeNodeId = task.currentNodeId;
  }
  closeSocket();
  if (!preserveChat) {
    state.reviewHighlightAfter = reviewHighlightAfter;
    state.pendingSessionTitle = null;
    state.pendingSessionColor = null;
    state.conversationSegments = null;
    state.activeConversationId = null;
    syncBackgroundTasks();
    state.scheduledTurn = false;
    state.scheduledAssistantText = "";
    state.assistantRawText = "";
    // A conversation being opened fresh starts out following the newest message.
    state.followChat = true;
    clearChat();
    clearAttachments();
    const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
    showChatEmptyState("Connecting…", `Opening this conversation on ${node?.name || "the selected node"}.`);
  }
  state.activeSessionPath = sessionPath || "new";
  restoreDraft();
  state.conversationLock = null;
  renderConversationLock();
  if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  state.engine = harnessIdFromPath(state.harnesses, state.activeSessionPath);
  elements.sessionTitle.textContent = title;
  renderSessions();
  // A reconnect reuses this function. Switching panels there would yank the user
  // off the board (or any other view) every time a socket blips.
  if (!preserveChat) setMobileView("chat");
  setStatus("Connecting…", false, true);
  setComposerEnabled(false);

  const socket = new WebSocket(websocketUrl(sessionPath));
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    setStatus("Connected", true);
    setConnecting(false);
    startHeartbeat();
  });
  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    console.info("Conversation socket closed", { code: event.code, reason: event.reason || "none", engine: state.engine });
    stopHeartbeat();
    setStatus("Connecting…", false, true);
    setConnecting(true, "Connecting…");
    setComposerEnabled(false);
    scheduleReconnect(state.activeSessionPath);
  });
  // The connecting banner already shows this state, and reconnect attempts
  // repeat, so a toast per attempt is pure noise.
  socket.addEventListener("error", () => console.warn("WebSocket connection failed"));
  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    handleSocketPayload(JSON.parse(event.data), !preserveChat);
  });
}

export function handleSocketPayload(payload, scrollOnReady = false) {
  if (payload.type === "updatePreparing") {
    const message = payload.message || "Updating... Work will resume automatically.";
    setConnecting(true, message);
    setComposerEnabled(false);
    return;
  }
  if (payload.type === "pong") {
    state.lastPongAt = Date.now();
    return;
  }
  if (payload.type === "ready") {
    const openingDraft = state.harnesses.some(({ newSessionPath }) => newSessionPath === state.activeSessionPath);
    state.conversationLock = payload.ownership ?? null;
    state.conversationReadOnly = payload.readOnly === true;
    if (!payload.engine) throw new Error("Ready payload is missing its harness engine");
    state.engine = payload.engine;
    if (payload.executionNodeId) {
      state.activeNodeId = payload.executionNodeId;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: payload.executionNodeId });
    }
    setComposerEnabled(true);
    if (openingDraft) elements.messageInput.focus();
    renderConversationLock();
    state.activeSessionId = payload.sessionId || state.activeSessionId;
    state.activeConversationId = payload.conversationId || payload.sessionId || null;
    state.conversationSegments = payload.segments || null;
    state.scheduledTurn = payload.scheduledTurn === true;
    state.scheduledAssistantText = "";
    state.assistantRawText = "";
    updateRoutingMode(payload.routing ?? null);
    syncEngineUI();
    if (payload.sessionFile) {
      setActiveSessionPath(payload.sessionFile);
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: payload.sessionFile, activeSessionId: state.activeSessionId });
    }
    // The conversation now has an id, so a name typed before it existed can be
    // saved straight away instead of riding on the first turn finishing.
    const pendingTitle = state.pendingSessionTitle;
    if (pendingTitle && payload.sessionId) {
      state.pendingSessionTitle = null;
      saveSessionTitle(state.activeConversationId || payload.sessionId, state.engine, pendingTitle)
        .then(() => refreshSessionsQuietly())
        .catch((error) => toast(error.message, 8000));
    }
    const pendingColor = state.pendingSessionColor;
    if (pendingColor && payload.sessionId) {
      state.pendingSessionColor = null;
      saveSessionColor(state.activeConversationId || payload.sessionId, state.engine, pendingColor)
        .then(() => refreshSessionsQuietly())
        .catch((error) => toast(error.message, 8000));
    }
    // Match the conversations list by id first: a conversation reopened from the
    // board or a task carries an id before its file path is known here, and
    // matching on the path alone fell back to a bare "<Harness> conversation".
    const matchingSession = state.sessions.find((session) => (state.activeSessionId && session.id === state.activeSessionId) || session.path === payload.sessionFile);
    elements.sessionTitle.textContent = pendingTitle
      ? pendingTitle
      : matchingSession
        ? shortSessionTitle(matchingSession)
        : openingDraft
          ? `New ${harnessLabel(state.harnesses, state.engine)} conversation`
          : `${harnessLabel(state.harnesses, state.engine)} conversation`;
    seedPromptHistory(payload.messages);
    console.info("Conversation transcript ready", {
      engine: payload.engine,
      messages: payload.messages?.length || 0,
      characters: payload.messages?.reduce((total, message) => total + String(message.text || "").length, 0) || 0,
      segments: payload.segments?.length || 1,
    });
    const resumeFromTop = rerenderChatTranscript(payload.messages, payload.segments);
    // A fresh open starts on the newest message; a reconnect re-render follows
    // if the reader was following and otherwise puts them back where they were.
    if (scrollOnReady || state.followChat) {
      state.followChat = true;
      requestPinChat();
    } else {
      restoreChatScrollTop(resumeFromTop);
    }
    if (!payload.messages?.length) {
      const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
      showChatEmptyState("Ready for your first message", `${harnessLabel(state.harnesses, state.engine)} will run on ${node?.name || "the selected node"}. The conversation is created when you send.`);
    }
    renderChatSessionControls();
    updateStatus(payload.status);
    sendSocket({ type: "models" });
    subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
    refreshSessionsQuietly();
    return;
  }
  if (payload.type === "ownership") {
    state.conversationLock = payload.ownership ?? null;
    setComposerEnabled(socketOpen());
    renderConversationLock();
    return;
  }
  if (payload.type === "engineChanged") {
    const oldEngine = state.engine;
    if (!payload.engine) throw new Error("Harness change payload is missing its engine");
    state.engine = payload.engine;
    state.activeSessionId = payload.sessionId || null;
    state.activeConversationId = payload.conversationId || state.activeConversationId;
    state.conversationSegments = payload.segments || [...(state.conversationSegments || [{ engine: oldEngine }]), { engine: state.engine }];
    syncEngineUI();
    startHarnessSegment(state.engine);
    toast(`Switched to ${harnessLabel(state.harnesses, state.engine)} — context carries over on your next message`);
    return;
  }
  if (payload.type === "sessionFile") {
    if (payload.sessionId) state.activeSessionId = payload.sessionId;
    if (payload.sessionFile) {
      setActiveSessionPath(payload.sessionFile);
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: payload.sessionFile, activeSessionId: state.activeSessionId });
    }
    return;
  }
  if (payload.type === "models") {
    setModels(payload.models || [], payload.harnessId);
    return;
  }
  if (payload.type === "tools") {
    state.tools = payload.tools || [];
    state.toolsLoading = false;
    renderToolsDialog();
    return;
  }
  if (payload.type === "status") {
    updateStatus(payload.status);
    return;
  }
  if (payload.type === "bobGoal") {
    if (payload.announce) toast(payload.message, 6000);
    return;
  }
  if (payload.type === "userMessage") {
    finalizeAssistantBubble();
    // A scheduled task's trigger prompt is the scheduler talking; a person's own
    // message always shows, even in a conversation a schedule also drives.
    if (payload.scheduled) return;
    state.spinOffSourceTaskId = null;
    const bubble = appendMessage("user", payload.text, true, payload.attachments);
    if (payload.queued) markMessageQueued(bubble, payload.queueId, payload.editableText, payload.settings, payload.revision);
    state.thinkingBubble = null;
    return;
  }
  // Prompts typed while the agent was busy live on the conversation, not on this
  // socket, so a reload or a reconnect gets them back instead of losing them.
  if (payload.type === "queuedPrompts") {
    const prompts = payload.prompts.filter((prompt) => !prompt.scheduled);
    const retained = new Set(prompts.map((prompt) => prompt.id));
    for (const bubble of elements.messages.querySelectorAll("[data-queue-id]")) {
      if (!retained.has(bubble.dataset.queueId)) removeQueuedMessage(bubble.dataset.queueId);
    }
    for (const prompt of prompts) {
      const existing = elements.messages.querySelector(`[data-queue-id="${prompt.id}"]`);
      if (existing) {
        if (Number(existing.dataset.queueRevision) !== prompt.revision) updateQueuedMessage(prompt.id, prompt.text, prompt.editableText, prompt.settings, prompt.revision);
        continue;
      }
      markMessageQueued(appendMessage("user", prompt.text, true, prompt.attachments), prompt.id, prompt.editableText, prompt.settings, prompt.revision);
    }
    syncQueuedMessageOrder(prompts.map((prompt) => prompt.id));
    return;
  }
  if (payload.type === "promptStarted") {
    state.scheduledTurn = payload.scheduled === true;
    clearQueuedMark(payload.queueId);
    return;
  }
  if (payload.type === "promptRouted") {
    markPromptRouted(payload);
    return;
  }
  if (payload.type === "routingMode") {
    updateRoutingMode({ active: payload.active !== false, mode: payload.mode === "manual" ? "manual" : "auto", ...(payload.classifierId ? { classifierId: payload.classifierId } : {}), ...(payload.editable !== undefined ? { editable: payload.editable } : {}), warning: payload.warning || "" });
    return;
  }
  // The harness refused to start this prompt (quota, auth, crash). It stays
  // queued for a retry, so the reason belongs on the bubble, not only in a toast.
  if (payload.type === "promptFailed") {
    markQueuedMessageFailed(payload.queueId, payload.error);
    appendErrorMessage(payload.error);
    return;
  }
  if (payload.type === "queuedPromptEdited") {
    updateQueuedMessage(payload.queueId, payload.text, payload.editableText, payload.settings, payload.revision);
    return;
  }
  if (payload.type === "queuedPromptCancelled") {
    removeQueuedMessage(payload.queueId);
    return;
  }
  if (payload.type === "textDelta") {
    if (state.scheduledTurn) {
      state.scheduledAssistantText += payload.text;
      return;
    }
    clearThinkingBubble();
    if (!state.assistantBubble) state.assistantBubble = appendMessage("assistant", "");
    state.assistantRawText += payload.text;
    renderBubbleContent(state.assistantBubble, visibleAssistantText(state.assistantRawText, true));
    return;
  }
  if (payload.type === "assistantFinal") {
    if (state.scheduledTurn) {
      state.scheduledAssistantText = payload.text;
      return;
    }
    clearThinkingBubble();
    const text = visibleAssistantText(payload.text);
    if (!state.assistantBubble) appendMessage("assistant", text);
    else renderBubbleContent(state.assistantBubble, text, true);
    state.assistantBubble = null;
    state.assistantRawText = "";
    return;
  }
  if (payload.type === "thinkingStart") {
    if (state.scheduledTurn) return;
    state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    return;
  }
  if (payload.type === "thinkingDelta") {
    if (state.scheduledTurn) return;
    if (!state.thinkingBubble) state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    const currentText = state.thinkingBubble._raw || "";
    renderBubbleContent(state.thinkingBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "thinkingEnd") {
    clearThinkingBubble();
    return;
  }
  if (payload.type === "toolStart") {
    if (state.scheduledTurn) return;
    clearThinkingBubble();
    finalizeAssistantBubble();
    const bubble = appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    startDurationTicker();
    return;
  }
  if (payload.type === "toolUpdate") {
    if (state.scheduledTurn) return;
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    updateToolMessage(bubble, payload.text || "", "Running");
    return;
  }
  if (payload.type === "toolEnd") {
    if (state.scheduledTurn) return;
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    updateToolMessage(bubble, payload.text || "", payload.isError ? "Failed" : "Done", payload.isError);
    state.toolBubbles.delete(payload.toolCallId);
    return;
  }
  if (payload.type === "assistantError") {
    if (state.scheduledTurn) return;
    clearThinkingBubble();
    finalizeAssistantBubble();
    appendMessage("tool", `${harnessLabel(state.harnesses, state.engine)} error: ${payload.error}`);
  }
  if (payload.type === "agent_start") {
    if (state.scheduledTurn) state.scheduledAssistantText = "";
    state.assistantRawText = "";
    setStatus(`${harnessLabel(state.harnesses, state.engine)} is working`, true);
    state.lastTurnStartedAt = Date.now();
    state.sessionBusy = true;
    // The turn starting means the agent has everything sent before it.
    markUserMessagesRead();
    startDurationTicker();
  }
  if (payload.type === "agent_end") {
    clearThinkingBubble();
    finalizeAssistantBubble();
    if (state.scheduledTurn && state.scheduledAssistantText.trim()) appendMessage("assistant", visibleAssistantText(state.scheduledAssistantText));
    state.scheduledAssistantText = "";
    state.assistantRawText = "";
    state.scheduledTurn = false;
    setStatus("Connected", true);
    state.sessionBusy = false;
    if (state.lastTurnStartedAt) {
      finishTurnTimer();
      maybeNotifyTurnComplete().catch((error) => console.warn("Notification failed", error));
      state.lastTurnStartedAt = 0;
    }
  }
  if (payload.type === "sessionInfoChanged" && payload.name) syncChatTitleFromSessions(payload.name);
  if (handleInvalidation(payload)) return;
  if (payload.type === "messages") {
    // Read-only Claude transcript synchronized from another node: re-render in
    // place, following if the reader was at the bottom, anchoring if not.
    const resumeFromTop = rerenderChatTranscript(payload.messages, payload.segments || state.conversationSegments);
    if (state.followChat) requestPinChat();
    else restoreChatScrollTop(resumeFromTop);
    return;
  }
  if (payload.type === "sessionFileChanged") {
    console.info("Conversation transcript changed on disk; reconnecting", { engine: state.engine });
    // The session file changed on disk after synchronization. Reconnect so the
    // server loads the updated conversation; "ready" re-renders the messages.
    openSession(state.activeSessionPath, elements.sessionTitle.textContent || "Conversation", true, Boolean(state.activeTaskId));
    return;
  }
  if (payload.type === "error") {
    resetQueuedForceStart();
    if (elements.toolsDialog.open && state.toolsLoading) {
      state.toolsLoading = false;
      renderToolsDialog();
    }
    toast(payload.error, 6000);
  }
}

function scheduleAgentRunPoll() {
  if (state.agentRunPollTimer) clearTimeout(state.agentRunPollTimer);
  state.agentRunPollTimer = null;
  const hasActiveRun = state.sessions.some((session) =>
    session.running || session.backgroundRunning || session.reviewState === "running"
    || session.agentRuns?.some((run) => ["queued", "running"].includes(run.status)));
  if (!state.activeProjectId || !hasActiveRun) return;
  state.agentRunPollTimer = setTimeout(() => {
    state.agentRunPollTimer = null;
    refreshSessionsQuietly();
  }, 2000);
}

/** Server "something changed" notices and the loader each one re-runs. Both sockets share it. */
const INVALIDATION_HANDLERS = {
  sessionsChanged: () => {
    refreshSessionsQuietly();
    schedulePendingReviewsRefresh();
  },
  browserSessionsChanged: () => document.dispatchEvent(new Event("browserSessionsChanged")),
  projectsChanged: () => refreshProjectsQuietly(),
  pinsChanged: () => loadPins().catch((error) => console.warn(error)),
  recentsChanged: () => loadRecentSessions().catch((error) => console.warn(error)),
  shortcutsChanged: () => state.canvasController?.reloadShortcuts(),
  tasksChanged: () => loadTasks().catch((error) => console.warn(error)),
};

/** Runs the loader for an invalidation notice; false when the payload is not one. */
function handleInvalidation(payload) {
  const handler = INVALIDATION_HANDLERS[payload.type];
  if (!handler) return false;
  handler();
  return true;
}

export async function refreshSessionsQuietly() {
  // The pane frame hosts one conversation; parent-shell list polling stays off.
  if (state.canvasPaneMode) return;
  const projectId = state.activeProjectId;
  if (!projectId || state.sessionsRefreshing) return;
  state.sessionsRefreshing = true;
  const previousStates = new Map(state.sessions.map((session) => [session.path, session.reviewState]));
  try {
    const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
    // The active project can change mid-request; a late response must not
    // overwrite the newly selected project's conversations.
    if (state.activeProjectId !== projectId) return;
    const newlyNeedsReview = body.sessions.some((session) => session.reviewState === "needs_review" && previousStates.get(session.path) !== "needs_review");
    state.sessions = body.sessions;
    const activeSession = state.sessions.find((session) => session.id === state.activeSessionId || session.path === state.activeSessionPath);
    // The list can arrive after the conversation opened, so the header takes the
    // list's name as soon as it exists rather than keeping its harness fallback.
    if (activeSession && !state.pendingSessionTitle) elements.sessionTitle.textContent = shortSessionTitle(activeSession);
    if (newlyNeedsReview) playCompletionSound().catch((error) => console.warn("Completion sound failed", error));
    const activeNode = state.sessionNodes.find((node) => node.id === state.activeNodeId);
    const activeSessionExists = state.sessions.some((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
    if (activeNode?.local && state.activeSessionPath && !state.harnesses.some(({ newSessionPath }) => newSessionPath === state.activeSessionPath) && !socketOpen() && !activeSessionExists) {
      state.activeTaskId = null;
      closeSocket();
      clearChat();
      clearAttachments();
      state.activeSessionPath = null;
      state.activeSessionId = null;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
      elements.sessionTitle.textContent = "Select a conversation";
      setComposerEnabled(false);
      setMobileView("sessions");
    }
    renderSessions();
  } catch (error) {
    console.warn(error);
  } finally {
    state.sessionsRefreshing = false;
    scheduleAgentRunPoll();
  }
}

// ---- Project watch socket (live conversation refresh) ----
// A lightweight per-project WebSocket subscription. The server watches the Pi
// and Claude session directories on disk, so conversations synchronized from peers
// (via Syncthing) show up here without reopening the app.

export function closeWatchSocket() {
  if (state.watchReconnectTimer) clearTimeout(state.watchReconnectTimer);
  state.watchReconnectTimer = null;
  if (state.watchPingTimer) clearInterval(state.watchPingTimer);
  state.watchPingTimer = null;
  const socket = state.watchSocket;
  state.watchSocket = null;
  state.watchProjectId = null;
  if (socket) socket.close();
  elements.chatsLiveDot.hidden = true;
}

export function ensureWatchSocket() {
  // One watch socket per tab; a pane frame's tab is the canvas parent's document,
  // and panes never render the lists the watch socket feeds.
  if (state.canvasPaneMode) return;
  if (!state.activeProjectId) {
    closeWatchSocket();
    return;
  }
  // The subscription is bound to one project at connect time. Keeping a socket
  // that still watches the project we left costs the board every live update -
  // a ticket that gains a conversation only grows its chat button on a reload.
  const live = state.watchSocket && (state.watchSocket.readyState === WebSocket.OPEN || state.watchSocket.readyState === WebSocket.CONNECTING);
  if (live && state.watchProjectId === state.activeProjectId) return;
  closeWatchSocket();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("sessionPath", "watch");

  const socket = new WebSocket(url.toString());
  state.watchSocket = socket;
  state.watchProjectId = state.activeProjectId;
  socket.addEventListener("open", () => {
    elements.chatsLiveDot.hidden = false;
    if (state.watchNeedsRefresh) {
      state.watchNeedsRefresh = false;
      refreshSessionsQuietly();
      schedulePendingReviewsRefresh();
    }
    state.watchPingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  });
  socket.addEventListener("message", (event) => {
    handleInvalidation(JSON.parse(event.data));
  });
  socket.addEventListener("close", () => {
    if (state.watchSocket !== socket) return;
    state.watchNeedsRefresh = true;
    if (state.watchPingTimer) clearInterval(state.watchPingTimer);
    state.watchPingTimer = null;
    elements.chatsLiveDot.hidden = true;
    state.watchReconnectTimer = setTimeout(() => {
      state.watchReconnectTimer = null;
      ensureWatchSocket();
    }, 3000);
  });
}

// Resume the WebSocket after the phone UI returns to the foreground, after a
// back/forward cache restore, or when the network comes back online. Without
// this the connection stays "dropped" until the user sends a follow-up message.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  resumeConnection();
  ensureWatchSocket();
  refreshSessionsQuietly();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resumeConnection(true);
    ensureWatchSocket();
    refreshSessionsQuietly();
  }
});
window.addEventListener("online", () => {
  resumeConnection(true);
  ensureWatchSocket();
});
window.addEventListener("focus", () => resumeConnection());
