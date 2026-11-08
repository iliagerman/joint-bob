import type { DatabaseSync } from "node:sqlite";
import type { AuthSession } from "../auth.js";
import { runAsAccount } from "../account-context.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import {
  bobDatabase, listBobAccounts, listBobMessages, listOpenBobMessages, noteBobRecheck, onBobMessage, onBobRecheckAsked, readBobSettings, resolveBobMessage, settleButtonlessItems,
  type BobMessage, type BobSettings,
  type OpenBobMessage,
} from "../control-center/bob-store.js";
import {
  evidenceHash, isOpenItem, RELEVANCE_QUESTION, relevanceEvidence, relevanceState, replacedItems, settledByFacts, subjectKey, subjectOf, type ConversationNow,
} from "../control-center/recheck.js";
import { readReviewCheck } from "../control-center/review-check.js";
import { storedDigest } from "../conversation-digest.js";
import { allPendingGuardianReviews, onGuardianEvent } from "../guardian/reviews.js";
import { getProject, projectVisible } from "../store.js";
import { bobDecisionModel } from "./bob.js";
import { bobSessionFor } from "./control-center-session.js";
import { onConversationTurn } from "./harness-sessions.js";
import { projectsWithSharedNames } from "./projects.js";
import { sharedProjectSessions } from "./sessions-helpers.js";

/** Every few minutes each person's open items are checked again, so the chat keeps showing only what still waits for them. */
const SWEEP_MS = 2 * 60_000;
/** A review or a close is often one of several in a row: one check follows them all. */
const SOON_MS = 1_500;
/** The decision model judges an item only once the person has had time to act on it. */
let modelAfterMs = 10 * 60_000;
/** For tests that run a whole node. */
export function setRecheckModelDelay(ms: number): void { modelAfterMs = ms; }
/** At most this many decision model questions per person per sweep. */
const MODEL_QUESTIONS = 8;

const chains = new Map<string, Promise<void>>();
const soon = new Map<string, NodeJS.Timeout>();

/** Where each conversation the items are about stands for the person (one listing per project), and when Bob last checked it. */
async function conversationsOf(db: DatabaseSync, items: BobMessage[], session: AuthSession): Promise<Map<string, ConversationNow>> {
  const wanted = new Map<string, Set<string>>();
  for (const item of items) {
    const subject = subjectOf(item);
    if (subject?.kind === "conversation") wanted.set(subject.projectId, (wanted.get(subject.projectId) ?? new Set()).add(subject.conversationId));
  }
  const found = new Map<string, ConversationNow>();
  for (const [projectId, conversationIds] of wanted) {
    const project = await getProject(projectId);
    const sessions = project && await projectVisible(projectId) ? await sharedProjectSessions(project, session.userId, session.accountId) : [];
    for (const conversationId of conversationIds) {
      const entry = sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === conversationId);
      const state = !entry ? "missing" : entry.running ? "running" : entry.doneAt ? "done" : entry.reviewState === "reviewed" ? "reviewed" : "waiting";
      found.set(`${projectId}:${conversationId}`, {
        state, updatedAt: entry?.updatedAt ?? null, title: entry?.title ?? null, summary: storedDigest(projectId, conversationId)?.summary ?? null,
        checkedAt: readReviewCheck(db, projectId, conversationId)?.checkedAt ?? null,
      });
    }
  }
  return found;
}

/**
 * Asks the decision model about items the facts left open: only items this machine wrote, old enough, whose evidence changed
 * since it was last judged. Settled with enough confidence clears the item; anything else keeps it.
 */
async function askAboutTheRest(db: DatabaseSync, accountId: string, settings: BobSettings, items: OpenBobMessage[], conversations: Map<string, ConversationNow>): Promise<void> {
  if (!settings.monitoring) return;
  const timeline = listBobMessages(db, accountId, { limit: 300 });
  const due = items.flatMap((item) => {
    if (item.originNodeId || Date.now() - Date.parse(item.createdAt) < modelAfterMs) return [];
    const subject = subjectOf(item);
    const later = timeline.filter((message) => message.createdAt > item.createdAt && message.id !== item.id && (!message.projectId || message.projectId === item.projectId));
    const evidence = relevanceEvidence(item, subject?.kind === "conversation" ? conversations.get(subjectKey(subject)) ?? null : null, later);
    const hash = evidenceHash(evidence);
    return hash === item.recheckHash ? [] : [{ item, evidence, hash }];
  }).slice(0, MODEL_QUESTIONS);
  if (!due.length) return;
  const model = await bobDecisionModel(await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), settings);
  if (!model) return;
  for (const { item, evidence, hash } of due) {
    const state = relevanceState(evidence, Math.round((Date.now() - Date.parse(item.createdAt)) / 60_000), model.target.stateCharacters);
    const answer = state ? await askSystemOneChoices(model.target, state, { relevance: RELEVANCE_QUESTION }, model.apiKey) : null;
    // No answer is asked again next time; an answer is kept, so the same evidence is not asked about twice.
    if (!answer) continue;
    noteBobRecheck(db, accountId, item.id, hash);
    if (answer.relevance.choice === "settled" && answer.relevance.confidence >= settings.threshold) {
      resolveBobMessage(db, accountId, item.id, `Bob's decision model found it settled by what happened since (${Math.round(answer.relevance.confidence * 100)}%).`);
    }
  }
}

