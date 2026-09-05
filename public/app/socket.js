import { api, loadPins, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { renderChatSessionControls, renderConversationLock, sendSocket, setComposerEnabled, setModels, syncEngineUI, syncSafeguardsButton, updateStatus } from "./chat-controls.js";
import { appendMessage, appendToolMessage, clearChat, clearQueuedMark, clearThinkingBubble, finalizeAssistantBubble, finishTurnTimer, markMessageQueued, renderBubbleContent, requestPinChat, rerenderChatTranscript, restoreChatScrollTop, showChatEmptyState, startDurationTicker, updateToolMessage } from "./chat-transcript.js";
import { rememberDraft, restoreDraft, setActiveSessionPath } from "./composer.js";
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
    openSession(sessionPath, elements.sessionTitle.textContent || "Pi session", true, Boolean(state.activeTaskId));
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

export function openSession(sessionPath, title = "New Pi conversation", preserveChat = false, preserveTask = false) {
  rememberDraft();
  // Opening a conversation that already exists drops the picks made for a new one.
  if (sessionPath && sessionPath !== "claude:new") {
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
    state.pendingSessionTitle = null;
    state.pendingSessionColor = null;
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
  state.engine = state.activeSessionPath.startsWith("claude:") || state.activeSessionPath.startsWith("draft:claude:") ? "claude" : "pi";
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
    setStatus("Connected", true);
    setConnecting(false);
    startHeartbeat();
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    stopHeartbeat();
    setStatus("Connecting…", false, true);
    setConnecting(true, "Connecting…");
    setComposerEnabled(false);
    scheduleReconnect(state.activeSessionPath);
  });
  // The connecting banner already shows this state, and reconnect attempts
  // repeat, so a toast per attempt is pure noise.
  socket.addEventListener("error", () => console.warn("WebSocket connection failed"));
  socket.addEventListener("message", (event) => handleSocketPayload(JSON.parse(event.data), !preserveChat));
}

