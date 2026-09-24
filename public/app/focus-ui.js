import { savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { setMobileView } from "./layout.js";
import { state } from "./state.js";
import { refreshRowMenuAnchor } from "./row-menu.js";
import { toast } from "./shell.js";

const fab = document.querySelector("#focusControlsButton");
const menu = document.querySelector("#focusControls");
const toggle = document.querySelector("#settingsFocusUi");
const chatHost = document.querySelector("#focusChatControls");
const context = document.querySelector("#focusContextActions");
const toolbarHome = document.createComment("Chat toolbar location");
let enabled = false;
let position = null;

function currentView() {
  return ["projects", "sessions", "chat", "board", "canvas"].find(view => document.body.classList.contains(`view-${view}`)) || "projects";
}
function placeMenu() {
  if (menu.hidden) return;
  const rect = fab.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(rect.left - menu.offsetWidth - 10, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(rect.bottom - menu.offsetHeight, (visualViewport?.height || innerHeight) - menu.offsetHeight - 12))}px`;
}
function showMenu(show = menu.hidden) {
  if (!enabled) return;
  menu.hidden = !show;
  fab.setAttribute("aria-expanded", String(show));
  if (show) { fab.hidden = false; elements.chatMoreMenu.open = true; placeMenu(); }
  else if (menu.contains(document.activeElement)) fab.focus();
}
function proxyAction(label, target) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
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
  document.querySelector("#focusWorkspaceBar").hidden = view === "chat";
  document.querySelector("#focusContextTitle").textContent = {projects:"Projects",sessions:"This project",chat:"This conversation",board:"Project board",canvas:"Canvas"}[view];
  document.querySelector("#focusConversations").disabled = !state.activeProjectId;
  chatHost.hidden = view !== "chat";
  context.replaceChildren();
  if (view === "projects") proxyAction("New project", elements.newProjectButton);
  if (view === "sessions") {
    const rowMenu = document.querySelector(`[data-project-id="${CSS.escape(state.activeProjectId || "")}"] [data-testid="project-menu-button"]`);
    if (rowMenu) proxyAction("Project actions", rowMenu);
    proxyAction("Project board", elements.openBoardButton);
    proxyAction("Canvas", elements.openCanvasButton);
  }
  if (view === "board") proxyAction("New task", elements.newTaskButton);
  if (view === "canvas") proxyAction("Add conversation to canvas", elements.canvasAddButton);
}

/** Layout only: never reload a session or change the user's panel-collapse preferences. */
export function setFocusUi(value) {
  enabled = Boolean(value) && !state.canvasPaneMode;
  toggle.checked = enabled;
  toggle.disabled = state.canvasPaneMode;
  document.body.classList.toggle("focus-ui", enabled);
  fab.hidden = !enabled;
  menu.hidden = true;
  document.querySelector("#focusWorkspaceBar").hidden = !enabled;
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
  position = {x:Math.max(12, Math.min(x, innerWidth - fab.offsetWidth - 12)), y:Math.max(12, Math.min(y, height - fab.offsetHeight - 12))};
  Object.assign(fab.style, {left:`${position.x}px`, top:`${position.y}px`, right:"auto", bottom:"auto"});
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
  for (const id of ["focusSettings", "focusHeaderSettings"]) document.getElementById(id).onclick = settings;
  for (const id of ["focusNewConversation", "focusHeaderNew"]) document.getElementById(id).onclick = start;
  for (const [id, action] of [["focusNewNote", createNote], ["focusReviews", inspectReviews], ["focusRunning", inspectRunning]]) {
    document.getElementById(id).onclick = () => { showMenu(false); Promise.resolve().then(action).catch(error => toast(error.message)); };
  }
  document.querySelector("#focusProjects").onclick = () => setMobileView("projects");
  document.querySelector("#focusConversations").onclick = () => setMobileView("sessions");
  document.querySelector("#focusClose").onclick = () => showMenu(false);
  chatHost.addEventListener("click", event => { if (event.target.closest("button:not(:disabled)")) showMenu(false); });
  toggle.addEventListener("change", async () => {
    const next = toggle.checked;
    toggle.disabled = true;
    try { await savePreferences({ focusUiEnabled: next }); setFocusUi(next); }
    catch (error) { toggle.checked = enabled; toast(`Could not save interface preference: ${error.message}`); }
    finally { toggle.disabled = state.canvasPaneMode; }
  });
  window.addEventListener("app-view-changed", syncView);
  window.addEventListener("resize", resize);
  visualViewport?.addEventListener("resize", resize);
  installGestures();
}

function installGestures() {
  let drag = null, dragged = false, tap = null, previousTap = null, lastTouch = -Infinity, lastFabTouch = -Infinity;
  const interactive = "button,input,textarea,select,a,summary,dialog,[contenteditable],#focusControls";
  fab.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top};
    dragged = false;
    fab.setPointerCapture(event.pointerId);
  });
  fab.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx,dy) > 7) dragged = true;
    if (dragged) move(drag.left + dx, drag.top + dy);
  });
  fab.addEventListener("pointerup", event => {
    if (drag && event.pointerType !== "mouse") {
      lastFabTouch = performance.now();
      if (!dragged) showMenu();
    }
    drag = null;
  });
  fab.addEventListener("pointercancel", () => { drag = null; dragged = true; });
  fab.onclick = event => {
    // Touch browsers can omit click after a drag, or emit a delayed compatibility click.
    if (event.detail !== 0 && performance.now() - lastFabTouch < 700) return;
    if (dragged) { dragged = false; return; }
    showMenu();
  };
  fab.addEventListener("keydown", event => {
    const delta = {ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];
    if (!delta) return;
    event.preventDefault(); const rect = fab.getBoundingClientRect(); move(rect.left + delta[0], rect.top + delta[1]);
  });
  document.addEventListener("pointerdown", event => {
    if (!enabled || event.pointerType === "mouse") return;
    if (!event.isPrimary || event.target.closest(interactive)) { tap = previousTap = null; return; }
    tap = {id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now()};
  });
  document.addEventListener("pointerup", event => {
    if (!enabled || event.pointerType === "mouse") return;
    lastTouch = performance.now(); const start = tap; tap = null;
    if (!start || start.id !== event.pointerId || event.target.closest(interactive)) return;
    if (Math.hypot(event.clientX-start.x,event.clientY-start.y)>12 || lastTouch-start.time>300) { previousTap=null; return; }
    if (previousTap && lastTouch-previousTap.time<350 && Math.hypot(event.clientX-previousTap.x,event.clientY-previousTap.y)<32) {
      event.preventDefault(); previousTap=null; toggleFab();
    } else previousTap={x:event.clientX,y:event.clientY,time:lastTouch};
  });
  document.addEventListener("pointercancel", () => { tap=previousTap=null; });
  document.addEventListener("dblclick", event => {
    if (!enabled || performance.now()-lastTouch<700 || event.target.closest(interactive)) return;
    toggleFab();
  });
  document.addEventListener("keydown", event => {
    if (!enabled || document.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key === ".") { event.preventDefault(); showMenu(); if (!menu.hidden) menu.querySelector("button")?.focus(); }
    if (event.key === "Escape") showMenu(false);
  });
}
