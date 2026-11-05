import { waitForAsk } from "../assistant-collaboration/ask.js";
import { getAsk } from "../assistant-collaboration/store.js";
import { askAsBob, bobHelperViews, toBobHelper } from "./assistants-asks.js";
import { useAssistants, viaFor, type AskOutcome, type AssistantPorts, type PickDeps } from "./assistants.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { bobDecisionModel } from "../server/bob.js";
import { runGitReview } from "../server/git-review-run.js";
import { iconHarnessId } from "../server/label-icon.js";
import { projectsWithSharedNames } from "../server/projects.js";
import { announceToAllClients } from "../server/realtime.js";
import type { HarnessId } from "../types.js";
import { registerBobContextProvider, type BobContextProvider, type BobTurn } from "./bob-hooks.js";
import { appendBobMessage, bobDatabase } from "./bob-store.js";

/** How long one message waits for the assistants it asked. One helper turn is a full agent run, so this is generous. */
export const ASK_WAIT_MS = 80_000;
/** An ask that outlived the wait is followed this long, so its answer reaches the chat instead of being lost. */
const FOLLOW_MS = 15 * 60_000;
const LATE_ANSWER_CHARS = 4_000;

/** Open pages learn that an assistant started or stopped answering Bob. */
const changed = (accountId: string): void => announceToAllClients({ type: "controlCenterChanged" }, accountId);

/** The decision model Bob uses, and a tool-less agent turn in the project the message is about (or the first one). */
async function pickDeps(turn: BobTurn): Promise<PickDeps> {
  const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const model = await bobDecisionModel(projects, turn.settings);
  const project = projects.find((candidate) => candidate.id === turn.project?.id) ?? projects[0];
  return {
    stateCharacters: model?.target.stateCharacters ?? 3_500,
    ask: async (state, questions) => model ? askSystemOneChoices(model.target, state, questions, model.apiKey) : null,
    ...project ? {
      agent: async (step) => (await runGitReview({
        projectId: project.id, cwd: project.path, harnessId: (turn.settings.harnessId || iconHarnessId()) as HarnessId,
        provider: turn.settings.provider, modelId: turn.settings.modelId, thinkingLevel: turn.settings.thinkingLevel,
        selection: { scope: "context", label: "Bob's assistants" }, question: "", diff: step.material, instructions: step.instructions,
      })).answer,
    } : {},
  };
}

/** An assistant that answered after Bob had already replied: the answer is posted in the chat, so asking again is not needed. */
function followLateAnswer(accountId: string, late: AskOutcome): void {
  if (!late.askId) return;
  const askId = late.askId;
  void (async () => {
    const recorded = await getAsk(askId);
    if (!recorded) return;
    const done = await waitForAsk(askId, recorded.askerId, FOLLOW_MS);
    if (done.status === "running") return;
    const answered = done.status === "completed";
    const finished: AskOutcome = {
      ...late, askId, status: answered ? "completed" : "failed", answer: done.answer, error: done.error,
      seconds: Math.max(1, Math.round((Date.parse(done.finishedAt ?? done.startedAt) - Date.parse(done.startedAt)) / 1000)),
    };
    const answer = (done.answer ?? "").trim();
    appendBobMessage(await bobDatabase(), accountId, {
      role: "bob", importance: "fyi", via: viaFor([finished]),
      text: answered ? `${late.helper.name} answered after I had replied:\n\n${answer.length > LATE_ANSWER_CHARS ? `${answer.slice(0, LATE_ANSWER_CHARS)}\n… (cut)` : answer || "(an empty answer)"}` : `${late.helper.name} could not answer what I asked: ${done.error ?? "it failed"}.`,
    });
    changed(accountId);
  })().catch((error) => console.warn(`Could not follow the ask to ${late.helper.name}`, error instanceof Error ? error.message : error));
}

/** What Bob's assistants use for one turn. Tests replace the parts that need a model. */
export function assistantPorts(turn: BobTurn, waitMs = ASK_WAIT_MS, override: Partial<AssistantPorts> = {}): AssistantPorts {
  const accountId = turn.session.accountId;
  return {
    helpers: async () => (await bobHelperViews(accountId)).filter((view) => view.available).map(toBobHelper),
    pickDeps: () => pickDeps(turn),
    async askHelper(helper, message, purpose) {
      const outcome = await askAsBob(accountId, helper, message, purpose, { waitMs, onStarted: () => changed(accountId) });
      changed(accountId);
      if (outcome.status === "running") followLateAnswer(accountId, outcome);
      return outcome;
    },
    ...override,
  };
}

export const provideAssistants: BobContextProvider = (turn) => useAssistants(turn, assistantPorts(turn));

registerBobContextProvider("assistants", provideAssistants);
