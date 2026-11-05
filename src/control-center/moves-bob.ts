import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { askSystemOneChoices, type SystemOneTarget } from "../classifiers/typesafe.js";
import { loadBoard } from "../server/control-center-board.js";
import { runGitReview } from "../server/git-review-run.js";
import { iconHarnessId } from "../server/label-icon.js";
import type { BobReply } from "../server/bob.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { registerBobAction, type BobActionContext } from "./bob-actions.js";
import { appendBobMessage, bobDatabase, type BobMessage, type BobSettings } from "./bob-store.js";
import { decideMoveIntent, type IntentCard } from "./moves-intent.js";
import { createMoveEnvironment, listMoveNodes } from "./moves-runtime.js";
import { planMoves, plural, proposalText, startMoveJob, summarizeMoveJob, type MoveMode, type MovePlan, type MovePlanEntry } from "./moves.js";

/**
 * "Move all my running jobs from the Mac to the homeserver", said to Bob. Bob reads the message, checks each
 * unfinished conversation against the destination, and answers with what will and will not move and two buttons. The
 * button is the one confirmation for the whole batch: pressing it starts the moves and Bob reports when they are done.
 */

const AFTER_TURN = "moves.after-turn";
const NOW = "moves.now";
const CANCEL = "moves.cancel";

const buttonData = z.object({
  targetId: z.string().uuid(),
  conversations: z.array(z.object({ projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(300) }).strict()).min(1).max(100),
}).strict();

export interface BobMoveRequest {
  session: AuthSession;
  message: string;
  recentChat: string[];
  settings: BobSettings;
  projects: ProjectRecord[];
  /** The decision model Bob uses; null when none is set up. */
  model: { target: SystemOneTarget; apiKey: string } | null;
}

const FALLBACK_STATE_CHARACTERS = 4_000;

/** Bob's agent, asked for a one-line answer. A run that fails is logged and treated as no answer: Bob's usual path then meets the same failure in the open. */
function agentAsker(projects: ProjectRecord[], settings: BobSettings): ((prompt: string) => Promise<string>) | null {
  const project = projects[0];
  if (!project) return null;
  return async (prompt) => {
    try {
      const result = await runGitReview({
        projectId: project.id, cwd: project.path, harnessId: (settings.harnessId || iconHarnessId()) as HarnessId,
        provider: settings.provider, modelId: settings.modelId, thinkingLevel: settings.thinkingLevel,
        selection: { scope: "context", label: "Bob" }, question: prompt, diff: "", instructions: prompt,
      });
      return result.answer;
    } catch (error) {
      console.warn("Bob's agent could not tell whether this asks to move jobs", error instanceof Error ? error.message : error);
      return "";
    }
  };
}

function proposalActions(plan: MovePlan, movable: MovePlanEntry[]): BobMessage["actions"] {
  const data = { targetId: plan.target.id, conversations: movable.map((entry) => entry.ref) };
  return [
    { id: AFTER_TURN, label: `Move ${movable.length}`, style: "primary", data },
    { id: NOW, label: "Stop and move all now", style: "warn", data },
    { id: CANCEL, label: "Cancel" },
  ];
}

