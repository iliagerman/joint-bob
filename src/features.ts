/**
 * Feature gating system for replicated users.
 * Home users have full access; replicated users have restricted access.
 */

export const Feature = {
  TERMINAL: "terminal",
  SETTINGS: "settings",
  SECRETS_MANAGE: "secrets:manage",
  PROJECTS_ALL: "projects:all",
  CONVERSATIONS: "conversations",
} as const;

export type FeatureKey = (typeof Feature)[keyof typeof Feature];

/** Features available to the home user (full access). */
const HOME_USER_FEATURES: Set<FeatureKey> = new Set([
  Feature.TERMINAL,
  Feature.SETTINGS,
  Feature.SECRETS_MANAGE,
  Feature.PROJECTS_ALL,
  Feature.CONVERSATIONS,
]);

/** Features available to replicated users (restricted access). */
const REPLICATED_USER_FEATURES: Set<FeatureKey> = new Set([
  Feature.CONVERSATIONS,
]);

export interface FeatureContext {
  isRemoteLogin: boolean;
}

export function hasFeature(context: FeatureContext, feature: FeatureKey): boolean {
  if (context.isRemoteLogin) {
    return REPLICATED_USER_FEATURES.has(feature);
  }
  return HOME_USER_FEATURES.has(feature);
}

export function availableFeatures(context: FeatureContext): FeatureKey[] {
  if (context.isRemoteLogin) {
    return [...REPLICATED_USER_FEATURES];
  }
  return [...HOME_USER_FEATURES];
}

/** Guard that throws if the feature is not available. */
export function requireFeature(context: FeatureContext, feature: FeatureKey): void {
  if (!hasFeature(context, feature)) {
    throw new FeatureAccessError(feature);
  }
}

export class FeatureAccessError extends Error {
  constructor(public readonly feature: FeatureKey) {
    super(`Access to ${feature} is not available for replicated users`);
  }
}
