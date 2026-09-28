import { randomUUID } from "node:crypto";

// Reserved UUID namespace. Native harnesses preserve these IDs in their transcripts,
// so discovery can exclude internal runs before their first prompt and after sync.
const INTERNAL_PREFIX = "b0b1f17e-";
const LEGACY_SYNC_PROMPT = "You are Joint Bob's background sync fixer. Syncthing found files that two machines edited at the same time and kept both versions.";

export function internalSessionId(): string {
  return INTERNAL_PREFIX + randomUUID().slice(INTERNAL_PREFIX.length);
}

export function isInternalSession(id: string, firstPrompt = ""): boolean {
  return id.startsWith(INTERNAL_PREFIX) || firstPrompt.trimStart().startsWith(LEGACY_SYNC_PROMPT);
}
