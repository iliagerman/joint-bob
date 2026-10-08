import { api, savePreferencesInBackground } from "./api.js";
import { openScheduledTasks } from "./cron.js";
import { clearAttachments } from "./attachments.js";
import { renderChatSessionControls, setComposerEnabled } from "./chat-controls.js";
import { clearChat } from "./chat-transcript.js";
import { createMultiSelect } from "./multi-select.js";
import { elements } from "./elements.js";
import { agentIcon, sessionAgentId } from "./icons.js";
import { filteredSessions, normalizedQuery, selectedProject, sessionDisplayState, setMobileView, shortSessionTitle, updateChatFilterCounts } from "./layout.js";
import { toggleSessionNtfy } from "./ntfy.js";
import { keepListScroll, renderProjects } from "./project-list.js";
import { syncRecentSessionActivity } from "./recents.js";
import { openListedSession, reviewableSessions } from "./reviews.js";
import { openRowMenu, pinButton, refreshRowMenuAnchor } from "./row-menu.js";
import { openSecretScope } from "./secrets.js";
import { openConversationClassificationDialog, openConversationColorDialog, openRenameDialog, sessionEngine } from "./session-identity.js";
import { isSessionPinned, nestedSessionRows, sessionTicketTask, ticketBadge, ticketRowButton, togglePinnedSession } from "./session-rows.js";
import { loadWorktrees, worktreeBadge, worktreeSectionHeader, worktreesHeading } from "./worktrees.js";
import { confirmAction, enableNotifications, formatDate, toast } from "./shell.js";
import { closeSocket, refreshSessionsQuietly } from "./socket.js";
import { state } from "./state.js";
import { activeChatSession } from "./terminal.js";
import { usageBadge } from "./usage-format.js";

const classificationFilter = createMultiSelect({ id: "conversationClassificationFilter", testid: "conversation-classification-filter", label: "Labels", prompt: "All labels", placeholder: "Search labels" });
document.querySelector("#conversationFilterRow").prepend(classificationFilter.root);

function renderClassificationFilter() {
  const selected = state.classificationFilters;
  const labels = new Set([...state.conversationLabels, ...state.sessions.map((session) => session.classification).filter(Boolean)]);
  // Keep a selected retired label listed until the user clears it or changes project.
  for (const value of selected) if (value.startsWith("label:")) labels.add(value.slice(6));
  classificationFilter.setOptions([
    { value: "unclassified", label: "Unclassified" },
    ...[...labels].sort((left, right) => left.localeCompare(right)).map((label) => ({ value: `label:${label}`, label })),
  ]);
  classificationFilter.setValues(selected);
}

const chatFilterNames = { active: "running", review: "needs review", done: "reviewed", cron: "scheduled" };

