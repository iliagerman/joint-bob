import { actingAccount, asNode } from "../account-context.js";
import type { HarnessModelSettings, HarnessPrompt, HarnessRuntime, HarnessSession } from "../harnesses/runtime.js";
import { automationProfileContext } from "../provider-profiles/context.js";
import { resolvePoolModelSettings } from "../provider-profiles/pool-execution.js";
import { getProject } from "../store.js";
import type { HarnessId } from "../types.js";

/** Background helpers use the same subscription selection and safe failover as conversation turns. */
export async function prepareBackgroundTurn(input: {
  projectId: string; conversationId?: string; harnessId: HarnessId;
  runtime: HarnessRuntime; session: HarnessSession; settings: HarnessModelSettings;
  /** False keeps the session's own model: a task with no model of its own was never reconfigured. */
  configure?: boolean;
}): Promise<{ pooled: boolean; prompt: (prompt: HarnessPrompt) => Promise<void> }> {
  // Kiro uses standalone profiles, never subscription pools.
  const poolRunner = input.harnessId === "kiro" ? undefined : await import("./harness-chat.js");
  const { runtime, session, settings } = input;
  const project = poolRunner ? await asNode(() => getProject(input.projectId)) : undefined;
  const automation = automationProfileContext();
  const pool = poolRunner && await poolRunner.resolveSubscriptionPool({ engine: input.harnessId, provider: settings.provider,
    // Node-level helpers such as label icons have no workspace or source conversation.
    projectId: input.projectId, workspaceId: project?.type ?? "", conversationId: input.conversationId ?? session.id,
    accountId: automation?.accountId ?? actingAccount()?.accountId,
    usage: automation ? "automation" : "interactive", fixedProfile: Boolean(automation?.profileId) });
  if (!pool) {
    if (input.configure !== false) {
      await runtime.validateSettings(settings);
      await session.configure(settings);
    }
    await session.preflight();
  }
  return {
    pooled: Boolean(pool),
    prompt: prompt => pool
      ? poolRunner!.promptOnSubscriptionPool(session, pool, settings,
        candidate => resolvePoolModelSettings(input.harnessId, candidate.provider, settings, undefined, pool.fallbackModels[candidate.provider]),
        prompt, () => {})
      : session.prompt(prompt),
  };
}
