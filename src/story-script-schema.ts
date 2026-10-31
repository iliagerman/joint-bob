import { z } from "zod";
import { STORY_LOCATIONS, STORY_MOODS } from "./story-settings.js";

// A podcast script is a story told as chapters. Each chapter has a place, a mood, one slide and the lines two hosts say
// while the slide builds. The player draws all of it, so the writer only chooses and never draws.

export const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.object({ title: text(60), text: text(220) }).strict();

const visualSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flow"), nodes: z.array(z.object({ label: text(28), sub: z.string().trim().max(48).default(""), tone: z.enum(["neutral", "bad", "good"]).default("neutral") }).strict()).min(2).max(5), note: note.optional() }).strict(),
  z.object({ kind: z.literal("compare"), options: z.array(z.object({ title: text(60), why: text(90), verdict: z.enum(["yes", "no"]) }).strict()).min(2).max(3), note: note.optional() }).strict(),
  z.object({ kind: z.literal("timeline"), stops: z.array(z.object({ label: text(14), sub: text(24) }).strict()).min(2).max(4), note: note.optional() }).strict(),
  z.object({ kind: z.literal("panel"), panels: z.array(z.object({ title: text(40), tag: text(18), tone: z.enum(["log", "err", "ok"]), text: text(260) }).strict()).min(1).max(2), note: note.optional() }).strict(),
  z.object({
    kind: z.literal("code"), file: text(300),
    lines: z.array(z.string().max(160)).min(1).max(24),
    steps: z.array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1), note: text(220) }).strict()).min(1).max(4),
  }).strict(),
  z.object({ kind: z.literal("recap"), items: z.array(z.object({ label: text(24), text: text(160) }).strict()).length(4) }).strict(),
]);

const lineSchema = z.object({ who: z.enum(["host", "cohost"]), text: text(400), reveal: z.number().int().min(0).max(8) }).strict();

const chapterSchema = z.object({
  title: text(40),
  location: z.enum(STORY_LOCATIONS),
  mood: z.enum(STORY_MOODS),
  visual: visualSchema,
  lines: z.array(lineSchema).min(1).max(8),
  /** Set on chapters added by a follow-up question. */
  question: text(500).optional(),
}).strict();

const writeupSchema = z.object({
  changed: z.array(text(360)).min(1).max(8),
  how: z.array(text(360)).min(1).max(8),
  why: z.array(text(360)).min(1).max(6),
  rejected: z.array(z.object({ option: text(120), why: text(280) }).strict()).max(5),
  limits: z.array(text(360)).max(5),
}).strict();

export const writtenScriptSchema = z.object({ title: text(120), chapters: z.array(chapterSchema).min(3).max(10), writeup: writeupSchema }).strict();
export const writtenAnswerSchema = z.object({ answer: text(600), chapters: z.array(chapterSchema).min(1).max(2) }).strict();

/** The script as it is kept and replicated: what the writer wrote, the follow-up answers, and when it was made and expires. */
export const storyScriptSchema = writtenScriptSchema.extend({
  followUps: z.array(z.object({ question: text(500), answer: text(600) }).strict()).max(50),
  generatedAt: z.string().max(40),
  /** Changes with every save, so a replica knows which copy is newer. */
  updatedAt: z.string().max(40),
  /** The story's own expiry: a script never outlives the story it explains. */
  expiresAt: z.string().max(40),
}).strict();

export type PodcastChapter = z.infer<typeof chapterSchema>;
export type StoryScript = z.infer<typeof storyScriptSchema>;
