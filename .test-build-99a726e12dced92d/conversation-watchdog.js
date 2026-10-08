const CONVERSATION_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1e3;
const COMPACTION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1e3;
function conversationInactive(lastActivityAt, now = Date.now(), timeoutMs = CONVERSATION_INACTIVITY_TIMEOUT_MS) {
  return lastActivityAt > 0 && now - lastActivityAt > timeoutMs;
}
export {
  COMPACTION_INACTIVITY_TIMEOUT_MS,
  CONVERSATION_INACTIVITY_TIMEOUT_MS,
  conversationInactive
};
