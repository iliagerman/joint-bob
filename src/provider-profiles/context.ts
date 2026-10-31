import { AsyncLocalStorage } from "node:async_hooks";
import type { ProfileProvider, ProviderProfile } from "./store.js";

export interface AutomationProfileContext { accountId: string; profileId: string | null }
export interface PoolProfileContext {
  profileId: string;
  provider: ProfileProvider;
  label: string;
  poolId: string;
  profile?: ProviderProfile;
  clusterId?: string;
  poolOwnerNodeId?: string;
}
const automation = new AsyncLocalStorage<AutomationProfileContext>();
const poolProfile = new AsyncLocalStorage<PoolProfileContext>();

/** Trusted server-side identity and assignment, never taken from an incoming webhook payload. */
export function withAutomationProfile<T>(context: AutomationProfileContext, work: () => T): T {
  if (!context.accountId) throw new Error("Automation profile creator is missing");
  return automation.run(context, work);
}
export function automationProfileContext(): AutomationProfileContext | undefined { return automation.getStore(); }
export function withPoolProfile<T>(context: PoolProfileContext, work: () => T): T {
  if (!context.profileId || !context.poolId) throw new Error("Pool profile assignment is incomplete");
  if (Boolean(context.clusterId) !== Boolean(context.poolOwnerNodeId)) throw new Error("Cluster pool assignment is incomplete");
  return poolProfile.run(context, work);
}
export function poolProfileContext(): PoolProfileContext | undefined { return poolProfile.getStore(); }
export function withoutAutomationProfile<T>(work: () => T): T { return automation.exit(work); }
