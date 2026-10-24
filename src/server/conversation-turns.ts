import { getHarness, listHarnessSessions } from "../harnesses.js";
import { listConversationSegments } from "../conversation-records.js";
import type { ChatMessage, ProjectRecord } from "../types.js";
import { projectAdditionalPaths } from "./session-scope.js";

export interface ConversationTurn {
  /** 1-based position of the user message that opened the turn. */
  n: number;
  at?: string;
  user: string;
  assistant: string;
  /** Short or full hashes printed by `git commit` in this turn's tool output, in order. */
  commits: string[];
  /** The subject each of those lines gave, by hash. Quoted text can look like a commit line; Git's own subject settles it. */
  subjects: Map<string, string>;
  /** Every hash-like string the turn's tool output printed. One is a commit of this turn only when Git says it was made meanwhile. */
  printed: Set<string>;
  /** When each tool call of the turn ran, in milliseconds since the epoch. */
  ran: Array<{ from: number; to: number }>;
  /** Answers and tool output, kept only to find which changed paths the turn touched. */
  text: string;
}

// `git commit` prints "[branch abc1234] subject" (or "[branch (root-commit) abc1234]").
const COMMIT_OUTPUT = /\[[^\]\n]*? ([0-9a-f]{7,40})\] ([^\n]*)/g;
const HASH_LIKE = /\b[0-9a-f]{7,40}\b/g;
const PRINTED_LIMIT = 20_000;
const TURN_TEXT_LIMIT = 400_000;

export function commitHashesIn(text: string): string[] {
  return [...new Set([...text.matchAll(COMMIT_OUTPUT)].map((match) => match[1]))];
}

export function buildTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  let started = NaN;
  for (const message of messages) {
    if (message.role === "user") {
      current = { n: turns.length + 1, ...(message.timestamp ? { at: message.timestamp } : {}), user: message.text.trim(), assistant: "", commits: [], subjects: new Map(), printed: new Set(), ran: [], text: "" };
      started = message.timestamp ? Date.parse(message.timestamp) : NaN;
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant") current.assistant = `${current.assistant}\n\n${message.text}`.trim();
    else if (message.role === "toolResult" || message.role === "tool") {
      for (const [, hash, subject] of message.text.matchAll(COMMIT_OUTPUT)) {
        if (current.commits.includes(hash)) continue;
        current.commits.push(hash);
        current.subjects.set(hash, subject.trim());
      }
      for (const hash of message.text.match(HASH_LIKE) ?? []) if (current.printed.size < PRINTED_LIMIT) current.printed.add(hash);
      const to = message.timestamp ? Date.parse(message.timestamp) : NaN;
      // A call with no recorded runtime may have started any time since the turn began.
      const from = message.durationMs === undefined ? started : to - message.durationMs;
      if (Number.isFinite(from) && Number.isFinite(to)) current.ran.push({ from, to });
    } else continue;
    if (current.text.length < TURN_TEXT_LIMIT) current.text = `${current.text}\n${message.text}`.slice(0, TURN_TEXT_LIMIT);
  }
  return turns;
}

/** Every recorded message of a conversation, across harness switches, oldest first. */
export async function loadConversationMessages(project: ProjectRecord, conversationId: string): Promise<{ messages: ChatMessage[]; lastHarness: string }> {
  const transcriptProject = { ...project, additionalPaths: await projectAdditionalPaths(project.id) };
  const sessions = await listHarnessSessions(transcriptProject);
  const session = sessions.find((item) => (item.conversationId ?? item.id) === conversationId);
  if (!session) throw new Error("Conversation not found in this project");
  const records = await listConversationSegments(project.id, conversationId);
  const entries = records.length
    ? records.map((record) => ({ engine: record.engine, path: session.segments?.find((segment) => segment.engine === record.engine && segment.sessionId === record.sessionId)?.path ?? (session.harnessId === record.engine && session.id === record.sessionId ? session.path : "") }))
    : [{ engine: session.harnessId, path: session.path }];
  const messages: ChatMessage[] = [];
  let lastHarness: string = session.harnessId;
  for (const entry of entries) {
    if (!entry.path) continue;
    for (const message of await getHarness(entry.engine).sessions.loadMessages(transcriptProject, entry.path)) {
      messages.push(message);
      if (message.role === "assistant") lastHarness = message.attribution?.harnessId ?? entry.engine;
    }
  }
  return { messages, lastHarness };
}
