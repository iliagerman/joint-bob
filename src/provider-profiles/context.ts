import { AsyncLocalStorage } from "node:async_hooks";

export interface AutomationProfileContext { accountId: string; profileId: string | null }
const automation = new AsyncLocalStorage<AutomationProfileContext>();

/** Trusted server-side identity and assignment, never taken from an incoming webhook payload. */
export function withAutomationProfile<T>(context: AutomationProfileContext, work: () => T): T {
  if (!context.accountId) throw new Error("Automation profile creator is missing");
  return automation.run(context, work);
}
export function automationProfileContext(): AutomationProfileContext | undefined { return automation.getStore(); }
export function withoutAutomationProfile<T>(work: () => T): T { return automation.exit(work); }
