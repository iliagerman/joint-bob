import { loadWorktrees } from "./worktrees.js";
import { loadHiddenCronTasks } from "./cron.js";
import { api, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { loadHarnesses, loadSessionNodes, setComposerEnabled } from "./chat-controls.js";
import { clearChat, showChatEmptyState } from "./chat-transcript.js";
import { loadClusterDirectory } from "./cluster-filters.js";
import { hideCommandAutocomplete } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { setMobileView } from "./layout.js";
import { addOptimisticSession } from "./new-session.js";
import { withPendingSessionChanges } from "./optimistic-sessions.js";
import { renderProjects } from "./project-list.js";
import { refreshQuickNotes, renderQuickNotes, showConversations } from "./quick-notes.js";
import { openListedSession, refreshPendingReviews } from "./reviews.js";
import { refreshRunningConversations } from "./running.js";
import { renderSessions } from "./session-list.js";
import { setListLoading, subscribeToPush, toast } from "./shell.js";
import { closeSocket, ensureWatchSocket, openSession } from "./socket.js";
import { state } from "./state.js";
import { loadTasks } from "./tasks.js";

export async function refreshProjectsQuietly() {
  if (state.projectsRefreshing) return;
  state.projectsRefreshing = true;
  try {
    const body = await api("/api/projects");
    state.projects = body.projects;
    state.liveHome = body.liveHome;
    renderProjects();
  } catch (error) {
    console.warn("Could not refresh project sync status", error);
  } finally {
    state.projectsRefreshing = false;
  }
}

export function startProjectSyncPolling() {
  if (state.projectSyncTimer) clearInterval(state.projectSyncTimer);
  state.projectSyncTimer = setInterval(() => refreshProjectsQuietly(), 10_000);
  // Scanning every project's transcripts is far heavier than a project list refresh,
  // so the review badge runs on its own, slower clock.
  if (state.pendingReviewsTimer) clearInterval(state.pendingReviewsTimer);
  state.pendingReviewsTimer = setInterval(() => {
    refreshPendingReviews().catch((error) => console.warn("Could not refresh pending reviews", error));
    refreshRunningConversations().catch((error) => console.warn("Could not refresh running conversations", error));
  }, 60_000);
  refreshPendingReviews().catch((error) => console.warn("Could not load pending reviews", error));
  refreshRunningConversations().catch((error) => console.warn("Could not load running conversations", error));
}

export async function loadProjects() {
  setListLoading("projects", true);
  try {
    const body = await api("/api/projects?syncStatus=false");
    state.projects = body.projects;
    state.liveHome = body.liveHome;
  } finally {
    setListLoading("projects", false);
  }
  void loadHarnesses().catch((error) => toast(error.message, 8000));
  void loadClusterDirectory().catch((error) => console.warn("Could not load clusters for the list filters", error));
  void api("/api/settings").then((settings) => {
    state.conversationLabels = settings.conversationLabels;
    state.conversationLabelIcons = settings.conversationLabelIcons;
    renderSessions();
  }).catch((error) => console.warn("Could not load conversation labels", error));

  if (state.initialProjectId) state.activeProjectId = state.initialProjectId;
  if (state.initialSessionPath) state.activeSessionPath = state.initialSessionPath;
  if (state.initialSessionId) {
    state.activeSessionId = state.initialSessionId;
    if (!state.initialSessionPath) state.activeSessionPath = null;
  }
  if (state.initialNodeId) state.activeNodeId = state.initialNodeId;

  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    if (state.initialProjectId) {
      const resolved = await api(`/api/projects/${encodeURIComponent(state.initialProjectId)}`);
      state.activeProjectId = resolved.project.id;
    } else {
      state.activeProjectId = null;
      state.activeSessionPath = null;
      state.activeSessionId = null;
      if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: null, activeSessionPath: null, activeSessionId: null });
    }
  }

  renderProjects();
  void refreshProjectsQuietly();
  if (!state.activeProjectId) {
    setMobileView("projects");
    return;
  }

  await selectProject(state.activeProjectId, false, !state.initialProjectId || Boolean(state.initialSessionPath || state.initialSessionId));
  const activeSession = state.sessions.find((session) => session.path === state.activeSessionPath
    || session.segments?.some((segment) => segment.path === state.activeSessionPath)
    || Boolean(state.activeSessionId && (session.conversationId === state.activeSessionId || session.id === state.activeSessionId || session.segments?.some((segment) => segment.sessionId === state.activeSessionId))));
  if ((state.activeSessionPath || state.activeSessionId) && activeSession) {
    // The list renders without harness metadata, but opening a conversation resolves its engine.
    if (!state.harnesses.length) await loadHarnesses().catch(() => undefined);
    openListedSession(activeSession);
    return;
  }
  if (state.activeSessionPath) {
    state.activeSessionPath = null;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
  }

  setMobileView("sessions");
}

