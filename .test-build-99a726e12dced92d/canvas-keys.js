const DIGITS = [..."0123456789"];
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const SYMBOLS = ["[", "]", ";", "'", ",", ".", "-", "=", "`"];
const NAMED = ["ENTER"];
const CANVAS_KEY_TOKENS = [...DIGITS, ...LETTERS, ...SYMBOLS, ...NAMED];
const TOKENS = new Set(CANVAS_KEY_TOKENS);
function canonicalCanvasKeyToken(key) {
  if (typeof key !== "string") return null;
  const canonical = key.toUpperCase();
  return TOKENS.has(canonical) ? canonical : null;
}
const CANVAS_CHORD_KEY_TOKENS = [
  ...CANVAS_KEY_TOKENS,
  "/",
  "\\",
  "SPACE",
  "ARROWLEFT",
  "ARROWUP",
  "ARROWRIGHT",
  "ARROWDOWN"
];
const CHORD_TOKENS = new Set(CANVAS_CHORD_KEY_TOKENS);
function normalizeCanvasChordTokens(tokens, modifierOnly = false) {
  if (!Array.isArray(tokens)) return null;
  const modifiers = CANVAS_CHORD_MODIFIERS.filter((name) => tokens.includes(name));
  const keys = tokens.filter((token) => typeof token === "string" && !CANVAS_CHORD_MODIFIERS.includes(token));
  if (!modifiers.some((name) => name !== "shift")) return null;
  if (keys.some((key) => !CHORD_TOKENS.has(key))) return null;
  if (!modifierOnly && (keys.length < 1 || keys.length > 2)) return null;
  if (modifierOnly && keys.length !== 0) return null;
  if (modifierOnly && modifiers.length > 3) return null;
  if (modifiers.length + keys.length > 4) return null;
  return [...modifiers, ...keys];
}
const CANVAS_CHORD_MODIFIERS = ["meta", "ctrl", "alt", "shift"];
export {
  CANVAS_CHORD_KEY_TOKENS,
  CANVAS_CHORD_MODIFIERS,
  CANVAS_KEY_TOKENS,
  canonicalCanvasKeyToken,
  normalizeCanvasChordTokens
};
