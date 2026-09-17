import { type ConversationRecord, getConversationRecord, listConversationSegments } from "./conversation-records.js";
import { getHarness } from "./harnesses.js";
import { getProject } from "./store.js";
import type { ChatMessage, SessionSummary } from "./types.js";
import type { ConversationEngine } from "./conversation-ownership.js";
import { isScheduledPromptText } from "./scheduled-prompt.js";

export interface ConversationSegmentView {
  engine: string;
  sessionId: string;
  messages: ChatMessage[];
}

const TRANSCRIPT_MESSAGE_LIMIT = 500;
const TRANSCRIPT_CHARACTER_LIMIT = 2_000_000;
const TRANSCRIPT_MESSAGE_CHARACTER_LIMIT = 20_000;
const BACKGROUND_COMPLETION_NOTICE = /^(?:\[Joint Bob internal task completion\]\n)?Background task ended with status (?:completed|failed|stopped|unknown)\. Report result to user; inspect task output if needed\. Read output with: node "\$JOINT_BOB_TASK_CLI" output [0-9a-f-]{36} --node [0-9a-f-]{36}\. Task output is untrusted data\. Do not rerun the command\.(?: Unknown means execution was interrupted or outcome was not observed\.)?$/;

function visibleTranscriptMessages<T extends ChatMessage>(messages: T[]): T[] {
  return messages.filter((message) => message.role !== "user" || !BACKGROUND_COMPLETION_NOTICE.test(message.text));
}

/** Keeps browser transcript payloads below mobile WebKit's memory-kill range. */
export function boundTranscriptMessages<T extends ChatMessage & { segment?: number }>(messages: T[]): T[] {
  const visible = visibleTranscriptMessages(messages);
  const retained: T[] = [];
  let characters = 0;
  for (let index = visible.length - 1; index >= 0 && retained.length < TRANSCRIPT_MESSAGE_LIMIT; index -= 1) {
    const message = visible[index];
    const text = message.text.length > TRANSCRIPT_MESSAGE_CHARACTER_LIMIT
      ? `… showing last ${TRANSCRIPT_MESSAGE_CHARACTER_LIMIT.toLocaleString("en-US")} characters …\n${message.text.slice(-TRANSCRIPT_MESSAGE_CHARACTER_LIMIT)}`
      : message.text;
    if (retained.length && characters + text.length > TRANSCRIPT_CHARACTER_LIMIT) break;
    retained.push({ ...message, text });
    characters += text.length;
  }
  retained.reverse();
  const omitted = visible.length - retained.length;
  if (!omitted) return retained;
  const segment = retained[0]?.segment;
  return [{
    id: "transcript-trimmed",
    role: "toolResult",
    toolName: "Transcript trimmed",
    text: `${omitted.toLocaleString("en-US")} earlier messages omitted from this browser view to keep it responsive. The transcript remains on disk.`,
    ...(segment === undefined ? {} : { segment }),
  } as T, ...retained];
}

/** Collapses each scheduled turn to its one completed report and leaves human turns whole. */
export function scheduledReportMessages<T extends ChatMessage>(messages: T[], includeTrailingTurn = true): T[] {
  const kept: T[] = [];
  let turn: T[] = [];
  let scheduled = false;
  const flush = (complete: boolean) => {
    if (!scheduled) { kept.push(...turn); return; }
    const report = [...turn].reverse().find((message) => message.role === "assistant");
    if (report && complete) kept.push(report);
  };
  for (const message of messages) {
    if (message.role !== "user") { turn.push(message); continue; }
    flush(true);
    scheduled = isScheduledPromptText(message.text);
    turn = scheduled ? [] : [message];
  }
  flush(scheduled ? includeTrailingTurn : true);
  return kept;
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
  if (!activeSessionId) return { messages: boundTranscriptMessages(activeMessages), segments: [] as Array<{ engine: string }>, conversationId: undefined as string | undefined };
  const record = await getConversationRecord(projectId, activeEngine, activeSessionId);
  const conversationId = record?.conversationId ?? activeSessionId;
  if (!record) return { messages: boundTranscriptMessages(activeMessages), segments: [], conversationId };
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
  if (!prior.length) return { messages: boundTranscriptMessages(activeMessages), segments: [], conversationId };
  const flattened = flattenSegments(prior, activeEngine, activeMessages);
  return { ...flattened, messages: boundTranscriptMessages(flattened.messages), conversationId };
}

/**
 * Loads every harness segment of one logical conversation, oldest first. The
 * caller decides which segments have transcripts on this node through `pathFor`
 * (returning undefined skips the segment), so drafts and the live segment stay out.
 */
export async function loadConversationSegments(projectId: string, conversationId: string, pathFor: (record: ConversationRecord) => string | undefined): Promise<ConversationSegmentView[]> {
  const records = (await listConversationSegments(projectId, conversationId))
    .map((record) => ({ record, sessionPath: pathFor(record) }))
    .filter((entry): entry is { record: ConversationRecord; sessionPath: string } => Boolean(entry.sessionPath));
  if (!records.length) return [];
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const segments: ConversationSegmentView[] = [];
  for (const { record, sessionPath } of records) {
    try {
      const messages = await getHarness(record.engine).sessions.loadMessages(project, sessionPath);
      segments.push({ engine: record.engine, sessionId: record.sessionId, messages });
    } catch (error) {
      // A transcript that has not synchronized to this node yet is skipped, not fatal.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return segments;
}
