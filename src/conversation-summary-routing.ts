import type { DifficultyClassification } from "./classifiers/contract.js";
import type { DigestModel } from "./conversation-digest.js";
import { automaticRoutingModelAllowed, type RoutingMapping } from "./routing-policy.js";

/** The agent and model a conversation is using: live from its session, or as the page reports it. */
export interface ConversationModel { harnessId: string; provider?: string; modelId?: string }

export interface SummaryRun extends DigestModel { thinkingLevel: string }

/**
 * The routing configuration's model for a classified summary task, on the conversation's
 * agent, or null when the classification is unsure, abstained, unmapped or not allowed.
 * Kept apart from the runner, which pulls in the live sessions, so it can be tested alone.
 */
export function routedSummaryModel(levels: Record<string, RoutingMapping | null> | undefined, classification: DifficultyClassification | null, threshold: number, own: ConversationModel, fixedProvider?: string): SummaryRun | null {
  if (!classification || classification.abstained || classification.confidence < threshold) return null;
  const mapping = levels?.[String(classification.level)] ?? null;
  if (!mapping) return null;
  const provider = mapping.provider ?? fixedProvider ?? own.provider ?? "";
  if (!automaticRoutingModelAllowed(provider, mapping.modelId)) return null;
  return { harnessId: own.harnessId, provider, modelId: mapping.modelId, thinkingLevel: mapping.thinkingLevel, source: "classifier" };
}
