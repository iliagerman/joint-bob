import { api, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { renderChatSessionControls, setComposerEnabled } from "./chat-controls.js";
import { clearChat } from "./chat-transcript.js";
import { elements } from "./elements.js";
import { agentIcon, sessionAgentId } from "./icons.js";
import { filteredSessions, normalizedQuery, selectedProject, sessionChatState, setMobileView, shortSessionTitle, updateChatFilterCounts } from "./layout.js";
import { keepListScroll, renderProjects } from "./project-list.js";
import { syncRecentSessionActivity } from "./recents.js";
import { openListedSession, reviewableSessions } from "./reviews.js";
import { openRowMenu, pinButton, refreshRowMenuAnchor } from "./row-menu.js";
import { openConversationColorDialog, openRenameDialog, sessionEngine } from "./session-identity.js";
import { isSessionPinned, nestedSessionRows, sessionTicketTask, ticketBadge, ticketRowButton, togglePinnedSession } from "./session-rows.js";
import { confirmAction, formatDate, toast } from "./shell.js";
import { closeSocket, refreshSessionsQuietly } from "./socket.js";
import { state } from "./state.js";

export function renderSessions() {
  syncRecentSessionActivity();
  keepListScroll(elements.sessionList);
  // A background refresh must not leave a menu floating over rows that just moved.
  queueMicrotask(refreshRowMenuAnchor);
  elements.sessionList.replaceChildren();
  renderChatSessionControls();
  // A conversation entering or leaving review changes its project's badge, so redraw that too.
  renderProjects();
  const project = selectedProject();
  elements.projectName.textContent = project?.name || "No project selected";
  elements.projectPath.textContent = project?.path || "Create or select a local folder.";
  elements.chatProjectName.textContent = project?.name || "No project selected";
  elements.chatProjectName.title = project?.name || "";
  elements.newSessionButton.disabled = !project || !state.sessionNodes.length;
  elements.newClaudeSessionButton.disabled = !project || !state.sessionNodes.length;
  updateChatFilterCounts();
  elements.markAllReviewedButton.disabled = !project || !reviewableSessions().length;

  if (!project || state.sessionsLoading) return;
  const sessions = filteredSessions();
  if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No conversations yet. Start a Pi or Claude chat above.";
    elements.sessionList.append(empty);
    return;
  }
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = normalizedQuery(elements.sessionSearchInput.value || "")
      ? "No matching conversations."
      : `No ${state.chatFilter} conversations.`;
    elements.sessionList.append(empty);
    return;
  }

  const sessionIsActive = (candidate) => state.activeSessionId ? candidate.id === state.activeSessionId : candidate.path === state.activeSessionPath;
  const rows = nestedSessionRows(sessions, (parent, childSessions) => state.expandedSessionParents.has(parent.path) || childSessions.some(sessionIsActive));
  for (const { session, depth, childCount } of rows) {
    const sessionPinned = isSessionPinned(session);
    const ticketTask = sessionTicketTask(session);
    const row = document.createElement("div");
    const sessionActive = sessionIsActive(session);
    row.className = `list-row${sessionActive ? " active" : ""}${sessionPinned ? " pinned" : ""}${ticketTask ? " has-ticket" : ""}${childCount ? " has-children" : ""}`;
    row.dataset.sessionDepth = String(depth);
    // The row menu is re-pointed at this row after a refresh replaces it.
    row.dataset.sessionPath = session.path;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${sessionActive ? " active" : ""}${sessionPinned ? " pinned" : ""}`;
    if (sessionActive) button.setAttribute("aria-current", "true");
    if (session.color) button.dataset.color = session.color;
    const sessionName = document.createElement("strong");
    sessionName.textContent = shortSessionTitle(session);
    const meta = document.createElement("span");
    meta.textContent = formatDate(session.updatedAt || session.createdAt);
    const agentId = sessionAgentId(session);
    const agent = document.createElement("em");
    agent.className = "session-agent-label";
    agent.dataset.testid = "session-agent-label";
    const agentMark = agentIcon(agentId);
    agentMark.dataset.testid = "session-agent-icon";
    agent.setAttribute("aria-label", session.agentLabel);
    agent.append(agentMark);
    meta.append(" ", agent);
    button.append(sessionName, meta);
    const chatState = sessionChatState(session);
    const badge = document.createElement("em");
    badge.className = `chat-badge chat-badge-${chatState}`;
    const dot = document.createElement("i");
    dot.className = "chat-status-dot";
    dot.setAttribute("aria-hidden", "true");
    const statusLabel = document.createElement("b");
    statusLabel.textContent = chatState === "active" ? "Running" : chatState === "review" ? "Needs review" : session.draft ? "Ready" : "Reviewed";
    badge.append(dot, statusLabel);
    meta.append(" ", badge);
    if (ticketTask) meta.append(" ", ticketBadge(ticketTask));
    button.addEventListener("click", () => openListedSession(session));

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "ghost icon-button row-action-button row-menu-button";
    menuButton.setAttribute("aria-label", `Actions for ${shortSessionTitle(session)}`);
    menuButton.setAttribute("aria-haspopup", "true");
    menuButton.title = "Conversation actions";
    menuButton.textContent = "\u22EE";
    menuButton.dataset.testid = "session-menu-button";
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openRowMenu(menuButton, sessionMenuItems(session, sessionActive), `[data-session-path="${CSS.escape(session.path)}"] [data-testid="session-menu-button"]`);
    });

    const pinToggle = sessionPinToggle(session);

    let childToggle = null;
    if (childCount) {
      const expanded = state.expandedSessionParents.has(session.path);
      childToggle = document.createElement("button");
      childToggle.type = "button";
      childToggle.className = "ghost icon-button row-action-button session-children-toggle";
      childToggle.dataset.testid = "session-children-toggle";
      childToggle.setAttribute("aria-expanded", String(expanded));
      childToggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${childCount} sub-agent conversation${childCount === 1 ? "" : "s"}`);
      childToggle.textContent = `${expanded ? "▾" : "▸"} ${childCount}`;
      childToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expanded) state.expandedSessionParents.delete(session.path);
        else state.expandedSessionParents.add(session.path);
        renderSessions();
      });
    }

    // Sub-agent task lines below the card make the row taller than the card, so the
    // action lanes hang off a wrapper that ends where the card does — otherwise they
    // centre on the whole row and slide out past the card's border.
    const rowMain = document.createElement("div");
    rowMain.className = "list-row-main";
    if (ticketTask) rowMain.append(button, ticketRowButton(ticketTask), pinToggle, menuButton);
    else rowMain.append(button, pinToggle, menuButton);
    if (childToggle) rowMain.append(childToggle);
    row.append(rowMain);
    if (session.agentRuns?.length) {
      const runs = document.createElement("div");
      runs.className = "agent-run-list";
      for (const run of session.agentRuns) {
        for (const task of run.tasks) {
          const taskElement = document.createElement("div");
          taskElement.className = `agent-run-task agent-run-task-${task.status}`;
          taskElement.dataset.testid = "agent-run-task";
          taskElement.dataset.role = task.role;
          taskElement.dataset.status = task.status;
          taskElement.textContent = `${task.name} · ${task.role} · ${task.status}`;
          if (task.task) taskElement.title = task.task;
          runs.append(taskElement);
          const reason = agentRunTaskReason(task);
          if (reason) {
            const reasonElement = document.createElement("p");
            reasonElement.className = "agent-run-task-reason";
            reasonElement.dataset.testid = "agent-run-task-reason";
            reasonElement.textContent = reason;
            reasonElement.title = reason;
            runs.append(reasonElement);
          }
          if (task.finalOutput) {
            const output = document.createElement("details");
            output.className = "agent-run-task-output";
            const summaryElement = document.createElement("summary");
            summaryElement.textContent = `${task.name} output`;
            summaryElement.dataset.testid = "agent-run-task-output-toggle";
            const body = document.createElement("pre");
            body.textContent = task.finalOutput;
            output.append(summaryElement, body);
            runs.append(output);
          }
        }
      }
      row.append(runs);
    }
    elements.sessionList.append(row);
  }
}

