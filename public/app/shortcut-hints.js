// Buttons show the active keyboard shortcut beside their label or below their
// icon. A button declares its command with data-shortcut-hint; this module fills the
// badge from the saved keymap. The badge names the key alone - every command rides the
// same modifiers, so repeating them on 45 buttons only costs space - and the whole
// chord stays available as the badge's tooltip and in the shortcuts panel.
import { chordKeyLabel, chordLabel, normalizeCanvasKeymap } from "../canvas-layout.js";
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
    badge.textContent = chordKeyLabel(chord);
    badge.title = chordLabel(chord);
  }
}

syncShortcutHints();
