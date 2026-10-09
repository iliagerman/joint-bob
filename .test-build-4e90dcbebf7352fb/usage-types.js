import { z } from "zod";
const usageNumberSchema = z.number().int().nonnegative().nullable();
const usageRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(),
  cacheWrite1h: z.number().nonnegative().optional(),
  inputTiers: z.array(z.object({ threshold: z.number().int().nonnegative(), input: z.number().nonnegative(), output: z.number().nonnegative().optional(), cacheRead: z.number().nonnegative().optional(), cacheWrite5m: z.number().nonnegative().optional(), cacheWrite1h: z.number().nonnegative().optional() }).strict()).optional()
}).strict();
const usagePricingSchema = z.object({ source: z.string().min(1), capturedAt: z.string().datetime(), rates: usageRatesSchema.optional(), provenance: z.string().optional() }).strict();
const usageEventSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  sessionId: z.string().min(1),
  engine: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  occurredAt: z.string().datetime(),
  requestId: z.string().nullable(),
  input: usageNumberSchema,
  output: usageNumberSchema,
  cacheRead: usageNumberSchema,
  cacheWrite5m: usageNumberSchema,
  cacheWrite1h: usageNumberSchema,
  cacheWriteUnknown: usageNumberSchema.default(0),
  reasoning: usageNumberSchema,
  apiCostUsd: z.number().finite().nonnegative().nullable(),
  pricing: usagePricingSchema.nullable(),
  usageStatus: z.enum(["reported", "missing"]),
  difficultyLevel: z.number().int().min(1).max(10).nullable(),
  difficultyConfidence: z.number().min(0).max(1).nullable(),
  difficultyStatus: z.string(),
  turnId: z.string().nullable(),
  toolCalls: z.number().int().nonnegative(),
  toolErrors: z.number().int().nonnegative()
}).strict();
const usageDifficultySchema = z.object({
  turnId: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  sessionId: z.string().min(1),
  engine: z.string().min(1),
  occurredAt: z.string().datetime(),
  status: z.string().min(1),
  level: z.number().int().min(1).max(10).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  classifierId: z.string().nullable().optional(),
  configId: z.string().nullable().optional(),
  configRevision: z.number().int().nullable().optional(),
  inheritedFrom: z.string().nullable().optional(),
  mapped: z.boolean().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional()
}).strict();
export {
  usageDifficultySchema,
  usageEventSchema,
  usageNumberSchema,
  usagePricingSchema,
  usageRatesSchema
};
