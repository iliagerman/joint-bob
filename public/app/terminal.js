import { savePreferencesInBackground } from "./api.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";
import { handoffTaskToPeer } from "./tasks.js";

export function activeChatSession() {
  return state.sessions.find((session) => state.activeSessionId ? session.id === state.activeSessionId : session.path === state.activeSessionPath);
}

// A real xterm terminal bound to the selected node's PTY. The emulator is created once and reused;
// every open starts a fresh shell in the selected project folder on the selected node.
function terminalCssColor(name, fallback) {
  return getComputedStyle(elements.terminalHost).getPropertyValue(name).trim() || fallback;
}

// Nerd Font families come first so a powerline prompt draws its glyphs instead of
// tofu boxes; the browser falls through to the plain mono stack when none exist.
const TERMINAL_FONT = '"MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Hack Nerd Font", "SauceCodePro Nerd Font", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const TERMINAL_MIN_SIZE = 180;

function terminalSizeBounds(orientation = state.terminalOrientation) {
  const viewport = orientation === "horizontal" ? window.innerHeight : window.innerWidth;
  return { min: TERMINAL_MIN_SIZE, max: Math.max(TERMINAL_MIN_SIZE, Math.floor(viewport * 0.82)) };
}

function saveTerminalDockPreference() {
  savePreferencesInBackground({ terminalDock: {
    orientation: state.terminalOrientation,
    horizontalSize: state.terminalDockSizes.horizontal,
    verticalSize: state.terminalDockSizes.vertical,
  } });
}

function setTerminalDockSize(size, persist = true) {
  const { min, max } = terminalSizeBounds();
  const next = Math.max(min, Math.min(max, Math.round(Number(size) || min)));
  state.terminalDockSizes[state.terminalOrientation] = next;
  document.body.style.setProperty("--terminal-dock-size", `${next}px`);
  elements.terminalResizeHandle.setAttribute("aria-valuemin", String(min));
  elements.terminalResizeHandle.setAttribute("aria-valuemax", String(max));
  elements.terminalResizeHandle.setAttribute("aria-valuenow", String(next));
  if (persist) saveTerminalDockPreference();
  if (!elements.terminalPanel.hidden) requestAnimationFrame(fitTerminalOnceVisible);
}

function setTerminalOrientation(orientation, persist = true) {
  if (orientation !== "horizontal" && orientation !== "vertical") return;
  state.terminalOrientation = orientation;
  document.body.dataset.terminalOrientation = orientation;
  elements.terminalPanel.dataset.orientation = orientation;
  elements.terminalHorizontalButton.setAttribute("aria-pressed", String(orientation === "horizontal"));
  elements.terminalVerticalButton.setAttribute("aria-pressed", String(orientation === "vertical"));
  elements.terminalResizeHandle.setAttribute("aria-orientation", orientation);
  setTerminalDockSize(state.terminalDockSizes[orientation], false);
  if (persist) saveTerminalDockPreference();
  if (!elements.terminalPanel.hidden) requestAnimationFrame(fitTerminalOnceVisible);
}

export function applyTerminalDockPreference(preference) {
  if (!preference || typeof preference !== "object") return;
  for (const orientation of ["horizontal", "vertical"]) {
    const size = preference[orientation === "horizontal" ? "horizontalSize" : "verticalSize"];
    if (Number.isFinite(size) && size >= TERMINAL_MIN_SIZE && size <= 2500) state.terminalDockSizes[orientation] = Math.round(size);
  }
  setTerminalOrientation(preference.orientation, false);
}

setTerminalOrientation(state.terminalOrientation, false);

function loadTerminalScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`Could not load ${src}`)), { once: true });
    document.head.append(script);
  });
}

async function ensureTerminalDependencies() {
  if (typeof window.Terminal !== "function") await loadTerminalScript("/vendor/xterm/xterm.js");
  if (typeof window.FitAddon?.FitAddon !== "function") await loadTerminalScript("/vendor/xterm/addon-fit.js");
}