function syncChatFilterChips() {
  for (const chip of elements.chatFilters.querySelectorAll("button[data-filter]")) {
    const active = chip.dataset.filter === "all" ? !state.chatFilters.size : state.chatFilters.has(chip.dataset.filter);
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
}

export function renderSessions() {
  syncRecentSessionActivity();
  keepListScroll(elements.sessionList);
  // A background refresh must not leave a menu floating over rows that just moved.
  queueMicrotask(refreshRowMenuAnchor);
  elements.sessionList.replaceChildren();
  renderChatSessionControls();
  syncChatDoneButton();
  // A conversation entering or leaving review changes its project's badge, so redraw that too.
  renderProjects();
  const project = selectedProject();
  elements.projectName.textContent = project?.name || "No project selected";
  elements.projectPath.textContent = project?.path || "Create or select a local folder.";
  elements.chatProjectName.textContent = project?.name || "No project selected";
  elements.chatProjectName.title = project?.name || "";
  const newSessionDisabled = !project || !state.sessionNodes.length;
  elements.newSessionButton.disabled = newSessionDisabled;
  for (const button of elements.newSessionHarnesses.querySelectorAll("[data-new-session-harness]")) {
    button.disabled = newSessionDisabled || !state.harnesses.find(({ id }) => id === button.dataset.harnessId).ready;
  }
  renderClassificationFilter();
  elements.showDoneConversations.checked = state.showDoneConversations;
  elements.showScheduledConversations.checked = state.showScheduledConversations;
  updateChatFilterCounts();
  elements.markAllReviewedButton.disabled = !project || !reviewableSessions().length;

  if (!project || state.sessionsLoading) return;
  const sessions = filteredSessions();
  const narrowed = Boolean(state.classificationFilters.size || state.sessionClusterFilters.size || normalizedQuery(elements.sessionSearchInput.value || ""));
  const sessionIsActive = (candidate) => state.activeSessionId ? candidate.id === state.activeSessionId : candidate.path === state.activeSessionPath;
  const rows = nestedSessionRows(sessions, (parent, childSessions) => state.expandedSessionParents.has(parent.path) || childSessions.some(sessionIsActive));
  // Sessions can arrive before the worktree listing. Their badges already carry
  // enough metadata to group them instead of misfiling them in the project folder.
  const worktrees = new Map(state.worktrees.map((worktree) => [worktree.id, worktree]));
  for (const session of state.sessions) {
    if (session.worktree && !worktrees.has(session.worktree.id)) worktrees.set(session.worktree.id, session.worktree);
  }
  // A sub-agent conversation stays with its root's group, whatever folder it ran in.
  const worktreeRows = new Map();
  const projectRows = [];
  let owner = null;
  for (const row of rows) {
    if (row.depth === 0) owner = worktrees.has(row.session.worktree?.id) ? row.session.worktree.id : null;
    if (!owner) projectRows.push(row);
    else if (worktreeRows.has(owner)) worktreeRows.get(owner).push(row);
    else worktreeRows.set(owner, [row]);
  }

  const list = elements.sessionList;
  list.append(worktreesHeading());
  for (const worktree of worktrees.values()) {
    const group = worktreeRows.get(worktree.id) || [];
    if (!group.length && (narrowed || state.chatFilters.size)) continue;
    list.append(worktreeSectionHeader(worktree, group.filter((row) => row.depth === 0).length));
    if (state.collapsedWorktreeIds.has(worktree.id)) continue;
    for (const row of group) list.append(sessionRow(row, sessionIsActive(row.session)));
  }
  if (state.sessions.length === 0 || sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = state.sessions.length === 0
      ? "No conversations yet. Start a new conversation above."
      : narrowed
        ? "No matching conversations."
        : `No ${[...state.chatFilters].map((filter) => chatFilterNames[filter]).join(" or ")} conversations.`;
    list.append(empty);
    return;
  }
  if (worktrees.size && projectRows.length) {
    const heading = document.createElement("div");
    heading.className = "worktree-subsection-title";
    heading.dataset.testid = "project-folder-subsection";
    heading.textContent = "Project folder";
    list.append(heading);
  }
  for (const row of projectRows) list.append(sessionRow(row, sessionIsActive(row.session)));
}

function sessionCard(session, sessionActive, sessionPinned, ticketTask) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `session-card${sessionActive ? " active" : ""}${sessionPinned ? " pinned" : ""}`;
  if (sessionActive) button.setAttribute("aria-current", "true");
  if (session.color) button.dataset.color = session.color;
  if (session.worktree) button.dataset.worktreeColor = session.worktree.color;
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
  if (session.classification) {
    const classification = document.createElement("span");
    classification.className = "session-classification";
    classification.dataset.testid = "session-classification";
    classification.textContent = session.classification;
    sessionName.append(classification);
  }
  button.append(sessionName, meta, usageBadge(session.usage, "session-usage-cost"));
  const displayState = sessionDisplayState(session);
  const badge = document.createElement("em");
  badge.className = `chat-badge chat-badge-${displayState}`;
  const dot = document.createElement("i");
  dot.className = "chat-status-dot";
  dot.setAttribute("aria-hidden", "true");
  const statusLabel = document.createElement("b");
  statusLabel.textContent = displayState === "active" ? "Running" : displayState === "background" ? "Background tasks" : displayState === "review" ? "Needs review" : session.draft ? "Ready" : "Reviewed";
  badge.append(dot, statusLabel);
  meta.append(" ", badge);
  if (session.doneAt) {
    const doneBadge = document.createElement("em");
    doneBadge.className = "session-done-badge";
    doneBadge.dataset.testid = "session-done-badge";
    doneBadge.title = `Marked done ${formatDate(session.doneAt)}`;
    doneBadge.textContent = "Done";
    meta.append(" ", doneBadge);
  }
  if (ticketTask) meta.append(" ", ticketBadge(ticketTask));
  if (session.worktree) meta.append(" ", worktreeBadge(session.worktree));
  button.addEventListener("click", () => openListedSession(session));
  return button;
}

