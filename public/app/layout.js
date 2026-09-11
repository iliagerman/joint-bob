import { savePreferencesInBackground } from "./api.js";
import { conversationTask } from "./chat-controls.js";
import { elements } from "./elements.js";
import { addSessionToCanvas } from "./session-list.js";
import { formatDate, setTheme, toast } from "./shell.js";
import { state } from "./state.js";
import { focusTaskCard, renderBoardView } from "./tasks.js";

export function shortSessionTitle(session) {
  const title = session?.title || "Pi session";
  if (!session?.path) return title;
  if (title && !title.endsWith(".jsonl") && title !== "Untitled Pi session") return title;
  return `Pi session • ${formatDate(session.updatedAt || session.createdAt)}`;
}

/**
 * The chat header must agree with the conversations list. Status updates and
 * sessionInfoChanged carry the engine's own live session name (for example a
 * generated one), which must not clobber a Joint Bob rename the list still shows.
 */
export function syncChatTitleFromSessions(engineName) {
  const session = state.sessions.find((item) => item.id === state.activeSessionId)
    || state.sessions.find((item) => item.path === state.activeSessionPath);
  elements.sessionTitle.textContent = session ? shortSessionTitle(session) : engineName;
}

/**
 * Desktop-only: the mobile layout already shows a single panel at a time, so the
 * body class simply narrows one grid column down to the rail width.
 */
export function setPanelCollapsed(panel, collapsed) {
  const panelElement = panel === "projects" ? elements.projectsPanel : elements.chatsPanel;
  document.body.classList.toggle(`${panel}-collapsed`, collapsed);
  panelElement.classList.toggle("collapsed", collapsed);
  if (!state.preferencesLoaded) return;
  if (panel === "projects") savePreferencesInBackground({ projectsPanelCollapsed: collapsed });
  else savePreferencesInBackground({ chatsPanelCollapsed: collapsed });
}

export function togglePanel(panel) {
  if (matchMedia("(max-width: 1023px)").matches) return;
  setPanelCollapsed(panel, !document.body.classList.contains(`${panel}-collapsed`));
}

const MOBILE_VIEWS = ["projects", "sessions", "board", "chat", "canvas"];

function currentMobileView() {
  return MOBILE_VIEWS.find((name) => document.body.classList.contains(`view-${name}`)) ?? "projects";
}

/**
 * The app-wide canvas key. It opens the canvas from anywhere and puts the user back in the
 * view they left, so one key moves in both directions rather than only out of the canvas.
 */
export function toggleCanvasView() {
  if (state.canvasPaneMode) return;
  if (currentMobileView() === "canvas") {
    setMobileView(state.viewBeforeCanvas || (state.activeProjectId ? "sessions" : "projects"));
    return;
  }
  setMobileView("canvas");
}

export function setMobileView(view, updateHistory = true) {
  // A pane frame hosts exactly one conversation; it never navigates elsewhere.
  if (state.canvasPaneMode) {
    document.body.classList.remove("view-projects", "view-sessions", "view-board", "view-chat", "view-canvas");
    document.body.classList.add("view-chat");
    return;
  }
  // Canvas is a desktop surface; a narrow viewport (or a stale persisted view)
  // falls back to the conversation list, or the project list without one.
  if (view === "canvas" && matchMedia("(max-width: 1023px)").matches) {
    view = state.activeProjectId ? "sessions" : "projects";
  }
  const currentView = history.state?.mobileView;
  if (view === "canvas" && currentMobileView() !== "canvas") state.viewBeforeCanvas = currentMobileView();
  if (state.preferencesLoaded) savePreferencesInBackground({ mobileView: view });

  document.body.classList.remove("view-projects", "view-sessions", "view-board", "view-chat", "view-canvas");
  document.body.classList.add(`view-${view}`);
  for (const [name, navButton] of [
    ["projects", elements.navProjectsButton],
    ["sessions", elements.navSessionsButton],
    ["board", elements.navBoardButton],
    ["chat", elements.navChatButton],
  ]) {
    navButton.classList.toggle("active", name === view);
  }
  if (view === "canvas") state.canvasController?.activate().catch((error) => toast(error.message, 8000));
  else state.canvasController?.deactivate();
  if (updateHistory && currentView !== view) history.pushState({ ...history.state, mobileView: view }, "");
}

history.replaceState({ ...history.state, mobileView: "projects" }, "");
window.addEventListener("popstate", (event) => {
  if (event.state?.mobileView) setMobileView(event.state.mobileView, false);
});

export function selectedProject() {
  return state.projects.find((project) => project.id === state.activeProjectId) || null;
}

export function normalizedQuery(value) {
  return value.trim().toLowerCase();
}

export function sessionChatState(session) {
  if (session.running || session.reviewState === "running") return "active";
  if (session.reviewState === "needs_review") return "review";
  return "done";
}

function matchesClassification(session) {
  const value = session.classification ? `label:${session.classification}` : "unclassified";
  return !state.classificationFilter || state.classificationFilter === value;
}

export function updateChatFilterCounts() {
  const sessions = state.sessions.filter(matchesClassification);
  const counts = { all: sessions.length, active: 0, review: 0, done: 0, cron: sessions.filter(session => session.cronTaskId).length };
  for (const session of sessions) counts[sessionChatState(session)] += 1;
  for (const count of elements.chatFilters.querySelectorAll("[data-filter-count]")) {
    count.textContent = counts[count.dataset.filterCount];
  }
}

export function filteredSessions() {
  const query = normalizedQuery(elements.sessionSearchInput.value || "");
  return state.sessions.filter((session) => {
    if (!matchesClassification(session)) return false;
    const searchableText = `${shortSessionTitle(session)}\n${session.firstMessage || ""}\n${session.path || ""}`.toLowerCase();
    if (query && !searchableText.includes(query)) return false;
    return state.chatFilter === "all" || (state.chatFilter === "cron" ? Boolean(session.cronTaskId) : sessionChatState(session) === state.chatFilter);
  });
}

export function filteredProjects() {
  const query = normalizedQuery(elements.projectSearchInput.value || "");
  if (!query) return state.projects;
  return state.projects.filter((project) => `${project.name}\n${project.path}`.toLowerCase().includes(query));
}

elements.themeToggleButton.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
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
elements.openCanvasButton.addEventListener("click", () => setMobileView("canvas"));
elements.canvasAddButton.addEventListener("click", () => state.canvasController?.openPicker());
elements.canvasBackButton.addEventListener("click", () => setMobileView("sessions"));
elements.addToCanvasButton.addEventListener("click", () => {
  const session = state.sessions.find((candidate) => state.activeSessionId
    ? candidate.id === state.activeSessionId
    : candidate.path === state.activeSessionPath);
  if (!session) return;
  elements.chatMoreMenu.removeAttribute("open");
  addSessionToCanvas(session);
});
elements.collapseProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", true));

elements.expandProjectsButton.addEventListener("click", () => setPanelCollapsed("projects", false));
elements.collapseChatsButton.addEventListener("click", () => setPanelCollapsed("chats", true));
elements.expandChatsButton.addEventListener("click", () => setPanelCollapsed("chats", false));
