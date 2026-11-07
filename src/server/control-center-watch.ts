import { actingAccountFromSession, runAsAccount, type ActingAccount } from "../account-context.js";
import { bobSays, registerBobAction } from "../control-center/bob-actions.js";
import { appendBobMessage, bobDatabase, listBobAccounts, onBobMessage, onBobTimelineChanged, readBobSettings } from "../control-center/bob-store.js";
import { disableAutoRespond, enableAutoRespond, getAutoRespond, onAutoRespondStopped, type AutoRespondState } from "../conversation-auto-respond.js";
import { allPendingGuardianReviews, decideGuardianReview, onGuardianEvent, type GuardianReview } from "../guardian/reviews.js";
import { isLeased } from "../control-center/leases.js";
import { sessionTitleOverrides } from "../names.js";
import { getProject, projectVisible } from "../store.js";
import { titleOf } from "./control-center-start.js";
import { harnessSessions } from "./harness-sessions.js";
import { broadcastToAllClients } from "./realtime.js";

/** The conversation's title, for saying which one a notice is about: its own title, or its first message. Null when this machine has not opened it. */
async function conversationTitle(projectId: string, conversationId: string): Promise<string | null> {
  const shared = [...harnessSessions.values()].find((entry) => entry.projectId === projectId && entry.conversationId === conversationId);
  if (!shared) return null;
  const first = shared.session.messages.find((message) => message.role === "user" && message.text?.trim())?.text;
  return (await sessionTitleOverrides())[shared.session.id] ?? (first ? titleOf(first) : null);
}

/** Who is told about something in a project: people who use Bob, can see the project, and have not paused Bob. */
async function watchers(projectId: string): Promise<ActingAccount[]> {
  const db = await bobDatabase();
  const found: ActingAccount[] = [];
  for (const actor of listBobAccounts(db)) {
    if (readBobSettings(db, actor.accountId).monitoring && await runAsAccount(actor, () => projectVisible(projectId))) found.push(actor);
  }
  return found;
}

// ── Guardian: a step that needs the person's OK shows in the chat with the buttons to answer it ──────────

async function announceReview(review: GuardianReview): Promise<void> {
  const project = await getProject(review.projectId);
  const title = await conversationTitle(review.projectId, review.conversationId);
  const db = await bobDatabase();
  for (const actor of await watchers(review.projectId)) {
    appendBobMessage(db, actor.accountId, {
      role: "system", importance: "needs-ok", projectId: review.projectId, projectName: project?.name ?? null,
      text: `${title ? `"${title}": ` : ""}${review.title}\n${review.subject}\n${review.detail}`,
      via: "Guardian · production or destructive steps always ask you. Bob never answers these for you.",
      actions: [
        { id: "guardian.allow", label: "Allow once", style: "warn", data: { projectId: review.projectId, conversationId: review.conversationId, reviewId: review.id } },
        { id: "guardian.block", label: "Block", data: { projectId: review.projectId, conversationId: review.conversationId, reviewId: review.id } },
        { id: "open", label: "Open", data: { open: { projectId: review.projectId, conversationId: review.conversationId, ...(title ? { title } : {}) } } },
      ],
    });
  }
}

function answerReview(decision: "allow" | "block"): Parameters<typeof registerBobAction>[1] {
  return async ({ db, session, message, action }) => {
    const data = action.data as { projectId: string; conversationId: string; reviewId: string };
    // The person pressed the button, so the answer is theirs; Bob only carries it.
    const done = await runAsAccount(actingAccountFromSession(session), async () =>
      (await projectVisible(data.projectId)) && decideGuardianReview(data.projectId, data.conversationId, data.reviewId, decision));
    // The question leaves the chat once answered, so the answer names the step.
    const step = message.text.split("\n")[0];
    return [bobSays(db, session, done ? `${decision === "allow" ? "Allowed once" : "Blocked"}: ${step}` : `That review was already answered, or it timed out and was blocked: ${step}`, { importance: "fyi", projectId: data.projectId })];
  };
}

// ── Auto respond: when it stops, Bob says why and what the person can do ─────────────────────────────────

