import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsageRecords } from "../src/usage-import.js";
import { priceUsage } from "../src/usage-pricing.js";
import { modelCostToPricing } from "../src/pi-service.js";
import { usageEventSchema, usagePricingSchema } from "../src/usage-types.js";

const context = { projectId: "project", conversationId: "conversation", createdAt: "2025-01-01T00:00:00.000Z" };
const catalog = () => ({ rates: { input: 3, output: 15, cacheRead: .3, cacheWrite5m: 3.75, cacheWrite1h: 6 }, pricing: { source: "runtime-catalog", capturedAt: "2025-01-01T00:00:00.000Z", rates: { input: 3, output: 15, cacheRead: .3, cacheWrite5m: 3.75, cacheWrite1h: 6 } } });

function pi(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return normalizeUsageRecords("pi", "session", [{ timestamp: 1735689600000, message: { role: "assistant", responseId: "response", provider: "anthropic", model: "claude", usage, ...extra } }], context, catalog)[0];
}
function claude(usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return normalizeUsageRecords("claude", "session", [{ timestamp: "2025-01-01T00:00:00.000Z", message: { role: "assistant", id: "response", model: "claude", usage, ...extra } }], context, catalog)[0];
}

test("Pi preserves native fractional cost, numeric timestamp, and reasoning subset", () => {
  const event = pi({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2, cost: { total: .6454304 } });
  assert.equal(event.apiCostUsd, .6454304); assert.equal(event.reasoning, 2); assert.equal(event.occurredAt, "2025-01-01T00:00:00.000Z");
});
test("Pi native cost provenance is pi-reported", () => assert.equal(pi({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: .5 } }).pricing?.source, "pi-reported"));
test("price tier uses aggregate cache and input and equality remains base", () => {
  const rates = { input: 1, output: 2, cacheRead: .1, cacheWrite5m: 1.25, cacheWrite1h: 2, inputTiers: [{ threshold: 100, input: 10, output: 20, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }] };
  assert.equal(priceUsage({ input: 50, output: 0, cacheRead: 51, cacheWrite5m: 0, cacheWrite1h: 0 }, rates), .000551);
  assert.equal(priceUsage({ input: 50, output: 0, cacheRead: 50, cacheWrite5m: 0, cacheWrite1h: 0 }, rates), .000055);
});
test("zero catalog price is unknown for nonzero usage", () => assert.equal(priceUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, { input: 0, output: 0 }), null));
test("Anthropic runtime pricing derives 5m and 1h rates correctly", () => {
  const pricing = modelCostToPricing("anthropic", { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75, tiers: [{ inputTokensAbove: 200000, input: 6, output: 30, cacheRead: .6, cacheWrite: 7.5 }] });
  assert.equal(pricing.rates?.cacheWrite5m, 3.75); assert.equal(pricing.rates?.cacheWrite1h, 6); assert.equal(pricing.rates?.inputTiers?.[0].cacheWrite1h, 12);
  usagePricingSchema.parse(pricing);
});
test("non-Anthropic runtime pricing does not invent Anthropic 1h rates", () => assert.equal(modelCostToPricing("other", { input: 3, output: 15, cacheWrite: 3.75 }).rates?.cacheWrite1h, undefined));
test("Claude standard service tier is priced", () => assert.notEqual(claude({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "standard" }).apiCostUsd, null));
test("Claude fast speed is unpriced even with standard service tier", () => {
  const event = claude({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: "standard", speed: "fast" });
  assert.equal(event.apiCostUsd, null); assert.equal(event.pricing?.source, "unsupported-claude-tier");
});
test("Claude unknown cache split is preserved and unpriced", () => {
  const event = claude({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 2 } });
  assert.equal(event.cacheWriteUnknown, 5); assert.equal(event.apiCostUsd, null);
});
test("Pi toolResult top-level error shape matches its tool call", () => {
  const records = [{ timestamp: 1735689600000, message: { role: "assistant", responseId: "r", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "toolCall", id: "tool" }] } }, { message: { role: "toolResult", toolCallId: "tool", isError: true, content: [{ type: "text", text: "failed" }] } }];
  assert.equal(normalizeUsageRecords("pi", "s", records, context)[0].toolErrors, 1);
});
test("Claude repeated tool blocks count two calls and one error", () => {
  const records = [{ timestamp: "2025-01-01", message: { role: "assistant", id: "r", model: "m", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] } }, { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true }] } }];
  const event = normalizeUsageRecords("claude", "s", records, context)[0]; assert.equal(event.toolCalls, 2); assert.equal(event.toolErrors, 1);
});
test("later equal-output complete snapshot replaces incomplete snapshot", () => {
  const records = [{ timestamp: "bad", message: { role: "assistant", responseId: "r", usage: { input: 1, output: 2 } } }, { timestamp: 1735689600000, message: { role: "assistant", responseId: "r", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } }];
  assert.equal(normalizeUsageRecords("pi", "s", records, context)[0].usageStatus, "reported");
});
test("missing timestamp can never be complete", () => assert.equal(normalizeUsageRecords("pi", "s", [{ message: { role: "assistant", responseId: "r", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } }], context)[0].usageStatus, "missing"));
test("negative and fractional external counters stay missing", () => {
  const event = pi({ input: -1, output: 1.5, cacheRead: 0, cacheWrite: 0 }); assert.equal(event.input, null); assert.equal(event.output, null); assert.equal(event.usageStatus, "missing");
});
test("usage schema preserves finite fractional costs", () => assert.equal(usageEventSchema.parse(pi({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: .6454304 } })).apiCostUsd, .6454304));
test("copied origin markers are excluded but ordinary records remain attributable", () => {
  const copied = normalizeUsageRecords("pi", "copy", [{ jointBobUsageOrigin: { sessionId: "old" }, message: { role: "assistant", usage: { input: 1, output: 1 } } }], context);
  assert.equal(copied.length, 0); assert.equal(pi({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }).sessionId, "session");
});
