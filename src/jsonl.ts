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
