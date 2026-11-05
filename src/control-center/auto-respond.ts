import { DEFAULT_AUTO_RESPOND_INSTRUCTIONS, DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, type AutoRespondConfig } from "../conversation-auto-respond.js";
import { listHarnessModels } from "../harnesses.js";
import type { HarnessId } from "../types.js";
import type { BobSettings } from "./bob-store.js";
import type { BobDecision } from "./decisions.js";

/** What Bob adds to the default stop instructions: the things only the person may decide. */
const BOB_STOP_EXTRAS = [
  "The agent presents a plan or a design and waits for the user's approval.",
  "The agent asks for a decision that changes what users will see or how the product behaves.",
  "The next step touches production, deploys, pushes or merges to main, or cannot be undone.",
  "Something only the user can decide, or the agent is unsure what the user wants.",
].map((line) => `- ${line}`);

export const BOB_AUTO_RESPOND_STOP_INSTRUCTIONS = [DEFAULT_AUTO_RESPOND_STOP_INSTRUCTIONS, ...BOB_STOP_EXTRAS].join("\n");
export const BOB_AUTO_RESPOND_LIMIT = 10;

/**
 * Whether Bob turns on auto respond for a task it starts, so its responder answers the agent's routine questions: always when
 * the person said so, never when they said never, and otherwise when the decision model found the work routine.
 */
export function bobWantsAutoRespond(settings: BobSettings, decision: BobDecision): boolean {
  if (decision.kind !== "task" || settings.autoRespond === "never") return false;
  return settings.autoRespond === "always" || decision.autoRespond;
}

/** The responder uses Bob's own agent settings when they name a model, otherwise the harness's first model. */
export async function bobAutoRespondConfig(settings: BobSettings, harnessId: HarnessId): Promise<AutoRespondConfig> {
  let { provider, modelId, thinkingLevel } = settings;
  if (!provider || !modelId) {
    const models = await listHarnessModels(harnessId);
    const model = models[0];
    if (!model) throw new Error("The agent has no model to answer with");
    provider = model.provider;
    modelId = model.id;
    thinkingLevel = model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0] ?? "default";
  }
  return {
    providerProfileId: null, harnessId, provider, modelId,
    thinkingLevel: (thinkingLevel || "medium") as AutoRespondConfig["thinkingLevel"],
    instructions: DEFAULT_AUTO_RESPOND_INSTRUCTIONS, stopInstructions: BOB_AUTO_RESPOND_STOP_INSTRUCTIONS,
    maxResponses: BOB_AUTO_RESPOND_LIMIT, useTools: true,
  };
}
