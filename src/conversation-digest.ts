import { storeTranscriptSummary, storedTranscriptSummary } from "./transcript-summary-store.js";

/**
 * The running summary shown in a conversation's activity sidebar. Each update hands the
 * writer the current summary and only the messages that came after it, and the writer
 * folds them in, so a long conversation costs one short call per message rather than a
 * re-read of its history. Tool output never goes in; only what was said. Summaries are
 * kept on the node that runs the conversation and pushed to its open pages.
 */
export interface ConversationDigest {
  summary: string;
  /** How many of the conversation's user and assistant messages the summary covers. */
  messages?: number;
  /** How many user turns the summary covers, for display. */
  turns: number;
  /** Kept for summaries written before `messages` existed. */
  lastAnswerLength?: number;
  updatedAt: string;
  /** Who wrote it, so the panel can say so. */
  model?: DigestModel;
}

export interface DigestModel {
  harnessId: string;
  provider: string;
  modelId: string;
  /** setting: chosen in Settings or by the relay; classifier: picked by routing; conversation: the conversation's own; fallback: the first agent that could run here. */
  source: "setting" | "classifier" | "conversation" | "fallback";
}

/** One thing said in the conversation: a person's message or an agent's answer. */
export interface DigestMessage { role: "user" | "assistant"; text: string }

const STORE_KIND = "conversation-digest";
const USER_LIMIT = 2_000;
const ANSWER_LIMIT = 6_000;
// The material handed to the model; the oldest new messages give way first.
const MATERIAL_LIMIT = 60_000;
const SUMMARY_LIMIT = 6_000;

function storeKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}

export function storedDigest(projectId: string, conversationId: string): ConversationDigest | undefined {
  return storedTranscriptSummary<ConversationDigest>(STORE_KIND, storeKey(projectId, conversationId));
}

export function saveDigest(projectId: string, conversationId: string, digest: ConversationDigest): void {
  storeTranscriptSummary(STORE_KIND, storeKey(projectId, conversationId), digest);
}

/** The conversation's spoken messages, without tool output, and without a closing prompt the agent has not answered yet. */
export function digestMessages(messages: ReadonlyArray<{ role: string; text: string }>): DigestMessage[] {
  const said = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .map((message) => ({ role: message.role as DigestMessage["role"], text: message.text.trim() }));
  let end = said.length;
  while (end > 0 && said[end - 1].role === "user") end -= 1;
  return said.slice(0, end);
}

export function turnCount(messages: DigestMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/** How many messages the stored summary already covers. A summary from before message counts restarts at its last covered turn. */
export function coveredMessages(digest: ConversationDigest | undefined, messages: DigestMessage[]): number {
  if (!digest) return 0;
  if (typeof digest.messages === "number") return digest.messages <= messages.length ? digest.messages : 0;
  let turns = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    turns += 1;
    if (turns === digest.turns) return index;
  }
  return 0;
}

/** True when the conversation holds answered messages the stored summary has not seen. */
export function digestIsStale(digest: ConversationDigest | undefined, messages: DigestMessage[]): boolean {
  return messages.length > coveredMessages(digest, messages);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)} …`;
}

/** Keeps how a long answer began and, mostly, where it got to. */
function clipAnswer(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.3);
  return `${text.slice(0, head)} … ${text.slice(text.length - (limit - head))}`;
}

function line(message: DigestMessage): string {
  return message.role === "user" ? `User: ${clip(message.text, USER_LIMIT)}` : `Assistant: ${clipAnswer(message.text, ANSWER_LIMIT)}`;
}

/** The messages after the summary, newest kept first when they do not all fit; a first summary always keeps the opening request. */
export function digestMaterial(messages: DigestMessage[], from: number): string {
  const fresh = messages.slice(from);
  const lines: string[] = [];
  let size = 0;
  for (let index = fresh.length - 1; index >= 0; index -= 1) {
    const entry = line(fresh[index]);
    if (size + entry.length > MATERIAL_LIMIT && lines.length) {
      lines.unshift(`(${index + 1} earlier message${index ? "s" : ""} omitted for length)`);
      const opening = from === 0 ? messages.find((message) => message.role === "user") : undefined;
      if (opening) lines.unshift(`First request — ${line(opening)}`);
      break;
    }
    lines.unshift(entry);
    size += entry.length;
  }
  return lines.join("\n\n");
}

export function digestPrompt(previous: string | undefined): string {
  return [
    "You keep a running summary of a conversation between a user and a coding agent. It is shown in a narrow side panel so the user can catch up at a glance.",
    "Use only the material below. Do not run tools, read files, or ask questions.",
    previous
      ? "Below are the current summary and the messages that came after it. Fold the new messages into the summary: update the goal if it moved, add finished work, replace the current state, keep open questions current, and drop details that no longer matter. Return the whole updated summary."
      : "Write the summary from the messages below.",
    "Answer in Markdown, at most about 250 words, with these bold labels, each followed by a sentence or short bullets:",
    "**Goal** — what the user wants.",
    "**Done so far** — decisions made and work finished.",
    "**Current state** — what is happening now or was last reported.",
    "**Open questions** — anything waiting on the user; leave this label out when there is none.",
    "No headings, code blocks, tables, raw JSON or long file paths: name files by their name only. Keep lines short; the panel is narrow.",
    "Write in the language the user writes in.",
    ...(previous ? ["", "Current summary:", previous] : []),
  ].join("\n");
}

/** The model's answer, without a wrapping code fence and bounded in size. */
export function parseDigestAnswer(answer: string): string {
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(answer.trim());
  const text = (fenced ? fenced[1] : answer).trim();
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)} …`;
}
