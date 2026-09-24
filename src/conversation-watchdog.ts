export const CONVERSATION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export function conversationInactive(lastActivityAt: number, now = Date.now()): boolean {
  return lastActivityAt > 0 && now - lastActivityAt > CONVERSATION_INACTIVITY_TIMEOUT_MS;
}
