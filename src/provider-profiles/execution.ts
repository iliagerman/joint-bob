import { AsyncLocalStorage } from "node:async_hooks";
import { currentRuntime, type RuntimeAccount } from "../account-runtime.js";
import { claudeProfileAccess, projectProviderProfile } from "./service.js";
import { prepareClaudeExecution, claudeProfileEnvironment } from "./claude.js";
import type { ProviderProfile } from "./store.js";

const claudeProfile = new AsyncLocalStorage<{ directory: string; accessToken: string; baseUrl?: string; runtime: RuntimeAccount }>();
function selectedExecution() {
  const selected = claudeProfile.getStore();
  const runtime = currentRuntime();
  if (selected && (selected.runtime.name !== runtime.name || selected.runtime.home !== runtime.home)) throw new Error("Claude turn execution runtime changed after token brokering");
  return selected;
}
const active = new Map<string, number>();
export function profileBusy(id: string): boolean { return (active.get(id) ?? 0) > 0; }
export async function useProviderProfile<T>(profile: ProviderProfile | undefined, work: () => Promise<T>): Promise<T> {
  if (!profile) return work();
  active.set(profile.id, (active.get(profile.id) ?? 0) + 1);
  try { return await work(); }
  finally { const count = active.get(profile.id)! - 1; if (count) active.set(profile.id, count); else active.delete(profile.id); }
}
export function selectedClaudeConfigPath(): string | undefined {
  return selectedExecution()?.directory;
}
export function selectedClaudeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected = selectedExecution();
  if (!selected) return environment;
  // A relay pool sign-in stays on the relay: the token is a placeholder only this machine's relay proxy accepts.
  return { ...claudeProfileEnvironment(environment, selected.directory), CLAUDE_CODE_OAUTH_TOKEN: selected.accessToken, ...(selected.baseUrl ? { ANTHROPIC_BASE_URL: selected.baseUrl } : {}) };
}
export async function withClaudeProfile<T>(projectId: string, conversationId: string | undefined, work: () => Promise<T>): Promise<T> {
  const profile = await projectProviderProfile(projectId, conversationId, "claude");
  if (!profile) return work();
  return useProviderProfile(profile, async () => {
    const access = await claudeProfileAccess(profile);
    const execution = await prepareClaudeExecution(profile);
    try { return await claudeProfile.run({ directory: execution.directory, ...access, runtime: currentRuntime() }, work); }
    finally { await execution.dispose(); }
  });
}