/** Null when the message is not about moving jobs, so Bob answers it the usual way. */
export async function handleBobMoveRequest(request: BobMoveRequest): Promise<BobReply | null> {
  const nodes = await listMoveNodes();
  // With one machine there is nowhere to move to.
  if (nodes.length < 2) return null;
  const { cards } = await loadBoard(request.session);
  const unfinished = cards.filter((card) => card.column !== "review");
  const intentCards: IntentCard[] = unfinished.map((card) => ({ projectId: card.projectId, conversationId: card.conversationId, title: card.title, projectName: card.projectName }));
  const intent = await decideMoveIntent({
    message: request.message, recentChat: request.recentChat, nodes, cards: intentCards,
    ask: request.model ? (state, questions) => askSystemOneChoices(request.model!.target, state, questions, request.model!.apiKey) : null,
    askAgent: agentAsker(request.projects, request.settings),
    threshold: request.settings.threshold,
    stateCharacters: request.model?.target.stateCharacters ?? FALLBACK_STATE_CHARACTERS,
  });
  if (intent.kind === "other") return null;

  const db = await bobDatabase();
  const accountId = request.session.accountId;
  const user = appendBobMessage(db, accountId, { role: "user", text: request.message });
  const answer = (text: string, extra: Partial<BobMessage> = {}): BobReply => ({
    action: "answer", user, projectId: null,
    reply: appendBobMessage(db, accountId, { role: "bob", text, ...extra }),
  });

  if (intent.kind === "unclear") {
    return answer(`Which machine should I move them to? I know ${nodes.map((node) => node.name).join(", ")}.`, { via: `Move jobs · ${intent.by}`, importance: "needs-you" });
  }
  const target = nodes.find((node) => node.id === intent.intent.target)!;
  const from = intent.intent.from ? nodes.find((node) => node.id === intent.intent.from)! : null;
  const via = `Move jobs · ${from?.name ?? "any machine"} → ${target.name} · ${intent.by === "decision model" ? `decision model ${Math.round(intent.confidence * 100)}%` : "Bob's agent decided"}`;
  const local = nodes.find((node) => node.local)!;
  const candidates = unfinished.filter((card) => intent.intent.conversation
    ? card.projectId === intent.intent.conversation.projectId && card.conversationId === intent.intent.conversation.conversationId
    : !from || (card.executionNodeId ?? local.id) === from.id);
  if (!candidates.length) {
    return answer(`Nothing unfinished is running ${from ? `on ${from.name}` : "anywhere"}, so there is nothing to move to ${target.name}.`, { via, importance: "fyi" });
  }
  const plan = await planMoves(createMoveEnvironment(request.session), candidates.map((card) => ({ projectId: card.projectId, conversationId: card.conversationId })), target.id);
  const { text, movable } = proposalText(plan, from?.name ?? "their machines");
  return answer(text, movable.length
    ? { via, importance: "needs-you", actions: proposalActions(plan, movable) }
    : { via, importance: "fyi" });
}

async function startFromButton(mode: MoveMode, context: BobActionContext): Promise<BobMessage[]> {
  const data = buttonData.parse(context.action.data);
  const env = createMoveEnvironment(context.session);
  // The conversations may have changed since Bob asked: they are checked again, and what cannot move now is said so.
  const plan = await planMoves(env, data.conversations, data.targetId);
  const { job, done } = startMoveJob(env, context.session.accountId, plan, mode);
  const accountId = context.session.accountId;
  void done.then(async () => {
    const summary = summarizeMoveJob(job);
    appendBobMessage(await bobDatabase(), accountId, { role: "bob", text: summary.text, via: "Move jobs · finished", importance: summary.allMoved ? "done" : "needs-you" });
  }).catch((error) => console.warn("Bob could not report the finished moves", error));
  const skipped = job.entries.filter((entry) => entry.status === "cannot" || entry.status === "there");
  const started = job.entries.length - skipped.length;
  const lines = [started
    ? `Moving ${plural(started, "job")} to ${plan.target.name}${mode === "now" ? ": stopping the running turns first" : ": each moves when its current turn ends"}. I'll tell you when they are done.`
    : `Nothing is moving to ${plan.target.name}.`,
  ...skipped.map((entry) => `- ${entry.title}: ${entry.status === "there" ? "already there" : `can't move now. ${entry.detail ?? ""}`.trim()}`)];
  return [appendBobMessage(context.db, accountId, { role: "bob", text: lines.join("\n"), via: "Move jobs", importance: "fyi" })];
}

registerBobAction(AFTER_TURN, (context) => startFromButton("after-turn", context));
registerBobAction(NOW, (context) => startFromButton("now", context));
registerBobAction(CANCEL, async ({ db, session }) => [appendBobMessage(db, session.accountId, { role: "bob", text: "Okay, nothing was moved.", via: "Move jobs", importance: "fyi" })]);
