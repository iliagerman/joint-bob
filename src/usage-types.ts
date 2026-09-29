import { z } from "zod";

export const usageNumberSchema = z.number().int().nonnegative().nullable();
export const usageRatesSchema = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional(),
  cacheWrite5m: z.number().nonnegative().optional(), cacheWrite1h: z.number().nonnegative().optional(),
  inputTiers: z.array(z.object({ threshold: z.number().int().nonnegative(), input: z.number().nonnegative(), output: z.number().nonnegative().optional(), cacheRead: z.number().nonnegative().optional(), cacheWrite5m: z.number().nonnegative().optional(), cacheWrite1h: z.number().nonnegative().optional() }).strict()).optional(),
}).strict();
export type UsageRates = z.infer<typeof usageRatesSchema>;

export const usagePricingSchema = z.object({ source: z.string().min(1), capturedAt: z.string().datetime(), rates: usageRatesSchema.optional(), provenance: z.string().optional() }).strict();
export type UsagePricing = z.infer<typeof usagePricingSchema>;

export const usageEventSchema = z.object({
  id: z.string().min(1), projectId: z.string().min(1), conversationId: z.string().min(1), sessionId: z.string().min(1),
  engine: z.string().min(1), provider: z.string().min(1), modelId: z.string().min(1), occurredAt: z.string().datetime(), requestId: z.string().nullable(),
  input: usageNumberSchema,
  output: usageNumberSchema,
  cacheRead: usageNumberSchema,
  cacheWrite5m: usageNumberSchema,
  cacheWrite1h: usageNumberSchema,
  cacheWriteUnknown: usageNumberSchema.default(0),
  reasoning: usageNumberSchema,
  apiCostUsd: z.number().finite().nonnegative().nullable(), pricing: usagePricingSchema.nullable(), usageStatus: z.enum(["reported", "missing"]),
  difficultyLevel: z.number().int().min(1).max(10).nullable(), difficultyConfidence: z.number().min(0).max(1).nullable(), difficultyStatus: z.string(), turnId: z.string().nullable(),
  toolCalls: z.number().int().nonnegative(), toolErrors: z.number().int().nonnegative(),
}).strict();
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const usageDifficultySchema = z.object({
  turnId: z.string().min(1), projectId: z.string().min(1), conversationId: z.string().min(1), sessionId: z.string().min(1), engine: z.string().min(1), occurredAt: z.string().datetime(),
  status: z.string().min(1), level: z.number().int().min(1).max(10).nullable(), confidence: z.number().min(0).max(1).nullable(), classifierId: z.string().nullable().optional(), configId: z.string().nullable().optional(), configRevision: z.number().int().nullable().optional(), inheritedFrom: z.string().nullable().optional(), mapped: z.boolean().optional(), startedAt: z.string().datetime().nullable().optional(), endedAt: z.string().datetime().nullable().optional(),
}).strict();
export type UsageDifficulty = z.infer<typeof usageDifficultySchema>;

export interface UsageTotals {
  apiCostUsd: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnknown: number;
  reasoning: number;
  totalTokens: number;
  requests: number;
  pricedRequests: number;
  missingRequests: number;
  unavailableSessions: number;
  toolCalls: number;
  toolErrors: number;
  partial: boolean;
}
export type UsageDimension = "project" | "conversation" | "classification" | "difficulty" | "model" | "day" | "engine";
export interface UsageFilters { projectIds: string[]; projectId?: string; conversationId?: string; sessionId?: string; provider?: string; modelId?: string; engine?: string; classification?: string; difficulty?: string; from?: string; to?: string; }
