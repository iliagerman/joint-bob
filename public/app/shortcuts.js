import {
  canvasKeyFromCode, chordFromEvent, chordId, DEFAULT_CANVAS_KEYMAP, normalizeCanvasKeymap, shortcutFinalMatches, shortcutPrefix,
} from "../keymap.js";
import { CHAT_SHORTCUT_CONTROLS, runChatShortcut } from "./chat-shortcuts.js";

/**
 * The app-wide keyboard shortcuts. The account's keymap binds each command to one chord or a
 * two-stroke sequence; this turns a key press into the command it names and runs it. A
 * command is either a conversation control (run by chat-shortcuts) or one of the app
 * commands registered at start-up.
 */
const SEQUENCE_MS = 1500;

let keymap = normalizeCanvasKeymap(DEFAULT_CANVAS_KEYMAP);
let appCommands = {};
let chordCommands = new Map();
let sequenceCommands = new Map();
let pendingSequence = null;

function clearPendingSequence() {
  if (pendingSequence?.timer) clearTimeout(pendingSequence.timer);
  pendingSequence = null;
}

function rebuildChordCommands() {
  chordCommands = new Map();
  sequenceCommands = new Map();
  for (const [command, shortcut] of Object.entries(keymap.commands)) {
    if (!Array.isArray(shortcut)) continue;
    const prefix = shortcutPrefix(shortcut);
    if (!prefix) {
      chordCommands.set(chordId(shortcut), command);
      continue;
    }
    const id = chordId(prefix);
    const endings = sequenceCommands.get(id) ?? new Map();
    endings.set(shortcut[shortcut.length - 1], { command, shortcut });
    sequenceCommands.set(id, endings);
  }
  clearPendingSequence();
}

function runCommand(command) {
  if (Object.hasOwn(CHAT_SHORTCUT_CONTROLS, command)) {
    // A dialog on top owns the keyboard.
    if (!document.querySelector("dialog[open]")) runChatShortcut(command);
    return true;
  }
  if (!Object.hasOwn(appCommands, command)) return false;
  appCommands[command]();
  return true;
}

/** True when the key press was a shortcut (or the first stroke of one). */
function handleKey(event) {
  if (pendingSequence) {
    const pending = pendingSequence;
    clearPendingSequence();
    const ending = sequenceCommands.get(pending.id)?.get(canvasKeyFromCode(event.code));
    if (ending && shortcutFinalMatches(ending.shortcut, event)) return runCommand(ending.command);
  }
  const chord = chordFromEvent(event);
  if (!chord) return false;
  const id = chordId(chord);
  const command = chordCommands.get(id);
  if (command) return runCommand(command);
  if (!sequenceCommands.has(id)) return false;
  pendingSequence = { id, timer: setTimeout(clearPendingSequence, SEQUENCE_MS) };
  return true;
}

export function setShortcutKeymap(next) {
  keymap = normalizeCanvasKeymap(next);
  rebuildChordCommands();
}

/** `commands` maps a command name from the keymap to the function that runs it. */
export function installShortcuts(commands) {
  appCommands = commands;
  rebuildChordCommands();
  window.addEventListener("keydown", (event) => {
    if (handleKey(event)) event.preventDefault();
  });
}
