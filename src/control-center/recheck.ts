import { createHash } from "node:crypto";
import type { SystemOneQuestion } from "../classifiers/typesafe.js";
import type { BobAction, BobMessage } from "./bob-store.js";

/**
 * Bob's open items are checked again every few minutes, and at once when the person reviews or closes a conversation, so the
 * chat only shows what still waits for them. What the facts settle (the conversation was marked done, looked at, answered or
 * moved on, a newer item about it came, the Guardian step was answered) is cleared at once. What they cannot settle, the
 * decision model judges from the log of what happened since: the person's later messages, Bob's answers, and the items cleared
 * after it. Unsure means the item stays.
 */

/** A button the page runs by itself (open a conversation, undo a display change): it asks nothing of the person. */
const pageOnly = (action: BobAction): boolean => Boolean(action.data && ("open" in action.data || "appearance" in action.data));

/** An item: a message that waits for the person to press one of its buttons. */
export function isOpenItem(message: BobMessage): boolean {
  return !message.resolvedAt && message.importance !== "report" && message.actions.some((action) => !pageOnly(action));
}

export type ItemSubject = { kind: "guardian"; reviewId: string } | { kind: "conversation"; projectId: string; conversationId: string };

/** What an item is about, as its buttons name it: a Guardian step, or a conversation. Null for anything else. */
export function subjectOf(item: BobMessage): ItemSubject | null {
  const guardian = item.actions.find((action) => action.id.startsWith("guardian.") && typeof action.data?.reviewId === "string");
  if (guardian) return { kind: "guardian", reviewId: guardian.data!.reviewId as string };
  if (!item.projectId) return null;
  for (const action of item.actions) {
    const conversationId = (action.data?.open as { conversationId?: unknown } | undefined)?.conversationId ?? action.data?.conversationId;
    if (typeof conversationId === "string") return { kind: "conversation", projectId: item.projectId, conversationId };
  }
  return null;
}

export const subjectKey = (subject: ItemSubject): string => subject.kind === "guardian" ? `guardian:${subject.reviewId}` : `${subject.projectId}:${subject.conversationId}`;

/** Where a conversation stands for the person, as their project's list shows it. */
export interface ConversationNow { state: "running" | "waiting" | "reviewed" | "done" | "missing"; updatedAt: string | null; title: string | null; summary: string | null }

/** Items about a conversation that a newer open item about the same conversation replaced. */
export function replacedItems(items: BobMessage[]): Set<string> {
  const newest = new Map<string, BobMessage>();
  for (const item of items) {
    const subject = subjectOf(item);
    if (subject?.kind !== "conversation") continue;
    const held = newest.get(subjectKey(subject));
    if (!held || item.createdAt >= held.createdAt) newest.set(subjectKey(subject), item);
  }
  const newestIds = new Set([...newest.values()].map((item) => item.id));
  return new Set(items.filter((item) => subjectOf(item)?.kind === "conversation" && !newestIds.has(item.id)).map((item) => item.id));
}

/** How long after an item its conversation's own activity counts as moving on, past what ended the turn the item is about. */
const MOVED_ON_MS = 60_000;

export interface ItemFacts {
  /** For a Guardian item this machine wrote: whether its step still waits. Unknown elsewhere. */
  guardianPending?: boolean;
  conversation?: ConversationNow;
  replaced: boolean;
}

/** Why an item no longer waits for the person, from facts alone; null when the facts do not settle it. */
export function settledByFacts(item: BobMessage, facts: ItemFacts): string | null {
  const subject = subjectOf(item);
  if (subject?.kind === "guardian") return facts.guardianPending === false ? "The step was answered, or it timed out." : null;
  if (subject?.kind !== "conversation") return null;
  if (facts.replaced) return "A newer message about it replaced it.";
  const now = facts.conversation;
  if (!now) return null;
  if (now.state === "done") return "It was marked done.";
  if (now.state === "reviewed") return "You looked at it.";
  // A note that Bob pushed it on is about the turn that runs now; an item that asks the person is settled by their answer.
  if (item.importance === "fyi") return null;
  if (now.state === "running") return "It is running again.";
  if (now.updatedAt && Date.parse(now.updatedAt) > Date.parse(item.createdAt) + MOVED_ON_MS) return "It moved on since.";
  return null;
}

// ── The decision model, for what the facts leave open ──────────────────────────────────────────────────────

export const RELEVANCE_QUESTION: SystemOneQuestion = {
  instructions: "Bob, the user's assistant, posted this item in the user's control center because it needed the user. Given what it is about and the log of what happened since it was posted, does it still need the user?",
  criteria: {
    still_needed: "Nothing in the log settles it: the user has not done, answered or dismissed what it asks, and it is still current.",
    settled: "The log settles it or makes it pointless: the user did or answered it another way, told Bob to drop it, a later message replaced it, or what it is about is finished, closed or gone.",
  },
};

const ITEM_CHARACTERS = 1_200;
const SUMMARY_CHARACTERS = 1_200;
const ENTRY_CHARACTERS = 300;
const LOG_ENTRIES = 10;

export interface RelevanceEvidence {
  item: { posted_at: string; source: string | null; text: string; buttons: string[] };
  conversation: { title: string | null; state: ConversationNow["state"]; last_activity_at: string | null; summary: string | null } | null;
  /** What happened since, oldest first: the person's messages, Bob's answers, and items cleared since with why. */
  log: Array<{ at: string; from: "user" | "Bob"; text: string }>;
}

/** What the decision model reads about an item. `later` is the chat after it, in its project and about no project. */
export function relevanceEvidence(item: BobMessage, conversation: ConversationNow | null, later: BobMessage[]): RelevanceEvidence {
  return {
    item: { posted_at: item.createdAt, source: item.via, text: item.text.slice(0, ITEM_CHARACTERS), buttons: item.actions.map((action) => action.label) },
    conversation: conversation && { title: conversation.title, state: conversation.state, last_activity_at: conversation.updatedAt, summary: conversation.summary?.slice(0, SUMMARY_CHARACTERS) ?? null },
    log: later.slice(-LOG_ENTRIES).map((message) => ({
      at: message.createdAt, from: message.role === "user" ? "user" as const : "Bob" as const,
      text: `${message.text.slice(0, ENTRY_CHARACTERS)}${message.resolvedAt ? ` [cleared: ${message.resolution}]` : ""}`,
    })),
  };
}

/** The same evidence is judged once: an item is asked about again only when something in it changed. */
export const evidenceHash = (evidence: RelevanceEvidence): string => createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

/** The state sent to the decision model, within its budget: the oldest log entries go first. Null when even the item does not fit. */
export function relevanceState(evidence: RelevanceEvidence, minutesAgo: number, budget: number): string | null {
  for (let skip = 0; skip <= evidence.log.length; skip += 1) {
    const state = JSON.stringify({ ...evidence, posted_minutes_ago: minutesAgo, log: evidence.log.slice(skip) });
    if (state.length <= budget) return state;
  }
  return null;
}
