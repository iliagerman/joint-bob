import { z } from "zod";
import type { ProposedRule } from "./conversation-digest.js";

export const closeoutFeedbackSchema = z.object({
  rating: z.enum(["good", "bad", "unimportant"]),
  description: z.string().trim().max(1000).default(""),
}).strict();
export type CloseoutFeedback = z.infer<typeof closeoutFeedbackSchema>;
export const closeoutRecordSchema = z.object({
  revision: z.string(), projectId: z.string(), engine: z.string(),
  source: z.enum(["manual", "automatic"]),
  feedback: closeoutFeedbackSchema.nullable(),
  status: z.enum(["pending", "complete", "error"]),
  error: z.string().optional(),
}).strict();
export type CloseoutRecord = z.infer<typeof closeoutRecordSchema>;
export interface CloseoutDeps {
  classify(): Promise<CloseoutFeedback["rating"]>;
  describe(rating: "good" | "bad", description: string): Promise<{ description: string; rules: ProposedRule[] }>;
  select(rating: "good" | "bad", description: string, rules: ProposedRule[]): Promise<number[]>;
}

/** Human ratings are authoritative; neither agent is asked anything for an unimportant conversation. */
export async function closeoutAssessment(feedback: CloseoutFeedback | null, deps: CloseoutDeps) {
  const rating = feedback ? feedback.rating : await deps.classify();
  if (rating === "unimportant") return { rating, description: "", rules: [] as ProposedRule[] };
  const draft = await deps.describe(rating, feedback?.description ?? "");
  const description = feedback?.description || draft.description;
  const selected = draft.rules.length ? await deps.select(rating, description, draft.rules) : [];
  return { rating, description, rules: draft.rules.filter((_, index) => selected.includes(index)) };
}

/** Files syncing or summaries updating are not interactions. Missing timestamps cannot prove inactivity. */
export function inactiveConversation(messages: ReadonlyArray<{ role: string; timestamp?: string }>, busy: boolean, done: boolean, now: number): boolean {
  if (busy || done) return false;
  const timestamps = messages.filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => Date.parse(message.timestamp ?? ""));
  if (!timestamps.length || timestamps.some((stamp) => !Number.isFinite(stamp))) return false;
  return now - Math.max(...timestamps) > 4 * 24 * 3_600_000;
}
