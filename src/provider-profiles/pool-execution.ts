import type { HarnessModelSettings } from "../harnesses/runtime.js";
import type { HarnessId } from "../types.js";
import type { ProfileProvider } from "./store.js";

export type PoolFailureReason = "quota" | "auth" | "unavailable" | "other";

export class PoolAttemptFailure extends Error {
  constructor(readonly reason: PoolFailureReason, readonly started: boolean, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PoolAttemptFailure";
  }
}

export function orderPoolCandidates<C extends { provider: ProfileProvider }>(
  candidates: readonly C[], preferredProvider?: ProfileProvider, sameProviderOnly = false,
): C[] {
  const eligible = sameProviderOnly && preferredProvider
    ? candidates.filter((candidate) => candidate.provider === preferredProvider)
    : [...candidates];
  if (!preferredProvider) return eligible;
  return [
    ...eligible.filter((candidate) => candidate.provider === preferredProvider),
    ...eligible.filter((candidate) => candidate.provider !== preferredProvider),
  ];
}

export interface PoolClassifierModelMapping { provider: string; modelId: string; reasoning?: string }

function profileProviderForModel(provider: string): ProfileProvider | undefined {
  if (provider === "anthropic" || provider === "claude") return "claude";
  return provider === "openai-codex" ? provider : undefined;
}

export function resolvePoolModelSettings(engine: HarnessId, candidateProvider: ProfileProvider, initial: HarnessModelSettings,
  mapping?: PoolClassifierModelMapping, fallbackModel?: string): HarnessModelSettings {
  if (candidateProvider === "pi" && engine === "pi") return initial;
  if (profileProviderForModel(initial.provider) === candidateProvider) return initial;
  if (engine !== "pi") throw new Error("This harness cannot switch providers while using a subscription pool");
  if (mapping && profileProviderForModel(mapping.provider) === candidateProvider) {
    return { ...initial, provider: candidateProvider === "claude" ? "anthropic" : candidateProvider,
      modelId: mapping.modelId, reasoning: mapping.reasoning ?? "off" };
  }
  if (!fallbackModel) throw new Error(`Configure a fallback model for ${candidateProvider} in this pool before cross-provider failover`);
  return { ...initial, provider: candidateProvider === "claude" ? "anthropic" : candidateProvider, modelId: fallbackModel, reasoning: "off" };
}

export function classifyPoolAttemptFailure(error: unknown, started: boolean): PoolAttemptFailure | undefined {
  if (error instanceof PoolAttemptFailure) {
    return new PoolAttemptFailure(error.reason, started || error.started, error.message, { cause: error });
  }
  if (!(error instanceof Error)) return undefined;
  const details = error as Error & { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = details.status ?? details.statusCode;
  const code = typeof details.code === "string" ? details.code.toLowerCase() : "";
  const message = `${code} ${error.message}`.toLowerCase();
  // Claude reports a subscription limit as "You've hit your 5-hour limit" with the code rate_limit.
  const reason: PoolFailureReason | undefined = status === 429 || /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|usage limit|hit your [\w -]*limit|too many requests|insufficient_quota|billing_error/.test(message)
    ? "quota"
    : status === 401 || status === 403 || /invalid_grant|authentication[_ -]?(?:error|failed)|unauthorized|token (?:expired|revoked)|sign[- ]in required|sign in to .* again|sign in on this node/.test(message)
      ? "auth"
      : undefined;
  return reason ? new PoolAttemptFailure(reason, started, error.message, { cause: error }) : undefined;
}

/** A failure the next pool member can take over from: quota or sign-in at any point, an unusable member before it starts. */
function handsOver(failure: PoolAttemptFailure): boolean {
  return failure.started ? failure.reason === "quota" || failure.reason === "auth" : ["quota", "auth", "unavailable"].includes(failure.reason);
}

/**
 * Runs a turn on each pool member in turn until one finishes it. A member that fails before
 * starting is rolled back to the last checkpoint and the next one gets the same prompt. A member
 * that runs out of quota or sign-in mid-turn keeps the work it did: the next member is told to
 * continue (`continuing`), so nothing already done is replayed.
 */
export async function runPoolAttempts<T, C extends { provider: ProfileProvider }>(
  candidates: readonly C[],
  preferredProvider: ProfileProvider | undefined,
  attempt: (candidate: C, continuing: boolean) => Promise<T>,
  checkpoint: () => Promise<() => Promise<void>>,
  sameProviderOnly = false,
): Promise<T> {
  const ordered = orderPoolCandidates(candidates, preferredProvider, sameProviderOnly);
  if (!ordered.length) throw new Error("No compatible subscription profile is available in this pool");
  let restore = await checkpoint();
  let continuing = false;
  for (let index = 0; index < ordered.length; index += 1) {
    try { return await attempt(ordered[index], continuing); }
    catch (error) {
      const failure = classifyPoolAttemptFailure(error, false);
      if (!failure || !handsOver(failure)) throw error;
      if (index === ordered.length - 1) throw failure;
      if (failure.started) {
        continuing = true;
        restore = await checkpoint();
      } else await restore();
    }
  }
  throw new Error("Subscription pool attempts ended unexpectedly");
}
