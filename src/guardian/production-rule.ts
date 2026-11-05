import type { GuardianRule, GuardianSettings } from "./rules.js";

/** The rule that makes every production or destructive step ask the person first. */
export const PRODUCTION_RULE_ID = "production-or-destructive";

export const PRODUCTION_RULE: GuardianRule = {
  id: PRODUCTION_RULE_ID,
  name: "Production or destructive steps",
  question: "Could this command change a production system or cannot be undone: deploy or restart a live service, change cloud or production infrastructure, push or merge to the main branch, force a push, delete data, files, branches, conversations or automations, or spend real money?",
  enabled: true,
  check: "commands",
  ifYes: "ask",
  care: "cautious",
  yesAt: null,
  noAt: null,
  whenUnsure: null,
  fix: { kind: "remove-secrets" },
};

export type ProductionGuardStatus = "on" | "guardian-off" | "rule-off" | "rule-missing";

/** Whether production and destructive steps ask first on this machine. */
export function productionGuardStatus(settings: GuardianSettings): ProductionGuardStatus {
  if (!settings.enabled) return "guardian-off";
  const rule = settings.rules.find((candidate) => candidate.id === PRODUCTION_RULE_ID);
  if (!rule) return "rule-missing";
  return rule.enabled && rule.ifYes === "ask" ? "on" : "rule-off";
}

/** Guardian on, with the production rule present, on, and set to ask. Everything else in the settings stays as it was. */
export function withProductionGuard(settings: GuardianSettings): GuardianSettings {
  const others = settings.rules.filter((rule) => rule.id !== PRODUCTION_RULE_ID);
  return { ...settings, enabled: true, rules: [...others, PRODUCTION_RULE] };
}
