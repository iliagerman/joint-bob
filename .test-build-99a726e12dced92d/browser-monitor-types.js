import { z } from "zod";
const boundedNonempty = (max) => z.string().min(1).max(max);
const monitorBindingSchema = z.object({
  nodeId: z.string().uuid(),
  sessionId: z.string().uuid(),
  profileId: z.string().uuid(),
  pageId: z.string().uuid(),
  engine: z.enum(["pi", "claude"]),
  conversationId: boundedNonempty(200)
}).strict();
const originSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value === url.origin;
  } catch {
    return false;
  }
}, "Expected an exact HTTP(S) origin");
const targetIdsSchema = z.array(boundedNonempty(320)).max(200).refine((values) => new Set(values).size === values.length, "Target IDs must be unique");
const monitorInputSchema = z.object({
  projectId: boundedNonempty(200),
  name: z.string().trim().min(1).max(120),
  checkerId: z.string().trim().min(1).max(100),
  checkerVersion: z.number().int().positive(),
  origin: originSchema,
  accountId: z.string().trim().min(1).max(320),
  targetIds: targetIdsSchema,
  intervalSeconds: z.number().int().min(10).max(86400),
  binding: monitorBindingSchema,
  readAcknowledged: z.boolean()
}).strict();
const monitorItemSchema = z.object({
  externalId: boundedNonempty(1024),
  targetId: boundedNonempty(320),
  targetLabel: boundedNonempty(320),
  senderId: boundedNonempty(320),
  direction: z.enum(["incoming", "outgoing"]),
  kind: z.enum(["message.received", "page.changed", "message.edited"]),
  text: z.string().max(16e3),
  occurredAt: z.number().int().nonnegative().nullable(),
  identity: z.enum(["stable", "fingerprint"])
}).strict();
const monitorCheckpointSchema = z.record(z.string().max(320), z.string().max(8192)).refine((value) => Object.keys(value).length <= 500, "Checkpoint has too many keys").refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536, "Checkpoint is too large");
const monitorPartitionCoverageSchema = z.object({
  targetId: boundedNonempty(320),
  cursor: z.string().min(1).max(8192).nullable(),
  complete: z.boolean(),
  continuation: z.string().min(1).max(8192).nullable(),
  detail: z.string().max(2e3)
}).strict().superRefine((partition, context) => {
  if (partition.complete && partition.continuation !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["continuation"], message: "Complete partition cannot have a continuation" });
});
const monitorCoverageSchema = z.object({
  discoveryComplete: z.boolean(),
  partitions: z.array(monitorPartitionCoverageSchema).max(200)
}).strict().refine((value) => new Set(value.partitions.map((partition) => partition.targetId)).size === value.partitions.length, "Partition target IDs must be unique").refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536, "Coverage is too large");
const monitorCheckResultSchema = z.object({
  accountId: boundedNonempty(320),
  items: z.array(monitorItemSchema).max(500),
  checkpoint: monitorCheckpointSchema,
  complete: z.boolean(),
  detail: z.string().max(2e3),
  coverage: monitorCoverageSchema.optional()
}).strict().superRefine((result, context) => {
  if (!result.coverage) return;
  const partitions = new Map(result.coverage.partitions.map((partition) => [partition.targetId, partition]));
  for (const item of result.items) if (!partitions.has(item.targetId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Item target requires partition coverage" });
  const complete = result.coverage.discoveryComplete && result.coverage.partitions.every((partition) => partition.complete);
  if (result.complete !== complete) context.addIssue({ code: z.ZodIssueCode.custom, path: ["complete"], message: "Result completeness contradicts coverage" });
  const expected = Object.fromEntries(result.coverage.partitions.filter((partition) => partition.complete && partition.cursor !== null).map((partition) => [partition.targetId, partition.cursor]));
  if (Object.keys(result.checkpoint).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => result.checkpoint[key] !== value)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["checkpoint"], message: "Checkpoint must contain exactly complete partition cursors" });
});
export {
  monitorBindingSchema,
  monitorCheckResultSchema,
  monitorCheckpointSchema,
  monitorCoverageSchema,
  monitorInputSchema,
  monitorItemSchema,
  monitorPartitionCoverageSchema
};