/** Checks one person's open items: what the facts settle is cleared, the rest goes to the decision model. */
async function recheck(accountId: string): Promise<void> {
  const db = await bobDatabase();
  const actor = listBobAccounts(db).find((candidate) => candidate.accountId === accountId);
  const session = bobSessionFor(accountId, "recheck");
  if (!actor || !session) return;
  settleButtonlessItems(db, accountId, "Its buttons were used, or it was cleared on another machine, before this version kept that.");
  const items = listOpenBobMessages(db, accountId).filter(isOpenItem);
  if (!items.length) return;
  await runAsAccount(actor, async () => {
    const conversations = await conversationsOf(db, items, session);
    const pending = new Set(allPendingGuardianReviews().map((review) => review.id));
    const replaced = replacedItems(items);
    const open: OpenBobMessage[] = [];
    for (const item of items) {
      const subject = subjectOf(item);
      const settled = settledByFacts(item, {
        // Only the machine that wrote a Guardian item has its step.
        guardianPending: subject?.kind === "guardian" && !item.originNodeId ? pending.has(subject.reviewId) : undefined,
        conversation: subject?.kind === "conversation" ? conversations.get(subjectKey(subject)) : undefined,
        replaced: replaced.has(item.id),
      });
      if (settled) resolveBobMessage(db, accountId, item.id, settled);
      else if (subject?.kind !== "guardian") open.push(item);
    }
    await askAboutTheRest(db, accountId, readBobSettings(db, accountId), open, conversations);
  });
}

/** Checks a person's items again shortly; checks for one person never overlap. */
export function recheckSoon(accountId: string): void {
  clearTimeout(soon.get(accountId));
  soon.set(accountId, setTimeout(() => {
    soon.delete(accountId);
    const next = (chains.get(accountId) ?? Promise.resolve()).then(() => recheck(accountId))
      .catch((error) => console.warn("Bob could not check his open items again", error instanceof Error ? error.message : error));
    chains.set(accountId, next);
  }, SOON_MS).unref());
}

async function recheckEveryone(): Promise<void> {
  for (const actor of listBobAccounts(await bobDatabase())) recheckSoon(actor.accountId);
}

/** A conversation's turn started or ended: whoever has open items about it has them checked again now, not at the next sweep. */
async function recheckAbout(projectId: string, conversationId: string): Promise<void> {
  const db = await bobDatabase();
  for (const actor of listBobAccounts(db)) {
    const about = listOpenBobMessages(db, actor.accountId).some((item) => {
      const subject = subjectOf(item);
      return subject?.kind === "conversation" && subject.projectId === projectId && subject.conversationId === conversationId;
    });
    if (about) recheckSoon(actor.accountId);
  }
}

let started = false;

/**
 * Starts checking open items again: on a timer, when the person reviews or closes a conversation, when a conversation's turn
 * starts or ends, when a Guardian step is answered, and when the person writes to Bob (what they say is part of the log the
 * decision model reads).
 */
export function startBobRecheck(): void {
  if (started) return;
  started = true;
  const everyone = () => void recheckEveryone().catch((error) => console.warn("Bob could not check his open items again", error instanceof Error ? error.message : error));
  setInterval(everyone, SWEEP_MS).unref();
  onBobRecheckAsked(recheckSoon);
  onGuardianEvent(everyone);
  onBobMessage((accountId, message) => { if (message.role === "user") recheckSoon(accountId); });
  onConversationTurn((shared) => void recheckAbout(shared.projectId, shared.conversationId)
    .catch((error) => console.warn("Bob could not check his open items again", error instanceof Error ? error.message : error)));
}