function sessionRow({ session, depth, childCount }, sessionActive) {
  const sessionPinned = isSessionPinned(session);
  const ticketTask = sessionTicketTask(session);
  const row = document.createElement("div");
  row.className = `list-row${sessionActive ? " active" : ""}${sessionPinned ? " pinned" : ""}${session.doneAt ? " done" : ""}${ticketTask ? " has-ticket" : ""}${session.worktree ? " has-worktree" : ""}${childCount ? " has-children" : ""}`;
  row.dataset.sessionDepth = String(depth);
  // The row menu is re-pointed at this row after a refresh replaces it.
  row.dataset.sessionPath = session.path;

  const button = sessionCard(session, sessionActive, sessionPinned, ticketTask);

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
    const tasks = session.agentRuns.flatMap((run) => run.tasks);
    const collapsed = !state.expandedAgentRuns.has(session.path);
    row.append(agentRunToggle(session, tasks, collapsed));
    if (!collapsed) row.append(agentRunList(tasks));
  }
  return row;
}

/** A conversation fanning out to several sub-agents buries the rows under it, so the
    run lines start folded behind one summary and open only when the reader asks. */
function agentRunToggle(session, tasks, collapsed) {
  const running = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const parts = [`${tasks.length} sub-agent step${tasks.length === 1 ? "" : "s"}`];
  if (running) parts.push(`${running} running`);
  if (failed) parts.push(`${failed} failed`);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = `agent-run-toggle${failed ? " has-failed" : ""}`;
  toggle.dataset.testid = "agent-run-toggle";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = `${collapsed ? "▸" : "▾"} ${parts.join(" · ")}`;
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (collapsed) state.expandedAgentRuns.add(session.path);
    else state.expandedAgentRuns.delete(session.path);
    renderSessions();
  });
  return toggle;
}

