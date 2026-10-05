import { getHarness, listHarnessSessions } from "../harnesses.js";
import { listConversationSegments } from "../conversation-records.js";
import type { ChatMessage, ProjectRecord } from "../types.js";

export interface ConversationTurn {
  /** 1-based position of the user message that opened the turn. */
  n: number;
  at?: string;
  user: string;
  assistant: string;
  /** Short or full hashes printed by `git commit` in this turn's tool output, in order. */
  commits: string[];
  /** Answers and tool output, kept only to find which changed paths the turn touched. */
  text: string;
}

// `git commit` prints "[branch abc1234] subject" (or "[branch (root-commit) abc1234]").
const COMMIT_OUTPUT = /\[[^\]\n]*? ([0-9a-f]{7,40})\] /g;
const TURN_TEXT_LIMIT = 400_000;

export function commitHashesIn(text: string): string[] {
  return [...new Set([...text.matchAll(COMMIT_OUTPUT)].map((match) => match[1]))];
}

export function buildTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      current = { n: turns.length + 1, ...(message.timestamp ? { at: message.timestamp } : {}), user: message.text.trim(), assistant: "", commits: [], text: "" };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant") current.assistant = `${current.assistant}\n\n${message.text}`.trim();
    else if (message.role === "toolResult" || message.role === "tool") {
      for (const hash of commitHashesIn(message.text)) if (!current.commits.includes(hash)) current.commits.push(hash);
    } else continue;
    if (current.text.length < TURN_TEXT_LIMIT) current.text = `${current.text}\n${message.text}`.slice(0, TURN_TEXT_LIMIT);
  }
  return turns;
}

/** Every recorded message of a conversation, across harness switches, oldest first. */
export async function loadConversationMessages(project: ProjectRecord, conversationId: string): Promise<{ messages: ChatMessage[]; lastHarness: string }> {
  const sessions = await listHarnessSessions(project);
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
    for (const message of await getHarness(entry.engine).sessions.loadMessages(project, entry.path)) {
      messages.push(message);
      if (message.role === "assistant") lastHarness = message.attribution?.harnessId ?? entry.engine;
    }
  }
  return { messages, lastHarness };
}
