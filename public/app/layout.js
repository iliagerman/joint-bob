import { savePreferencesInBackground } from "./api.js";
import { conversationTask } from "./chat-controls.js";
import { elements } from "./elements.js";
import { projectMatchesClusters, sessionMatchesClusters } from "./cluster-filters.js";
import { activateControlCenter } from "./control-center.js";
import { formatDate, toast } from "./shell.js";
import { state } from "./state.js";
import { focusTaskCard, renderBoardView } from "./tasks.js";

export function shortSessionTitle(session) {
  // Pi names a session it could not title "Untitled Pi session"; any harness's untitled session reads the same.
  const title = session?.title || "Conversation";
  if (!session?.path) return title;
  if (title && !title.endsWith(".jsonl") && title !== "Untitled Pi session") return title;
  return `Conversation • ${formatDate(session.updatedAt || session.createdAt)}`;
}

/** The title as the list and chat header show it. Moves, recents and references keep the stored title. */
export function sessionDisplayTitle(session) {
  return shortSessionTitle({ ...session, title: session.displayTitle ?? session.title });
}

/**
 * The chat header must agree with the conversations list. Status updates and
 * sessionInfoChanged carry the engine's own live session name (for example a
 * generated one), which must not clobber a Joint Bob rename the list still shows.
 */
export function syncChatTitleFromSessions(engineName) {
  const session = state.sessions.find((item) => item.id === state.activeSessionId)
    || state.sessions.find((item) => item.path === state.activeSessionPath);
  elements.sessionTitle.textContent = session ? sessionDisplayTitle(session) : engineName;
}

/**
 * Desktop-only: the mobile layout already shows a single panel at a time, so the
 * body class simply narrows one grid column down to the rail width.
 */
export function setPanelCollapsed(panel, collapsed) {
  const panelElement = panel === "projects" ? elements.projectsPanel : elements.chatsPanel;
  document.body.classList.toggle(`${panel}-collapsed`, collapsed);
  panelElement.classList.toggle("collapsed", collapsed && !document.body.classList.contains("focus-ui"));
  if (!state.preferencesLoaded) return;
  if (panel === "projects") savePreferencesInBackground({ projectsPanelCollapsed: collapsed });
  else savePreferencesInBackground({ chatsPanelCollapsed: collapsed });
}

export function togglePanel(panel) {
  if (matchMedia("(max-width: 1023px)").matches) return;
  setPanelCollapsed(panel, !document.body.classList.contains(`${panel}-collapsed`));
}

const MOBILE_VIEWS = ["projects", "sessions", "board", "chat", "control"];

function currentMobileView() {
  return MOBILE_VIEWS.find((name) => document.body.classList.contains(`view-${name}`)) ?? "projects";
}

/**
 * The app-wide control center key. It opens the control center from anywhere and puts the user
 * back in the view they left, so one key moves in both directions.
 */
export function toggleControlView() {
  if (currentMobileView() === "control") {
    setMobileView(state.viewBeforeControl || (state.activeProjectId ? "sessions" : "projects"));
    return;
  }
  setMobileView("control");
}

/** The view one level up: a conversation or the board returns to its project's list, and the list and the control center to the projects. */
function parentView(view) {
  if (view === "chat" || view === "board") return state.activeProjectId ? "sessions" : "projects";
  if (view === "sessions" || view === "control") return "projects";
  return null;
}
function controlExitView() {
  return state.viewBeforeControl || (state.activeProjectId ? "sessions" : "projects");
}

// History holds the base entry and exactly one entry above it for the current view, so Back always climbs one level
// instead of replaying every place visited, and Back on the projects view stays in the app.
function recordView(view) {
  if (history.state?.appTop) history.replaceState({ ...history.state, mobileView: view, appTop: true }, "");
  else history.pushState({ ...history.state, mobileView: view, appTop: true }, "");
}

export function setMobileView(view, updateHistory = true) {
  if (state.keepControlView && view !== "control") return;
  if (view === "control" && currentMobileView() !== "control") state.viewBeforeControl = currentMobileView();
  if (state.preferencesLoaded) savePreferencesInBackground({ mobileView: view });

  document.body.classList.remove("view-projects", "view-sessions", "view-board", "view-chat", "view-control");
  document.body.classList.add(`view-${view}`);
  for (const [name, navButton] of [
    ["projects", elements.navProjectsButton],
    ["sessions", elements.navSessionsButton],
    ["board", elements.navBoardButton],
    ["chat", elements.navChatButton],
  ]) {
    navButton.classList.toggle("active", name === view);
  }
  if (view === "control") activateControlCenter().catch((error) => toast.error(error.message));
  if (updateHistory) recordView(view);
  window.dispatchEvent(new CustomEvent("app-view-changed"));
}

history.replaceState({ ...history.state, mobileView: "projects", appTop: false }, "");
window.addEventListener("popstate", (event) => {
  if (event.state?.appTop) { setMobileView(event.state.mobileView, false); return; }
  // Back lands on the base entry: show the parent, or stay on the projects view, and put the entry above the base back.
  const parent = parentView(currentMobileView());
  if (parent) setMobileView(parent, false);
  recordView(currentMobileView());
});

