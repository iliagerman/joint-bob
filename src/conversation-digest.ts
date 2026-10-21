import { storeTranscriptSummary, storedTranscriptSummary } from "./transcript-summary-store.js";

/**
 * The running summary shown in a conversation's activity sidebar. It is rebuilt
 * incrementally: each refresh hands the model the previous summary plus only the
 * turns that are new (and the last covered turn again, since it may have still been
 * running), so a long conversation costs one short call per turn rather than a
 * re-read of the whole history. Tool output never goes in; only what was asked and
 * answered. Summaries are local to the node that wrote them.
 */
export interface ConversationDigest {
  summary: string;
  /** How many user turns the summary covers. */
  turns: number;
  /** Length of the last covered turn's answer, so a turn that kept going reads as new. */
  lastAnswerLength: number;
  updatedAt: string;
  /** Who wrote it, so the panel can say so. */
  model?: DigestModel;
}

export interface DigestModel {
  harnessId: string;
  provider: string;
  modelId: string;
  /** "setting" for the person's Summary model, "conversation" for the conversation's own, "fallback" when that could not run here. */
  source: "setting" | "conversation" | "fallback";
}

export interface DigestTurn { user: string; assistant: string }

const STORE_KIND = "conversation-digest";
const USER_LIMIT = 2_000;
const ANSWER_LIMIT = 4_000;
// The material handed to the model; the oldest new turns give way first.
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

/** True when the transcript holds turns, or answer text, the stored summary has not seen. */
export function digestIsStale(digest: ConversationDigest | undefined, turns: DigestTurn[]): boolean {
  if (!turns.length) return false;
  if (!digest) return true;
  if (turns.length !== digest.turns) return true;
  return (turns.at(-1)?.assistant.length ?? 0) !== digest.lastAnswerLength;
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)} …`;
}

/** The turns the next refresh must read: everything after the summary, plus its last turn again. */
export function turnsToSummarize(digest: ConversationDigest | undefined, turns: DigestTurn[]): { from: number; turns: DigestTurn[] } {
  const from = digest ? Math.max(0, Math.min(digest.turns, turns.length) - 1) : 0;
  return { from, turns: turns.slice(from) };
}

/** Numbered turn blocks, newest kept first when the whole set does not fit. */
export function digestMaterial(from: number, turns: DigestTurn[]): string {
  const blocks: string[] = [];
  let size = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const block = [`### Turn ${from + index + 1}`, `User: ${clip(turn.user, USER_LIMIT) || "(no text)"}`, `Assistant: ${clip(turn.assistant, ANSWER_LIMIT) || "(no answer yet)"}`].join("\n");
    if (size + block.length > MATERIAL_LIMIT && blocks.length) {
      blocks.unshift(`(${index + 1} earlier new turn${index ? "s" : ""} omitted for length)`);
      break;
    }
    blocks.unshift(block);
    size += block.length;
  }
  return blocks.join("\n\n");
}

export function digestPrompt(previous: string | undefined): string {
  return [
    "You keep a running summary of a conversation between a user and a coding agent, shown in a side panel so the user can catch up at a glance.",
    "Use only the material below. Do not run tools, read files, or ask questions.",
    previous
      ? "Update the existing summary with the new turns. The first new turn may repeat the last turn the summary already covers, in a more complete form; merge it rather than repeating it. Drop details that no longer matter."
      : "Write the summary from the turns below.",
    "Answer with Markdown only, no preamble, at most about 250 words, in these sections:",
    "**Goal** — one or two sentences on what the user wants.",
    "**Done so far** — short bullets of decisions made and work finished.",
    "**Current state** — what is happening now or was last reported.",
    "**Open questions** — bullets of anything waiting on the user; omit the section when there is none.",
    "Write in the language the user writes in.",
    ...(previous ? ["", "Existing summary:", previous] : []),
  ].join("\n");
}

/** The model's answer, without a wrapping code fence and bounded in size. */
export function parseDigestAnswer(answer: string): string {
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(answer.trim());
  const text = (fenced ? fenced[1] : answer).trim();
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)} …`;
}
