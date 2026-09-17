// Buttons reveal their keyboard shortcut while the command modifiers are held. A button
// declares its command with data-shortcut-hint; this module fills the badge from the saved
// keymap and overlays it on the control, so a resting button is just its icon and keeps its
// square. The badge names the key alone - every command rides the same modifiers, so
// repeating them on 45 buttons only costs space - and the whole chord stays available as
// the badge's tooltip and in the shortcuts panel.
import { CANVAS_COMMAND_MODIFIERS, chordKeyLabel, chordLabel, normalizeCanvasKeymap } from "../canvas-layout.js";
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

/** Holding Control+Option paints every shortcut-bearing control with its key. */
const modifiersHeld = (event) => CANVAS_COMMAND_MODIFIERS.every((name) => event[`${name}Key`]);
const revealShortcuts = (on) => document.body.classList.toggle("shortcuts-revealed", on);
window.addEventListener("keydown", (event) => revealShortcuts(modifiersHeld(event)));
window.addEventListener("keyup", (event) => revealShortcuts(modifiersHeld(event)));
// A chord that switches windows never delivers its keyup, so the badges would stay lit.
window.addEventListener("blur", () => revealShortcuts(false));
window.addEventListener("shortcut-targets-changed", syncShortcutHints);

syncShortcutHints();
