// The Shortcuts tab in Settings: one place that shows and edits every keyboard
// shortcut. Each row records one modified key or a modified key followed by a
// second stroke, with at most four physical keys total.

import {
  chordId, chordLabel, conversationChord, DEFAULT_CANVAS_KEYMAP, fuzzyMatchScore,
  normalizeCanvasKeymap, normalizeChord, shortcutsConflict,
} from "../canvas-layout.js";
import { api, savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { captureChordInput } from "./key-capture.js";
import { syncShortcutHints } from "./shortcut-hints.js";
import { state } from "./state.js";

const baseInput = document.querySelector("#canvasKeymapBase");
const commandsHost = document.querySelector("#canvasKeymapCommands");
const statusLine = document.querySelector("#canvasKeymapStatus");
const saveButton = document.querySelector("#canvasKeymapSaveButton");
const resetButton = document.querySelector("#canvasKeymapResetButton");
let conversationShortcuts = [];

/** One row per configurable command, in the order the panel lists them. Labels stay
 * here, next to their recorder wiring, so adding a command is adding one line. */
const COMMAND_ROWS = [
  { command: "spotlight", label: "Open the search bar over every project and conversation" },
  { command: "pendingReviews", label: "Open the pending reviews list" },
  { command: "recents", label: "Open the recent conversations list" },
  { command: "runningConversations", label: "Open the running conversations list" },
  { command: "settings", label: "Open the settings dialog" },
  { command: "focusInput", label: "Put the cursor in the field you can type in" },
  { command: "toggleProjects", label: "Collapse or expand the projects panel" },
  { command: "toggleChats", label: "Collapse or expand the conversations panel" },
  { command: "board", label: "Open the project board" },
  { command: "newProject", label: "Add a project" },
  { command: "newPiChat", label: "Start a Pi conversation" },
  { command: "newClaudeChat", label: "Start a Claude conversation" },
  { command: "runsOn", label: "Chat: focus the Runs on selector" },
  { command: "selectAgent", label: "Chat: focus the agent selector" },
  { command: "selectModel", label: "Chat: choose a model" },
  { command: "selectThinking", label: "Chat: focus the thinking or effort selector" },
  { command: "terminal", label: "Chat: open the terminal" },
  { command: "notify", label: "Chat: toggle notifications" },
  { command: "addToCanvas", label: "Chat: add this conversation to the canvas" },
  { command: "rename", label: "Chat: rename this conversation" },
  { command: "toggleView", label: "Switch between the canvas and the conversation you left" },
  { command: "recentPane", label: "Canvas: jump to the conversation you were in before" },
  { command: "focusPane", label: "Canvas: bring the current conversation forward, or put it back" },
  { command: "paneSearch", label: "Canvas: search the conversations already on the canvas" },
  { command: "splitRight", label: "Canvas: split the screen and put a new conversation to the right" },
  { command: "splitBelow", label: "Canvas: split the screen and put a new conversation below" },
  { command: "closePane", label: "Canvas: close this conversation, after a Y/N confirmation" },
  { command: "createPage", label: "Canvas: new page" },
  { command: "nextPage", label: "Canvas: next page" },
  { command: "prevPage", label: "Canvas: previous page" },
  { command: "focusLeft", label: "Canvas: go to the conversation to the left" },
  { command: "focusRight", label: "Canvas: go to the conversation to the right" },
  { command: "focusUp", label: "Canvas: go to the conversation above" },
  { command: "focusDown", label: "Canvas: go to the conversation below" },
  ...[..."123456789"].map((digit, index) => ({ command: `page${index + 1}`, label: `Canvas: jump to page ${digit}` })),
];
const rowTestid = (command) => `canvas-keymap-${command.replace(/[A-Z0-9]/g, (character) => `-${character.toLowerCase()}`)}-input`;

const commandInputs = new Map();
const commandRowEntries = [];
captureChordInput(baseInput, { modifierOnly: true });
for (const { command, label } of COMMAND_ROWS) {
  const row = document.createElement("label");
  row.className = "canvas-keymap-command";
  row.htmlFor = `canvasKeymapCommand-${command}`;
  const description = document.createElement("span");
  description.textContent = label;
  const input = document.createElement("input");
  input.id = `canvasKeymapCommand-${command}`;
  input.type = "text";
  input.readOnly = true;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "unbound";
  input.dataset.testid = rowTestid(command);
  captureChordInput(input);
  row.append(description, input);
  commandsHost.append(row);
  commandInputs.set(command, input);
  commandRowEntries.push({ row, command, label });
}

/** Fuzzy-finds rows: an empty query shows everything, otherwise a row stays only when
    the query's characters appear in order in its label. Rows are hidden, not removed, so
    recording a chord into a found field keeps working without an un-filter step. */
function filterShortcutRows(rawQuery) {
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
  const matches = (text) => terms.every((term) => fuzzyMatchScore(text, term) !== null);
  for (const { row, command, label } of commandRowEntries) row.hidden = !matches(`${label} ${command}`);
  for (const row of elements.shortcutConversationList.querySelectorAll("[data-testid='settings-conversation-shortcut-row']")) row.hidden = !matches(row.textContent);
}
elements.canvasKeymapSearch.addEventListener("input", () => filterShortcutRows(elements.canvasKeymapSearch.value));

function fillFields(keymap) {
  baseInput.dataset.chord = JSON.stringify(keymap.base);
  baseInput.value = chordLabel(keymap.base);
  for (const [command, input] of commandInputs) {
    const chord = keymap.commands[command];
    input.dataset.chord = chord ? JSON.stringify(chord) : "";
    input.value = chord ? chordLabel(chord) : "";
  }
}

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
    key.textContent = chordLabel(conversationChord(state.canvasKeymap, shortcut.binding));
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
  fillFields(keymap);
  statusLine.textContent = "";
  elements.canvasKeymapSearch.value = "";
  filterShortcutRows("");
  try {
    conversationShortcuts = (await api("/api/canvas/shortcuts")).shortcuts || [];
  } catch {
    conversationShortcuts = state.canvasController?.listShortcuts() || [];
  }
  renderConversationShortcuts(conversationShortcuts);
}

