import type { SessionSummary } from "./types.js";

export const DEFAULT_CONVERSATION_RETENTION_DAYS = 40;
/** A just-opened conversation is a draft until its first message; give it time to get one. */
export const EMPTY_CONVERSATION_GRACE_MS = 60 * 60_000;
/** A draft nobody owns may be a new conversation whose owner has not replicated its claim yet. */
export const UNOWNED_EMPTY_CONVERSATION_GRACE_MS = 7 * 24 * 60 * 60_000;

export type RetentionReason = "empty" | "expired";

export interface RetentionContext {
  now: number;
  retentionDays: number;
  /** `engine:sessionId` keys and session paths pinned by any user. */
  pinned: Set<string>;
  /** Whether this node, and no other, may delete the conversation; `undefined` when nobody owns it yet. */
  ownedLocally: (session: SessionSummary) => boolean | undefined;
  hasQueuedPrompts: (session: SessionSummary) => boolean;
}

function segmentKeys(session: SessionSummary): string[] {
  return [
    `${session.harnessId}:${session.id}`, session.path,
    ...(session.conversationId ? [`${session.segments?.[0]?.engine ?? session.harnessId}:${session.conversationId}`] : []),
    ...(session.segments ?? []).flatMap((segment) => [`${segment.engine}:${segment.sessionId}`, segment.path]),
  ];
}

/** Why a listed conversation should be deleted now, or `undefined` to keep it. */
export function retentionReason(session: SessionSummary, context: RetentionContext): RetentionReason | undefined {
  // Sub-agent transcripts and done tickets are read-only; tickets and schedules own their conversations.
  if (session.readOnly || session.taskId || session.cronTaskId) return undefined;
  if (segmentKeys(session).some((key) => context.pinned.has(key))) return undefined;
  const owned = context.ownedLocally(session);
  if (owned === false) return undefined;
  const updatedAt = Date.parse(session.updatedAt ?? session.createdAt ?? "");
  if (!Number.isFinite(updatedAt)) return undefined;
  const age = context.now - updatedAt;
  const empty = session.draft && (session.segments ?? []).every((segment) => segment.draft);
  if (empty) {
    if (context.hasQueuedPrompts(session)) return undefined;
    return age >= (owned ? EMPTY_CONVERSATION_GRACE_MS : UNOWNED_EMPTY_CONVERSATION_GRACE_MS) ? "empty" : undefined;
  }
  return age >= context.retentionDays * 86_400_000 ? "expired" : undefined;
}
