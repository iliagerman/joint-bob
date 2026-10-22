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
  /** Skills the writer thinks would help this conversation; absent on summaries from before suggestions. */
  suggestions?: SkillSuggestion[];
}

/** An installed skill the conversation could have loaded, or a new one for work it keeps doing by hand. */
export interface SkillSuggestion { kind: "use" | "new"; skill: string; reason: string }

/** What the writer is told about skills: the ones the conversation's agent can load, the ones it loaded, and the last suggestions. */
export interface DigestSkills {
  catalog: Array<{ name: string; description: string }>;
  used: string[];
  suggestions?: SkillSuggestion[];
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
// The line that separates the summary from the skill suggestions in the writer's answer.
const SUGGESTIONS_MARK = "@@skills";
const MAX_SUGGESTIONS = 3;
const CATALOG_LIMIT = 80;
const CATALOG_DESCRIPTION_LIMIT = 110;
const REASON_LIMIT = 200;

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

/** A skill's own name, without the plugin Claude puts in front of a plugin's skill. */
export function bareSkillName(name: string): string {
  return (name.split(":").at(-1) ?? name).trim().toLowerCase();
}

/** The skills the conversation loaded, in the order first loaded; a load that failed does not count. */
export function usedSkills(messages: ReadonlyArray<{ role: string; isError?: boolean; toolTarget?: { skill?: string } }>): string[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    const skill = message.toolTarget?.skill;
    if (!skill || message.isError === true || (message.role !== "toolResult" && message.role !== "toolCall")) continue;
    if (!names.has(bareSkillName(skill))) names.set(bareSkillName(skill), skill);
  }
  return [...names.values()];
}

function skillInstructions(skills: DigestSkills): string[] {
  const catalog = skills.catalog.slice(0, CATALOG_LIMIT).map((skill) => `- ${skill.name}: ${clip(skill.description.replace(/\s+/g, " ").trim(), CATALOG_DESCRIPTION_LIMIT)}`);
  return [
    "",
    `After the summary, write a line with only ${SUGGESTIONS_MARK}. Under it, suggest at most ${MAX_SUGGESTIONS} skills that would clearly help with this conversation's work, one per line, and write nothing under it when none would; most conversations need none:`,
    "use <installed skill name> — <why, in under 15 words> for an installed skill below that fits the work but was not used.",
    "new <short-kebab-case-name> — <why, in under 15 words> for a procedure the conversation repeats by hand that no installed skill covers.",
    "Never suggest a skill the conversation already used.",
    skills.used.length ? `Skills the conversation used: ${skills.used.join(", ")}.` : "The conversation has not used a skill.",
    ...(skills.suggestions?.length ? ["Your last suggestions; keep, change or drop them:", ...skills.suggestions.map((item) => `${item.kind} ${item.skill} — ${item.reason}`)] : []),
    ...(catalog.length ? ["Installed skills:", ...catalog] : ["No skills are installed, so suggest only new ones."]),
  ];
}

/** What a summary is for and how it reads: the part of the writer's prompt a machine's admin can replace in Settings. */
export const DEFAULT_SUMMARY_INSTRUCTIONS = [
  "You keep a running summary of a conversation between a user and a coding agent. It is shown in a narrow side panel so the user can catch up at a glance.",
  "Answer in Markdown, at most about 250 words, with these bold labels, each followed by a sentence or short bullets:",
  "**Goal** — what the user wants.",
  "**Done so far** — decisions made and work finished.",
  "**Current state** — what is happening now or was last reported.",
  "**Open questions** — anything waiting on the user; leave this label out when there is none.",
  "No headings, code blocks, tables, raw JSON or long file paths: name files by their name only. Keep lines short; the panel is narrow.",
  "Write in the language the user writes in.",
].join("\n");

/**
 * The writer's prompt: the instructions (the built-in ones or a machine's own), then what
 * every summary needs whatever they say: only the material given, how to fold new messages
 * into the current summary, the skill suggestions, and the current summary itself.
 */
export function digestPrompt(previous: string | undefined, skills?: DigestSkills, instructions?: string | null): string {
  return [
    instructions?.trim() || DEFAULT_SUMMARY_INSTRUCTIONS,
    "",
    "Use only the material below. Do not run tools, read files, or ask questions.",
    previous
      ? "Below are the current summary and the messages that came after it. Fold the new messages into the summary: update the goal if it moved, add finished work, replace the current state, keep open questions current, and drop details that no longer matter. Return the whole updated summary."
      : "Write the summary from the messages below.",
    ...(skills ? skillInstructions(skills) : []),
    ...(previous ? ["", "Current summary:", previous] : []),
  ].join("\n");
}

function unfenced(text: string): string {
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text.trim());
  return (fenced ? fenced[1] : text).trim();
}

/** The model's answer, without a wrapping code fence and bounded in size. */
export function parseDigestAnswer(answer: string): string {
  const text = unfenced(answer);
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)} …`;
}

/**
 * The writer's answer split into the summary and its skill suggestions. Suggestions are
 * undefined when the answer has no suggestions line, so the last ones stand. An installed
 * skill must be in the catalog, and a skill the conversation already used is never suggested.
 */
export function parseDigestReply(answer: string, skills: DigestSkills): { summary: string; suggestions?: SkillSuggestion[] } {
  const text = unfenced(answer);
  const mark = new RegExp(`^[ \\t]*${SUGGESTIONS_MARK}[ \\t]*$`, "m").exec(text);
  if (!mark) return { summary: parseDigestAnswer(text) };
  const installed = new Map(skills.catalog.map((skill) => [bareSkillName(skill.name), skill.name]));
  const taken = new Set(skills.used.map(bareSkillName));
  const suggestions: SkillSuggestion[] = [];
  for (const line of text.slice(mark.index + mark[0].length).split("\n")) {
    const found = /^\s*(?:[-*•]|\d+[.)])?\s*(use|new)\s+`?([\w.:-]{1,80})`?\s*(?:—|–|-|:)\s*(.+)$/i.exec(line);
    if (!found || suggestions.length >= MAX_SUGGESTIONS) continue;
    const kind = found[1].toLowerCase() as SkillSuggestion["kind"];
    const bare = bareSkillName(found[2]);
    if (taken.has(bare)) continue;
    if (kind === "use" && !installed.has(bare)) continue;
    if (kind === "new" && installed.has(bare)) continue;
    taken.add(bare);
    suggestions.push({ kind, skill: kind === "use" ? installed.get(bare)! : found[2].toLowerCase(), reason: clip(found[3].trim(), REASON_LIMIT) });
  }
  return { summary: parseDigestAnswer(text.slice(0, mark.index)), suggestions };
}

/** Earlier suggestions, without any skill the conversation has since used. */
export function keptSuggestions(suggestions: SkillSuggestion[] | undefined, used: string[]): SkillSuggestion[] {
  const taken = new Set(used.map(bareSkillName));
  return (suggestions ?? []).filter((item) => !taken.has(bareSkillName(item.skill)));
}
