import assert from "node:assert/strict";
import test from "node:test";
import { autoRespondConfigSchema } from "../src/conversation-auto-respond.js";
import { BOB_AUTO_RESPOND_LIMIT, BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, bobAutoRespondConfig, bobWantsAutoRespond } from "../src/control-center/auto-respond.js";
import { DEFAULT_BOB_SETTINGS } from "../src/control-center/bob-store.js";
import type { BobDecision } from "../src/control-center/decisions.js";

const routine: BobDecision = { kind: "task", size: "long", projectId: "p", autoRespond: true, confidence: 0.95 };

test("Bob turns auto respond on only for routine tasks, and only when the person let Bob decide", () => {
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, routine), true);
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, { ...routine, autoRespond: false }), false, "the decision model found it not routine");
  assert.equal(bobWantsAutoRespond(DEFAULT_BOB_SETTINGS, { ...routine, kind: "question" }), false);
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "always" }, { ...routine, autoRespond: false }), true, "the person asked Bob to always answer");
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "always" }, { ...routine, kind: "question" }), false, "only tasks start agents");
  assert.equal(bobWantsAutoRespond({ ...DEFAULT_BOB_SETTINGS, autoRespond: "never" }, routine), false);
});

test("the responder stops for plans, user-facing decisions and production steps, and fits the auto respond schema", async () => {
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /plan or a design/);
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /production/);
  assert.match(BOB_AUTO_RESPOND_STOP_INSTRUCTIONS, /destructive/, "the default stop instructions are kept");
  const config = await bobAutoRespondConfig({ ...DEFAULT_BOB_SETTINGS, provider: "anthropic", modelId: "opus", thinkingLevel: "high" }, "claude");
  assert.equal(config.maxResponses, BOB_AUTO_RESPOND_LIMIT);
  assert.equal(config.modelId, "opus");
  assert.doesNotThrow(() => autoRespondConfigSchema.parse(config));
});