function agentRunList(tasks) {
  const runs = document.createElement("div");
  runs.className = "agent-run-list";
  for (const task of tasks) {
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
  return runs;
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
  const readOnly = session.readOnly === true || sessionTicketTask(session)?.status === "done";
  return [
    {
      label: "Add to canvas",
      icon: "canvas",
      testid: "session-add-to-canvas-button",
      onSelect: () => addSessionToCanvas(session),
    },
    {
      label: "Fork conversation",
      icon: "copy",
      testid: "session-fork-button",
      title: "Copy history and settings into an independent conversation",
      onSelect: () => forkSessionFromRow(session).catch((error) => toast(error.message)),
    },
    {
      label: session.doneAt ? "Mark not done" : "Mark done",
      icon: "check",
      testid: "session-done-button",
      title: session.doneAt ? "Put it back in the active list" : "Hide it from the list until you ask for done conversations",
      onSelect: () => toggleSessionDone(session).catch((error) => toast(error.message)),
    },
    ...(readOnly ? [] : [
      {
        label: session.reviewNotificationsEnabled ? "Stop review notifications" : "Notify when ready for review",
        icon: "sliders",
        testid: "session-review-notifications-button",
        onSelect: () => toggleSessionReviewNotifications(session).catch((error) => toast(error.message)),
      },
      {
        label: session.ntfyEnabled ? "Stop ntfy publishing" : "Publish reviews to ntfy",
        icon: "sliders",
        testid: "session-ntfy-button",
        onSelect: () => toggleSessionNtfy(session).catch((error) => toast(error.message)),
      },
      { label: "Scheduled tasks", icon: "refresh", testid: "session-cron-button", onSelect: () => openScheduledTasks(state.activeProjectId, session).catch(error => toast(error.message)) },
      {
        label: "Secret accounts",
        icon: "key",
        testid: "session-secrets-button",
        title: "Accounts this conversation gets on top of its project's and workspace's",
        onSelect: () => openSecretScope("conversation", `${sessionEngine(session)}:${session.id}`, name).catch((error) => toast(error.message)),
      },
      {
        label: "Classification",
        icon: "sliders",
        testid: "session-classification-button",
        onSelect: () => openConversationClassificationDialog(session).catch((error) => toast(error.message)),
      },
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
        onSelect: () => openRenameDialog(session.conversationId || session.id, sessionEngine(session), name),
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
 * The open conversation gets the same menu its row gets, built from the same list,
 * so the two can never drift apart. Desktop flattens the More menu into the toolbar,
 * which leaves this button on screen to anchor the popup; mobile closes the More menu
 * on the click, so the popup anchors to the More button that stays visible.
 */
elements.chatSessionMenuButton.addEventListener("click", () => {
  const session = activeChatSession();
  if (!session) { toast("Open a conversation first"); return; }
  const anchor = elements.chatMoreMenu.open ? elements.chatMoreMenu.querySelector("summary") : elements.chatSessionMenuButton;
  openRowMenu(anchor, sessionMenuItems(session, true));
});

/**
 * Closing a conversation out is the action people reach for most from inside one, so it
 * sits in the chat menu itself rather than behind Conversation actions, which on a phone
 * means opening a second menu on top of the first.
 */
elements.chatDoneButton.addEventListener("click", () => {
  const session = activeChatSession();
  if (!session) { toast("Open a conversation first"); return; }
  elements.chatMoreMenu.open = false;
  toggleSessionDone(session).catch((error) => toast(error.message));
});

/** The one label has to say what the click will do, on whichever conversation is open. */
function syncChatDoneButton() {
  const session = activeChatSession();
  const label = session?.doneAt ? "Mark not done" : "Mark done";
  elements.chatDoneButton.querySelector(".chat-action-label").textContent = label;
  elements.chatDoneButton.setAttribute("aria-label", label);
  elements.chatDoneButton.title = session?.doneAt
    ? `${label} — put it back in the active list`
    : `${label} — hide it from the list until you ask for done conversations`;
  elements.chatDoneButton.disabled = !session;
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

async function forkSessionFromRow(session) {
  const projectId = state.activeProjectId;
  const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions/fork`, {
    method: "POST",
    body: JSON.stringify({ engine: sessionEngine(session), sessionId: session.id }),
  });
  if (state.activeProjectId !== projectId) { toast("Conversation forked"); return; }
  // A remote fork may arrive before its replicated record or transcript does.
  state.sessions = [body.session, ...state.sessions.filter((candidate) => candidate.id !== body.session.id)];
  elements.sessionSearchInput.value = "";
  state.chatFilters.clear();
  syncChatFilterChips();
  renderSessions();
  openListedSession(body.session);
  toast("Conversation forked");
}

/** Closing a conversation out is list housekeeping, so it works on read-only rows too. */
async function toggleSessionDone(session) {
  const done = !session.doneAt;
  const projectId = state.activeProjectId;
  const result = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions/done`, {
    method: "PUT",
    body: JSON.stringify({ sessionId: session.conversationId || session.id, engine: sessionEngine(session), done }),
  });
  session.doneAt = done ? new Date().toISOString() : undefined;
  if (state.activeProjectId === projectId) {
    // A list refresh during cleanup may have replaced the row's session object.
    for (const current of state.sessions) {
      if ((current.conversationId || current.id) === (session.conversationId || session.id)) current.doneAt = session.doneAt;
    }
    state.worktreeCleanupReasons = result.retainedWorktrees || {};
  }
  const deleted = result.deletedWorktreeIds?.length;
  if (deleted && state.activeProjectId === projectId) await loadWorktrees();
  renderSessions();
  const retained = result.retainedWorktrees?.[session.worktree?.id];
  toast(retained || (deleted ? "Conversation marked done; empty worktrees deleted" : done ? "Conversation marked done" : "Conversation reopened"));
}

async function toggleSessionReviewNotifications(session) {
  const enabled = !session.reviewNotificationsEnabled;
  if (enabled && !await enableNotifications()) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/review-notifications`, {
    method: "PUT",
    body: JSON.stringify({ sessionPath: session.path, enabled }),
  });
  session.reviewNotificationsEnabled = enabled;
  renderSessions();
  toast(enabled ? "Review notifications enabled" : "Review notifications disabled");
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
    const filter = button.dataset.filter;
    if (filter === "all") state.chatFilters.clear();
    else if (state.chatFilters.has(filter)) state.chatFilters.delete(filter);
    else state.chatFilters.add(filter);
    syncChatFilterChips();
    renderSessions();
  });
}
syncChatFilterChips();
elements.sessionSearchInput.addEventListener("input", () => renderSessions());
function saveProjectVisibility() {
  if (!state.activeProjectId) return;
  state.projectConversationVisibility = {
    ...state.projectConversationVisibility,
    [state.activeProjectId]: { done: state.showDoneConversations, scheduled: state.showScheduledConversations },
  };
  if (state.preferencesLoaded) savePreferencesInBackground({ projectConversationVisibility: state.projectConversationVisibility });
  renderSessions();
}
elements.showDoneConversations.addEventListener("change", () => {
  state.showDoneConversations = elements.showDoneConversations.checked;
  saveProjectVisibility();
});
elements.showScheduledConversations.addEventListener("change", () => {
  state.showScheduledConversations = elements.showScheduledConversations.checked;
  saveProjectVisibility();
});
classificationFilter.onChange((values) => {
  state.classificationFilters = values;
  renderSessions();
});
window.addEventListener("cluster-filters-changed", (event) => {
  if (event.detail.list === "sessions") renderSessions();
});
