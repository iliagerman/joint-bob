import { savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { openRecentSessions } from "./recents.js";
import { setMobileView } from "./layout.js";
import { state } from "./state.js";
import { refreshRowMenuAnchor } from "./row-menu.js";
import { toast } from "./shell.js";
import { initializeMobileProjectControls, syncMobileProjectControls, mobileFocusViewport } from "./focus-project-controls.js";

const fab = document.querySelector("#focusControlsButton");
const menu = document.querySelector("#focusControls");
const toggle = document.querySelector("#settingsFocusUi");
const chatHost = document.querySelector("#focusChatControls");
const context = document.querySelector("#focusContextActions");
const toolbarHome = document.createComment("Chat toolbar location");
let enabled = false;
let preferred = false;

function currentView() {
  return ["projects", "sessions", "chat", "board", "canvas"].find(view => document.body.classList.contains(`view-${view}`)) || "projects";
}
function placeMenu() {
  if (menu.hidden) return;
  const rect = fab.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(rect.left - menu.offsetWidth - 10, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(rect.top - menu.offsetHeight - 10, (visualViewport?.height || innerHeight) - menu.offsetHeight - 12))}px`;
}
function showMenu(show = menu.hidden) {
  if (!enabled) return;
  menu.hidden = !show;
  fab.setAttribute("aria-expanded", String(show));
  if (show) { fab.hidden = false; showSection(""); }
  else if (menu.contains(document.activeElement)) fab.focus();
}
function showSection(section) {
  menu.dataset.section = section;
  const inChat = currentView() === "chat";
  document.querySelector("#focusBack").hidden = !section;
  document.querySelector("#focusChatSections").hidden = !inChat || Boolean(section);
  context.hidden = Boolean(section);
  chatHost.hidden = !section;
  document.querySelector("#focusAgent").setAttribute("aria-expanded", String(section === "agent"));
  document.querySelector("#focusTools").setAttribute("aria-expanded", String(section === "tools"));
  document.querySelector("#focusContextTitle").textContent = section
    ? { agent: "Agent & model", tools: "Tools & actions" }[section]
    : { projects: "Projects", sessions: "This project", chat: "This conversation", board: "Project board", canvas: "Canvas" }[currentView()];
  elements.chatMoreMenu.open = section === "tools";
  placeMenu();
}
function proxyAction(label, target, icon) {
  const button = document.createElement("button");
  button.type = "button";
  button.append(menuIcon(icon), document.createTextNode(label));
  button.dataset.testid = `focus-action-${target.id}`;
  button.disabled = target.disabled;
  button.addEventListener("click", () => {
    showMenu(false);
    target.click();
    if (elements.rowMenu.matches(":popover-open")) {
      state.rowMenuAnchor = fab;
      state.rowMenuAnchorSelector = null;
      refreshRowMenuAnchor();
    }
  });
  context.append(button);
}
function syncView() {
  if (!enabled) return;
  const view = currentView();
  showMenu(false);
  document.querySelector("#focusConversations").disabled = !state.activeProjectId;
  showSection("");
  context.replaceChildren();
  if (view === "projects") proxyAction("New project", elements.newProjectButton, "folder");
  if (view === "sessions") {
    const rowMenu = document.querySelector(`[data-project-id="${CSS.escape(state.activeProjectId || "")}"] [data-testid="project-menu-button"]`);
    if (rowMenu) proxyAction("Project actions", rowMenu, "sliders");
    proxyAction("Project board", elements.openBoardButton, "canvas");
    proxyAction("Canvas", elements.openCanvasButton, "canvas");
  }
  if (state.activeProjectId && view === "projects") proxyAction("Project notes", document.querySelector("#projectNotesButton"), "file");
  if (view === "board") proxyAction("New task", elements.newTaskButton, "pencil");
  if (view === "canvas") proxyAction("Add conversation", elements.canvasAddButton, "chat");
}

/** Layout only: never reload a session or change the user's panel-collapse preferences.
 *  The saved preference applies to mobile screens only; desktops keep the classic layout. */
export function setFocusUi(value) {
  preferred = Boolean(value);
  applyFocusUi();
}

function applyFocusUi() {
  enabled = preferred && mobileFocusViewport.matches && !state.canvasPaneMode;
  toggle.checked = preferred && !state.canvasPaneMode;
  toggle.disabled = state.canvasPaneMode;
  document.body.classList.toggle("focus-ui", enabled);
  syncMobileProjectControls();
  fab.hidden = !enabled;
  menu.hidden = true;
  for (const [name, panel] of [["projects", elements.projectsPanel], ["chats", elements.chatsPanel]]) {
    panel.classList.toggle("collapsed", !enabled && document.body.classList.contains(`${name}-collapsed`));
  }
  if (enabled) {
    if (!toolbarHome.isConnected) elements.chatToolbar.before(toolbarHome);
    chatHost.append(elements.chatToolbar);
    syncView();
    resize();
  } else {
    if (toolbarHome.isConnected) toolbarHome.replaceWith(elements.chatToolbar);
    elements.chatMoreMenu.removeAttribute("open");
  }
}

function resize() {
  if (!enabled) return;
  document.documentElement.style.setProperty("--focus-height", `${visualViewport?.height || innerHeight}px`);
  placeMenu();
}
export function initializeFocusUi({ openSettings, startConversation, createNote, inspectReviews, inspectRunning }) {
  const settings = () => { showMenu(false); openSettings().catch(error => toast(error.message)); };
  const start = () => { showMenu(false); startConversation().catch(error => toast(error.message)); };
  document.querySelector("#focusSettings").onclick = settings;
  document.querySelector("#focusNewConversation").onclick = start;
  document.querySelector("#conversationSearchCreateButton").onclick = start;
  decorateControls();
  document.querySelector("#focusAgent").onclick = () => { showSection("agent"); document.querySelector("#focusBack").focus(); };
  document.querySelector("#focusTools").onclick = () => { showSection("tools"); document.querySelector("#focusBack").focus(); };
  document.querySelector("#focusBack").onclick = backToControls;
  for (const [id, action] of [["focusNewNote", createNote], ["focusRecents", openRecentSessions], ["focusReviews", inspectReviews], ["focusRunning", inspectRunning]]) {
    document.getElementById(id).onclick = () => { showMenu(false); Promise.resolve().then(action).catch(error => toast(error.message)); };
  }
  document.querySelector("#focusProjects").onclick = () => setMobileView("projects");
  document.querySelector("#focusConversations").onclick = () => setMobileView("sessions");
  document.querySelector("#focusClose").onclick = () => showMenu(false);
  chatHost.addEventListener("click", event => { if (!mobileFocusViewport.matches && event.target.closest("button:not(:disabled)")) showMenu(false); });
  toggle.addEventListener("change", async () => {
    const next = toggle.checked;
    toggle.disabled = true;
    try { await savePreferences({ focusUiEnabled: next }); setFocusUi(next); }
    catch (error) { toggle.checked = preferred; toast(`Could not save interface preference: ${error.message}`); }
    finally { toggle.disabled = state.canvasPaneMode; }
  });
  window.addEventListener("app-view-changed", syncView);
  mobileFocusViewport.addEventListener("change", applyFocusUi);
  window.addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
  fab.onclick = () => showMenu();
  initializeMobileProjectControls();
  installFocusKeys();
}

function backToControls() {
  const section = menu.dataset.section;
  showSection("");
  document.querySelector(section === "agent" ? "#focusAgent" : "#focusTools").focus();
}
function decorateControls() {
  for (const [id, icon] of Object.entries({
    focusBack: "back", focusClose: "close", focusAgent: "sliders", focusTools: "terminal",
    focusNewConversation: "chat", focusNewNote: "pencil", focusRecents: "clock", focusReviews: "archive", focusRunning: "play",
    focusProjects: "folder", focusConversations: "chat", focusSettings: "sliders",
    openTerminalButton: "terminal", openBrowserButton: "globe", chatFilesButton: "folder", chatGitButton: "merge",
    notifyButton: "sliders", addToCanvasButton: "canvas", renameSessionButton: "pencil", chatCronButton: "clock",
    chatDoneButton: "check", chatSessionMenuButton: "menu", installAppButton: "transfer",
  })) {
    const svg = menuIcon(icon);
    svg.classList.add("focus-action-icon");
    document.getElementById(id).prepend(svg);
  }
}

function installFocusKeys() {
  document.addEventListener("pointerdown", event => {
    if (mobileFocusViewport.matches && event.target.closest("dialog")) return;
    if (enabled && event.pointerType === "mouse" && !menu.contains(event.target) && !fab.contains(event.target)) showMenu(false);
  });
  document.addEventListener("keydown", event => {
    if (!enabled || document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key === ".") { event.preventDefault(); showMenu(); if (!menu.hidden) menu.querySelector("button")?.focus(); }
    if (event.key === "Escape") {
      if (!menu.hidden && menu.dataset.section) backToControls();
      else showMenu(false);
    }
  });
}
