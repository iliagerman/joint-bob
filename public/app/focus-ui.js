import { savePreferences } from "./api.js";
import { openDashboardMode } from "./dashboards.js";
import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { openRecentSessions } from "./recents.js";
import { setMobileView } from "./layout.js";
import { state } from "./state.js";
import { refreshRowMenuAnchor } from "./row-menu.js";
import { toast } from "./shell.js";
import { initializeMobileProjectControls, syncMobileProjectControls, mobileFocusViewport } from "./focus-project-controls.js";
import { installCreationGestures } from "./focus-creation-gestures.js";

const fab = document.querySelector("#focusControlsButton");
const menu = document.querySelector("#focusControls");
const toggle = document.querySelector("#settingsFocusUi");
const chatHost = document.querySelector("#focusChatControls");
const context = document.querySelector("#focusContextActions");
const nodeList = document.querySelector("#focusNodeList");
const toolbarHome = document.createComment("Chat toolbar location");
let enabled = false;
let preferred = false;
let position = null;

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
  document.querySelector("#focusChatQuickActions").hidden = !inChat || Boolean(section);
  context.hidden = Boolean(section);
  chatHost.hidden = section !== "tools";
  nodeList.hidden = !["node", "agent", "effort"].includes(section);
  document.querySelector("#focusTools").setAttribute("aria-expanded", String(section === "tools"));
  document.querySelector("#focusNode").setAttribute("aria-expanded", String(section === "node"));
  document.querySelector("#focusContextTitle").textContent = section
    ? { tools: "Tools & actions", node: "Runs on", agent: "Agent", effort: "Effort" }[section]
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
/** Dashboard mode for the open project; a conversation's is under Tools, with its other actions. */
function dashboardAction(target) {
  const button = document.createElement("button");
  button.type = "button";
  button.append(menuIcon("dashboard"), document.createTextNode("Dashboard"));
  button.dataset.testid = "focus-dashboard";
  button.addEventListener("click", () => {
    showMenu(false);
    openDashboardMode(target()).catch((error) => toast(error.message));
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
    if (state.activeProjectId) dashboardAction(() => ({ kind: "project", id: state.activeProjectId, projectId: state.activeProjectId }));
    proxyAction("Project board", elements.openBoardButton, "canvas");
    proxyAction("Canvas", elements.openCanvasButton, "canvas");
  }
  if (state.activeProjectId && view === "projects") proxyAction("Project notes", document.querySelector("#projectNotesButton"), "file");
  if (view === "board") proxyAction("New task", elements.newTaskButton, "pencil");
  if (view === "canvas") proxyAction("Add conversation", elements.canvasAddButton, "chat");
  syncQuickActionLabels();
}

export function syncQuickActionLabels() {
  if (!enabled) return;
  const agentLabel = document.querySelector("#focusAgentLabel");
  const modelLabel = document.querySelector("#focusModelLabel");
  const effortLabel = document.querySelector("#focusEffortLabel");
  const nodeLabel = document.querySelector("#focusNodeLabel");
  if (!agentLabel || !modelLabel || !effortLabel || !nodeLabel) return;

  const harness = state.harnesses.find(h => h.id === state.engine);
  agentLabel.textContent = harness?.label || "Agent";
  modelLabel.textContent = state.activeModelLabel || "Model";
  effortLabel.textContent = state.thinkingLevel || "Effort";
  const activeNode = state.sessionNodes.find(n => n.id === state.activeNodeId);
  nodeLabel.textContent = activeNode?.name || "Node";
  document.querySelector("#focusAgent").disabled = elements.chatHarnessSelect.disabled;
  document.querySelector("#focusEffort").disabled = elements.reasoningLevelSelect.disabled;
  document.querySelector("#focusNode").disabled = elements.chatNodeSelect.disabled;
}

/** Show the toolbar selects as buttons; their native pickers cannot open while the toolbar is hidden. */
function showSelectOptions(select, section) {
  nodeList.replaceChildren(...Array.from(select.options, option => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.textContent;
    button.dataset.testid = `focus-${section}-option`;
    button.disabled = option.disabled;
    button.setAttribute("aria-pressed", String(option.selected));
    button.addEventListener("click", () => {
      if (!option.selected) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (section === "node") showMenu(false);
      else showSection("");
    });
    return button;
  }));
  showSection(section);
  document.querySelector("#focusBack").focus();
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

function move(x, y) {
  const height = visualViewport?.height || innerHeight;
  position = { x: Math.max(12, Math.min(x, innerWidth - fab.offsetWidth - 12)), y: Math.max(12, Math.min(y, height - fab.offsetHeight - 12)) };
  Object.assign(fab.style, { left: `${position.x}px`, top: `${position.y}px`, right: "auto", bottom: "auto" });
  placeMenu();
}
function resize() {
  if (!enabled) return;
  document.documentElement.style.setProperty("--focus-height", `${visualViewport?.height || innerHeight}px`);
  if (position && !fab.hidden) move(position.x, position.y);
  placeMenu();
}
function toggleFab() {
  const hide = !fab.hidden;
  showMenu(false);
  fab.hidden = hide;
  if (!hide) resize();
}
export function initializeFocusUi({ openSettings, startConversation, createNote, inspectReviews, inspectRunning }) {
  const settings = () => { showMenu(false); openSettings().catch(error => toast(error.message)); };
  const start = () => { showMenu(false); startConversation().catch(error => toast(error.message)); };
  document.querySelector("#focusSettings").onclick = settings;
  document.querySelector("#focusNewConversation").onclick = start;
  document.querySelector("#conversationSearchCreateButton").onclick = start;
  decorateControls();
  document.querySelector("#focusMarkDone").onclick = () => { showMenu(false); elements.chatDoneButton.click(); };
  document.querySelector("#focusAgent").onclick = () => showSelectOptions(elements.chatHarnessSelect, "agent");
  document.querySelector("#focusModel").onclick = () => { showMenu(false); elements.modelButton.click(); };
  document.querySelector("#focusEffort").onclick = () => showSelectOptions(elements.reasoningLevelSelect, "effort");
  document.querySelector("#focusNode").onclick = () => showSelectOptions(elements.chatNodeSelect, "node");
  document.querySelector("#focusAutoRespond").onclick = () => { showMenu(false); elements.autoRespondButton.click(); };
  document.querySelector("#focusTools").onclick = (event) => { event.stopPropagation(); showSection("tools"); document.querySelector("#focusBack").focus(); };
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
  installFabDrag();
  initializeMobileProjectControls();
  installCreationGestures(start, () => document.querySelector("#focusNewNote").click());
  installTapGestures();
  installFocusKeys();
}

function backToControls() {
  showSection("");
  document.querySelector("#focusNewConversation").focus();
}
function decorateControls() {
  // Only add icons to buttons that don't already have icons in the HTML.
  // Toolbar buttons (.chat-action) already have .chat-toolbar-icon; skip them.
  for (const [id, icon] of Object.entries({
    focusBack: "back", focusClose: "close",
    focusNewConversation: "chat", focusNewNote: "pencil", focusRecents: "clock", focusReviews: "archive", focusRunning: "play",
    focusProjects: "folder", focusConversations: "chat", focusSettings: "sliders",
  })) {
    const svg = menuIcon(icon);
    svg.classList.add("focus-action-icon");
    document.getElementById(id).prepend(svg);
  }
}

function installFabDrag() {
  let drag = null, dragged = false;
  fab.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    dragged = false;
    fab.setPointerCapture(event.pointerId);
  });
  fab.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 7) dragged = true;
    if (dragged) move(drag.left + dx, drag.top + dy);
  });
  fab.addEventListener("pointerup", () => { drag = null; });
  fab.addEventListener("pointercancel", () => { drag = null; dragged = true; });
  fab.onclick = () => {
    if (dragged) { dragged = false; return; }
    showMenu();
  };
  fab.addEventListener("keydown", event => {
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const rect = fab.getBoundingClientRect();
    move(rect.left + delta[0], rect.top + delta[1]);
  });
}

