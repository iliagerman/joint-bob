import { createHash } from "node:crypto";
import { priceUsage } from "./usage-pricing.js";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
function count(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function amount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function timestamp(record, message) {
  const value = record.timestamp ?? message.timestamp;
  const milliseconds = typeof value === "number" && Number.isFinite(value) ? value : void 0;
  const parsed = milliseconds === void 0 ? Date.parse(String(value ?? "")) : milliseconds;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function requestIdentity(engine, sessionId, record, message) {
  const responseId = message.responseId ?? record.responseId;
  if (typeof responseId === "string" && responseId.length > 0 && responseId.length <= 500) return responseId;
  const fallback = message.id ?? record.requestId ?? record.id;
  if (typeof fallback !== "string" || fallback.length === 0 || fallback.length > 500) return null;
  return engine === "pi" ? `${sessionId}:${fallback}` : fallback;
}
function eventBase(engine, sessionId, record, message, context) {
  const provider = String(message.provider ?? record.provider ?? context.provider ?? (engine === "claude" ? "anthropic" : "unknown"));
  const modelId = String(message.model ?? record.model ?? context.modelId ?? "unknown");
  const occurredAt = timestamp(record, message) ?? new Date(context.createdAt).toISOString();
  const requestId = requestIdentity(engine, sessionId, record, message);
  const identity = requestId ?? `${sessionId}:${JSON.stringify(record)}`;
  return {
    id: hash(`${engine}:${provider}:${modelId}:${identity}`),
    projectId: context.projectId,
    conversationId: context.conversationId,
    sessionId,
    engine,
    provider,
    modelId,
    occurredAt,
    requestId,
    timestampMissing: timestamp(record, message) === null
  };
}
function contentToolIds(content) {
  const ids = /* @__PURE__ */ new Set();
  if (!Array.isArray(content)) return ids;
  for (const raw of content) {
    const item = object(raw);
    if (item.type !== "tool_use" && item.type !== "toolCall") continue;
    const id = item.id ?? item.tool_use_id ?? item.toolCallId;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}
function piEvent(sessionId, record, context, resolver) {
  const message = object(record.message);
  if (record.jointBobUsageOrigin || message.jointBobUsageOrigin || message.role !== "assistant") return null;
  const usage = object(message.usage ?? record.usage);
  const input = count(usage.input ?? usage.inputTokens);
  const output = count(usage.output ?? usage.outputTokens);
  const cacheRead = count(usage.cacheRead ?? usage.cacheReadTokens);
  const cacheWrite = count(usage.cacheWrite ?? usage.cacheWriteTokens);
  const cacheWrite1h = count(usage.cacheWrite1h ?? usage.cacheWrite1hTokens) ?? 0;
  const base = eventBase("pi", sessionId, record, message, context);
  const tokens = {
    input,
    output,
    cacheRead,
    cacheWrite5m: cacheWrite === null ? null : Math.max(0, cacheWrite - cacheWrite1h),
    cacheWrite1h: cacheWrite === null ? null : cacheWrite1h
  };
  const complete = [input, output, cacheRead, cacheWrite].every((value) => value !== null) && !base.timestampMissing;
  const nativeCost = amount(object(usage.cost).total ?? usage.cost);
  const catalog = resolver(base.provider, base.modelId, base.occurredAt);
  const allZero = Object.values(tokens).every((value) => value === 0);
  const acceptedNative = nativeCost !== null && (nativeCost > 0 || allZero) ? nativeCost : null;
  const toolCalls = contentToolIds(message.content).size;
  const { timestampMissing: _, ...identity } = base;
  return {
    ...identity,
    ...tokens,
    cacheWriteUnknown: 0,
    reasoning: count(usage.reasoning ?? usage.reasoningTokens),
    apiCostUsd: acceptedNative ?? (catalog ? priceUsage(tokens, catalog.rates) : null),
    pricing: acceptedNative !== null ? {
      source: "pi-reported",
      capturedAt: base.occurredAt,
      ...catalog ? { rates: catalog.rates, provenance: "Native Pi cost; runtime catalog rate snapshot" } : { provenance: "Native Pi reported cost" }
    } : catalog?.pricing ?? null,
    usageStatus: complete ? "reported" : "missing",
    difficultyLevel: null,
    difficultyConfidence: null,
    difficultyStatus: "not-classified",
    turnId: null,
    toolCalls,
    toolErrors: 0
  };
}
function claudeEvent(sessionId, record, context, resolver) {
  const message = object(record.message);
  if (record.jointBobUsageOrigin || message.jointBobUsageOrigin || message.role !== "assistant") return null;
  const usage = object(message.usage);
  const modelId = String(message.model ?? record.model ?? context.modelId ?? "unknown");
  if (modelId === "<synthetic>") return null;
  const aggregate = count(usage.cache_creation_input_tokens);
  const breakdown = object(usage.cache_creation);
  const write5m = count(breakdown.ephemeral_5m_input_tokens);
  const write1h = count(breakdown.ephemeral_1h_input_tokens);
  const splitTotal = (write5m ?? 0) + (write1h ?? 0);
  const splitKnown = aggregate === null || aggregate === 0 || splitTotal === aggregate;
  const base = eventBase("claude", sessionId, record, message, { ...context, provider: "anthropic", modelId });
  const tokens = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite5m: splitKnown ? write5m ?? aggregate : null,
    cacheWrite1h: splitKnown ? write1h ?? 0 : null
  };
  const unknownWrite = splitKnown ? 0 : aggregate;
  const complete = [tokens.input, tokens.output, tokens.cacheRead, aggregate].every((value) => value !== null) && !base.timestampMissing;
  const serviceTier = usage.service_tier;
  const speed = usage.speed ?? record.speed;
  const standardTier = (serviceTier === void 0 || serviceTier === "standard") && (speed === void 0 || speed === "standard");
  const tier = speed !== void 0 && speed !== "standard" ? speed : serviceTier;
  const catalog = standardTier ? resolver(base.provider, base.modelId, base.occurredAt) : null;
  const outputDetails = object(usage.output_tokens_details);
  const { timestampMissing: _, ...identity } = base;
  return {
    ...identity,
    ...tokens,
    cacheWriteUnknown: unknownWrite,
    reasoning: count(outputDetails.thinking_tokens),
    apiCostUsd: catalog && splitKnown ? priceUsage(tokens, catalog.rates) : null,
    pricing: standardTier ? catalog?.pricing ?? null : {
      source: "unsupported-claude-tier",
      capturedAt: base.occurredAt,
      provenance: `Unsupported Claude service tier: ${String(tier)}`
    },
    usageStatus: complete ? "reported" : "missing",
    difficultyLevel: null,
    difficultyConfidence: null,
    difficultyStatus: "not-classified",
    turnId: null,
    toolCalls: contentToolIds(message.content).size,
    toolErrors: 0
  };
}
function toolErrorIds(records) {
  const result = /* @__PURE__ */ new Set();
  for (const raw of records) {
    const record = object(raw);
    const message = object(record.message);
    if (message.role === "toolResult" && message.isError === true && typeof message.toolCallId === "string") {
      result.add(message.toolCallId);
    }
    const content = message.content ?? record.content;
    if (!Array.isArray(content)) continue;
    for (const rawItem of content) {
      const item = object(rawItem);
      if ((item.type === "tool_result" || item.type === "toolResult") && (item.is_error === true || item.isError === true)) {
        const id = item.tool_use_id ?? item.toolCallId ?? item.id;
        if (typeof id === "string") result.add(id);
      }
    }
  }
  return result;
}
function normalizeUsageRecords(engine, sessionId, records, context, pricingResolver = () => null) {
  const errors = toolErrorIds(records);
  const events = /* @__PURE__ */ new Map();
  for (const raw of records) {
    const record = object(raw);
    const event = engine === "claude" ? claudeEvent(sessionId, record, context, pricingResolver) : piEvent(sessionId, record, context, pricingResolver);
    if (!event) continue;
    const tools = contentToolIds(object(record.message).content);
    const previous = events.get(event.id);
    if (!previous) {
      events.set(event.id, { event, tools });
      continue;
    }
    for (const id of tools) previous.tools.add(id);
    const score = (value) => (value.usageStatus === "reported" ? 1e6 : 0) + [value.input, value.output, value.cacheRead, value.cacheWrite5m, value.cacheWrite1h].filter((count2) => count2 !== null).length * 1e5 + (value.output ?? 0);
    if (score(event) > score(previous.event)) previous.event = event;
  }
  return [...events.values()].map(({ event, tools }) => ({
    ...event,
    toolCalls: tools.size,
    toolErrors: [...tools].filter((id) => errors.has(id)).length
  }));
}
export {
  normalizeUsageRecords
};
