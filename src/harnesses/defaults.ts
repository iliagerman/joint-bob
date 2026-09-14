import { z } from "zod";
import { listDiscoveredHarnesses } from "./registry.js";

export const conversationDefaultSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();
export type ConversationDefault = z.infer<typeof conversationDefaultSchema>;

function specializedSchema(configuration: NonNullable<ReturnType<typeof listDiscoveredHarnesses>[number]["configuration"]> | undefined) {
  if (!configuration) return conversationDefaultSchema;
  return conversationDefaultSchema.superRefine((value, context) => {
    if (configuration.fixedProvider && value.provider !== configuration.fixedProvider) context.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"], message: `Provider must be ${configuration.fixedProvider}` });
    if (!configuration.thinkingLevels.includes(value.thinkingLevel)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["thinkingLevel"], message: "Thinking level is not supported" });
  });
}

export const conversationDefaultsSchema = z.object(Object.fromEntries(
  listDiscoveredHarnesses().map((adapter) => [adapter.id, specializedSchema(adapter.configuration).default(adapter.defaults)]),
) as Record<string, z.ZodType<ConversationDefault>>).strict();