export function selectedProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

export function normalizedQuery(value) {
  return value.trim().toLowerCase();
}

export function sessionDisplayState(session) {
  if (session.turnRunning || (!session.backgroundRunning && (session.running || session.reviewState === "running"))) return "active";
  if (session.backgroundRunning) return "background";
  if (session.reviewState === "needs_review") return "review";
  return "done";
}

export function sessionChatState(session) {
  const display = sessionDisplayState(session);
  return display === "background" ? "active" : display;
}

/** A conversation the user closed out. Unrelated to the "done" status chip, which means reviewed. */
function isDoneConversation(session) {
  return Boolean(session.doneAt);
}

/** Project lists and badges share visibility, including saved settings for unopened projects. */
export function sessionIsVisible(session, projectId = state.activeProjectId) {
  const active = projectId === state.activeProjectId;
  const visibility = active
    ? { done: state.showDoneConversations, scheduled: state.showScheduledConversations }
    : state.projectConversationVisibility[projectId] || {};
  // Other projects' snapshots already exclude schedules hidden from history on the server.
  return (visibility.done === true || !isDoneConversation(session))
    && (!session.cronTaskId || (visibility.scheduled === true
      && (!active || (state.knownCronTaskIds.has(session.cronTaskId) && !state.hiddenCronTaskIds.has(session.cronTaskId)))));
}

function matchesClassification(session) {
  const value = session.classification ? `label:${session.classification}` : "unclassified";
  return !state.classificationFilters.size || state.classificationFilters.has(value);
}

/** Status chips combine: choosing Running and Needs review shows both. None chosen is All. */
function matchesChatFilters(session) {
  if (!state.chatFilters.size) return true;
  return [...state.chatFilters].some((filter) => filter === "cron" ? Boolean(session.cronTaskId) : sessionChatState(session) === filter);
}

export function updateChatFilterCounts() {
  const sessions = state.sessions.filter((session) => matchesClassification(session) && sessionMatchesClusters(session) && sessionIsVisible(session));
  const counts = { all: sessions.length, active: 0, review: 0, done: 0, cron: sessions.filter(session => session.cronTaskId).length };
  for (const session of sessions) counts[sessionChatState(session)] += 1;
  for (const count of elements.chatFilters.querySelectorAll("[data-filter-count]")) {
    count.textContent = counts[count.dataset.filterCount];
  }
}

export function filteredSessions() {
  const query = normalizedQuery(elements.sessionSearchInput.value || "");
  return state.sessions.filter((session) => {
    if (!matchesClassification(session) || !sessionMatchesClusters(session) || !sessionIsVisible(session)) return false;
    const searchableText = `${shortSessionTitle(session)}\n${session.firstMessage || ""}\n${session.path || ""}`.toLowerCase();
    if (query && !searchableText.includes(query)) return false;
    return matchesChatFilters(session);
  });
}

export function filteredProjects() {
  const query = normalizedQuery(elements.projectSearchInput.value || "");
  return state.projects.filter((project) => projectMatchesClusters(project)
    && (!query || `${project.name}\n${project.path}`.toLowerCase().includes(query)));
}

elements.navProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.navSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.navBoardButton.addEventListener("click", () => {
  renderBoardView();
  setMobileView("board");
});
elements.navChatButton.addEventListener("click", () => setMobileView("chat"));
elements.backToProjectsButton.addEventListener("click", () => setMobileView("projects"));
elements.backToChatsButton.addEventListener("click", () => setMobileView("sessions"));
elements.backToSessionsButton.addEventListener("click", () => setMobileView("sessions"));
elements.taskBacklinkButton.addEventListener("click", () => {
  const task = conversationTask();
  if (!task) return;
  renderBoardView();
  setMobileView("board");
  focusTaskCard(task.id);
});
elements.openBoardButton.addEventListener("click", () => {
  renderBoardView();
  setMobileView("board");
});
elements.openControlCenterButton.addEventListener("click", () => setMobileView("control"));
const EXIT_PROMPT_MS = 3000;
let exitPromptTimer = null;

function hideExitPrompt() {
  clearTimeout(exitPromptTimer);
  elements.controlExitPrompt.hidden = true;
}

function leaveControlCenter() {
  hideExitPrompt();
  setMobileView(controlExitView());
}
elements.controlCenterCloseButton.addEventListener("click", leaveControlCenter);
elements.controlExitConfirm.addEventListener("click", leaveControlCenter);
// Esc twice is the quick way out, so one stray press does not leave: the first asks, the second leaves. It leaves typing in a
// field and open dialogs alone.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || currentMobileView() !== "control" || event.defaultPrevented) return;
  if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select")) return;
  if (!elements.controlExitPrompt.hidden) { leaveControlCenter(); return; }
  elements.controlExitPrompt.hidden = false;
  clearTimeout(exitPromptTimer);
  exitPromptTimer = setTimeout(hideExitPrompt, EXIT_PROMPT_MS);
});
elements.collapseProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", true));

elements.expandProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", false));
elements.collapseChatsButton.addEventListener("click", () => setPanelCollapsed("chats", true));
elements.expandChatsButton.addEventListener("click", () => setPanelCollapsed("chats", false));
