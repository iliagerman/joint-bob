import { systemAiSettings } from './system-ai-config.js';
import { systemSecretAccounts, systemSecretVariable } from './secrets.js';
import { adminAccountId } from './ownership.js';
import { withAutomationProfile } from './provider-profiles/context.js';
import { accessibleProviderProfile } from './provider-profiles/store.js';

/** Never broadens agent credentials; only server-owned decision requests call this. */
export function systemDecisionKey(model: 'typesafe' | 'laya'): string {
  const choice = systemAiSettings().decision;
  const name = model === 'typesafe' ? 'TYPESAFE_AI_API_KEY' : 'LAYA_API_KEY';
  const selected = model === 'typesafe' ? choice.typesafeAccountId : choice.layaAccountId;
  if (selected) return systemSecretVariable(selected, name);
  if (model === 'laya') return '';
  const candidates = systemSecretAccounts().filter(account => account.variables.some(variable => variable.name === name && variable.kind === 'value'));
  if (candidates.length !== 1) throw new Error(candidates.length
    ? 'Several TypeSafe accounts are saved. Select the system secret in Settings → System AI.'
    : 'No system TypeSafe key is available. Add a secret in Settings → Secrets, then select it in System AI.');
  return systemSecretVariable(candidates[0].id, name);
}

/** A pinned system profile applies only around an internal operation, never a user's turn. */
export function withSystemAiProfile<T>(harness: string, provider: string, work: () => T): T {
  const profiles = systemAiSettings().profiles;
  const kind = harness === 'claude' ? 'claude' : harness === 'kiro' ? 'kiro' : profiles.pi ? 'pi' : provider === 'openai-codex' ? 'openai-codex' : provider === 'anthropic' ? 'claude' : undefined;
  const profileId = kind ? profiles[kind] : null;
  if (!profileId) return work();
  const accountId = adminAccountId();
  if (!accountId) throw new Error('System AI has no local administrator account.');
  const profile = accessibleProviderProfile(accountId, profileId, 'automation');
  if (profile.provider !== kind) throw new Error('Selected system login profile does not match the agent. Check Settings → System AI.');
  return withAutomationProfile({ accountId, profileId }, work);
}
