import { api, savePreferencesInBackground } from "./api.js";
import { clearAttachments } from "./attachments.js";
import { loadHarnesses, loadSessionNodes, setComposerEnabled } from "./chat-controls.js";
import { clearChat, showChatEmptyState } from "./chat-transcript.js";
import { hideCommandAutocomplete } from "./composer-dialogs.js";
import { elements } from "./elements.js";
import { setMobileView } from "./layout.js";
import { addOptimisticSession } from "./new-session.js";
import { renderProjects } from "./project-list.js";
import { openListedSession, refreshPendingReviews } from "./reviews.js";
import { renderSessions } from "./session-list.js";
import { setListLoading, subscribeToPush, toast } from "./shell.js";
import { closeSocket, ensureWatchSocket, openSession } from "./socket.js";
import { state } from "./state.js";
import { loadTasks } from "./tasks.js";

export async function refreshProjectsQuietly() {
  if (state.projectsRefreshing) return;
  state.projectsRefreshing = true;
  try {
    state.projects = (await api("/api/projects")).projects;
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
  }, 60_000);
  refreshPendingReviews().catch((error) => console.warn("Could not load pending reviews", error));
}

export async function loadProjects() {
  setListLoading("projects", true);
  try {
    const body = await api("/api/projects?syncStatus=false");
    state.projects = body.projects;
  } finally {
    setListLoading("projects", false);
  }
  void loadHarnesses().catch((error) => console.warn("Could not load harnesses", error));

  if (state.initialProjectId) state.activeProjectId = state.initialProjectId;
  if (state.initialSessionPath) state.activeSessionPath = state.initialSessionPath;
  if (state.initialSessionId) state.activeSessionId = state.initialSessionId;
  if (state.initialNodeId) state.activeNodeId = state.initialNodeId;

  if (state.activeProjectId && !state.projects.some((project) => project.id === state.activeProjectId)) {
    state.activeProjectId = null;
    state.activeSessionPath = null;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeProjectId: null, activeSessionPath: null, activeSessionId: null });
  }

  renderProjects();
  void refreshProjectsQuietly();
  if (!state.activeProjectId) {
    setMobileView("projects");
    return;
  }

  await selectProject(state.activeProjectId, false, !state.initialProjectId || Boolean(state.initialSessionPath));
  const activeSession = state.sessions.find((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
  if (state.activeSessionPath && activeSession) {
    openListedSession(activeSession);
    return;
  }
  if (state.canvasPaneMode && state.activeSessionPath?.startsWith("draft:")) {
    await startCanvasPaneConversation();
    return;
  }
  if (state.activeSessionPath) {
    state.activeSessionPath = null;
    state.activeSessionId = null;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeSessionPath: null, activeSessionId: null });
  }

  setMobileView("sessions");
}

/**
 * A canvas pane can be opened on a conversation that does not exist yet: the canvas
 * hands it the draft path and the id to create it under, and the pane starts it here
 * on the local node. Once the agent writes its transcript the pane resolves to the
 * listed session by that id and this path is never used again.
 */
async function startCanvasPaneConversation() {
  const harnessId = state.activeSessionPath.split(":")[1];
  if (!state.harnesses.length) await loadHarnesses();
  const harness = state.harnesses.find((candidate) => candidate.id === harnessId);
  if (!harness) {
    showChatEmptyState("Agent unavailable", `This node has no agent named ${harnessId}.`);
    return;
  }
  if (!state.sessionNodes.length) await loadSessionNodes(state.activeProjectId);
  const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId && candidate.online && candidate.mapped)
    || state.sessionNodes.find((candidate) => candidate.local);
  if (!node) {
    showChatEmptyState("No node available", "No online node has this project mapped.");
    return;
  }
  state.activeNodeId = node.id;
  const title = `New ${harness.label} conversation`;
  addOptimisticSession(state.activeSessionId, harness.newSessionPath, title, null);
  openSession(harness.newSessionPath, title);
}

export async function selectProject(projectId, shouldRender = true, preserveSession = false) {
  state.activeProjectId = projectId;
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
  state.sessions = [];
  setListLoading("sessions", true);
  renderSessions();
  setMobileView("sessions");
  void loadSessionNodes(projectId).catch((error) => toast(error.message, 8000));
  let body;
  try {
    body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  } finally {
    if (state.activeProjectId === projectId) setListLoading("sessions", false);
  }
  // A newer switch can land while this request is in flight; a late response
  // must never paint one project's conversations under another.
  if (state.activeProjectId !== projectId) return;
  state.sessions = body.sessions;
  if (shouldRender) renderProjects();
  renderSessions();
  if (!state.canvasPaneMode) {
    ensureWatchSocket();
    subscribeToPush().catch((error) => console.warn("Push subscription failed", error));
    loadTasks().catch((error) => console.warn(error));
  }
}