/** A failed task with no explanation is the worst outcome, so say the dashboard stayed silent
    rather than showing a bare "failed" the reader cannot act on. */
function agentRunTaskReason(task) {
  if (task.status !== "failed") return "";
  return task.error || "No reason reported by the agent dashboard";
}

/** Pinning is the one action a row needs often enough to earn its own button;
    everything else stays in the overflow menu. */
function sessionPinToggle(session) {
  const name = shortSessionTitle(session);
  const pinned = isSessionPinned(session);
  return pinButton({
    pinned,
    label: pinned ? `Unpin ${name}` : `Pin ${name}`,
    testid: "session-pin-button",
    onToggle: () => togglePinnedSession(session),
  });
}

/** Every other row action lives in the overflow menu, so the row itself stays one tap target. */
function sessionMenuItems(session, sessionActive) {
  const name = shortSessionTitle(session);
  const isClaude = sessionEngine(session) === "claude";
  const readOnly = session.readOnly === true || sessionTicketTask(session)?.status === "done";
  return [
    {
      label: "Add to canvas",
      icon: "canvas",
      testid: "session-add-to-canvas-button",
      onSelect: () => addSessionToCanvas(session),
    },
    ...(readOnly ? [] : [
      {
        label: "Colour",
        icon: "sliders",
        testid: "session-color-button",
        onSelect: () => openConversationColorDialog(session),
      },
      {
        label: "Rename",
        icon: "pencil",
        testid: "session-rename-button",
        onSelect: () => openRenameDialog(session.conversationId || session.id, isClaude ? "claude" : "pi", name),
      },
      {
        label: "Remove",
        icon: "trash",
        testid: "session-remove-button",
        danger: true,
        onSelect: () => removeSessionFromRow(session, sessionActive).catch((error) => toast(error.message)),
      },
    ]),
  ];
}

/**
 * Puts an already-open conversation on the canvas from the conversation list or the
 * chat menu, then shows the canvas so the user lands on what they just added.
 */
export function addSessionToCanvas(session) {
  try {
    state.canvasController.addSessionPane(state.activeProjectId, session);
  } catch (error) {
    toast(error.message);
    return;
  }
  setMobileView("canvas");
}

async function removeSessionFromRow(session, sessionActive) {
  const confirmed = await confirmAction({
    eyebrow: "Remove conversation",
    title: `Remove session "${shortSessionTitle(session)}"?`,
    message: "The transcript is deleted from this node.",
    confirmLabel: "Remove session",
    destructive: true,
  });
  if (!confirmed) return;
  const taskQuery = session.taskId ? `&taskId=${encodeURIComponent(session.taskId)}` : "";
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions?sessionId=${encodeURIComponent(session.id)}&engine=${sessionEngine(session)}${taskQuery}`, { method: "DELETE" });
  if (sessionActive) {
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
  await refreshSessionsQuietly();
}
for (const button of elements.chatFilters.querySelectorAll("button[data-filter]")) {
  button.addEventListener("click", () => {
    state.chatFilter = button.dataset.filter;
    for (const chip of elements.chatFilters.querySelectorAll("button[data-filter]")) {
      chip.classList.toggle("active", chip === button);
    }
    renderSessions();
  });
}
elements.sessionSearchInput.addEventListener("input", () => renderSessions());
