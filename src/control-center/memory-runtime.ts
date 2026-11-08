import { z } from "zod";
import type { AuthSession } from "../auth.js";
import { askSystemOneChoices } from "../classifiers/typesafe.js";
import { bobDecisionModel } from "../server/bob.js";
import { runGitReview } from "../server/git-review-run.js";
import { agentFor } from "../background-agent.js";
import { projectsWithSharedNames } from "../server/projects.js";
import { BobActionError, bobSays, registerBobAction } from "./bob-actions.js";
import { registerBobContextProvider, registerBobExchangeObserver, type BobTurn } from "./bob-hooks.js";
import { bobDatabase } from "./bob-store.js";
import { learnFromExchange, useMemory, type MemoryDeps } from "./memory.js";
import { ensureMemorySchema, keepChange, MemoryError, memoryRoot, revertChange, type MemoryChange, type MemoryContext } from "./memory-store.js";

/** Bob's memory for one account: the node's database for the changes, the account's folder for the topics. */
export async function memoryContextFor(accountId: string): Promise<MemoryContext> {
  const db = await bobDatabase();
  ensureMemorySchema(db);
  return { db, accountId, root: memoryRoot(accountId) };
}

/** The decision model Bob uses, and a tool-less agent turn in the project the message is about (or the first one). */
async function memoryDeps(turn: BobTurn): Promise<MemoryDeps> {
  const projects = await projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false });
  const model = await bobDecisionModel(projects, turn.settings);
  const project = projects.find((candidate) => candidate.id === turn.project?.id) ?? projects[0];
  return {
    stateCharacters: model?.target.stateCharacters ?? 3_500,
    ask: async (state, questions) => model ? askSystemOneChoices(model.target, state, questions, model.apiKey) : null,
    ...project ? {
      agent: async (step) => (await runGitReview({
        projectId: project.id, cwd: project.path, ...agentFor(turn.settings),
        selection: { scope: "context", label: "Bob's memory" }, question: "", diff: step.material, instructions: step.instructions,
      })).answer,
    } : {},
  };
}

registerBobContextProvider("memory", async (turn) => useMemory(await memoryContextFor(turn.session.accountId), turn, () => memoryDeps(turn)));

registerBobExchangeObserver("memory", async (turn, reply) => {
  await learnFromExchange(await memoryContextFor(turn.session.accountId), await memoryDeps(turn), turn, reply);
});

const actionData = z.object({ changeId: z.string().min(1).max(100) });

/** What a Keep or Revert button on one of Bob's messages does; the button only exists on a message about that change. */
function settleFromChat(verb: string, run: (ctx: MemoryContext, id: string) => MemoryChange) {
  return async ({ session, db, action }: { session: AuthSession; db: Awaited<ReturnType<typeof bobDatabase>>; action: { data?: Record<string, unknown> } }) => {
    ensureMemorySchema(db);
    try {
      const change = run({ db, accountId: session.accountId, root: memoryRoot(session.accountId) }, actionData.parse(action.data).changeId);
      return [bobSays(db, session, `${verb} "${change.topic}".`, { via: "Memory", importance: "fyi" })];
    } catch (error) {
      if (error instanceof MemoryError) throw new BobActionError(error.status, error.message);
      throw error;
    }
  };
}

registerBobAction("memory-keep", settleFromChat("Kept", keepChange));
registerBobAction("memory-revert", settleFromChat("Reverted", revertChange));
