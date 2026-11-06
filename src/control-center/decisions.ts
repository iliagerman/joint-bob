import type { SystemOneChoice, SystemOneQuestion } from "../classifiers/typesafe.js";

/** What Bob should do with a message, as the decision model judges it. */
export type BobKind = "question" | "task" | "automation" | "organize" | "other";
export type BobSize = "short" | "long";

export interface BobProjectOption { id: string; name: string; headlines: string[] }

export interface BobDecision {
  kind: BobKind;
  size: BobSize;
  /** null when the message is about no listed project. */
  projectId: string | null;
  /** Whether auto respond suits the conversation this starts: routine work that can be checked, with no plan to approve. */
  autoRespond: boolean;
  /** The lowest confidence among the answers this decision rests on. */
  confidence: number;
}

/** Sends one batch of Choice questions to the decision model. Null means it could not answer. */
export type AskChoices = (state: string, questions: Record<string, SystemOneQuestion>) => Promise<Record<string, SystemOneChoice> | null>;

export interface DecideInput {
  message: string;
  /** The last few lines of the chat, so "that one" and "the second" can be understood. */
  recentChat: string[];
  projects: BobProjectOption[];
  ask: AskChoices;
  /** How much state one request may carry; the project list is split into groups to fit. */
  stateCharacters: number;
  /** When set, the person chose the project, so it is not asked. */
  fixedProjectId?: string;
}

const KIND: SystemOneQuestion = {
  instructions: "What does the user want from their assistant?",
  criteria: {
    question: "The user asks what is happening, what was decided, or something the assistant can answer from what it already knows about their projects.",
    task: "The user asks for work to be done in a project: build, fix, change, investigate, review or research something.",
    automation: "The user asks to create, change, pause or delete a scheduled task or a webhook.",
    organize: "The user asks to create, rename, move, close or delete a workspace, a project or a conversation itself, or to ask or tell one of their existing conversations something, rather than for new work inside a project.",
    other: "Chatting, thanks, or anything that is none of the above.",
  },
};

const SIZE: SystemOneQuestion = {
  instructions: "How much work does the user's request need?",
  criteria: {
    short: "It can be answered right away from short summaries and notes, without changing anything.",
    long: "It needs an agent to work inside a project: read code, run commands, make changes, or research that takes time.",
  },
};

const AUTO_RESPOND: SystemOneQuestion = {
  instructions: "Should an automatic responder keep this task moving by answering the agent's routine questions?",
  criteria: {
    yes: "Routine implementation or fix work that tests or checks can confirm, where the agent's questions are about details.",
    no: "Investigation, a plan to approve, production or destructive steps, or work where the person wants to decide along the way.",
  },
};

const NONE = "none";
const RECENT_CHAT_LINES = 4;
const HEADLINES_PER_PROJECT = 5;

function describe(project: BobProjectOption): string {
  const headlines = project.headlines.slice(0, HEADLINES_PER_PROJECT).join("; ");
  return headlines ? `${project.name}. Recent work: ${headlines}` : project.name;
}

function projectQuestion(group: BobProjectOption[]): { question: SystemOneQuestion; byKey: Map<string, string> } {
  const byKey = new Map<string, string>();
  const criteria: Record<string, string> = {};
  group.forEach((project, index) => {
    const key = `project_${index}`;
    byKey.set(key, project.id);
    criteria[key] = describe(project);
  });
  criteria[NONE] = "No listed project fits: this is general, or about something new.";
  return { question: { instructions: "Which project is the user's message about?", criteria }, byKey };
}

function stateFor(input: DecideInput, group: BobProjectOption[]): string {
  return JSON.stringify({
    user_message: input.message,
    recent_chat: input.recentChat.slice(-RECENT_CHAT_LINES),
    projects: group.map((project) => ({ name: project.name, recent_work: project.headlines.slice(0, HEADLINES_PER_PROJECT) })),
  });
}

