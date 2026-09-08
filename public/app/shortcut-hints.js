// Header icons wear their keyboard shortcut as a tiny key badge, so the chord in
// force is visible where the action lives. A button declares its command with
// data-shortcut-hint; this module fills the badge from the saved keymap.
import { chordLabel, normalizeCanvasKeymap } from "../canvas-layout.js";
import { state } from "./state.js";

export function syncShortcutHints() {
  const keymap = normalizeCanvasKeymap(state.canvasKeymap);
  for (const host of document.querySelectorAll("[data-shortcut-hint]")) {
    const chord = keymap.commands[host.dataset.shortcutHint];
    let badge = host.querySelector(".shortcut-hint");
    if (!chord) { badge?.remove(); continue; }
    if (!badge) {
      badge = document.createElement("kbd");
      badge.className = "shortcut-hint";
      badge.setAttribute("aria-hidden", "true");
      host.append(badge);
    }
    badge.textContent = chordLabel(chord);
  }
}

syncShortcutHints();
