// The Shortcuts tab in Settings: one place that shows and edits every keyboard
// shortcut. The canvas used to own its own dialog for this; it now sends the user here.

import {
  CANVAS_KEYMAP_COMMANDS, CANVAS_MODIFIERS, canonicalCanvasKey, canvasChordIsUsable, canvasChordLabel,
  DEFAULT_CANVAS_KEYMAP, normalizeCanvasKeymap,
} from "../canvas-layout.js";
import { api, savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { captureCanvasKeyInput } from "./key-capture.js";
import { state } from "./state.js";

const modifierInputs = new Map(CANVAS_MODIFIERS
  .map((name) => [name, document.querySelector(`#canvasKeymapModifier-${name}`)]));
const commandInputs = new Map(CANVAS_KEYMAP_COMMANDS
  .map((command) => [command, document.querySelector(`#canvasKeymapCommand-${command}`)]));
const statusLine = document.querySelector("#canvasKeymapStatus");
const saveButton = document.querySelector("#canvasKeymapSaveButton");
const resetButton = document.querySelector("#canvasKeymapResetButton");
let conversationShortcuts = [];

for (const input of commandInputs.values()) captureCanvasKeyInput(input);

/** The keys the account gave individual conversations, so both kinds are visible together. */
function renderConversationShortcuts(shortcuts) {
  elements.shortcutConversationList.replaceChildren();
  if (!shortcuts.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No conversation has its own key yet.";
    elements.shortcutConversationList.append(empty);
    return;
  }
  for (const shortcut of shortcuts) {
    const row = document.createElement("div");
    row.className = "shortcut-conversation-row";
    row.dataset.testid = "settings-conversation-shortcut-row";
    const key = document.createElement("kbd");
    key.textContent = canvasChordLabel(state.canvasKeymap, shortcut.binding);
    const name = document.createElement("span");
    // The canvas knows the conversation's name while it is on a page; a binding for a
    // conversation that is not shows its id, which is still enough to recognise it.
    name.textContent = shortcut.title || shortcut.sessionId;
    row.append(key, name);
    elements.shortcutConversationList.append(row);
  }
}

export async function fillShortcutSettings() {
  const keymap = normalizeCanvasKeymap(state.canvasKeymap);
  for (const [name, input] of modifierInputs) input.checked = keymap.modifiers.includes(name);
  for (const [command, input] of commandInputs) input.value = keymap[command] || "";
  statusLine.textContent = "";
  try {
    conversationShortcuts = (await api("/api/canvas/shortcuts")).shortcuts || [];
  } catch {
    conversationShortcuts = state.canvasController?.listShortcuts() || [];
  }
  renderConversationShortcuts(conversationShortcuts);
}

/** Reads the panel into one keymap, refusing a chord or a key that cannot work. */
function keymapFromPanel(conversationKeys) {
  const modifiers = CANVAS_MODIFIERS.filter((name) => modifierInputs.get(name).checked);
  if (!canvasChordIsUsable(modifiers)) throw new Error("Pick Command, Control, or Option. Shift on its own would swallow ordinary typing.");
  const draft = { modifiers };
  const taken = new Set();
  for (const [command, input] of commandInputs) {
    const typed = String(input.value || "").trim();
    const key = typed ? canonicalCanvasKey(typed) : null;
    if (typed && !key) throw new Error("Each key is one digit, letter, punctuation key, or Enter.");
    if (key && taken.has(key)) throw new Error("Two commands cannot share one key.");
    if (key && conversationKeys.includes(key)) throw new Error(`${key} already belongs to a conversation on the canvas.`);
    if (key) taken.add(key);
    draft[command] = key;
  }
  return normalizeCanvasKeymap(draft);
}

async function saveShortcutSettings() {
  let next;
  try {
    const held = conversationShortcuts.map((shortcut) => shortcut.binding);
    next = keymapFromPanel(held);
  } catch (error) {
    statusLine.textContent = error.message;
    return;
  }
  try {
    await savePreferences({ canvasKeymap: next });
  } catch (error) {
    statusLine.textContent = error instanceof Error ? error.message : "Could not save these shortcuts";
    return;
  }
  state.canvasKeymap = next;
  state.canvasController?.setKeymap(next);
  statusLine.textContent = "Saved.";
}

saveButton.addEventListener("click", () => { void saveShortcutSettings(); });
resetButton.addEventListener("click", () => {
  for (const [name, input] of modifierInputs) input.checked = DEFAULT_CANVAS_KEYMAP.modifiers.includes(name);
  for (const [command, input] of commandInputs) input.value = DEFAULT_CANVAS_KEYMAP[command] || "";
  statusLine.textContent = "";
});
