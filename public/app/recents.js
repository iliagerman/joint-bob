import { chordMatches, shortcutPrefix } from "../canvas-layout.js";
import { api } from "./api.js";
import { attachDigitShortcuts, isRowSelectorQuery, LIST_SHORTCUT_LIMIT, shortcutIndexBadge } from "./list-shortcuts.js";
import { elements } from "./elements.js";
import { normalizedQuery, shortSessionTitle } from "./layout.js";
import { selectProject } from "./project-selection.js";
import { openListedSession } from "./reviews.js";
import { pinButton } from "./row-menu.js";
import { sessionEngine } from "./session-identity.js";
import { isSessionPinned, sessionTranscriptName, sortPinnedFirst, togglePinnedSession } from "./session-rows.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";

/** Newest first; the cap keeps the dialog and the stored preference small. */
const RECENT_SESSIONS_LIMIT = 20;

function canonicalSessionPath(sessionPath) {
  return sessionPath.replace(/\.sync-conflict-[^/\\]+(?=\.jsonl$)/, "");
}

/**
 * Resuming a conversation on another node copies its transcript under that node's project
 * directory, so the same conversation reaches the recents list under several paths. The
 * transcript file name is the conversation's identity; the directory around it is not.
 */
function transcriptKey(sessionPath) {
  return sessionTranscriptName(canonicalSessionPath(sessionPath));
}

function recentSessionKey(entry) {
  return entry.engine && entry.sessionId ? `${entry.engine}:${entry.sessionId}` : transcriptKey(entry.sessionPath);
}

function sessionRecentKey(session) {
  return session?.harnessId && session?.id ? `${session.harnessId}:${session.id}` : transcriptKey(session.path);
}

export async function loadRecentSessions() {
  const body = await api("/api/recents");
  state.recentSessions = body.recentSessions || [];
  if (elements.recentSessionsDialog.open) renderRecentSessionsDialog();
}

function saveRecentSessionInBackground(entry) {
  api("/api/recents", { method: "PUT", body: JSON.stringify(entry) })
    .catch((error) => console.warn("Could not save recent conversation", error));
}

/**
 * One row per conversation: the copy the user opened most recently, carrying the newest
 * activity time of the whole group so the row is dated by its latest message.
 */
function mergeRecentSessions(entries) {
  const merged = new Map();
  for (const entry of entries) {
    const key = recentSessionKey(entry);
    const kept = merged.get(key);
    if (!kept) merged.set(key, entry);
    else if (recentSessionActivityAt(entry) > recentSessionActivityAt(kept)) {
      merged.set(key, { ...kept, updatedAt: recentSessionActivityAt(entry) });
    }
  }
  return [...merged.values()];
}

export function rememberRecentSession(session) {
  const entry = {
    projectId: state.activeProjectId,
    sessionPath: canonicalSessionPath(session.path),
    title: shortSessionTitle(session),
    openedAt: new Date().toISOString(),
    updatedAt: session.updatedAt ?? session.createdAt ?? null,
    engine: sessionEngine(session),
    sessionId: session.id,
  };
  const others = state.recentSessions.filter((candidate) => recentSessionKey(candidate) !== recentSessionKey(entry));
  state.recentSessions = [entry, ...others].slice(0, RECENT_SESSIONS_LIMIT);
  if (state.preferencesLoaded) saveRecentSessionInBackground(entry);
}

/** When the conversation last moved, not when this browser last opened it. */
function recentSessionActivityAt(entry) {
  return entry.updatedAt || entry.openedAt;
}

/** Stamps each entry with the activity time from its project's freshly listed conversations. */
function applyRecentSessionActivity(sessionsByProject) {
  const changedEntries = [];
  state.recentSessions = state.recentSessions.map((entry) => {
    const sessions = sessionsByProject.get(entry.projectId);
    if (!sessions) return entry;
    const session = sessions.find((candidate) => sessionRecentKey(candidate) === recentSessionKey(entry));
    const updatedAt = session?.updatedAt ?? session?.createdAt ?? null;
    if (!updatedAt || updatedAt === entry.updatedAt) return entry;
    const changed = { ...entry, updatedAt };
    changedEntries.push(changed);
    return changed;
  });
  if (state.preferencesLoaded) {
    for (const entry of changedEntries) saveRecentSessionInBackground(entry);
  }
}

/**
 * Conversations keep moving while the recents dialog is closed — a ticket run, or
 * another node writing through Syncthing — so every session-list render refreshes
 * the stored activity time for the project it just listed.
 */
export function syncRecentSessionActivity() {
  applyRecentSessionActivity(new Map([[state.activeProjectId, state.sessions]]));
}

/**
 * The dialog lists every project, but only the active one's conversations are in memory,
 * so opening it asks each other project for its own list. A recents entry can outlive its
 * project, and that failed request just leaves the entry's stored time alone.
 */
async function refreshRecentSessionActivity() {
  const projectIds = [...new Set(state.recentSessions.map((entry) => entry.projectId))];
  const listed = await Promise.all(projectIds.map(async (projectId) => {
    if (projectId === state.activeProjectId) return [projectId, state.sessions];
    try {
      const body = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
      return [projectId, body.sessions];
    } catch {
      return [projectId, null];
    }
  }));
  applyRecentSessionActivity(new Map(listed.filter(([, sessions]) => sessions)));
  renderRecentSessionsDialog();
}