// Delay gesture controls only; editors need native activation to open mobile keyboards.
function installTapGestures() {
  let tap = null, sequence = null, timer = null, lastTouch = -Infinity;
  const controls = "button,input,textarea,select,a,summary,label,[contenteditable],[role=button]";
  const nativeControls = "input,textarea,select,label,[contenteditable],#sendButton,#browserPanel,.browser-viewer,.xterm,.canvas-root";
  const clear = () => { clearTimeout(timer); tap = sequence = null; };
  const finish = () => {
    const completed = sequence;
    clear();
    if (!enabled || !completed) return;
    if (completed.count >= 4 && mobileFocusViewport.matches) document.querySelector("#focusRunning").click();
    else if (completed.count >= 3) { showMenu(false); openRecentSessions(); }
    else if (completed.count === 2 && !completed.target.closest(controls)) toggleFab();
    else activateTap(completed.target, controls);
  };
  document.addEventListener("pointerdown", event => {
    if (!enabled || event.pointerType === "mouse") return;
    if (!event.isPrimary || event.target.closest(nativeControls)) { clear(); return; }
    const now = performance.now();
    if (sequence && (now - sequence.time > 350 || Math.hypot(event.clientX - sequence.x, event.clientY - sequence.y) > 32)) finish();
    clearTimeout(timer);
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, time: now, target: event.target };
    if (event.target.closest(controls)) event.preventDefault();
  }, true);
  document.addEventListener("pointerup", event => {
    if (!enabled || event.pointerType === "mouse" || !tap || tap.id !== event.pointerId) return;
    lastTouch = performance.now();
    if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 12 || lastTouch - tap.time > 350) { clear(); return; }
    sequence = { count: (sequence?.count || 0) + 1, target: tap.target, x: tap.x, y: tap.y, time: lastTouch };
    tap = null;
    timer = setTimeout(finish, 350);
  }, true);
  document.addEventListener("pointercancel", clear, true);
  document.addEventListener("click", event => {
    if (!enabled || !event.isTrusted || event.detail === 0 || event.target.closest(nativeControls)) return;
    if (event.pointerType ? event.pointerType === "mouse" : performance.now() - lastTouch > 700) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener("dblclick", event => {
    if (enabled && !event.target.closest(nativeControls) && performance.now() - lastTouch < 700) event.preventDefault();
  }, true);
}
function activateTap(target, controls) {
  if (!target.isConnected) return;
  const control = target.closest(controls);
  if (!control) { if (!menu.contains(target)) showMenu(false); return; }
  const input = control instanceof HTMLLabelElement ? control.control : control;
  if (!input || input.disabled) return;
  input.focus({ preventScroll: true });
  if (input instanceof HTMLSelectElement && typeof input.showPicker === "function") input.showPicker();
  else input.click();
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
