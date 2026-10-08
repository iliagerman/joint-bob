import { z } from "zod";
const DEFAULT_CONVERSATION_LABELS = ["Research", "Bug", "Feature", "POC"];
const classificationSchema = z.string().trim().min(1).max(80);
const conversationLabelsSchema = z.array(classificationSchema.refine(
  (label) => !["other", "__other__"].includes(label.toLowerCase()),
  "Other is reserved for free-text classifications"
)).max(50).transform((labels) => labels.filter((label, index) => labels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) === index));
export {
  DEFAULT_CONVERSATION_LABELS,
  classificationSchema,
  conversationLabelsSchema
};
