// The conversation switcher: hold the chord, tap Tab (Space elsewhere) to step through the
// last conversations opened, and let go to open the one selected. Keys are read in the
// top-level app. A chat pane is its own document and forwards its switcher keys up here,
// including the release that ends the hold, because only this window sees that release.

import { isSwitcherKey, isSwitcherNavigationCode, switcherChord, switcherHeld, switcherStep } from "../canvas-layout.js";
import { lastOpenedConversations, openRecentSession } from "./recents.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

const ROW_LIMIT = 10;
/** Null while closed; otherwise the conversations to choose from and the row selected. */
let session = null;
let overlay = null;

function close() {
  session = null;
  render();
}

/** Closes the switcher and opens the row picked. Row 1 is the conversation already open,
 *  so picking it only closes. */
function commit(index) {
  const entry = session?.entries[index];
  close();
  if (!entry || index === 0) return;
  openRecentSession(entry).catch((error) => toast(error.message));
}

function step(delta) {
  session.index = (session.index + delta + session.entries.length) % session.entries.length;
  render();
}

/** Handles a key going down, from this window or a pane. Returns true when the switcher took it. */
export function pressSwitcherKey(event) {
  if (!session) {
    if (!isSwitcherKey(event) || document.querySelector("dialog[open]")) return false;
    const entries = lastOpenedConversations(ROW_LIMIT);
    // One conversation has nothing to switch to, so the press is swallowed and nothing opens.
    if (entries.length > 1) {
      session = { entries, index: 1 };
      render();
    }
    return true;
  }
  if (isSwitcherKey(event)) {
    step(switcherStep(event));
    return true;
  }
  if (!isSwitcherNavigationCode(event.code)) return false;
  if (event.code === "Escape") {
    close();
    return true;
  }
  const digit = /^Digit([0-9])$/.exec(event.code);
  if (digit) {
    const row = digit[1] === "0" ? 10 : Number(digit[1]);
    if (row <= session.entries.length) commit(row - 1);
    return true;
  }
  step(event.code === "ArrowUp" || event.code === "ArrowLeft" ? -1 : 1);
  return true;
}

/** Handles a key coming up. Letting go of any chord key opens the row selected. */
export function releaseSwitcherKey(event) {
  if (!session || switcherHeld(event)) return false;
  commit(session.index);
  return true;
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "conversation-switcher";
  overlay.hidden = true;
  // Acts on pointerdown rather than click: on a Mac, Control+click is a context-menu gesture
  // that can suppress the click, and the chord itself holds Control.
  overlay.addEventListener("contextmenu", (event) => event.preventDefault());
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
    const row = event.target.closest("[data-index]");
    if (row && session) commit(Number(row.dataset.index));
  });
  // The mouse highlights the row it is over, so a pointer and the keys show the same selection.
  overlay.addEventListener("pointermove", (event) => {
    const row = event.target.closest("[data-index]");
    if (!row || !session || session.index === Number(row.dataset.index)) return;
    session.index = Number(row.dataset.index);
    render();
  });
  document.body.append(overlay);
  return overlay;
}

function render() {
  const host = ensureOverlay();
  host.hidden = !session;
  if (!session) {
    host.replaceChildren();
    return;
  }
  const projectNames = new Map(state.projects.map((project) => [project.id, project.name]));
  const rows = session.entries.map((entry, index) => {
    const row = document.createElement("div");
    row.className = `conversation-switcher-row${index === session.index ? " selected" : ""}`;
    row.dataset.index = String(index);
    const key = document.createElement("kbd");
    key.textContent = String(index === 9 ? 0 : index + 1);
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const project = document.createElement("span");
    const open = entry.sessionId && entry.sessionId === state.activeSessionId ? " · open" : "";
    project.textContent = `${projectNames.get(entry.projectId) || "Unknown project"}${open}`;
    row.append(key, title, project);
    return row;
  });
  const chord = switcherChord();
  const hint = document.createElement("p");
  hint.className = "conversation-switcher-hint";
  hint.textContent = `Hold ${chord.hold} · ${chord.cycle} next · ${chord.back} back · 1–0 jump · release to open · Esc cancel`;
  const panel = document.createElement("div");
  panel.className = "conversation-switcher-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Recent conversations");
  panel.append(...rows, hint);
  host.replaceChildren(panel);
}

/** Top-level app only. Registered before the canvas, so a handled key never reaches the
 *  canvas's own shortcuts (Ctrl+Alt+1 is also "page 1" while the switcher is open). */
export function installConversationSwitcher() {
  window.addEventListener("keydown", (event) => {
    if (pressSwitcherKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  });
  window.addEventListener("keyup", (event) => { releaseSwitcherKey(event); });
  window.addEventListener("blur", () => { if (session) close(); });
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "conversationSwitcherKey") return;
    // Only a chat pane this page framed may drive the switcher.
    if (![...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === event.source)) return;
    const { kind, key } = event.data;
    if (kind === "up") releaseSwitcherKey(key);
    else pressSwitcherKey(key);
  });
}
