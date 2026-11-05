import assert from "node:assert/strict";
import test from "node:test";
import { guardianSettingsSchema, DEFAULT_GUARDIAN_SETTINGS } from "../src/guardian/rules.js";
import { PRODUCTION_RULE, PRODUCTION_RULE_ID, productionGuardStatus, withProductionGuard } from "../src/guardian/production-rule.js";

test("the production rule is a valid Guardian rule that asks, and turning it on keeps the other rules", () => {
  const off = structuredClone(DEFAULT_GUARDIAN_SETTINGS);
  assert.equal(productionGuardStatus(off), "guardian-off");
  assert.equal(productionGuardStatus({ ...off, enabled: true }), "rule-missing");
  const on = withProductionGuard(off);
  assert.doesNotThrow(() => guardianSettingsSchema.parse(on));
  assert.equal(productionGuardStatus(on), "on");
  assert.deepEqual(on.rules.map((rule) => rule.id).sort(), [...off.rules.map((rule) => rule.id), PRODUCTION_RULE_ID].sort());
  assert.equal(PRODUCTION_RULE.ifYes, "ask");
  assert.deepEqual(withProductionGuard(on), on, "turning it on twice changes nothing");
  assert.equal(productionGuardStatus({ ...on, rules: on.rules.map((rule) => rule.id === PRODUCTION_RULE_ID ? { ...rule, enabled: false } : rule) }), "rule-off");
  assert.equal(productionGuardStatus({ ...on, rules: on.rules.map((rule) => rule.id === PRODUCTION_RULE_ID ? { ...rule, ifYes: "block" } : rule) }), "rule-off", "blocking silently is not asking");
});
