export const CONVERSATION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
/** A compaction summary is one silent model request; long conversations need several minutes. */
export const COMPACTION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export function conversationInactive(lastActivityAt: number, now = Date.now(), timeoutMs = CONVERSATION_INACTIVITY_TIMEOUT_MS): boolean {
  return lastActivityAt > 0 && now - lastActivityAt > timeoutMs;
}
