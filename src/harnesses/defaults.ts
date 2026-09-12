import { z } from "zod";

export const conversationDefaultSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  modelId: z.string().trim().min(1).max(300),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
}).strict();
export type ConversationDefault = z.infer<typeof conversationDefaultSchema>;
export const conversationDefaultsSchema = z.object({
  pi: conversationDefaultSchema,
  claude: conversationDefaultSchema.extend({ provider: z.literal("claude"), thinkingLevel: z.enum(["low", "medium", "high", "xhigh", "max"]) }),
}).strict();
