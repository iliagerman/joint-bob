import { randomUUID } from "node:crypto";

// Reserved UUID namespace. Native harnesses preserve these IDs in their transcripts,
// so discovery can exclude internal runs before their first prompt and after sync.
const INTERNAL_PREFIX = "b0b1f17e-";
// Background runs that started before they used internal IDs, matched by their fixed prompt opening.
const LEGACY_INTERNAL_PROMPTS = [
  "You are Joint Bob's background sync fixer. Syncthing found files that two machines edited at the same time and kept both versions.",
  "Read ONLY the supplied conversation transcript. Which pending paths did the coding agent say it changed",
  "Review the pending changes only. Return ONLY JSON: {\"summary\":string",
  "You are a read-only code reviewer. Explain code changes; never modify files",
];

export function internalSessionId(): string {
  return INTERNAL_PREFIX + randomUUID().slice(INTERNAL_PREFIX.length);
}

export function isInternalSession(id: string, firstPrompt = ""): boolean {
  const prompt = firstPrompt.trimStart();
  return id.startsWith(INTERNAL_PREFIX) || LEGACY_INTERNAL_PROMPTS.some((prefix) => prompt.startsWith(prefix));
}
