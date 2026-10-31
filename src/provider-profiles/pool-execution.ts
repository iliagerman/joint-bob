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
  const reason: PoolFailureReason | undefined = status === 429 || /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|usage limit|too many requests|insufficient_quota/.test(message)
    ? "quota"
    : status === 401 || status === 403 || /invalid_grant|authentication[_ -]?error|unauthorized|token (?:expired|revoked)|sign[- ]in required|sign in to .* again|sign in on this node/.test(message)
      ? "auth"
      : undefined;
  return reason ? new PoolAttemptFailure(reason, started, error.message, { cause: error }) : undefined;
}

export async function runPoolAttempts<T, C extends { provider: ProfileProvider }>(
  candidates: readonly C[],
  preferredProvider: ProfileProvider | undefined,
  attempt: (candidate: C) => Promise<T>,
  restore: () => Promise<void>,
  sameProviderOnly = false,
): Promise<T> {
  const ordered = orderPoolCandidates(candidates, preferredProvider, sameProviderOnly);
  if (!ordered.length) throw new Error("No compatible subscription profile is available in this pool");
  for (let index = 0; index < ordered.length; index += 1) {
    try { return await attempt(ordered[index]); }
    catch (error) {
      const failure = classifyPoolAttemptFailure(error, false);
      if (!failure || failure.started || !["quota", "auth", "unavailable"].includes(failure.reason)) throw error;
      if (index === ordered.length - 1) throw failure;
      await restore();
    }
  }
  throw new Error("Subscription pool attempts ended unexpectedly");
}
