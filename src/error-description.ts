/** "fetch failed" on its own says nothing; the cause chain carries the DNS or socket error. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) parts.push(current.message);
  return parts.length ? parts.join(": ") : String(error);
}
