// ── Shortcut chords ─────────────────────────────────────────────────────────────
// A shortcut is one chord or a two-stroke sequence, written as a flat token array in
// canonical order: ["meta", "shift", "P"] or ["ctrl", "SPACE", "\\"]. Modifiers
// apply to the first key; an optional second key follows after release. Four physical
// keys is the ceiling. Shift alone never starts a shortcut because it would swallow
// every capital letter a conversation is typing.
export const SHORTCUT_MODIFIERS = ["meta", "ctrl", "alt", "shift"];
const MODIFIER_TOKENS = new Set(SHORTCUT_MODIFIERS);
/** Mac draws modifiers as symbols; everywhere else they are spelled out, because
 *  ⌥ names a key that keyboard does not have. */
const MAC_MODIFIER_LABELS = { meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const OTHER_MODIFIER_LABELS = { meta: "Win+", ctrl: "Ctrl+", alt: "Alt+", shift: "Shift+" };
export const isMacPlatform = () => (typeof navigator === "object" && navigator
  ? /mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent)
  : true);
/** The single keys a shortcut may end on under the base chord. Mirrors `src/shortcut-keys.ts`;
 *  Space and the slashes are left out of this short list (a full chord may still use them). */
export const SHORTCUT_KEY_TOKENS = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", "[", "]", ";", "'", ",", ".", "-", "=", "`", "ENTER"];
const SHORTCUT_KEYS = new Set(SHORTCUT_KEY_TOKENS);
export const canonicalShortcutKey = (key) => { const canonical = typeof key === "string" ? key.toUpperCase() : ""; return SHORTCUT_KEYS.has(canonical) ? canonical : null; };
/** Keys a chord may end in: the binding vocabulary plus the keys a binding could never
 *  carry - Space, the arrows, and both slashes. A chord lives in the saved keymap,
 *  never in a URL path segment, so it may use them. */
export const SHORTCUT_CHORD_KEYS = [...SHORTCUT_KEY_TOKENS, "/", "\\", "SPACE", "ARROWLEFT", "ARROWUP", "ARROWRIGHT", "ARROWDOWN"];
const CHORD_KEYS = new Set(SHORTCUT_CHORD_KEYS);
/** Canonical shortcut tokens, or null when the value cannot be a shortcut.
 * `modifierOnly` accepts the bare modifier chord a conversation key rides under. */
export function normalizeChord(tokens, { modifierOnly = false } = {}) {
  if (!Array.isArray(tokens)) return null;
  const modifiers = SHORTCUT_MODIFIERS.filter((name) => tokens.includes(name));
  const keys = tokens.filter((token) => typeof token === "string" && !MODIFIER_TOKENS.has(token));
  if (!modifiers.some((name) => name !== "shift")) return null;
  if (keys.some((key) => !CHORD_KEYS.has(key))) return null;
  if (modifierOnly ? keys.length !== 0 : keys.length < 1 || keys.length > 2) return null;
  if (modifierOnly && modifiers.length > 3) return null;
  if (modifiers.length + keys.length > 4) return null;
  return [...modifiers, ...keys];
}
export const chordId = (chord) => JSON.stringify(chord);
/** Physical keys, so a shortcut survives a layout that moves the character elsewhere. */
const SHORTCUT_KEY_CODES = { BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Minus: "-", Equal: "=", Backquote: "`", Enter: "ENTER", NumpadEnter: "ENTER", Space: "SPACE", Backslash: "\\", Slash: "/", ArrowLeft: "ARROWLEFT", ArrowRight: "ARROWRIGHT", ArrowUp: "ARROWUP", ArrowDown: "ARROWDOWN" };
export const shortcutKeyFromCode = (code) => SHORTCUT_KEY_CODES[code] || /^(?:Digit([0-9])|Key([A-Z]))$/.exec(code || "")?.slice(1).find(Boolean) || null;
/** The chord a keydown event describes: every modifier held plus the key it pressed. */
export function chordFromEvent(event) {
  if (!event || event.repeat) return null;
  const key = shortcutKeyFromCode(event.code);
  if (!key) return null;
  return normalizeChord([...SHORTCUT_MODIFIERS.filter((name) => event[`${name}Key`]), key]);
}
/** A chord answers an event only when every modifier and the key match exactly: a
 *  stray Control held beside Command+Shift+P must not fire it. */
export const chordMatches = (chord, event) => Array.isArray(chord)
  && SHORTCUT_MODIFIERS.every((name) => Boolean(event[`${name}Key`]) === chord.includes(name))
  && shortcutKeyFromCode(event.code) === chord[chord.length - 1];
