import { z } from "zod";
import { settingsDatabase, save, value } from "./settings-store.js";

/**
 * How conversation summaries (the Activity panel's) are kept on this node: when they are
 * written and which agent writes them. A node admin sets it in Settings; a relay this node
 * has joined can publish one too, and an admitted relay's policy wins over the node's.
 */
export const summaryWriterSchema = z.discriminatedUnion("source", [
  /** The routing classifier picks the model when routing is on; otherwise the conversation's own. */
  z.object({ source: z.literal("automatic") }).strict(),
  z.object({ source: z.literal("conversation") }).strict(),
  z.object({
    source: z.literal("fixed"),
    harnessId: z.string().trim().min(1).max(80),
    provider: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().trim().min(1).max(300),
    thinkingLevel: z.string().trim().min(1).max(40),
  }).strict(),
]);

export const summaryPolicySchema = z.object({
  /** each-message: after every answer, panel open or not; panel: only while someone has the panel open; manual: only when asked. */
  updates: z.enum(["each-message", "panel", "manual"]),
  writer: summaryWriterSchema,
}).strict();

export type SummaryWriter = z.infer<typeof summaryWriterSchema>;
export type SummaryPolicy = z.infer<typeof summaryPolicySchema>;

const SETTING_KEY = "conversationSummary";
const INSTRUCTIONS_KEY = "conversationSummaryInstructions";
export const SUMMARY_INSTRUCTIONS_LIMIT = 6_000;

/** What the writer is told a summary is for and how to write it; empty means the built-in text. */
export const summaryInstructionsSchema = z.string().trim().max(SUMMARY_INSTRUCTIONS_LIMIT);

export function defaultSummaryPolicy(): SummaryPolicy {
  return { updates: "each-message", writer: { source: "automatic" } };
}

/** This node's own policy, as its admin saved it. */
export function nodeSummaryPolicy(): SummaryPolicy {
  const stored = value(SETTING_KEY, "");
  if (!stored) return defaultSummaryPolicy();
  try {
    return summaryPolicySchema.parse(JSON.parse(stored));
  } catch {
    return defaultSummaryPolicy();
  }
}

export function saveNodeSummaryPolicy(policy: SummaryPolicy): SummaryPolicy {
  const parsed = summaryPolicySchema.parse(policy);
  save(settingsDatabase(), SETTING_KEY, JSON.stringify(parsed));
  return parsed;
}

/**
 * This machine's own summary instructions, or null for the built-in ones. They stay out of
 * the relay's signed policy: machines on older releases reject a policy with fields they do
 * not know, which would cost them the relay's skill rules too.
 */
export function nodeSummaryInstructions(): string | null {
  const stored = value(INSTRUCTIONS_KEY, "").trim();
  return stored || null;
}

/** Saves this machine's summary instructions; null or empty text goes back to the built-in ones. */
export function saveNodeSummaryInstructions(text: string | null): string | null {
  const parsed = text === null ? "" : summaryInstructionsSchema.parse(text);
  save(settingsDatabase(), INSTRUCTIONS_KEY, parsed);
  return parsed || null;
}

export function nodeSkillSuggestionInstructions(): string | null {
  return value("conversationSkillSuggestionInstructions", "").trim() || null;
}

export function saveNodeSkillSuggestionInstructions(text: string | null): string | null {
  const parsed = text === null ? "" : summaryInstructionsSchema.parse(text);
  save(settingsDatabase(), "conversationSkillSuggestionInstructions", parsed);
  return parsed || null;
}

export interface EffectiveSummaryPolicy extends SummaryPolicy {
  /** Where it came from: this node's setting, or the relay that set it. */
  from: { kind: "node" } | { kind: "relay"; relay: string };
}

/** The relay's policy when an admitted relay published one (the first, in membership order), else the node's. */
export function effectiveSummaryPolicy(relayPolicies: Array<{ relay: string; summary?: SummaryPolicy }>): EffectiveSummaryPolicy {
  const relay = relayPolicies.find((candidate) => candidate.summary);
  if (relay?.summary) return { ...relay.summary, from: { kind: "relay", relay: relay.relay } };
  return { ...nodeSummaryPolicy(), from: { kind: "node" } };
}

/** A short name for who writes summaries, for the panel. */
export function summaryWriterLabel(writer: SummaryWriter): string {
  if (writer.source === "automatic") return "automatic";
  if (writer.source === "conversation") return "as conversation";
  return writer.modelId;
}
