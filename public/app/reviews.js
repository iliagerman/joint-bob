import { api, savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { agentIcon, sessionAgentId } from "./icons.js";
import { shortSessionTitle } from "./layout.js";
import { renderProjects } from "./project-list.js";
import { selectProject } from "./project-selection.js";
import { rememberRecentSession } from "./recents.js";
import { renderSessions } from "./session-list.js";
import { formatDate, toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";

/**
 * The open project's conversations are the live source for its own review count, so every
 * surface that shows one has to be redrawn together: the list, the inbox badge, and the
 * project rows. Leaving the badge until the next background refresh shows a count that
 * disagrees with the list the user is looking at.
 */
function renderReviewCounts() {
  renderSessions();
  renderPendingReviewsBadge();
  renderProjects();
}

function markSessionReviewed(session) {
  if (session.reviewState !== "needs_review" || session.running) return;
  session.reviewState = "reviewed";
  renderReviewCounts();
  void api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/reviewed`, {
    method: "PUT",
    body: JSON.stringify({ sessionPath: session.path, updatedAt: session.updatedAt }),
  }).catch((error) => {
    session.reviewState = "needs_review";
    renderReviewCounts();
    toast(error.message);
  });
}

export function reviewableSessions() {
  return state.sessions.filter((session) => session.reviewState === "needs_review" && !session.running);
}

async function markAllSessionsReviewed() {
  const targets = reviewableSessions();
  if (!state.activeProjectId || !targets.length) return;
  const sessions = targets.map((session) => ({ sessionPath: session.path, updatedAt: session.updatedAt }));
  for (const session of targets) session.reviewState = "reviewed";
  renderReviewCounts();
  try {
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/reviewed-all`, {
      method: "PUT",
      body: JSON.stringify({ sessions }),
    });
  } catch (error) {
    for (const session of targets) session.reviewState = "needs_review";
    renderReviewCounts();
    toast(error.message);
  }
}

/**
 * The review inbox spans every project, so the badge and the dialog read one server snapshot
 * rather than the active project's in-memory conversations.
 */
export async function refreshPendingReviews() {
  const body = await api("/api/reviews/pending");
  state.pendingReviews = body.projects;
  renderPendingReviewsBadge();
  renderProjects();
}

// Replicated review and running-state updates now broadcast, but the cross-project
// inbox is too heavy to fetch per event; trail behind the burst instead of polling on
// the minute alone.
export function schedulePendingReviewsRefresh() {
  if (state.pendingReviewsRefreshTimer) return;
  state.pendingReviewsRefreshTimer = setTimeout(() => {
    state.pendingReviewsRefreshTimer = null;
    refreshPendingReviews().catch((error) => console.warn("Could not refresh pending reviews", error));
  }, 5000);
}

/**
 * Reviews pile up in projects you are not looking at, so the row carries the count.
 * The open project's own conversations are live, so they beat the once-a-minute snapshot;
 * mid-switch the list is empty and not yet loaded, so the snapshot still answers for it.
 */
export function pendingReviewCountForProject(projectId) {
  if (projectId === state.activeProjectId && !state.sessionsLoading) return reviewableSessions().length;
  return state.pendingReviews.find((group) => group.projectId === projectId)?.sessions.length ?? 0;
}

function pendingReviewCount() {
  const projectIds = new Set(state.pendingReviews.map((group) => group.projectId));
  if (state.activeProjectId) projectIds.add(state.activeProjectId);
  return [...projectIds].reduce((total, projectId) => total + pendingReviewCountForProject(projectId), 0);
}

function renderPendingReviewsBadge() {
  const count = pendingReviewCount();
  for (const badge of [elements.pendingReviewsBadge, elements.navPendingReviewsBadge]) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
  }
  elements.markAllPendingReviewedButton.disabled = count === 0;
}

/** Rows 1-10 carry a digit shortcut, the way the recent conversations list does. */
const PENDING_REVIEW_SHORTCUT_LIMIT = 10;
let pendingReviewShortcuts = [];

