import { z } from "zod";

const boundedNonempty = (max: number) => z.string().min(1).max(max);
export const monitorBindingSchema = z.object({
  nodeId: z.string().uuid(), sessionId: z.string().uuid(), profileId: z.string().uuid(), pageId: z.string().uuid(),
  engine: z.enum(["pi", "claude"]), conversationId: boundedNonempty(200),
}).strict();
export type MonitorBinding = z.infer<typeof monitorBindingSchema>;

const originSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value === url.origin;
  } catch { return false; }
}, "Expected an exact HTTP(S) origin");
const targetIdsSchema = z.array(boundedNonempty(320)).max(200).refine(values => new Set(values).size === values.length, "Target IDs must be unique");
export const monitorInputSchema = z.object({
  projectId: boundedNonempty(200), name: z.string().trim().min(1).max(120), checkerId: z.string().trim().min(1).max(100),
  checkerVersion: z.number().int().positive(), origin: originSchema, accountId: z.string().trim().min(1).max(320),
  targetIds: targetIdsSchema, intervalSeconds: z.number().int().min(10).max(86400), binding: monitorBindingSchema,
  readAcknowledged: z.boolean(),
}).strict();
export type MonitorInput = z.infer<typeof monitorInputSchema>;

export const monitorItemSchema = z.object({
  externalId: boundedNonempty(1024), targetId: boundedNonempty(320), targetLabel: boundedNonempty(320), senderId: boundedNonempty(320),
  direction: z.enum(["incoming", "outgoing"]), kind: z.enum(["message.received", "page.changed", "message.edited"]),
  text: z.string().max(16000), occurredAt: z.number().int().nonnegative().nullable(), identity: z.enum(["stable", "fingerprint"]),
}).strict();
export type MonitorItem = z.infer<typeof monitorItemSchema>;

export const monitorCheckpointSchema = z.record(z.string().max(320), z.string().max(8192)).refine(value => Object.keys(value).length <= 500, "Checkpoint has too many keys").refine(value => Buffer.byteLength(JSON.stringify(value)) <= 65536, "Checkpoint is too large");
export const monitorCheckResultSchema = z.object({
  accountId: boundedNonempty(320), items: z.array(monitorItemSchema).max(500), checkpoint: monitorCheckpointSchema,
  complete: z.boolean(), detail: z.string().max(2000),
}).strict();
export type MonitorCheckResult = z.infer<typeof monitorCheckResultSchema>;

export type MonitorHealth = "paused" | "ready" | "partial" | "checking" | "needs-login" | "wrong-account" | "target-missing" | "incompatible" | "browser-stopped" | "paused-by-human" | "unavailable" | "error";
export interface MonitorRecord extends MonitorInput {
  id: string; ownerNodeId: string; generation: number; enabled: boolean; baseline: boolean; checkpoint: Record<string, string>;
  health: MonitorHealth; detail: string; nextDueAt: number | null; lastStartedAt: number | null; lastFinishedAt: number | null;
  createdAt: number; updatedAt: number;
}
export interface MonitorRun { id: string; monitorId: string; generation: number; dueAt: number; startedAt: number; finishedAt: number | null; status: "running" | "succeeded" | "failed" | "cancelled"; detail: string }
export interface MonitorEvent extends MonitorItem { id: string; monitorId: string; observedAt: number; processed: boolean }
