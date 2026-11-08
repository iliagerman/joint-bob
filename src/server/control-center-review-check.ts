import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { actingAccountFromSession, runAsAccount, type ActingAccount } from "../account-context.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { appendBobMessage, askBobRecheck, bobDatabase, listBobAccounts, readBobSettings, type BobAction, type BobSettings } from "../control-center/bob-store.js";
import { isLeased } from "../control-center/leases.js";
import { bobStarter } from "../control-center/started.js";
import {
  answerHash, latestRequest, MAX_PUSHES, nextStep, PUSH_PREFIX, parseAgentVerdict, pushesSoFar, readReviewCheck, reasonFromAnswer, REVIEW_INSTRUCTIONS, REVIEW_QUESTION, reviewState,
  verdictOf, writeReviewCheck, type ReviewCheck, type ReviewVerdict,
} from "../control-center/review-check.js";
import { getAutoRespond } from "../conversation-auto-respond.js";
import { storedDigest } from "../conversation-digest.js";
import { sessionTitleOverrides } from "../names.js";
import { listQueuedPrompts } from "../prompt-queue.js";
import { getProject, projectVisible } from "../store.js";
import { bobDecisionModel } from "./bob.js";
import { titleOf } from "./control-center-start.js";
import { queueConversationPrompt, stopConversationTurn } from "./conversation-prompt.js";
import { runGitReview } from "./git-review-run.js";
import { harnessSessionBusy, onConversationMessage, type SharedHarnessSession } from "./harness-sessions.js";
import { agentFor } from "../background-agent.js";
import { projectsWithSharedNames } from "./projects.js";
import { broadcastToAllClients } from "./realtime.js";
import { markConversationDoneAsActor } from "./routes/projects.js";

/** Long enough for a queued message or auto respond to start first, so Bob only judges a conversation nothing else is moving. */
let checkDelayMs = 20_000;
/** For tests that run a whole node. */
export function setReviewCheckDelay(ms: number): void { checkDelayMs = ms; }

const pending = new Map<string, NodeJS.Timeout>();

const pushText = (reason: string): string => [
  `${PUSH_PREFIX}${reason ? ` (${reason.replace(/\.$/, "")})` : ""}.`,
  "Keep going until it is done, then say what you did. If you need something only I can decide, ask me.",
].join(" ");

export interface Conversation { projectId: string; projectName: string; conversationId: string; engine: string; sessionId: string; title: string }

async function decide(actor: ActingAccount, settings: BobSettings, conversation: Conversation, cwd: string, input: { request: string; summary: string | null; answer: string }): Promise<{ verdict: ReviewVerdict; reason: string; by: string } | null> {
  return runAsAccount(actor, async () => {
    const model = await bobDecisionModel(await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }), settings);
    if (model) {
      const state = reviewState(input, model.target.stateCharacters);
      const answer = state ? await askSystemOneChoices(model.target, state, { verdict: REVIEW_QUESTION }, model.apiKey) : null;
      const verdict = answer?.verdict ? verdictOf(answer.verdict.choice) : null;
      if (answer?.verdict && verdict && answer.verdict.confidence >= settings.threshold) {
        return { verdict, reason: reasonFromAnswer(input.answer), by: `Decision model ${Math.round(answer.verdict.confidence * 100)}%` };
      }
    }
    // The model is missing, could not answer, or was not sure enough: Bob's own agent reads the same and decides.
    const result = await runGitReview({
      projectId: conversation.projectId, cwd, ...agentFor(settings),
      selection: { scope: "context", label: "Bob review check" }, question: "",
      diff: JSON.stringify({ user_request: input.request, conversation_summary: input.summary, agent_last_message: input.answer.slice(-8000) }), instructions: REVIEW_INSTRUCTIONS,
    });
    const parsed = parseAgentVerdict(result.answer);
    return parsed ? { ...parsed, reason: parsed.reason || reasonFromAnswer(input.answer), by: model ? "Under the threshold, so Bob's agent decided" : "Bob's agent" } : null;
  });
}

async function push(actor: ActingAccount, conversation: Conversation, reason: string): Promise<void> {
  await runAsAccount(actor, () => queueConversationPrompt({
    projectId: conversation.projectId, engine: conversation.engine, sessionId: conversation.sessionId, message: pushText(reason),
    requestId: randomUUID(), label: "Bob", until: "started",
  }));
}

// The open button names the conversation, so Bob's chat can say which one a message is about.
const openAction = (conversation: Conversation): BobAction => ({ id: "open", label: "Open", data: { open: { projectId: conversation.projectId, conversationId: conversation.conversationId, title: conversation.title } } });
const pushAction = (conversation: Conversation): BobAction => ({ id: "review.push", label: "Push it on", style: "primary", data: { ...conversation } });
const doneAction = (conversation: Conversation): BobAction => ({ id: "conversation.done", label: "Done", data: { ...conversation } });
const abandonAction = (conversation: Conversation): BobAction => ({ id: "conversation.abandon", label: "Abandon", style: "warn", data: { ...conversation } });

