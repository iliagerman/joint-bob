import { loadClaudeMessages } from "./claude-service.js";
import { type ConversationRecord, getConversationRecord, listConversationSegments } from "./conversation-records.js";
import { loadPiMessages } from "./pi-service.js";
import type { ChatMessage, SessionSummary } from "./types.js";
import type { ConversationEngine } from "./conversation-ownership.js";

export interface ConversationSegmentView {
  engine: string;
  sessionId: string;
  messages: ChatMessage[];
}

/** One flat transcript where every message knows its segment, plus the segment engines in order. */
export function flattenSegments(prior: ConversationSegmentView[], activeEngine: string, activeMessages: ChatMessage[]): { segments: Array<{ engine: string }>; messages: Array<ChatMessage & { segment: number }> } {
  return {
    segments: [...prior.map((segment) => ({ engine: segment.engine })), { engine: activeEngine }],
    messages: [
      ...prior.flatMap((segment, index) => segment.messages.map((message) => ({ ...message, segment: index }))),
      ...activeMessages.map((message) => ({ ...message, segment: prior.length })),
    ],
  };
}

/** Builds the segmented transcript for an open conversation; single-segment chats stay plain. */
export async function conversationTranscriptPayload(projectId: string, activeEngine: ConversationEngine, activeSessionId: string | null | undefined, listedSessions: SessionSummary[] | undefined, activeMessages: ChatMessage[]) {
  if (!activeSessionId) return { messages: activeMessages, segments: [] as Array<{ engine: string }>, conversationId: undefined as string | undefined };
  const record = await getConversationRecord(projectId, activeEngine, activeSessionId);
  const conversationId = record?.conversationId ?? activeSessionId;
  if (!record) return { messages: activeMessages, segments: [], conversationId };
  const prior = await loadConversationSegments(projectId, conversationId, (candidate) => {
    if (candidate.engine === activeEngine && candidate.sessionId === activeSessionId) return undefined;
    // A switched conversation lists only its newest segment, so older transcripts
    // resolve through the group's segment index as well as standalone rows.
    for (const session of listedSessions ?? []) {
      if (session.harnessId === candidate.engine && session.id === candidate.sessionId && !session.draft) return session.path;
      const segment = session.segments?.find((entry) => entry.engine === candidate.engine && entry.sessionId === candidate.sessionId && !entry.draft);
      if (segment) return segment.path;
    }
    return undefined;
  });
  if (!prior.length) return { messages: activeMessages, segments: [], conversationId };
  return { ...flattenSegments(prior, activeEngine, activeMessages), conversationId };
}

/**
 * Loads every harness segment of one logical conversation, oldest first. The
 * caller decides which segments have transcripts on this node through `pathFor`
 * (returning undefined skips the segment), so drafts and the live segment stay out.
 */
export async function loadConversationSegments(projectId: string, conversationId: string, pathFor: (record: ConversationRecord) => string | undefined): Promise<ConversationSegmentView[]> {
  const segments: ConversationSegmentView[] = [];
  for (const record of await listConversationSegments(projectId, conversationId)) {
    const sessionPath = pathFor(record);
    if (!sessionPath) continue;
    try {
      const messages = record.engine === "claude" ? await loadClaudeMessages(sessionPath) : await loadPiMessages(sessionPath);
      segments.push({ engine: record.engine, sessionId: record.sessionId, messages });
    } catch (error) {
      // A transcript that has not synchronized to this node yet is skipped, not fatal.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return segments;
}