function handleSocketPayload(payload, scrollOnReady = false) {
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
    const openingDraft = ["new", "claude:new"].includes(state.activeSessionPath);
    state.conversationLock = payload.ownership ?? null;
    state.conversationReadOnly = payload.readOnly === true;
    state.engine = payload.engine || "pi";
    if (payload.executionNodeId) {
      state.activeNodeId = payload.executionNodeId;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: payload.executionNodeId });
    }
    setComposerEnabled(true);
    renderConversationLock();
    state.activeSessionId = payload.sessionId || state.activeSessionId;
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
      saveSessionTitle(payload.sessionId, state.engine, pendingTitle)
        .then(() => refreshSessionsQuietly())
        .catch((error) => toast(error.message, 8000));
    }
    const pendingColor = state.pendingSessionColor;
    if (pendingColor && payload.sessionId) {
      state.pendingSessionColor = null;
      saveSessionColor(payload.sessionId, state.engine, pendingColor)
        .then(() => refreshSessionsQuietly())
        .catch((error) => toast(error.message, 8000));
    }
    const matchingSession = state.sessions.find((session) => session.path === payload.sessionFile);
    elements.sessionTitle.textContent = pendingTitle
      ? pendingTitle
      : matchingSession
        ? shortSessionTitle(matchingSession)
        : openingDraft
          ? `New ${state.engine === "claude" ? "Claude" : "Pi"} conversation`
          : state.engine === "claude" ? "Claude conversation" : "Pi conversation";
    const resumeFromTop = rerenderChatTranscript(payload.messages);
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
      showChatEmptyState("Ready for your first message", `${state.engine === "claude" ? "Claude" : "Pi"} will run on ${node?.name || "the selected node"}. The conversation is created when you send.`);
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
    state.engine = payload.engine || "pi";
    state.activeSessionId = null;
    syncEngineUI();
    toast(state.engine === "claude" ? "Switched to Claude — context carries over on your next message" : "Switched to Pi — context carries over on your next message");
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
    setModels(payload.models || []);
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
  if (payload.type === "userMessage") {
    finalizeAssistantBubble();
    state.spinOffSourceTaskId = null;
    const bubble = appendMessage("user", payload.text);
    if (payload.queued) markMessageQueued(bubble, payload.queueId);
    state.thinkingBubble = null;
    return;
  }
  // Prompts typed while the agent was busy live on the conversation, not on this
  // socket, so a reload or a reconnect gets them back instead of losing them.
  if (payload.type === "queuedPrompts") {
    for (const prompt of payload.prompts || []) {
      if (elements.messages.querySelector(`[data-queue-id="${prompt.id}"]`)) continue;
      markMessageQueued(appendMessage("user", prompt.text), prompt.id);
    }
    return;
  }
  if (payload.type === "promptStarted") {
    clearQueuedMark(payload.queueId);
    return;
  }
  if (payload.type === "textDelta") {
    clearThinkingBubble();
    if (!state.assistantBubble) state.assistantBubble = appendMessage("assistant", "");
    const currentText = state.assistantBubble._raw || "";
    renderBubbleContent(state.assistantBubble, `${currentText}${payload.text}`);
    return;
  }
  if (payload.type === "assistantFinal") {
    clearThinkingBubble();
    if (!state.assistantBubble) appendMessage("assistant", payload.text);
    else renderBubbleContent(state.assistantBubble, payload.text, true);
    state.assistantBubble = null;
    return;
  }
  if (payload.type === "thinkingStart") {
    state.thinkingBubble = appendMessage("thinking", "Thinking…\n");
    return;
  }
  if (payload.type === "thinkingDelta") {
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
    clearThinkingBubble();
    finalizeAssistantBubble();
    const bubble = appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    startDurationTicker();
    return;
  }
  if (payload.type === "toolUpdate") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    state.toolBubbles.set(payload.toolCallId, bubble);
    updateToolMessage(bubble, payload.text || "", "Running");
    return;
  }
  if (payload.type === "toolEnd") {
    const bubble = state.toolBubbles.get(payload.toolCallId) || appendToolMessage(payload.toolName, payload.toolCallId);
    updateToolMessage(bubble, payload.text || "", payload.isError ? "Failed" : "Done", payload.isError);
    state.toolBubbles.delete(payload.toolCallId);
    return;
  }
  if (payload.type === "assistantError") {
    clearThinkingBubble();
    finalizeAssistantBubble();
    appendMessage("tool", `${state.engine === "claude" ? "Claude" : "Pi"} error: ${payload.error}`);
  }
  if (payload.type === "agent_start") {
    setStatus(`${state.engine === "claude" ? "Claude" : "Pi"} is working`, true);
    state.lastTurnStartedAt = Date.now();
    state.sessionBusy = true;
    startDurationTicker();
    syncSafeguardsButton();
  }
  if (payload.type === "agent_end") {
    clearThinkingBubble();
    finalizeAssistantBubble();
    setStatus("Connected", true);
    state.sessionBusy = false;
    syncSafeguardsButton();
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
    const resumeFromTop = rerenderChatTranscript(payload.messages);
    if (state.followChat) requestPinChat();
    else restoreChatScrollTop(resumeFromTop);
    return;
  }
  if (payload.type === "sessionFileChanged") {
    // The session file changed on disk after synchronization. Reconnect so the
    // server loads the updated conversation; "ready" re-renders the messages.
    openSession(state.activeSessionPath, elements.sessionTitle.textContent || "Pi session", true, Boolean(state.activeTaskId));
    return;
  }
  if (payload.type === "error") {
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
    session.agentRuns?.some((run) => ["queued", "running"].includes(run.status)));
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
    if (newlyNeedsReview) playCompletionSound().catch((error) => console.warn("Completion sound failed", error));
    const activeNode = state.sessionNodes.find((node) => node.id === state.activeNodeId);
    const activeSessionExists = state.sessions.some((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
    if (activeNode?.local && state.activeSessionPath && !["new", "claude:new"].includes(state.activeSessionPath) && !socketOpen() && !activeSessionExists) {
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
