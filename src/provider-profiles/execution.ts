import { AsyncLocalStorage } from "node:async_hooks";
import { currentRuntime, type RuntimeAccount } from "../account-runtime.js";
import { claudeProfileAccessToken, projectProviderProfile } from "./service.js";
import { prepareClaudeExecution, claudeProfileEnvironment } from "./claude.js";
import type { ProviderProfile } from "./store.js";

const claudeProfile = new AsyncLocalStorage<{ directory: string; accessToken: string; runtime: RuntimeAccount }>();
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
  return { ...claudeProfileEnvironment(environment, selected.directory), CLAUDE_CODE_OAUTH_TOKEN: selected.accessToken };
}
export async function withClaudeProfile<T>(projectId: string, conversationId: string | undefined, work: () => Promise<T>): Promise<T> {
  const profile = await projectProviderProfile(projectId, conversationId, "claude");
  if (!profile) return work();
  return useProviderProfile(profile, async () => {
    const accessToken = await claudeProfileAccessToken(profile);
    const execution = await prepareClaudeExecution(profile);
    try { return await claudeProfile.run({ directory: execution.directory, accessToken, runtime: currentRuntime() }, work); }
    finally { await execution.dispose(); }
  });
}