export async function selectProject(projectId, shouldRender = true, preserveSession = false) {
  const started = performance.now();
  // A finished list is kept for the project it belongs to, so coming back to it shows rows at
  // once while the fresh list, which takes seconds on a busy machine, is fetched.
  if (state.sessionsProjectId && state.sessionsProjectId === state.activeProjectId && !state.sessionsLoading) state.keptSessionLists.set(state.sessionsProjectId, {
    sessions: state.sessions, worktrees: state.worktrees, hiddenCronTaskIds: state.hiddenCronTaskIds, knownCronTaskIds: state.knownCronTaskIds,
  });
  const kept = state.keptSessionLists.get(projectId);
  if (state.activeProjectId !== projectId) {
    state.classificationFilters.clear();
    state.worktrees = [];
    state.worktreeCleanupReasons = {};
  }
  showConversations();
  state.activeProjectId = projectId;
  const visibility = state.projectConversationVisibility[projectId] || {};
  state.showDoneConversations = visibility.done === true;
  state.showScheduledConversations = visibility.scheduled === true;
  state.hiddenCronTaskIds = kept?.hiddenCronTaskIds ?? new Set();
  state.knownCronTaskIds = kept?.knownCronTaskIds ?? new Set();
  state.skills = [];
  state.skillsLoading = false;
  state.skillsProjectId = null;
  state.commands = [];
  state.commandsLoading = false;
  state.commandsKey = null;
  hideCommandAutocomplete();
  if (!preserveSession) {
    state.activeSessionPath = null;
    state.activeSessionId = null;
    state.activeTaskId = null;
  }
  if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: projectId, activeSessionPath: state.activeSessionPath, activeSessionId: state.activeSessionId });
  closeSocket();
  clearChat();
  clearAttachments();
  setComposerEnabled(false);
  elements.sessionTitle.textContent = "Select a conversation";
  state.sessionNodes = [];
  state.sessions = kept?.sessions ?? [];
  state.sessionsProjectId = kept ? projectId : null;
  if (kept) state.worktrees = kept.worktrees;
  state.quickNotes = [];
  // Kept rows stay usable while they refresh; the bar alone says a fresh list is coming.
  setListLoading("sessions", !kept);
  elements.sessionsLoading.hidden = false;
  renderSessions();
  renderQuickNotes();
  setMobileView("sessions");
  void loadSessionNodes(projectId).catch((error) => toast(error.message, 8000));
  // The board does not need the conversation list, so it loads beside it instead of after it.
  // Worktrees wait: their listing starts a scan of every project's finished worktrees, which
  // competes with the list on a busy machine, and the rows already carry their worktree badges.
  loadTasks().catch((error) => console.warn(error));
  // Shared notes can wait on an offline peer. They must not block local conversations.
  void refreshQuickNotes(projectId).catch((error) => {
    if (state.activeProjectId === projectId) toast(error.message, 8000);
  });
  // Rows already carry agent labels; model discovery is needed by controls, not the list.
  if (!state.harnesses.length) void loadHarnesses().then(() => {
    if (state.activeProjectId === projectId) renderSessions();
  }).catch((error) => toast(error.message, 8000));
  const requestStarted = performance.now();
  let body;
  try {
    const byTheWayQuery = state.byTheWayToken ? `?byTheWayToken=${encodeURIComponent(state.byTheWayToken)}` : "";
    body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions${byTheWayQuery}`);
  } finally {
    if (state.activeProjectId === projectId) setListLoading("sessions", false);
  }
  // A newer switch can land while this request is in flight; a late response
  // must never paint one project's conversations under another.
  if (state.activeProjectId !== projectId) return;
  const renderStarted = performance.now();
  state.sessions = withPendingSessionChanges(projectId, body.sessions, requestStarted);
  state.sessionsProjectId = projectId;
  if (body.sessions.some((session) => session.cronTaskId)) {
    try { await loadHiddenCronTasks(projectId); }
    catch (error) { console.warn("Could not load scheduled task visibility", error); }
  }
  if (state.activeProjectId !== projectId) return;
  if (shouldRender) renderProjects();
  renderSessions();
  const ready = performance.now();
  if (ready - started >= 500) console.info("[performance] project.open", {
    durationMs: Math.round(ready - started), requestMs: Math.round(renderStarted - requestStarted),
    renderMs: Math.round(ready - renderStarted), conversations: body.sessions.length, keptListShown: Boolean(kept),
  });
  ensureWatchSocket();
  subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
  loadWorktrees().catch((error) => console.warn(error));
}