/** Checks one conversation whose turn ended, as the person whose conversation it is, and acts on what is found. "busy" means the turn is still settling. */
async function check(shared: SharedHarnessSession, actor: ActingAccount, turnEndedAt: number): Promise<"busy" | void> {
  const db = await bobDatabase();
  const settings = readBobSettings(db, actor.accountId);
  if (!settings.monitoring || settings.reviewCheck === "off") return;
  if (shared.turnInFlight > 0 || harnessSessionBusy(shared)) return "busy";
  // Something else is moving it, or the person is in it: nothing to judge.
  if (listQueuedPrompts(`${shared.projectId}:${shared.conversationId}`).length) return;
  if (isLeased(shared.projectId, shared.conversationId)) return;
  // Auto respond answers for the agent; when it stopped on this turn, it already brought the conversation to the person.
  const responder = await getAutoRespond(shared.projectId, shared.conversationId);
  if (responder?.status === "active" || (responder?.status === "stopped" && Date.parse(responder.updatedAt) >= turnEndedAt - AUTO_RESPOND_SLACK_MS)) return;
  const messages = shared.session.messages;
  const answer = [...messages].reverse().find((message) => message.role === "assistant")?.text?.trim();
  if (!answer) return;
  const previous = readReviewCheck(db, shared.projectId, shared.conversationId);
  // The same words can end two turns ("Done."); the count of messages tells the turns apart.
  const hash = answerHash(`${messages.length}:${answer}`);
  if (previous?.answerHash === hash) return;
  const project = await getProject(shared.projectId);
  if (!project || !await runAsAccount(actor, () => projectVisible(project.id))) return;
  const request = latestRequest(messages);
  const conversation: Conversation = {
    projectId: project.id, projectName: project.name, conversationId: shared.conversationId, engine: shared.engine, sessionId: shared.session.id,
    title: (await sessionTitleOverrides())[shared.session.id] ?? titleOf(request || answer),
  };
  const decided = await decide(actor, settings, conversation, project.path, { request, summary: storedDigest(project.id, shared.conversationId)?.summary ?? null, answer });
  if (!decided) { console.warn(`Bob could not tell whether "${conversation.title}" is done`); return; }
  const pushes = pushesSoFar(previous);
  const step = nextStep(decided.verdict, settings.reviewCheck, pushes);
  const record: ReviewCheck = {
    projectId: project.id, conversationId: shared.conversationId, accountId: actor.accountId, verdict: decided.verdict, reason: decided.reason, by: decided.by, answerHash: hash,
    pushes, pushPending: false, needsYou: step === "tell" || step === "ask", checkedAt: new Date().toISOString(),
  };
  const label = { projectId: project.id, projectName: project.name, via: `Review check · ${decided.by}` };
  if (step === "push") {
    await push(actor, conversation, decided.reason);
    writeReviewCheck(db, { ...record, pushes: pushes + 1, pushPending: true });
    appendBobMessage(db, actor.accountId, { role: "bob", importance: "fyi", text: `"${conversation.title}" stopped before it was done, so I told it to go on (${pushes + 1} of ${MAX_PUSHES}).${decided.reason ? `\n${decided.reason}` : ""}`, actions: [openAction(conversation), abandonAction(conversation)], ...label });
  } else {
    writeReviewCheck(db, record);
    if (step === "ask") {
      appendBobMessage(db, actor.accountId, { role: "bob", importance: "needs-you", text: `"${conversation.title}" stopped before it was done.${decided.reason ? `\n${decided.reason}` : ""}\nShall I tell it to go on?`, actions: [pushAction(conversation), doneAction(conversation), abandonAction(conversation), openAction(conversation), { id: "review.leave", label: "Leave it", data: { projectId: project.id, conversationId: shared.conversationId } }], ...label });
    } else if (step === "tell") {
      const text = decided.verdict === "continue"
        ? `I told "${conversation.title}" to go on ${MAX_PUSHES} times and it is still not done.${decided.reason ? `\n${decided.reason}` : ""}`
        : `"${conversation.title}" waits for you.${decided.reason ? `\n${decided.reason}` : ""}`;
      appendBobMessage(db, actor.accountId, { role: "bob", importance: "needs-you", text, actions: [pushAction(conversation), doneAction(conversation), abandonAction(conversation), openAction(conversation)], ...label });
    }
  }
  broadcastToAllClients({ type: "controlCenterChanged" }, actor.accountId);
  // What Bob found settles his older items about it: a newer one replaces them, and a note that he pushed it on has its answer.
  askBobRecheck(actor.accountId);
}