const STOP_LABELS: Record<NonNullable<AutoRespondState["stopKind"]>, { importance: "needs-you" | "urgent" | "fyi"; text: string }> = {
  "stop-instruction": { importance: "needs-you", text: "Auto respond stopped because the agent needs you" },
  limit: { importance: "needs-you", text: "Auto respond reached its limit" },
  "turn-failed": { importance: "urgent", text: "The agent's turn failed, so auto respond stopped" },
  "responder-failed": { importance: "urgent", text: "The responder failed, so auto respond stopped" },
  budget: { importance: "needs-you", text: "Auto respond stopped: no budget is left" },
  "user-stopped": { importance: "fyi", text: "You stopped auto respond" },
};

async function announceAutoRespondStopped(state: AutoRespondState): Promise<void> {
  if (!state.stopKind || state.stopKind === "user-stopped") return;
  const project = await getProject(state.projectId);
  const title = await conversationTitle(state.projectId, state.conversationId);
  const db = await bobDatabase();
  const label = STOP_LABELS[state.stopKind];
  for (const actor of await watchers(state.projectId)) {
    appendBobMessage(db, actor.accountId, {
      role: "system", importance: label.importance, projectId: state.projectId, projectName: project?.name ?? null,
      text: `${title ? `"${title}": ` : ""}${label.text}.${state.stopReason ? `\n${state.stopReason}` : ""}`,
      via: "Auto respond ended · Bob was told",
      actions: [
        { id: "open", label: "Open the conversation", style: "primary", data: { open: { projectId: state.projectId, conversationId: state.conversationId, ...(title ? { title } : {}) } } },
        { id: "autorespond.resume", label: "Turn auto respond on again", data: { projectId: state.projectId, conversationId: state.conversationId } },
        { id: "autorespond.off", label: "Leave it to me", data: { projectId: state.projectId, conversationId: state.conversationId } },
      ],
    });
  }
}

/**
 * Whether auto respond must not answer for the agent right now: the person has taken control of the conversation, or Bob is
 * paused and Bob is the one that turned it on. A responder the person turned on themselves is theirs, and keeps running.
 */
export async function autoRespondHeldBack(state: AutoRespondState): Promise<boolean> {
  if (isLeased(state.projectId, state.conversationId)) return true;
  if (state.enabledBy !== null || !state.creatorAccountId) return false;
  return !readBobSettings(await bobDatabase(), state.creatorAccountId).monitoring;
}

let started = false;

/** Starts listening. Safe to call more than once. */
export function startControlCenterWatch(): void {
  if (started) return;
  started = true;
  // Open pages learn at once that Bob has something new, instead of asking on a timer.
  onBobMessage((accountId) => broadcastToAllClients({ type: "controlCenterChanged" }, accountId));
  onBobTimelineChanged((accountId) => broadcastToAllClients({ type: "controlCenterChanged" }, accountId));
  onGuardianEvent((event) => {
    broadcastToAllClients({ type: "controlCenterChanged" });
    if (event.type !== "reviews" || !allPendingGuardianReviews().some((review) => review.id === event.review.id)) return;
    void announceReview(event.review).catch((error) => console.warn("Bob could not announce a Guardian review", error instanceof Error ? error.message : error));
  });
  onAutoRespondStopped((state) => {
    void announceAutoRespondStopped(state).catch((error) => console.warn("Bob could not announce an auto respond stop", error instanceof Error ? error.message : error));
  });
  registerBobAction("guardian.allow", answerReview("allow"));
  registerBobAction("guardian.block", answerReview("block"));
  registerBobAction("autorespond.resume", async ({ db, session, action }) => {
    const data = action.data as { projectId: string; conversationId: string };
    const state = await getAutoRespond(data.projectId, data.conversationId);
    if (!state) return [bobSays(db, session, "That conversation has no auto respond to turn on again.", { projectId: data.projectId })];
    const { projectId: _p, conversationId: _c, status: _s, stopKind: _k, stopReason: _r, responses: _n, answeredKey: _a, enabledBy, revision: _v, updatedAt: _u, creatorAccountId, retry: _t, sourcePromptId: _sp, sourceRequestId: _sr, ...config } = state;
    await enableAutoRespond(data.projectId, data.conversationId, config, enabledBy, creatorAccountId ?? session.accountId);
    return [bobSays(db, session, "Auto respond is on again for that conversation.", { projectId: data.projectId })];
  });
  registerBobAction("autorespond.off", async ({ db, session, action }) => {
    const data = action.data as { projectId: string; conversationId: string };
    await disableAutoRespond(data.projectId, data.conversationId);
    return [bobSays(db, session, "Auto respond is off for that conversation. It is yours now.", { projectId: data.projectId })];
  });
}
