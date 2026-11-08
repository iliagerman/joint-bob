import { forgetReadyHarnesses, knownReadyHarnesses, rememberReadyHarnesses } from "./harness-readiness.js";
import { getHarnessRuntime } from "./harnesses.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { backgroundAgentNow, type ResolvedBackgroundAgent } from "./settings.js";
import type { HarnessId } from "./types.js";

/**
 * Joint Bob's own background work (Bob, summaries' fallback, titles, icons, knowledge
 * cleanup, the sync check and dashboards by default) runs on the background agent chosen in
 * Settings → Conversations, or automatically on the first agent that is installed and
 * signed in here. Whether an agent is signed in is answered by its command-line tool, so
 * the answer is kept for ten minutes and refreshed in the background when someone asks
 * after that; nothing polls.
 */
const READINESS_MAX_AGE_MS = 10 * 60_000;
let refreshing: Promise<string[]> | undefined;

async function harnessReady(id: string): Promise<boolean> {
  try {
    const runtime = await getHarnessRuntime(id as HarnessId);
    if ((await runtime.readiness(process.cwd())).length) return false;
    return !(await runtime.signInProblems()).length;
  } catch {
    return false;
  }
}

/** Asks every agent that can run here whether it is installed and signed in; one check at a time. */
export function refreshHarnessReadiness(): Promise<string[]> {
  refreshing ??= (async () => {
    try {
      const candidates = listDiscoveredHarnesses().filter((adapter) => adapter.runtime);
      const answers = await Promise.all(candidates.map(async (adapter) => (await harnessReady(adapter.id)) ? adapter.id : undefined));
      const ready = answers.filter((id): id is string => Boolean(id));
      rememberReadyHarnesses(ready);
      return ready;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

function readinessStale(): boolean {
  const known = knownReadyHarnesses();
  return !known || Date.now() - known.at > READINESS_MAX_AGE_MS;
}

/** The background agent now, from the last sign-in check; a stale check is refreshed for next time. */
export function backgroundAgent(): ResolvedBackgroundAgent {
  if (readinessStale()) void refreshHarnessReadiness().catch(() => undefined);
  return backgroundAgentNow();
}

/** The background agent after a sign-in check no older than ten minutes. */
export async function currentBackgroundAgent(): Promise<ResolvedBackgroundAgent> {
  if (readinessStale()) await refreshHarnessReadiness().catch(() => undefined);
  return backgroundAgentNow();
}

/** Settings changed what an agent can do (paths, sign-in, Kiro on or off): check again. */
export function forgetHarnessReadiness(): void {
  forgetReadyHarnesses();
}

/** Who runs a piece of background work: its own choice when it has one, else the background agent. */
export interface AgentChoice { harnessId: HarnessId; provider: string; modelId: string; thinkingLevel: string }
export function agentFor(choice: { harnessId?: string; provider?: string; modelId?: string; thinkingLevel?: string } | undefined): AgentChoice {
  if (choice?.harnessId) return { harnessId: choice.harnessId as HarnessId, provider: choice.provider ?? "", modelId: choice.modelId ?? "", thinkingLevel: choice.thinkingLevel ?? "" };
  const { harnessId, provider, modelId, thinkingLevel } = backgroundAgent();
  return { harnessId: harnessId as HarnessId, provider, modelId, thinkingLevel };
}
