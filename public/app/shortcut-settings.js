// The Shortcuts tab in Settings: one place that shows and edits every keyboard
// shortcut. Each row records one modified key or a modified key followed by a
// second stroke, with at most four physical keys total.

import {
  chordLabel, DEFAULT_KEYMAP, fuzzyMatchScore,
  normalizeKeymap, normalizeChord, shortcutsConflict,
} from "../keymap.js";
import { savePreferences } from "./api.js";
import { elements } from "./elements.js";
import { captureChordInput } from "./key-capture.js";
import { setShortcutKeymap } from "./shortcuts.js";
import { syncShortcutHints } from "./shortcut-hints.js";
import { state } from "./state.js";

const commandsHost = document.querySelector("#keymapCommands");
const statusLine = document.querySelector("#keymapStatus");
const saveButton = document.querySelector("#keymapSaveButton");
const resetButton = document.querySelector("#keymapResetButton");

/** One row per configurable command, in the order the panel lists them. Labels stay
 * here, next to their recorder wiring, so adding a command is adding one line. */
const COMMAND_ROWS = [
  { command: "spotlight", label: "Open the search bar over every project and conversation" },
  { command: "pendingReviews", label: "Open the pending reviews list" },
  { command: "recents", label: "Open the recent conversations list" },
  { command: "runningConversations", label: "Open the running conversations list" },
  { command: "settings", label: "Open the settings dialog" },
  { command: "focusInput", label: "Put the cursor in the field you can type in" },
  { command: "savedCommands", label: "Saved / custom commands: open the chat picker. Add prompts in Settings → Commands; search, choose with ↑/↓, then Enter to paste without sending." },
  { command: "toggleProjects", label: "Collapse or expand the projects panel" },
  { command: "toggleChats", label: "Collapse or expand the conversations panel" },
  { command: "newProject", label: "Add a project" },
  { command: "newPiChat", label: "Start a Pi conversation" },
  { command: "newClaudeChat", label: "Start a Claude conversation" },
  { command: "newKiroChat", label: "Start a Kiro conversation" },
  { command: "quickNote", label: "Create a quick note for the active project" },
  { command: "toggleNotes", label: "Show or collapse notes for the active project" },
  { command: "runsOn", label: "Chat: focus the Runs on selector" },
  { command: "selectAgent", label: "Chat: focus the agent selector" },
  { command: "selectModel", label: "Chat: choose a model" },
  { command: "selectThinking", label: "Chat: focus the thinking or effort selector" },
  { command: "terminal", label: "Chat: open the terminal" },
  { command: "browser", label: "Chat: open the browser" },
  { command: "notify", label: "Chat: toggle notifications" },
  { command: "rename", label: "Chat: rename this conversation" },
  { command: "scheduledTasks", label: "Chat: open scheduled tasks" },
  { command: "backgroundTasks", label: "Chat: open background tasks" },
  { command: "chatFiles", label: "Chat: open the project files" },
  { command: "sessionActions", label: "Chat: open the conversation actions" },
  { command: "markDone", label: "Chat: mark this conversation done" },
  { command: "autoRespond", label: "Chat: set up auto respond" },
  { command: "git", label: "Chat: open git" },
  { command: "explainConversation", label: "Chat: explain what this conversation did" },
  { command: "activity", label: "Chat: show or collapse the activity panel (steps and summary)" },
  { command: "toggleView", label: "Open or leave the control center" },
  { command: "costs", label: "Open costs and subscriptions" },
];
const rowTestid = (command) => `keymap-${command.replace(/[A-Z0-9]/g, (character) => `-${character.toLowerCase()}`)}-input`;

const commandInputs = new Map();
const commandRowEntries = [];
for (const { command, label } of COMMAND_ROWS) {
  const row = document.createElement("label");
  row.className = "keymap-command";
  row.htmlFor = `keymapCommand-${command}`;
  const description = document.createElement("span");
  description.textContent = label;
  const input = document.createElement("input");
  input.id = `keymapCommand-${command}`;
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
}
elements.keymapSearch.addEventListener("input", () => filterShortcutRows(elements.keymapSearch.value));

function fillFields(keymap) {
  for (const [command, input] of commandInputs) {
    const chord = keymap.commands[command];
    input.dataset.chord = chord ? JSON.stringify(chord) : "";
    input.value = chord ? chordLabel(chord) : "";
  }
}

function syncSavedCommandsHelp(keymap) {
  const chord = keymap.commands.savedCommands;
  document.querySelector("#savedCommandsShortcutHelp").textContent = chord
    ? `press ${chordLabel(chord)} to open the saved commands menu`
    : "assign a keyboard shortcut in Settings → Shortcuts";
}

export async function fillShortcutSettings() {
  const keymap = normalizeKeymap(state.keymap);
  fillFields(keymap);
  syncSavedCommandsHelp(keymap);
  statusLine.textContent = "";
  elements.keymapSearch.value = "";
  filterShortcutRows("");
}

/** Reads the panel into one keymap, refusing a chord that cannot work. */
function keymapFromPanel() {
  // The panel always writes the current scheme, so the draft carries its version -
  // an older one would be treated as stale and rebuilt back to the defaults.
  const draft = { version: DEFAULT_KEYMAP.version, base: state.keymap.base, commands: {} };
  const taken = [];
  for (const [command, input] of commandInputs) {
    const raw = input.dataset.chord ? JSON.parse(input.dataset.chord) : null;
    const chord = raw ? normalizeChord(raw) : null;
    if (raw && !chord) throw new Error("Each shortcut needs Command, Control, or Option, one or two strokes, and at most four keys.");
    if (!chord) { draft.commands[command] = null; continue; }
    const clash = taken.find((entry) => shortcutsConflict(entry.chord, chord));
    if (clash) throw new Error(`Two commands cannot share or shadow one shortcut: ${chordLabel(chord)} conflicts with ${clash.command}.`);
    taken.push({ command, chord });
    draft.commands[command] = chord;
  }
  return normalizeKeymap(draft);
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
  state.keymap = next;
  syncSavedCommandsHelp(next);
  setShortcutKeymap(next);
  syncShortcutHints();
  statusLine.textContent = "Saved.";
}

saveButton.addEventListener("click", () => { void saveShortcutSettings(); });
resetButton.addEventListener("click", () => {
  fillFields(DEFAULT_KEYMAP);
  statusLine.textContent = "";
});
