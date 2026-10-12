/**
 * A delivery that keeps failing for the same reason says so once, not on every attempt: a
 * machine that was off for a day used to fill the log with the same line every two seconds
 * from each delivery loop. The line is written again when the reason changes, and
 * `settled` re-arms it once the delivery goes through.
 */
const noted = new Map<string, string>();

export function warnOnChange(key: string, message: string): void {
  if (noted.get(key) === message) return;
  if (noted.size >= 5_000) noted.clear();
  noted.set(key, message);
  console.warn(message);
}

export function settled(key: string): void { noted.delete(key); }
