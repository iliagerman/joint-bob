const DEFAULT_CONVERSATION_RETENTION_DAYS = 40;
const EMPTY_CONVERSATION_GRACE_MS = 60 * 6e4;
const UNOWNED_EMPTY_CONVERSATION_GRACE_MS = 7 * 24 * 60 * 6e4;
function segmentKeys(session) {
  return [
    `${session.harnessId}:${session.id}`,
    session.path,
    ...session.conversationId ? [`${session.segments?.[0]?.engine ?? session.harnessId}:${session.conversationId}`] : [],
    ...(session.segments ?? []).flatMap((segment) => [`${segment.engine}:${segment.sessionId}`, segment.path])
  ];
}
function retentionReason(session, context) {
  if (session.readOnly || session.taskId || session.cronTaskId) return void 0;
  if (segmentKeys(session).some((key) => context.pinned.has(key))) return void 0;
  const owned = context.ownedLocally(session);
  if (owned === false) return void 0;
  const updatedAt = Date.parse(session.updatedAt ?? session.createdAt ?? "");
  if (!Number.isFinite(updatedAt)) return void 0;
  const age = context.now - updatedAt;
  const empty = session.draft && (session.segments ?? []).every((segment) => segment.draft);
  if (empty) {
    if (context.hasQueuedPrompts(session)) return void 0;
    return age >= (owned ? EMPTY_CONVERSATION_GRACE_MS : UNOWNED_EMPTY_CONVERSATION_GRACE_MS) ? "empty" : void 0;
  }
  return age >= context.retentionDays * 864e5 ? "expired" : void 0;
}
export {
  DEFAULT_CONVERSATION_RETENTION_DAYS,
  EMPTY_CONVERSATION_GRACE_MS,
  UNOWNED_EMPTY_CONVERSATION_GRACE_MS,
  retentionReason
};
