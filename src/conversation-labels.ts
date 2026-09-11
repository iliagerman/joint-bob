import { z } from "zod";

export const DEFAULT_CONVERSATION_LABELS = ["Research", "Bug", "Feature", "POC"];
export const classificationSchema = z.string().trim().min(1).max(80);
export const conversationLabelsSchema = z.array(classificationSchema.refine(
  (label) => !["other", "__other__"].includes(label.toLowerCase()),
  "Other is reserved for free-text classifications",
)).max(50).transform((labels) => labels.filter((label, index) =>
  labels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index));