const BUSY_RETRIES = 5;
/** Auto respond stops a moment after the turn it judged; a stop this close to the turn's end is about that turn. */
const AUTO_RESPOND_SLACK_MS = 5_000;

/**
 * Whose conversation it is decides whose Bob checks it; nobody else's Bob acts on it. The person who sent the turn, or, for a
 * turn Bob sent (his push, or the brief of a conversation he started), the person he sent it for.
 */
async function ownerOf(shared: SharedHarnessSession, turnAccountId: string | null): Promise<ActingAccount | undefined> {
  const db = await bobDatabase();
  const accountId = turnAccountId ?? readReviewCheck(db, shared.projectId, shared.conversationId)?.accountId ?? await bobStarter(shared.projectId, shared.session.id);
  return accountId ? listBobAccounts(db).find((candidate) => candidate.accountId === accountId) : undefined;
}

function schedule(shared: SharedHarnessSession, turnAccountId: string | null, turnEndedAt: number, attempt: number): void {
  const key = `${shared.projectId}:${shared.conversationId}`;
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    void (async () => {
      const owner = await ownerOf(shared, turnAccountId);
      if (owner && await check(shared, owner, turnEndedAt) === "busy" && attempt < BUSY_RETRIES) schedule(shared, turnAccountId, turnEndedAt, attempt + 1);
    })().catch((error) => console.warn("Bob's review check failed", error instanceof Error ? error.message : error));
  }, checkDelayMs).unref());
}

let started = false;

/** Starts checking conversations as their turns end. Safe to call more than once. */
export function startReviewChecks(): void {
  if (started) return;
  started = true;
  onConversationMessage((shared) => {
    if (shared.scheduledTurn || shared.internalTurn) return;
    // Read now: the turn's person is forgotten once it ends.
    const turnAccountId = shared.turnAccountId ?? null;
    schedule(shared, turnAccountId, Date.now(), 0);
  });
}

const conversationData = z.object({ projectId: z.string().min(1), projectName: z.string(), conversationId: z.string().min(1), engine: z.string().min(1), sessionId: z.string().min(1), title: z.string() });

registerBobAction("review.push", async ({ db, session, action }) => {
  const conversation = conversationData.parse(action.data);
  if (isLeased(conversation.projectId, conversation.conversationId)) return [bobSays(db, session, `You are in "${conversation.title}" now, so I left it to you.`, { projectId: conversation.projectId, projectName: conversation.projectName })];
  const previous = readReviewCheck(db, conversation.projectId, conversation.conversationId);
  await push(actingAccountFromSession(session), conversation, previous?.reason ?? "");
  if (previous) writeReviewCheck(db, { ...previous, pushes: previous.pushes + 1, pushPending: true, needsYou: false });
  return [bobSays(db, session, `Told "${conversation.title}" to go on.`, { importance: "done", projectId: conversation.projectId, projectName: conversation.projectName, via: "Review check · you pressed the button" })];
});

/**
 * Closes the conversation as the person, as marking it done in its project does; abandoning stops it first (its turn, auto
 * respond, a step waiting for an answer). Bob's check of it ends either way, and his other items about it are cleared. The
 * pressed item leaves the chat, which says it all: nothing new is written.
 */
export async function closeConversation(session: AuthSession, db: DatabaseSync, conversation: Conversation, abandoned: boolean): Promise<void> {
  await runAsAccount(actingAccountFromSession(session), async () => {
    if (abandoned) await stopConversationTurn({ projectId: conversation.projectId, engine: conversation.engine, sessionId: conversation.sessionId, label: "Bob" });
    await markConversationDoneAsActor(conversation.projectId, { engine: conversation.engine, sessionId: conversation.sessionId, done: true });
  });
  const previous = readReviewCheck(db, conversation.projectId, conversation.conversationId);
  if (previous) writeReviewCheck(db, { ...previous, verdict: "done", reason: abandoned ? "You abandoned it." : "You marked it done.", by: "you", needsYou: false, pushPending: false });
  broadcastToAllClients({ type: "controlCenterChanged" }, session.accountId);
  askBobRecheck(session.accountId);
}

registerBobAction("conversation.done", async ({ db, session, action }) => {
  await closeConversation(session, db, conversationData.parse(action.data), false);
});

registerBobAction("conversation.abandon", async ({ db, session, action }) => {
  await closeConversation(session, db, conversationData.parse(action.data), true);
});

registerBobAction("review.leave", async ({ db, action }) => {
  const { projectId, conversationId } = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1) }).parse(action.data);
  const previous = readReviewCheck(db, projectId, conversationId);
  if (previous) writeReviewCheck(db, { ...previous, verdict: "done", reason: "You chose to leave it for review.", by: "you", needsYou: false, pushPending: false });
});
