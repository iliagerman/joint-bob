import { randomUUID } from "node:crypto";
const INTERNAL_PREFIX = "b0b1f17e-";
const LEGACY_INTERNAL_PROMPTS = [
  "You are Joint Bob's background sync fixer. Syncthing found files that two machines edited at the same time and kept both versions.",
  "Read ONLY the supplied conversation transcript. Which pending paths did the coding agent say it changed",
  'Review the pending changes only. Return ONLY JSON: {"summary":string',
  "You are a read-only code reviewer. Explain code changes; never modify files"
];
function internalSessionId() {
  return INTERNAL_PREFIX + randomUUID().slice(INTERNAL_PREFIX.length);
}
function isInternalSession(id, firstPrompt = "") {
  const prompt = firstPrompt.trimStart();
  return id.startsWith(INTERNAL_PREFIX) || LEGACY_INTERNAL_PROMPTS.some((prefix) => prompt.startsWith(prefix));
}
export {
  internalSessionId,
  isInternalSession
};
