import { createHash } from "node:crypto";
import { z } from "zod";
import type { MonitorEvent } from "./browser-monitor-types.js";

const boundedId = z.string().min(1).max(320);
const uniqueIds = z.array(boundedId).max(200).refine(values => new Set(values).size === values.length, "IDs must be unique");
const provider = z.string().min(1).max(100);
const modelId = z.string().min(1).max(200);
const aiConditionSchema = z.object({ question: z.string().trim().min(1).max(2000), provider, modelId }).strict();
const replyContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fixed"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ type: z.literal("ai"), instructions: z.string().trim().min(1).max(4000), provider, modelId }).strict(),
]);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ignore") }).strict(),
  z.object({ type: z.literal("notify") }).strict(),
  z.object({ type: z.literal("reply"), mode: z.enum(["approval", "automatic"]), content: replyContentSchema }).strict(),
]);

export const browserMonitorRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(120), priority: z.number().int().min(-1000).max(1000),
  targetIds: uniqueIds, senderIds: uniqueIds, excludedTargetIds: uniqueIds, excludedSenderIds: uniqueIds,
  textContains: z.string().min(1).max(1000).nullable(), caseSensitive: z.boolean(), aiCondition: aiConditionSchema.nullable(),
  action: actionSchema, cooldownSeconds: z.number().int().min(60).max(86400), maxRepliesPerHour: z.number().int().min(1).max(60),
}).strict().refine(input => input.action.type !== "ignore" || input.aiCondition === null, "Ignore rules cannot have an AI condition");
export type BrowserMonitorRuleInput = z.infer<typeof browserMonitorRuleInputSchema>;
export interface BrowserMonitorRuleRecord { id: string; monitorId: string; version: number; input: BrowserMonitorRuleInput; enabled: boolean; activatedAt: number | null; createdAt: number; updatedAt: number }

function matches(event: MonitorEvent, rule: BrowserMonitorRuleRecord): boolean {
  const input = rule.input;
  if (rule.monitorId !== event.monitorId || !rule.enabled || rule.createdAt > event.observedAt) return false;
  if (rule.activatedAt === null || event.observedAt < rule.activatedAt) return false;
  if (event.occurredAt !== null && event.occurredAt <= rule.activatedAt) return false;
  if (input.targetIds.length && !input.targetIds.includes(event.targetId)) return false;
  if (input.senderIds.length && !input.senderIds.includes(event.senderId)) return false;
  if (input.excludedTargetIds.includes(event.targetId) || input.excludedSenderIds.includes(event.senderId)) return false;
  if (input.textContains === null) return true;
  return input.caseSensitive ? event.text.includes(input.textContains) : event.text.toLowerCase().includes(input.textContains.toLowerCase());
}

function specificity(rule: BrowserMonitorRuleRecord): number {
  return Number(rule.input.targetIds.length > 0) * 2 + Number(rule.input.senderIds.length > 0);
}

export function browserMonitorRuleRevision(rules: readonly BrowserMonitorRuleRecord[]): string {
  const authority = [...rules].sort((left, right) => left.id.localeCompare(right.id))
    .map(rule => [rule.id, rule.version, rule.activatedAt]);
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

export function browserMonitorRuleCandidates(event: MonitorEvent, rules: readonly BrowserMonitorRuleRecord[]): BrowserMonitorRuleRecord[] {
  if (event.direction === "outgoing" || event.kind === "message.edited" || event.processed) return [];
  return rules.filter(rule => matches(event, rule)).sort((left, right) =>
    Number(right.input.action.type === "ignore") - Number(left.input.action.type === "ignore")
    || right.input.priority - left.input.priority
    || specificity(right) - specificity(left)
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id));
}
