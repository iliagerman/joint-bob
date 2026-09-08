/**
 * The keys a canvas conversation shortcut may hold. Digits and letters were the
 * original vocabulary; punctuation and Enter were added so a shortcut can sit under a
 * finger instead of on a letter the conversation is also typing.
 *
 * Three keys are deliberately absent. Space is the plain space bar a conversation is
 * typing, and "/" and "\" travel as a URL path segment on the way to the shortcut
 * routes. A full shortcut chord can still use them - see CANVAS_CHORD_KEY_TOKENS.
 *
 * `public/canvas-layout.js` holds the browser's copy of these lists;
 * `test/canvas-keys.test.ts` keeps the two in step.
 */
const DIGITS = [..."0123456789"];
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SYMBOLS = ["[", "]", ";", "'", ",", ".", "-", "=", "`"];
/** Keys that type no character, so they travel as a name rather than as themselves. */
const NAMED = ["ENTER"];

export const CANVAS_KEY_TOKENS: readonly string[] = [...DIGITS, ...LETTERS, ...SYMBOLS, ...NAMED];

const TOKENS = new Set(CANVAS_KEY_TOKENS);

/** The one spelling of a key, or null when the canvas cannot carry it. */
export function canonicalCanvasKeyToken(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const canonical = key.toUpperCase();
  return TOKENS.has(canonical) ? canonical : null;
}

/** Keys a shortcut chord may end in: the conversation-binding vocabulary plus Space, the
 *  arrows, and both slashes, which a binding could never carry (a binding rides a URL
 *  path segment) but a chord in the saved keymap can. */
export const CANVAS_CHORD_KEY_TOKENS: readonly string[] = [
  ...CANVAS_KEY_TOKENS, "/", "\\", "SPACE", "ARROWLEFT", "ARROWUP", "ARROWRIGHT", "ARROWDOWN",
];

const CHORD_TOKENS = new Set(CANVAS_CHORD_KEY_TOKENS);

/** The canonical form of one shortcut, or null when the value cannot be one. A
 * shortcut is one modified key or a modified key followed by one more key, with at
 * most four physical keys altogether. */
export function normalizeCanvasChordTokens(tokens: unknown, modifierOnly = false): string[] | null {
  if (!Array.isArray(tokens)) return null;
  const modifiers = CANVAS_CHORD_MODIFIERS.filter((name) => tokens.includes(name));
  const keys = tokens.filter((token): token is string => typeof token === "string" && !CANVAS_CHORD_MODIFIERS.includes(token as CanvasChordModifier));
  if (!modifiers.some((name) => name !== "shift")) return null;
  if (keys.some((key) => !CHORD_TOKENS.has(key))) return null;
  if (!modifierOnly && (keys.length < 1 || keys.length > 2)) return null;
  if (modifierOnly && keys.length !== 0) return null;
  if (modifierOnly && modifiers.length > 3) return null;
  if (modifiers.length + keys.length > 4) return null;
  return [...modifiers, ...keys];
}

export type CanvasChordModifier = "meta" | "ctrl" | "alt" | "shift";
export const CANVAS_CHORD_MODIFIERS: readonly CanvasChordModifier[] = ["meta", "ctrl", "alt", "shift"];
