/**
 * Forgiving text search: every character of the query must appear in order, so "hmsv"
 * finds "Homeserver" and "rsch" finds "Research". Consecutive characters and matches at the
 * start of a word score higher. Returns null when there is no match, or a score where
 * higher is better.
 */
export function fuzzyScore(query, text) {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!needle) return 0;
  const haystack = String(text ?? "").toLocaleLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1000 - direct;
  let score = 0, position = -1, run = 0;
  for (const character of needle) {
    const next = haystack.indexOf(character, position + 1);
    if (next < 0) return null;
    run = next === position + 1 ? run + 1 : 0;
    const wordStart = next === 0 || /[\s._\-/]/.test(haystack[next - 1]);
    score += 10 + run * 5 + (wordStart ? 8 : 0) - Math.min(next - position - 1, 10);
    position = next;
  }
  return score;
}

/** The best score across several fields, or null when none of them match. */
export function fuzzyMatch(query, ...fields) {
  let best = null;
  for (const field of fields) {
    const score = fuzzyScore(query, field);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}
