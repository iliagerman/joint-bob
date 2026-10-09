const Feature = {
  TERMINAL: "terminal",
  SETTINGS: "settings",
  SECRETS_MANAGE: "secrets:manage",
  PROJECTS_ALL: "projects:all",
  CONVERSATIONS: "conversations"
};
const HOME_USER_FEATURES = /* @__PURE__ */ new Set([
  Feature.TERMINAL,
  Feature.SETTINGS,
  Feature.SECRETS_MANAGE,
  Feature.PROJECTS_ALL,
  Feature.CONVERSATIONS
]);
const REPLICATED_USER_FEATURES = /* @__PURE__ */ new Set([
  Feature.CONVERSATIONS
]);
function hasFeature(context, feature) {
  if (context.isRemoteLogin) {
    return REPLICATED_USER_FEATURES.has(feature);
  }
  return HOME_USER_FEATURES.has(feature);
}
function availableFeatures(context) {
  if (context.isRemoteLogin) {
    return [...REPLICATED_USER_FEATURES];
  }
  return [...HOME_USER_FEATURES];
}
function requireFeature(context, feature) {
  if (!hasFeature(context, feature)) {
    throw new FeatureAccessError(feature);
  }
}
class FeatureAccessError extends Error {
  constructor(feature) {
    super(`Access to ${feature} is not available for replicated users`);
    this.feature = feature;
  }
  feature;
}
export {
  Feature,
  FeatureAccessError,
  availableFeatures,
  hasFeature,
  requireFeature
};
