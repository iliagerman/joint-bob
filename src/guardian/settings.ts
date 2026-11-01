import { clusterV2Database } from "../cluster-v2-store.js";
import { relayPolicyLabel, relayPolicySubscriptions } from "../relay/resource-policy.js";
import { save, settingsDatabase, value } from "../settings-store.js";
import { DEFAULT_GUARDIAN_SETTINGS, guardianSettingsSchema, type GuardianModelId, type GuardianRule, type GuardianSettings } from "./rules.js";

const SETTINGS_KEY = "guardian";

export function getGuardianSettings(): GuardianSettings {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_GUARDIAN_SETTINGS);
  return guardianSettingsSchema.parse(JSON.parse(stored));
}

export function updateGuardianSettings(input: unknown): GuardianSettings {
  const settings = guardianSettingsSchema.parse(input);
  save(settingsDatabase(), SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/** Rules that share one author and one model: this machine's own, or one relay's. */
export interface GuardianGroup {
  /** "This machine", or the relay's label. */
  source: string;
  relay: boolean;
  model: GuardianModelId;
  layaUrl: string;
  rules: GuardianRule[];
}

/** Every rule that applies on this machine: its own while Guardian is on, and every admitted relay's, always. */
export async function guardianGroups(): Promise<GuardianGroup[]> {
  const local = getGuardianSettings();
  const groups: GuardianGroup[] = local.enabled ? [{ source: "This machine", relay: false, model: local.model, layaUrl: local.layaUrl, rules: local.rules }] : [];
  for (const { relay, statement } of relayPolicySubscriptions(await clusterV2Database())) {
    const policy = statement?.body.guardian;
    if (policy) groups.push({ source: relayPolicyLabel(relay), relay: true, model: policy.model, layaUrl: policy.layaUrl, rules: policy.rules });
  }
  return groups;
}
