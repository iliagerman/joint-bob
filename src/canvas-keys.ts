/**
 * The keys a canvas shortcut may hold. Digits and letters were the original
 * vocabulary; punctuation and Enter were added so a shortcut can sit under a finger
 * instead of on a letter the conversation is also typing.
 *
 * Three keys are deliberately absent. Space is the split leader. "/" and "\" travel
 * as a URL path segment on the way to the shortcut routes, and "\" already means
 * "split" once the leader is armed.
 *
 * `public/canvas-layout.js` holds the browser's copy of this list;
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
