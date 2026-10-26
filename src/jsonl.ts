/** Append-only transcripts can end mid-record while an agent writes. Completed
 * lines must parse; a valid last record is also accepted without a newline. */
export function parseCompletedJsonl(contents: string): unknown[] {
  const lines = contents.split("\n");
  const tail = lines.pop()!;
  const records = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (tail.trim()) {
    try { records.push(JSON.parse(tail)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return records;
}

const reportedDamage = new Set<string>();

/**
 * For conversation lists and usage totals: a completed line that does not parse is skipped, and said once per file.
 * fix: a write cut short by a full disk, followed by a newline (homeserver, 2026-10-26), failed every list holding
 * that transcript, /api/running among them. Forks keep parseCompletedJsonl: they must not copy a damaged history.
 */
export function parseJsonlSkippingDamage(contents: string, file: string): unknown[] {
  const lines = contents.split("\n");
  const tail = lines.pop()!;
  const records: unknown[] = [];
  let damaged = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; damaged++; }
  }
  if (tail.trim()) {
    try { records.push(JSON.parse(tail)); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  if (damaged && !reportedDamage.has(file)) {
    reportedDamage.add(file);
    console.warn(`Transcript ${file} has ${damaged} damaged ${damaged === 1 ? "line" : "lines"}; ${damaged === 1 ? "it is" : "they are"} skipped`);
  }
  return records;
}
