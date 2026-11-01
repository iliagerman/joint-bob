import assert from "node:assert/strict";
import test from "node:test";
import { GitReviewError } from "../src/git-review.js";
import { DEFAULT_STORY_SETTINGS, type StorySettings } from "../src/story-settings.js";
import type { SavedChangeStory } from "../src/server/git-change-story.js";
import { checkChapters, material, parseWriterAnswer, writtenAnswerSchema, writtenScriptSchema, type PodcastChapter } from "../src/server/story-podcast.js";

const saved = {
  patches: [{ path: "src/loader.ts", source: "abc1234", patch: "@@ -1,3 +1,4 @@\n for (const entry of entries) {\n-  if (!entry.path) continue;\n+  if (!entry.path || entry.path.startsWith(\"draft:\")) continue;\n   load(entry);" }],
} as SavedChangeStory;

function chapter(visual: PodcastChapter["visual"], overrides: Partial<PodcastChapter> = {}): PodcastChapter {
  return { title: "The fix", location: "matrix", mood: "insight", visual, lines: [{ who: "host", text: "Here is the fix.", reveal: 1 }], ...overrides };
}
const code = (lines: string[], steps = [{ from: 1, to: 1, note: "The loop." }], file = "src/loader.ts"): PodcastChapter["visual"] => ({ kind: "code", file, lines, steps });
const rejects = (chapters: PodcastChapter[], settings: StorySettings, pattern: RegExp) =>
  assert.throws(() => checkChapters(chapters, saved, settings), (error: GitReviewError) => error.status === 422 && pattern.test(error.message));

test("a code slide may show only lines that the diff of its file contains", () => {
  checkChapters([chapter(code(["for (const entry of entries) {", "-  if (!entry.path) continue;", "+  if (!entry.path || entry.path.startsWith(\"draft:\")) continue;", ""]))], saved, DEFAULT_STORY_SETTINGS);
  rejects([chapter(code(["+  if (entry.isDraft) continue;"]))], DEFAULT_STORY_SETTINGS, /not in the diff of src\/loader.ts/);
  rejects([chapter(code(["load(entry);"], undefined, "src/other.ts"))], DEFAULT_STORY_SETTINGS, /src\/other.ts, which is not part of these changes/);
});

test("highlights stay inside the snippet and the snippet stays inside the limit", () => {
  rejects([chapter(code(["load(entry);"], [{ from: 1, to: 3, note: "Too far." }]))], DEFAULT_STORY_SETTINGS, /covers lines 1 to 3, but the snippet has 1/);
  rejects([chapter(code(["load(entry);", "load(entry);"]))], { ...DEFAULT_STORY_SETTINGS, maxCodeLines: 1 } as StorySettings, /limit is 1/);
});

test("code and locations that Settings switched off are refused", () => {
  rejects([chapter(code(["load(entry);"]))], { ...DEFAULT_STORY_SETTINGS, codeSlides: false }, /code slides are off/);
  rejects([chapter({ kind: "recap", items: [1, 2, 3, 4].map((n) => ({ label: `L${n}`, text: "x" })) }, { location: "rooftop" })], { ...DEFAULT_STORY_SETTINGS, locations: ["podcast"] }, /rooftop, which is switched off/);
  checkChapters([chapter({ kind: "recap", items: [1, 2, 3, 4].map((n) => ({ label: `L${n}`, text: "x" })) }, { location: "rooftop" })], saved, { ...DEFAULT_STORY_SETTINGS, backdrops: false, locations: ["podcast"] });
});

test("the writer's answer is parsed, and a misshapen one says where it went wrong", () => {
  const written = { title: "T", chapters: [1, 2, 3].map((n) => chapter({ kind: "flow", nodes: [{ label: "A", sub: "", tone: "neutral" }, { label: "B", sub: "", tone: "bad" }] }, { title: `Chapter ${n}` })), writeup: { changed: ["a"], how: ["b"], why: ["c"], rejected: [], limits: [] } };
  assert.equal(parseWriterAnswer(writtenScriptSchema, `\`\`\`json\n${JSON.stringify(written)}\n\`\`\``).chapters.length, 3);
  assert.throws(() => parseWriterAnswer(writtenScriptSchema, "not json"), /valid JSON/);
  const bad = { answer: "x", chapters: [chapter({ kind: "flow", nodes: [{ label: "A", sub: "", tone: "neutral" }] })] };
  assert.throws(() => parseWriterAnswer(writtenAnswerSchema, JSON.stringify(bad)), /chapters\.0\.visual\.nodes/);
});

test("the movie is written from the conversation's turns and diffs when there is no written story", () => {
  const facts = {
    conversation: true,
    turns: [{ n: 1, user: "Skip draft entries when loading", commits: ["abc1234"], paths: ["src/loader.ts"] }],
    commits: [{ hash: "abc1234abc1234", shortHash: "abc1234", subject: "fix: skip drafts", turn: 1 }],
    files: [{ path: "src/loader.ts", kind: "modified" as const, add: 1, del: 1, where: ["abc1234"], area: "src" }],
  };
  const text = material({ facts, patches: saved.patches });
  assert.match(text, /What was asked in the conversation[\s\S]*1\. Skip draft entries when loading/);
  assert.match(text, /abc1234: fix: skip drafts/);
  assert.match(text, /Diff:/);
  assert.doesNotMatch(text, /Change story \(already checked/);
});
