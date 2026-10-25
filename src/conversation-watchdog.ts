export const CONVERSATION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
/** A turn with no background agent that goes this long without input or output is stopped. */
export const TURN_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A compaction summary is one silent model request; long conversations need several minutes. */
export const COMPACTION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * A turn waiting on background agents reports only when an agent finishes a tool call, so an
 * agent thinking or writing a large file stays silent for a long time while still working.
 */
export const BACKGROUND_WORK_INACTIVITY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function conversationInactive(lastActivityAt: number, now = Date.now(), timeoutMs = CONVERSATION_INACTIVITY_TIMEOUT_MS): boolean {
  return lastActivityAt > 0 && now - lastActivityAt > timeoutMs;
}