/** Reads the panel into one keymap, refusing a chord that cannot work. */
function keymapFromPanel() {
  const base = normalizeChord(baseInput.dataset.chord ? JSON.parse(baseInput.dataset.chord) : null, { modifierOnly: true });
  if (!base) throw new Error("The conversation-key chord needs Command, Control, or Option, and at most three modifiers.");
  const draft = { version: 3, base, commands: {} };
  const taken = [];
  for (const [command, input] of commandInputs) {
    const raw = input.dataset.chord ? JSON.parse(input.dataset.chord) : null;
    const chord = raw ? normalizeChord(raw) : null;
    if (raw && !chord) throw new Error("Each shortcut needs Command, Control, or Option, one or two strokes, and at most four keys.");
    if (!chord) { draft.commands[command] = null; continue; }
    const clash = taken.find((entry) => shortcutsConflict(entry.chord, chord));
    if (clash) throw new Error(`Two commands cannot share or shadow one shortcut: ${chordLabel(chord)} conflicts with ${clash.command}.`);
    const holder = conversationShortcuts.find((shortcut) => chordId(conversationChord({ base }, shortcut.binding)) === chordId(chord));
    if (holder) throw new Error(`${chordLabel(chord)} already belongs to a conversation on the canvas.`);
    taken.push({ command, chord });
    draft.commands[command] = chord;
  }
  return normalizeCanvasKeymap(draft);
}

async function saveShortcutSettings() {
  let next;
  try {
    next = keymapFromPanel();
  } catch (error) {
    statusLine.textContent = error instanceof Error ? error.message : "Could not read these shortcuts";
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
  syncShortcutHints();
  statusLine.textContent = "Saved.";
}

saveButton.addEventListener("click", () => { void saveShortcutSettings(); });
resetButton.addEventListener("click", () => {
  fillFields(DEFAULT_CANVAS_KEYMAP);
  statusLine.textContent = "";
});