/** Splits the projects so each request's state and criteria fit what the decision model can read. */
export function groupProjects(projects: BobProjectOption[], input: Pick<DecideInput, "message" | "recentChat" | "stateCharacters">): BobProjectOption[][] {
  const overhead = JSON.stringify({ user_message: input.message, recent_chat: input.recentChat.slice(-RECENT_CHAT_LINES) }).length + 400;
  // Each project appears twice in a request: in the state and in its criterion.
  const budget = Math.max(200, input.stateCharacters - overhead);
  const groups: BobProjectOption[][] = [];
  let current: BobProjectOption[] = [];
  let used = 0;
  for (const project of projects) {
    const cost = describe(project).length * 2 + 40;
    if (current.length && used + cost > budget) { groups.push(current); current = []; used = 0; }
    current.push(project);
    used += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * One decision from the decision model alone. What kind of message it is and how big the job is are
 * asked together with the first group of projects, in one request; further groups are asked in parallel,
 * and when several groups each name a project, one more request picks among those. Null when the model
 * could not answer any of it: the caller then lets Bob's own agent decide.
 */
export async function decideForBob(input: DecideInput): Promise<BobDecision | null> {
  if (!input.message.trim()) return null;
  const candidates = input.fixedProjectId ? input.projects.filter((project) => project.id === input.fixedProjectId) : input.projects;
  const groups = input.fixedProjectId || !candidates.length ? [[]] : groupProjects(candidates, input);
  const requests = groups.map((group, index) => {
    const asked: Record<string, SystemOneQuestion> = {};
    if (index === 0) { asked.kind = KIND; asked.size = SIZE; asked.autorespond = AUTO_RESPOND; }
    const project = group.length ? projectQuestion(group) : null;
    if (project) asked.project = project.question;
    return { asked, state: stateFor(input, group), byKey: project?.byKey ?? new Map<string, string>() };
  });
  const answers = await Promise.all(requests.map((request) => input.ask(request.state, request.asked)));
  if (answers.some((answer) => answer === null)) return null;
  const first = answers[0]!;
  let confidence = Math.min(first.kind.confidence, first.size.confidence);
  const autoRespond = first.autorespond.choice === "yes";
  let projectId: string | null = input.fixedProjectId ?? null;
  if (!input.fixedProjectId) {
    const named: Array<{ project: BobProjectOption; confidence: number }> = [];
    let noneConfidence = 1;
    answers.forEach((answer, index) => {
      const choice = answer!.project;
      if (!choice) return;
      const id = requests[index].byKey.get(choice.choice);
      if (id === undefined) { noneConfidence = Math.min(noneConfidence, choice.confidence); return; }
      named.push({ project: candidates.find((project) => project.id === id)!, confidence: choice.confidence });
    });
    if (named.length === 1) {
      projectId = named[0].project.id;
      confidence = Math.min(confidence, named[0].confidence);
    } else if (named.length > 1) {
      const final = projectQuestion(named.map((entry) => entry.project));
      const decided = await input.ask(stateFor(input, named.map((entry) => entry.project)), { project: final.question });
      if (!decided) return null;
      const id = final.byKey.get(decided.project.choice);
      projectId = id ?? null;
      confidence = Math.min(confidence, decided.project.confidence, ...named.map((entry) => entry.confidence));
    } else {
      confidence = Math.min(confidence, noneConfidence);
    }
  }
  return { kind: first.kind.choice as BobKind, size: first.size.choice as BobSize, projectId, autoRespond, confidence };
}

/** Bob's own agent decides when the decision model is missing, could not answer, or was not sure enough. */
export function needsAgentDecision(decision: BobDecision | null, threshold: number): boolean {
  return decision === null || decision.confidence < threshold;
}

export const DEFAULT_BOB_CONFIDENCE = 0.9;

export interface ConversationOption { id: string; title: string; summary: string | null }

const SUMMARY_CHARACTERS = 200;
const MAX_CONVERSATIONS = 8;

/**
 * Whether a task continues one of a project's recent conversations or starts a new one: one Choice question over the
 * conversations (by title and summary) and "new". Null when the model could not answer; `conversationId` is null for new.
 */
export async function chooseConversation(input: { message: string; recentChat: string[]; options: ConversationOption[]; ask: AskChoices; stateCharacters: number }): Promise<{ conversationId: string | null; confidence: number } | null> {
  const options = input.options.slice(0, MAX_CONVERSATIONS);
  if (!input.message.trim() || !options.length) return { conversationId: null, confidence: 1 };
  const byKey = new Map<string, string>();
  const criteria: Record<string, string> = {};
  options.forEach((option, index) => {
    const key = `conversation_${index}`;
    byKey.set(key, option.id);
    criteria[key] = `Continue the conversation "${option.title}".${option.summary ? ` ${option.summary.replace(/\s+/g, " ").slice(0, SUMMARY_CHARACTERS)}` : ""}`;
  });
  criteria[NONE] = "Start a new conversation: this is separate work, or nothing here is clearly the same work.";
  const state = JSON.stringify({ user_message: input.message, recent_chat: input.recentChat.slice(-RECENT_CHAT_LINES), conversations: options.map((option) => ({ title: option.title, summary: option.summary?.slice(0, SUMMARY_CHARACTERS) ?? null })) });
  if (state.length > input.stateCharacters) return null;
  const answer = await input.ask(state, { conversation: { instructions: "Does the user's message continue one of these conversations, or is it new work?", criteria } });
  if (!answer) return null;
  return { conversationId: byKey.get(answer.conversation.choice) ?? null, confidence: answer.conversation.confidence };
}