function ensureTerminalEmulator() {
  if (state.terminalEmulator) return state.terminalEmulator;
  const emulator = new window.Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: TERMINAL_FONT,
    fontSize: 13,
    // Rows sit flush against each other at the default 1.0 and clip descenders.
    lineHeight: 1.25,
    scrollback: 5000,
    theme: {
      background: terminalCssColor("--code-bg", "#08090b"),
      foreground: terminalCssColor("--code-text", "#ebeced"),
      cursor: terminalCssColor("--accent", "#37cfab"),
      cursorAccent: terminalCssColor("--code-bg", "#08090b"),
      selectionBackground: "#37cfab55",
    },
  });
  // The addon's UMD bundle assigns its whole module namespace to window.FitAddon,
  // so the constructor itself lives one level down at window.FitAddon.FitAddon.
  const fit = new window.FitAddon.FitAddon();
  emulator.loadAddon(fit);
  emulator.open(elements.terminalHost);
  state.terminalFit = fit;
  emulator.onData((data) => {
    if (state.terminalSocket?.readyState === WebSocket.OPEN) {
      state.terminalSocket.send(JSON.stringify({ type: "terminalInput", data }));
    }
  });
  state.terminalObserver = new ResizeObserver(() => fitTerminalOnceVisible());
  state.terminalObserver.observe(elements.terminalHost);
  state.terminalEmulator = emulator;
  return emulator;
}

// The heading pill is a traffic light plus a line of text: red idle, amber while
// the socket opens, green once the shell answers.
function setTerminalStatus(connection, text) {
  elements.terminalStatus.dataset.state = connection;
  elements.terminalStatusText.textContent = text;
  elements.terminalStatusText.title = text;
}

function fitTerminalOnceVisible() {
  // The dialog was hidden when the emulator attached, so measure now that it is in the top layer.
  const emulator = state.terminalEmulator;
  if (!emulator || elements.terminalPanel.hidden) return;
  state.terminalFit.fit();
  if (state.terminalSocket?.readyState === WebSocket.OPEN) {
    state.terminalSocket.send(JSON.stringify({ type: "terminalResize", cols: emulator.cols, rows: emulator.rows }));
  }
}

function closeTerminalSocket() {
  const socket = state.terminalSocket;
  state.terminalSocket = null;
  if (socket) socket.close();
  state.terminalEmulator?.blur();
}

function terminalWebsocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${location.host}/ws`);
  url.searchParams.set("mode", "terminal");
  url.searchParams.set("projectId", state.activeProjectId);
  url.searchParams.set("nodeId", state.activeNodeId);
  // A board ticket keeps its own copy of the project, so its terminal opens there.
  if (state.activeTaskId) url.searchParams.set("taskId", state.activeTaskId);
  return url;
}

async function openProjectTerminal() {
  if (!state.activeProjectId || !state.activeNodeId) throw new Error("Select a project and execution node first");
  await ensureTerminalDependencies();
  const node = state.sessionNodes.find((candidate) => candidate.id === state.activeNodeId);
  closeTerminalSocket();
  setTerminalStatus("connecting", `Connecting to ${node?.name || "node"}...`);
  elements.terminalPanel.hidden = false;
  document.body.classList.add("terminal-open");
  const emulator = ensureTerminalEmulator();
  emulator.reset();
  requestAnimationFrame(() => { fitTerminalOnceVisible(); emulator.focus(); });

  const socket = new WebSocket(terminalWebsocketUrl());
  state.terminalSocket = socket;
  socket.addEventListener("message", (event) => {
    if (state.terminalSocket !== socket) return;
    const payload = JSON.parse(event.data);
    if (payload.type === "terminalReady") {
      setTerminalStatus("live", `${node?.name || "Node"} \u00b7 ${payload.cwd}`);
      emulator.focus();
    }
    if (payload.type === "terminalOutput") emulator.write(payload.data || "", () => emulator.scrollToBottom());
    if (payload.type === "terminalError") emulator.write(`\r\nError: ${payload.error}\r\n`);
    if (payload.type === "terminalExit") emulator.write(`\r\n[Shell exited${payload.code === null ? "" : ` with code ${payload.code}`}]\r\n`);
  });
  socket.addEventListener("close", (event) => {
    if (state.terminalSocket !== socket) return;
    state.terminalSocket = null;
    setTerminalStatus("idle", event.code === 4031 && event.reason ? event.reason : "Disconnected");
  });
  socket.addEventListener("error", () => {
    if (state.terminalSocket === socket) emulator.write("\r\nCould not connect to terminal.\r\n");
  });
}
function closeTerminalPanel() {
  if (elements.terminalPanel.hidden) return;
  elements.terminalPanel.hidden = true;
  document.body.classList.remove("terminal-open");
  closeTerminalSocket();
}

function beginTerminalResize(event) {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  event.preventDefault();
  state.terminalResize = {
    pointerId: event.pointerId,
    orientation: state.terminalOrientation,
    startX: event.clientX,
    startY: event.clientY,
    startSize: state.terminalDockSizes[state.terminalOrientation],
  };
  elements.terminalResizeHandle.setPointerCapture(event.pointerId);
}

function moveTerminalResize(event) {
  const resize = state.terminalResize;
  if (!resize || resize.pointerId !== event.pointerId) return;
  const delta = resize.orientation === "horizontal" ? resize.startY - event.clientY : resize.startX - event.clientX;
  setTerminalDockSize(resize.startSize + delta, false);
}

function endTerminalResize(event) {
  if (state.terminalResize?.pointerId !== event.pointerId) return;
  state.terminalResize = null;
  saveTerminalDockPreference();
}

function resizeTerminalByKeyboard(event) {
  const step = event.shiftKey ? 64 : 24;
  const increaseKey = state.terminalOrientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
  const decreaseKey = state.terminalOrientation === "horizontal" ? "ArrowDown" : "ArrowRight";
  if (event.key === increaseKey) setTerminalDockSize(state.terminalDockSizes[state.terminalOrientation] + step);
  else if (event.key === decreaseKey) setTerminalDockSize(state.terminalDockSizes[state.terminalOrientation] - step);
  else return;
  event.preventDefault();
}

export async function continueTaskOnNode(task, destination) {
  if (!task) throw new Error("Active ticket was not found");
  if (!task.sessionPath) throw new Error("Send a message first, then continue this ticket on another node");
  if (task.executionState !== "idle") throw new Error("Wait for the ticket agent to finish before continuing on another node");
  if (!destination) throw new Error("Destination node was not found");
  const body = await handoffTaskToPeer(task, destination);
  if (!body) return false;
  if (body.handoffPendingCommit) throw new Error(body.message);
  if (!body.task?.sessionPath) throw new Error("Ticket conversation is not available on the destination node");
  state.activeNodeId = destination.id;
  state.activeSessionId = null;
  if (state.preferencesLoaded) savePreferencesInBackground({ activeNodeId: destination.id, activeSessionId: null });
  openSession(body.task.sessionPath, task.title, false, true);
  return true;
}
elements.openTerminalButton.addEventListener("click", async () => {
  try { await openProjectTerminal(); }
  catch (error) { toast(error.message, 8000); }
});
elements.clearTerminalButton.addEventListener("click", () => { state.terminalEmulator?.clear(); });
elements.closeTerminalButton.addEventListener("click", closeTerminalPanel);
elements.terminalHorizontalButton.addEventListener("click", () => setTerminalOrientation("horizontal"));
elements.terminalVerticalButton.addEventListener("click", () => setTerminalOrientation("vertical"));
elements.terminalResizeHandle.addEventListener("pointerdown", beginTerminalResize);
elements.terminalResizeHandle.addEventListener("pointermove", moveTerminalResize);
elements.terminalResizeHandle.addEventListener("pointerup", endTerminalResize);
elements.terminalResizeHandle.addEventListener("pointercancel", endTerminalResize);
elements.terminalResizeHandle.addEventListener("keydown", resizeTerminalByKeyboard);
window.addEventListener("resize", () => setTerminalDockSize(state.terminalDockSizes[state.terminalOrientation], false));
/**
 * Escape closes the terminal - except while a full-screen program is running in it.
 * vim, less and htop draw on the alternate screen buffer and Escape is one of their
 * real keys, so there it belongs to the shell and the dialog stays put.
 */
elements.terminalPanel.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.terminalEmulator?.buffer.active.type === "alternate") {
    event.preventDefault();
    event.stopPropagation();
    if (state.terminalSocket?.readyState === WebSocket.OPEN) {
      state.terminalSocket.send(JSON.stringify({ type: "terminalInput", data: "\u001b" }));
    }
    return;
  }
  event.preventDefault();
  closeTerminalPanel();
}, true);
