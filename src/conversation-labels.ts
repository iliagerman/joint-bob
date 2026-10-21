import { z } from "zod";

export const DEFAULT_CONVERSATION_LABELS = ["Research", "Bug", "Feature", "POC", "Deploy to prod", "Hotfix"];
export const classificationSchema = z.string().trim().min(1).max(80);
export const conversationLabelsInputSchema = z.array(classificationSchema.refine(
  (label) => !["other", "__other__"].includes(label.toLowerCase()),
  "Other is reserved for free-text classifications",
)).max(50);
export const conversationLabelsSchema = conversationLabelsInputSchema.transform((labels) => {
  const available = [...DEFAULT_CONVERSATION_LABELS, ...labels];
  return available.filter((label, index) => available.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index);
});

export const DEFAULT_CONVERSATION_LABEL_ICONS: Record<string, string> = { Research: "🔬", Bug: "🐞", Feature: "✨", POC: "🧪", "Deploy to prod": "🚀", Hotfix: "🔥" };
/** A label's icon is a short glyph (an emoji, usually); a label without an entry shows its name. */
export const labelIconSchema = z.string().trim().min(1).max(16);
export const conversationLabelIconsSchema = z.record(classificationSchema, labelIconSchema);
/** Empty stored overrides distinguish an intentionally cleared icon from a missing new default. */
export const storedConversationLabelIconsSchema = z.record(classificationSchema, labelIconSchema.or(z.literal("")));

/** Keeps icons for labels still in the list, so renaming or removing a label never leaves a stray icon. */
export function iconsForLabels(labels: string[], icons: Record<string, string>): Record<string, string> {
  return Object.fromEntries(labels.filter((label) => icons[label]).map((label) => [label, icons[label]]));
}

export function labelIconPrompt(label: string): string {
  return [
    "Pick one icon for a conversation label in a developer tool, shown in place of the label's text.",
    `Label: ${JSON.stringify(label)}`,
    "Reply with exactly one emoji that best conveys the label's meaning. No words, no quotes, no punctuation, no explanation.",
  ].join("\n");
}

/** The first emoji or symbol in a model reply, or undefined when it answered with words only. */
export function parseGeneratedIcon(answer: string): string | undefined {
  const match = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/u.exec(answer);
  return match?.[0];
}