function renderPendingReviewsDialog() {
  elements.pendingReviewsList.replaceChildren();
  pendingReviewShortcuts = [];
  if (!pendingReviewCount()) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing is waiting for review.";
    elements.pendingReviewsList.append(empty);
    return;
  }
  for (const group of state.pendingReviews) {
    const heading = document.createElement("div");
    heading.className = "pending-reviews-group";
    heading.dataset.testid = "pending-reviews-group";
    heading.textContent = group.projectName;
    elements.pendingReviewsList.append(heading);
    for (const entry of group.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-card";
      if (entry.color) button.dataset.color = entry.color;
      button.dataset.testid = "pending-review-option";
      // Rows are single-line, so the full title lives in the tooltip.
      button.title = entry.title;
      if (pendingReviewShortcuts.length < PENDING_REVIEW_SHORTCUT_LIMIT) {
        pendingReviewShortcuts.push({ group, entry });
        const index = document.createElement("kbd");
        index.dataset.testid = "pending-review-index";
        index.textContent = pendingReviewShortcuts.length === 10 ? "0" : String(pendingReviewShortcuts.length);
        button.append(index);
      }
      const title = document.createElement("strong");
      title.textContent = entry.title;
      const meta = document.createElement("span");
      meta.append(agentIcon(sessionAgentId(entry)), document.createTextNode(`${entry.agentLabel} · ${formatDate(entry.updatedAt)}`));
      button.append(title, meta);
      button.addEventListener("click", () => openPendingReview(group, entry).catch((error) => toast(error.message)));
      elements.pendingReviewsList.append(button);
    }
  }
}

/**
 * The snapshot can outlive the conversation it points at, so a stale row is dropped on the
 * click that discovers it rather than checked up front.
 */
async function openPendingReview(group, entry) {
  elements.pendingReviewsDialog.close();
  if (state.activeProjectId !== group.projectId) await selectProject(group.projectId);
  const session = state.sessions.find((candidate) => candidate.path === entry.path);
  if (!session) {
    toast("That conversation is no longer available");
    await refreshPendingReviews();
    return;
  }
  openListedSession(session);
  await refreshPendingReviews();
}

async function markAllPendingReviewed() {
  const groups = state.pendingReviews;
  if (!groups.length) return;
  for (const group of groups) {
    await api(`/api/projects/${encodeURIComponent(group.projectId)}/sessions/reviewed-all`, {
      method: "PUT",
      body: JSON.stringify({ sessions: group.sessions.map((entry) => ({ sessionPath: entry.path, updatedAt: entry.updatedAt })) }),
    });
  }
  // The open conversation list holds its own copy of the state the server just cleared.
  for (const session of state.sessions) {
    if (session.reviewState === "needs_review") session.reviewState = "reviewed";
  }
  renderSessions();
  await refreshPendingReviews();
  renderPendingReviewsDialog();
  toast("All conversations marked as read");
}

export function openPendingReviews() {
  if (elements.pendingReviewsDialog.open) {
    elements.pendingReviewsDialog.close();
    return;
  }
  openPendingReviewsDialog();
}

function openPendingReviewsDialog() {
  renderPendingReviewsDialog();
  elements.pendingReviewsDialog.showModal();
  // Digits are shortcuts, so focus starts on the list rather than in a text field.
  elements.pendingReviewsList.focus();
  // The badge may be up to a minute stale, and mark-all sends these exact watermarks.
  refreshPendingReviews()
    .then(renderPendingReviewsDialog)
    .catch((error) => toast(error.message));
}

export function openListedSession(session) {
  markSessionReviewed(session);
  rememberRecentSession(session);
  state.activeSessionId = session.id;
  state.activeTaskId = session.taskId || null;
  if (session.executionNodeId) {
    state.activeNodeId = session.executionNodeId;
    if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: session.executionNodeId });
  }
  openSession(session.path, shortSessionTitle(session), false, Boolean(state.activeTaskId));
}
elements.markAllReviewedButton.addEventListener("click", () => { void markAllSessionsReviewed(); });

for (const trigger of document.querySelectorAll("[data-pending-reviews-open]")) {
  trigger.addEventListener("click", openPendingReviewsDialog);
}
elements.markAllPendingReviewedButton.addEventListener("click", () => {
  markAllPendingReviewed().catch((error) => toast(error.message));
});
elements.closePendingReviewsButton.addEventListener("click", () => elements.pendingReviewsDialog.close());
/** A digit opens that row, exactly as it does in the recent conversations list. */
elements.pendingReviewsDialog.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const position = event.key === "0" ? 10 : Number(event.key);
  if (!Number.isInteger(position) || position < 1 || position > PENDING_REVIEW_SHORTCUT_LIMIT) return;
  const row = pendingReviewShortcuts[position - 1];
  if (!row) return;
  event.preventDefault();
  openPendingReview(row.group, row.entry).catch((error) => toast(error.message));
});