/** Searching covers the project name too, since the same title repeats across projects. */
function recentSessionSearchText(entry) {
  const project = state.projects.find((candidate) => candidate.id === entry.projectId);
  return `${entry.title}\n${project ? project.name : ""}`.toLowerCase();
}

function forgetRecentSession(entry) {
  state.recentSessions = state.recentSessions.filter((candidate) => recentSessionKey(candidate) !== recentSessionKey(entry));
  if (state.preferencesLoaded) {
    api("/api/recents", { method: "DELETE", body: JSON.stringify({ projectId: entry.projectId, engine: entry.engine, sessionId: entry.sessionId }) })
      .catch((error) => { console.warn("Could not remove recent conversation", error); toast("Could not remove recent conversation"); });
  }
  renderRecentSessionsDialog();
}

/**
 * The recents list can outlive the conversation or the project it points at, so a stale
 * entry is dropped on the click that discovers it rather than checked up front.
 */
async function openRecentSession(entry) {
  elements.recentSessionsDialog.close();
  if (state.activeProjectId !== entry.projectId) await selectProject(entry.projectId);
  const session = state.sessions.find((candidate) => sessionRecentKey(candidate) === recentSessionKey(entry));
  if (!session) {
    forgetRecentSession(entry);
    toast("That conversation is no longer available");
    return;
  }
  openListedSession(session);
}

/** Rows 1-10 carry a digit shortcut; the list is renumbered whenever the search narrows it. */
let recentSessionShortcuts = [];

export function renderRecentSessionsDialog() {
  elements.recentSessionsList.replaceChildren();
  recentSessionShortcuts = [];

  const typed = elements.recentSessionsSearchInput.value || "";
  const query = isRowSelectorQuery(typed) ? "" : normalizedQuery(typed);
  const byActivity = [...mergeRecentSessions(state.recentSessions)].sort((left, right) =>
    recentSessionActivityAt(right).localeCompare(recentSessionActivityAt(left)));
  const ordered = sortPinnedFirst(byActivity, isSessionPinned);
  const matches = ordered.filter((entry) => !query || recentSessionSearchText(entry).includes(query));

  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = query ? "No conversations match that search." : "No conversations opened yet.";
    elements.recentSessionsList.append(empty);
    return;
  }

  for (const entry of matches) {
    const pinned = isSessionPinned(entry);
    const row = document.createElement("div");
    row.className = "list-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${pinned ? " pinned" : ""}`;
    if (entry.color) button.dataset.color = entry.color;
    button.dataset.testid = "recent-session-option";
    // Rows are single-line, so the full title lives in the tooltip.
    button.title = entry.title;
    if (recentSessionShortcuts.length < LIST_SHORTCUT_LIMIT) {
      recentSessionShortcuts.push(entry);
      button.append(shortcutIndexBadge("recent-session-index", recentSessionShortcuts.length));
    }
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const meta = document.createElement("span");
    const project = state.projects.find((candidate) => candidate.id === entry.projectId);
    meta.textContent = `${project ? project.name : "Unknown project"} · ${formatDate(recentSessionActivityAt(entry))}`;
    button.append(title, meta);
    button.addEventListener("click", () => openRecentSession(entry).catch((error) => toast(error.message)));

    const pinToggle = pinButton({
      pinned,
      label: pinned ? `Unpin ${entry.title}` : `Pin ${entry.title}`,
      testid: "recent-session-pin-button",
      onToggle: () => {
        togglePinnedSession(entry);
        renderRecentSessionsDialog();
      },
    });

    row.append(button, pinToggle);
    elements.recentSessionsList.append(row);
  }
}
/** One dialog, several triggers: the projects header, the conversations header, the
 *  chat menu, and the recorded shortcut. Exported for the canvas dispatcher. */
export function openRecentSessions() {
  elements.recentSessionsSearchInput.value = "";
  renderRecentSessionsDialog();
  elements.recentSessionsDialog.showModal();
  elements.recentSessionsSearchInput.focus();
  // Stored times go stale while the dialog is closed; the rows reorder once the fresh ones land.
  refreshRecentSessionActivity().catch((error) => console.warn(error));
}
for (const trigger of document.querySelectorAll("[data-recent-sessions-open]")) {
  trigger.addEventListener("click", openRecentSessions);
}
elements.recentSessionsSearchInput.addEventListener("input", () => renderRecentSessionsDialog());
// Search inputs consume Escape to clear their query instead of dismissing the dialog.
elements.recentSessionsSearchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  elements.recentSessionsDialog.close();
});
attachDigitShortcuts(elements.recentSessionsDialog, () => recentSessionShortcuts, (entry) => openRecentSession(entry).catch((error) => toast(error.message)));
/** The recorded recents chord reaches the list from any view, including
 * mid-conversation. A canvas pane stays out of the way: it forwards the keystroke to
 * the canvas, which opens the list once for the whole workspace. */
document.addEventListener("keydown", (event) => {
  if (state.canvasPaneMode) return;
  const chord = state.canvasKeymap?.commands?.recents;
  if (!Array.isArray(chord) || shortcutPrefix(chord) || !chordMatches(chord, event)) return;
  event.preventDefault();
  if (elements.recentSessionsDialog.open) {
    elements.recentSessionsDialog.close();
    return;
  }
  openRecentSessions();
});
elements.closeRecentSessionsButton.addEventListener("click", () => elements.recentSessionsDialog.close());
