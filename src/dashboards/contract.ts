import { z } from "zod";

/**
 * A dashboard's definition is its manifest plus one HTML page. The manifest only says how the
 * data is refreshed; which conversation, project or workspace it belongs to lives in the
 * node's record, so the creator agent can never move a dashboard by editing its files.
 */
export const refreshMethodSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("script"), command: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ method: z.literal("ai"), prompt: z.string().trim().min(1).max(20_000) }).strict(),
]);
export type RefreshMethod = z.infer<typeof refreshMethodSchema>;

export const dashboardManifestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  refresh: refreshMethodSchema,
}).strict();
export type DashboardManifest = z.infer<typeof dashboardManifestSchema>;

const entityId = z.string().min(1).max(300);
export const dashboardEntitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), id: entityId, projectId: entityId }).strict(),
  z.object({ kind: z.literal("project"), id: entityId }).strict(),
  z.object({ kind: z.literal("workspace"), id: entityId }).strict(),
]);
export type DashboardEntity = z.infer<typeof dashboardEntitySchema>;
export type DashboardEntityKind = DashboardEntity["kind"];

export type DashboardPayload = Record<string, unknown> & { generatedAt: string };

/** A refresh prints exactly one JSON object; anything else is a failed refresh. */
export function parsePayload(text: string): DashboardPayload {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("The refresh did not print valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The refresh must print one JSON object");
  const generatedAt = (value as { generatedAt?: unknown }).generatedAt;
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) throw new Error("The refresh payload needs a generatedAt timestamp");
  return value as DashboardPayload;
}