/** A key that types no character needs a symbol a person can read on a badge. */
export const shortcutKeyLabel = (key) => ({ ENTER: "⏎", SPACE: "Space", ARROWLEFT: "←", ARROWRIGHT: "→", ARROWUP: "↑", ARROWDOWN: "↓" })[key] ?? (key || "");
export function chordLabel(chord, mac = isMacPlatform()) {
  if (!Array.isArray(chord)) return "";
  const symbols = mac ? MAC_MODIFIER_LABELS : OTHER_MODIFIER_LABELS;
  const keys = chord.filter((token) => !MODIFIER_TOKENS.has(token));
  const first = SHORTCUT_MODIFIERS.filter((name) => chord.includes(name)).map((name) => symbols[name]).join("") + shortcutKeyLabel(keys[0]);
  return [first, ...keys.slice(1).map(shortcutKeyLabel)].join(" ");
}
/** The keys alone, without the modifiers. Every default shortcut rides the same
 *  modifiers, so a button badge only has to name the key that makes it unique - the
 *  shortcuts panel is where the whole chord is spelled out. */
export function chordKeyLabel(chord) {
  if (!Array.isArray(chord)) return "";
  return chord.filter((token) => !MODIFIER_TOKENS.has(token)).map(shortcutKeyLabel).join(" ");
}
export const shortcutPrefix = (shortcut) => {
  const keys = Array.isArray(shortcut) ? shortcut.filter((token) => !MODIFIER_TOKENS.has(token)) : [];
  return keys.length === 2 ? shortcut.slice(0, -1) : null;
};
export function shortcutsConflict(left, right) {
  if (chordId(left) === chordId(right)) return true;
  const leftPrefix = shortcutPrefix(left);
  const rightPrefix = shortcutPrefix(right);
  return Boolean(leftPrefix && !rightPrefix && chordId(leftPrefix) === chordId(right)
    || rightPrefix && !leftPrefix && chordId(rightPrefix) === chordId(left));
}
export const shortcutFinalMatches = (shortcut, event) => Boolean(shortcutPrefix(shortcut))
  && !event.metaKey && !event.ctrlKey && !event.altKey
  && shortcutKeyFromCode(event.code) === shortcut[shortcut.length - 1];
/** The chord a conversation's own key fires on: the base modifiers plus that key. */
export const conversationChord = (keymap, key) => normalizeChord([...keymap.base, key]);
export const conversationChordLabel = (keymap, key, mac = isMacPlatform()) => chordLabel(conversationChord(keymap, key), mac);

// ── Conversation switcher ──────────────────────────────────────────────────────
// Hold the chord and tap the cycle key to step through the last conversations opened;
// letting go of the chord opens the one selected. It is fixed rather than in the keymap,
// because a single-key binding cannot describe a hold. Ctrl+Shift+Space elsewhere, not
// Ctrl+Alt, because Ctrl+Alt is AltGr on many keyboard layouts.
const SWITCHER_CHORDS = {
  mac: { modifiers: ["ctrl", "alt"], code: "Tab", hold: "⌃⌥", cycle: "Tab", back: "⇧Tab" },
  other: { modifiers: ["ctrl", "shift"], code: "Space", hold: "Ctrl+Shift", cycle: "Space", back: "↑" },
};
export const switcherChord = (mac = isMacPlatform()) => SWITCHER_CHORDS[mac ? "mac" : "other"];
/** True while every modifier of the chord is down; letting any one go ends the hold. */
export const switcherHeld = (event, mac = isMacPlatform()) => switcherChord(mac).modifiers.every((name) => Boolean(event[`${name}Key`]));
/** The switcher's own keystroke. A Mac lets Shift join it, which steps back; elsewhere
 *  Shift is part of the chord, so any other modifier means it is not the switcher. */
export function isSwitcherKey(event, mac = isMacPlatform()) {
  const { modifiers, code } = switcherChord(mac);
  if (event.code !== code || !switcherHeld(event, mac)) return false;
  return SHORTCUT_MODIFIERS.every((name) => modifiers.includes(name) || (mac && name === "shift") || !event[`${name}Key`]);
}
/** One row forward, or one back when a Mac press carries Shift. */
export const switcherStep = (event, mac = isMacPlatform()) => (mac && event.shiftKey ? -1 : 1);
/** Keys an open switcher answers to: digits jump to a row, arrows step, Escape cancels. */
export const isSwitcherNavigationCode = (code) => /^Digit[0-9]$/.test(code)
  || ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"].includes(code);

/** Every command the keymap can bind, in collision-priority order: where a stored
 *  keymap hands one chord to two commands, the earlier command keeps it. Commands
 *  answer from anywhere in the app. */
