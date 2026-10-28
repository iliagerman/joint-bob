import { NotFoundError } from "../not-found.js";
import { accessibleProviderProfile } from "../provider-profiles/store.js";
import { withAutomationProfile, withoutAutomationProfile } from "../provider-profiles/context.js";

export interface AutomationAssignment { creatorAccountId?: string | null; providerProfileId?: string | null }

export function assertAutomationCreator(creatorAccountId: string | null | undefined, editorAccountId: string | null | undefined): void {
  if (creatorAccountId && creatorAccountId !== editorAccountId) throw new NotFoundError("Automation not found or not owned by this creator");
}
export function automationProfileContext(input: AutomationAssignment) {
  if (!input.creatorAccountId) {
    if (input.providerProfileId) throw new Error("Automation profile requires a creator account");
    return undefined;
  }
  return { accountId: input.creatorAccountId, profileId: input.providerProfileId ?? null };
}
/** Legacy unassigned jobs retain node defaults. Explicit assignments fail closed. */
export function runWithAutomationProfile<T>(input: AutomationAssignment, work: () => T): T {
  const context = automationProfileContext(input);
  if (!context) return withoutAutomationProfile(work);
  if (context.profileId) accessibleProviderProfile(context.accountId, context.profileId, "automation");
  return withAutomationProfile(context, work);
}
