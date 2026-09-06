// App entry point. The feature modules under ./app register their DOM listeners
// when they load; this file wires the boot sequence and the canvas pane mode.
import {
  canvasChordMatches, canvasKeyFromCode, canvasSplitPlacement, DEFAULT_CANVAS_KEYMAP,
  isCanvasModifierKey, isCanvasSplitLeader,
} from "./canvas-layout.js";
import { createConversationCanvas } from "./canvas.js";
import { api, savePreferences } from "./app/api.js";
import { initializeApplication, revealApplication } from "./app/auth.js";
import { elements } from "./app/elements.js";
import { setMobileView, toggleCanvasView } from "./app/layout.js";
import { SERVICE_WORKER_UPDATE_MS, setTheme, syncNotifyButton, toast, updateInstallButton, updateServiceWorker } from "./app/shell.js";
import { state } from "./app/state.js";
import "./app/state.js";
import "./app/elements.js";
import "./app/project-files.js";
import "./app/api.js";
import "./app/auth.js";
import "./app/settings.js";
import "./app/shell.js";
import "./app/layout.js";
import "./app/attachments.js";
import "./app/project-forms.js";
import "./app/cluster-panel.js";
import "./app/workspaces.js";
import "./app/session-identity.js";
import "./app/session-rows.js";
import "./app/icons.js";
import "./app/row-menu.js";
import "./app/project-list.js";
import "./app/reviews.js";
import "./app/recents.js";
import "./app/session-list.js";
import "./app/chat-transcript.js";
import "./app/composer-dialogs.js";
import "./app/chat-controls.js";
import "./app/project-selection.js";
import "./app/socket.js";
import "./app/tasks.js";
import "./app/terminal.js";
import "./app/new-session.js";
import "./app/ownership.js";
import "./app/composer.js";
import "./app/secrets.js";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await registration.update();
      setInterval(() => updateServiceWorker(registration), SERVICE_WORKER_UPDATE_MS);
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  });
}

if (state.canvasPaneMode) {
  document.body.classList.add("canvas-pane-mode");
  // A pane has no canvas of its own, so this action belongs to the top-level app only.
  elements.addToCanvasButton.hidden = true;
  // A pane is an iframe, so a canvas shortcut typed in here never reaches the canvas
  // document. The canvas owns the chord and the binding table and tells this pane
  // which keys it claims; every other combination still belongs to the conversation.
  const canvasBindings = new Set();
  let canvasModifiers = DEFAULT_CANVAS_KEYMAP.modifiers;
  let splitLeaderArmed = false;
  window.addEventListener("keydown", (event) => {
    if (isCanvasSplitLeader(event)) {
      splitLeaderArmed = true;
      event.preventDefault();
      return;
    }
    if (splitLeaderArmed) {
      if (isCanvasModifierKey(event)) return;
      splitLeaderArmed = false;
      const placement = canvasSplitPlacement(event);
      if (placement) {
        event.preventDefault();
        parent.postMessage({ type: "canvasSplitShortcut", placement }, location.origin);
        return;
      }
    }
    if (!canvasChordMatches({ modifiers: canvasModifiers }, event)) return;
    const binding = canvasKeyFromCode(event.code);
    if (!binding || !canvasBindings.has(binding)) return;
    event.preventDefault();
    parent.postMessage({
      type: "canvasShortcut", code: event.code,
      metaKey: event.metaKey, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
    }, location.origin);
  });
  window.addEventListener("message", (event) => {
    // Only the canvas that framed this pane may set its bindings or move its cursor.
    if (event.origin !== location.origin || event.source !== parent) return;
    if (event.data?.type === "canvasShortcutBindings") {
      canvasBindings.clear();
      for (const binding of event.data.bindings || []) canvasBindings.add(binding);
      if (event.data.modifiers?.length) canvasModifiers = event.data.modifiers;
    }
    if (event.data?.type === "canvasFocusComposer") document.querySelector("#messageInput")?.focus();
  });
  // The canvas needs to know which pane the user last touched, so "jump back" and
  // "bring forward" act on the conversation they are actually working in.
  const reportActive = () => parent.postMessage({ type: "canvasPaneActive" }, location.origin);
  window.addEventListener("focus", reportActive);
  window.addEventListener("pointerdown", reportActive, true);
  parent.postMessage({ type: "canvasPaneReady" }, location.origin);
}
if (!state.canvasPaneMode) {
  state.canvasController = createConversationCanvas({
    api,
    getProjects: () => state.projects,
    saveLayout: (next) => {
      state.canvasLayout = next;
      // Serialize saves: rapid resizes must persist in order, newest last.
      state.canvasLayoutSave = (state.canvasLayoutSave ?? Promise.resolve())
        .catch(() => {})
        .then(() => savePreferences({ canvasLayout: next }))
        .catch((error) => toast(`Could not save the canvas layout: ${error.message}`, 8000));
    },
    saveKeymap: (next) => savePreferences({ canvasKeymap: next }),
    toggleView: toggleCanvasView,
    showMessage: (message) => toast(message, 8000),
  });
}
const desktopViewportQuery = matchMedia("(min-width: 1024px)");
desktopViewportQuery.addEventListener("change", (event) => {
  if (!event.matches && document.body.classList.contains("view-canvas")) {
    setMobileView(state.activeProjectId ? "sessions" : "projects");
  }
});

setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
syncNotifyButton();
updateInstallButton();
initializeApplication()
  .catch((error) => toast(error.message))
  .finally(revealApplication);