export const KEYMAP_COMMANDS = [
  "toggleView", "spotlight", "pendingReviews", "recents", "runningConversations", "settings", "focusInput", "savedCommands",
  "toggleProjects", "toggleChats", "board", "newProject", "newPiChat", "newClaudeChat", "newKiroChat", "quickNote", "toggleNotes",
  "runsOn", "selectAgent", "selectModel", "selectThinking", "terminal", "notify", "rename", "browser", "scheduledTasks",
  "backgroundTasks", "chatFiles", "sessionActions", "markDone", "autoRespond", "git", "explainConversation", "costs", "activity",
];
/** Every command rides one modifier pair - Control+Option on a Mac, Control+Alt
 *  elsewhere, the same two physical keys - so a button badge can name the key alone.
 */
export const COMMAND_MODIFIERS = ["ctrl", "alt"];
const commandChord = (key) => [...COMMAND_MODIFIERS, key];
export const DEFAULT_KEYMAP = {
  version: 4,
  // The chord every conversation key rides under: the base modifiers plus its key.
  base: ["meta", "shift"],
  commands: {
    toggleView: commandChord("V"),
    spotlight: commandChord("P"),
    pendingReviews: commandChord("R"),
    recents: commandChord("K"),
    runningConversations: commandChord("O"),
    settings: commandChord(","),
    focusInput: commandChord("I"),
    savedCommands: ["ctrl", "alt", "shift", "L"],
    toggleProjects: commandChord("["),
    toggleChats: commandChord("]"),
    board: commandChord("D"),
    newProject: commandChord("="),
    newPiChat: commandChord("N"),
    newClaudeChat: commandChord("C"),
    newKiroChat: commandChord("Q"),
    quickNote: commandChord("."),
    toggleNotes: commandChord("/"),
    runsOn: commandChord("H"),
    selectAgent: commandChord("A"),
    selectModel: commandChord("M"),
    selectThinking: commandChord("T"),
    terminal: commandChord("X"),
    browser: commandChord("B"),
    notify: commandChord("Y"),
    rename: commandChord("E"),
    scheduledTasks: commandChord("S"),
    backgroundTasks: commandChord("U"),
    chatFiles: commandChord("Z"),
    // The letters under Control+Option are all taken, so these add Shift, as costs does.
    sessionActions: ["ctrl", "alt", "shift", "A"],
    markDone: ["ctrl", "alt", "shift", "D"],
    autoRespond: ["ctrl", "alt", "shift", "R"],
    git: ["ctrl", "alt", "shift", "G"],
    explainConversation: ["ctrl", "alt", "shift", "E"],
    costs: ["ctrl", "alt", "shift", "C"],
    activity: ["ctrl", "alt", "shift", "S"],
  },
};
export function normalizeKeymap(keymap) {
  const source = keymap && typeof keymap === "object" ? keymap : {};
  // Before commands existed the base modifiers were stored as `modifiers`.
  const base = normalizeChord(source.commands ? source.base : source.modifiers, { modifierOnly: true }) || [...DEFAULT_KEYMAP.base];
  // Version 4 moved every command onto one modifier pair, so a keymap saved before it
  // describes a scheme that no longer exists: its command chords are rebuilt from the
  // defaults and only the conversation base modifiers carry over.
  const rebuild = !(source.version >= 4);
  const commands = {};
  const taken = [];
  for (const command of KEYMAP_COMMANDS) {
    const raw = rebuild || source.commands?.[command] === undefined
      ? [...DEFAULT_KEYMAP.commands[command]]
      : source.commands[command];
    const chord = raw === null ? null : normalizeChord(raw);
    // A chord the keymap cannot carry is dropped, not stored; a chord two commands
    // would share goes to the earlier one, so the second is unbound rather than random.
    commands[command] = chord && !taken.some((existing) => shortcutsConflict(existing, chord)) ? chord : null;
    if (commands[command]) taken.push(chord);
  }
  return { version: 4, base, commands };
}
/** Command/Control + ? opens the shortcuts panel. This one is fixed: it is how a person
 *  finds out what the configurable keys are. It matches the typed "?" as well as
 *  Shift and "/", so a layout that puts "?" elsewhere still works - and the bare "/"
 *  is deliberately left alone, because the terminal and the code editor use it. */
export const isHelpShortcut = (combination) => (combination.metaKey || combination.ctrlKey)
  && !combination.altKey
  && (combination.key === "?" || (combination.code === "Slash" && combination.shiftKey));
export function fuzzyMatchScore(text, query) { if (!query) return 0; let score = 0, index = -1, prior = -2; const haystack = String(text).toLowerCase(); for (const character of String(query).toLowerCase()) { index = haystack.indexOf(character, index + 1); if (index < 0) return null; score += index === prior + 1 ? 10 : 1; if (index === 0 || /[\s·\-_/]/.test(haystack[index - 1])) score += 5; prior = index; } return score - haystack.length / 100; }
