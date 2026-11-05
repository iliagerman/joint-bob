import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as errors from "../src/git-review.js";
import * as threads from "../src/git-review-threads.js";
import * as scripts from "../src/story-scripts.js";
import * as schemas from "../src/story-script-schema.js";
import * as settings from "../src/story-settings.js";
import * as stories from "../src/server/git-change-story.js";
import type { RunGitReviewInput } from "../src/server/git-review-run.js";
import type * as Writer from "../src/server/story-podcast.js";

// Run the production writer with only the external model call replaced. Validation and persistence stay real.
const compiled = ts.transpileModule(readFileSync(new URL("../src/server/story-podcast.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function writer(answer: (input: RunGitReviewInput, attempt: number) => string) {
  const calls: RunGitReviewInput[] = [];
  const dependencies: Record<string, unknown> = {
    "../git-review.js": errors, "../git-review-threads.js": threads, "../story-scripts.js": scripts,
    "../story-script-schema.js": schemas, "../story-settings.js": settings, "./git-change-story.js": stories,
    "./git-review-run.js": { runGitReview: async (input: RunGitReviewInput) => {
      calls.push(input);
      return { answer: answer(input, calls.length), provider: "fixture", modelId: "fixture", thinkingLevel: "off" };
    } },
  };
  const exports = {} as typeof Writer;
  vm.runInThisContext(`(function(require, exports) { ${compiled}\n})`)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return { ...exports, calls };
}

const source: Writer.OverviewSource = {
  facts: { conversation: true, turns: [], commits: [], files: [{ path: "app.ts", kind: "modified", add: 1, del: 0, where: ["pending"], area: "app.ts" }] },
  patches: [{ path: "app.ts", source: "pending", patch: "@@ -0,0 +1 @@\n+run();" }],
};
const chapter: schemas.PodcastChapter = {
  title: "The change", location: "podcast", mood: "calm",
  visual: { kind: "code", file: "app.ts", lines: ["+run();"], steps: [{ from: 1, to: 1, note: "Run the app." }] },
  lines: [{ who: "host", text: "The app now runs.", reveal: 1 }],
};
const valid = { title: "The movie", chapters: [chapter, chapter, chapter], writeup: { changed: ["Runs the app."], how: ["Calls run."], why: ["Start the app."], rejected: [], limits: [] } };
function thread(): threads.GitReviewThread {
  const now = new Date().toISOString();
  return { id: randomUUID(), projectId: "writer-repair", conversationId: null, harnessId: "pi", provider: "fixture", modelId: "fixture", thinkingLevel: "off", selection: { scope: "worktree" }, snapshot: "", messages: [], createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
}
const oversized = { ...chapter, visual: { ...chapter.visual, lines: ["+run();", "+run();", "+" + "x".repeat(160)] } };

for (const [name, bad, issue] of [
  ["oversized code line", JSON.stringify({ ...valid, chapters: [chapter, chapter, chapter, oversized] }), /chapters\.3\.visual\.lines\.2/],
  ["invalid JSON", "not JSON", /valid JSON/],
  ["invented code", JSON.stringify({ ...valid, chapters: [{ ...chapter, visual: { ...chapter.visual, lines: ["+invented();"] } }, chapter, chapter] }), /not in the diff/],
] as const) {
  test(`the movie writer repairs ${name} internally before saving`, async () => {
    const target = thread();
    const engine = writer((input, attempt) => {
      if (attempt === 1) return bad;
      assert.equal(scripts.loadStoryScript(target.projectId, target.id), null, "Rejected drafts must not be saved");
      assert.match(input.instructions!, issue);
      assert.ok(input.instructions!.includes(JSON.stringify(bad)), "Repair includes the rejected answer as data");
      assert.match(input.diff, /\+run\(\);/, "Repair keeps the source diff");
      return JSON.stringify(valid);
    });
    const result = await engine.generateStoryScript(target, "/fixture", source, settings.DEFAULT_STORY_SETTINGS);
    assert.equal(result.chapters.length, 3);
    assert.deepEqual(result.chapters[0].visual, chapter.visual);
    assert.deepEqual(scripts.loadStoryScript(target.projectId, target.id), result);
    assert.equal(engine.calls.length, 2);
  });
}

test("Activity overview keeps the source conversation's subscription scope", async () => {
  const target = { ...thread(), conversationId: "source-conversation" };
  const engine = writer(() => JSON.stringify(valid));
  await engine.generateStoryScript(target, "/fixture", source, settings.DEFAULT_STORY_SETTINGS);
  assert.equal(engine.calls[0].conversationId, "source-conversation");
  assert.equal(engine.calls[0].useTools, undefined, "subscription inheritance must not enable tools");
});

test("valid movie output needs no repair", async () => {
  const engine = writer(() => JSON.stringify(valid));
  const result = await engine.generateStoryScript(thread(), "/fixture", source, settings.DEFAULT_STORY_SETTINGS);
  assert.equal(result.title, "The movie");
  assert.equal(engine.calls.length, 1);
});

test("follow-up repairs preserve the existing movie until a valid answer can be appended", async () => {
  const target = thread();
  const original: schemas.StoryScript = { ...valid, followUps: [], generatedAt: target.createdAt, updatedAt: target.updatedAt, expiresAt: target.expiresAt };
  scripts.saveStoryScript(target.projectId, target.id, original);
  const engine = writer((input, attempt) => {
    assert.deepEqual(scripts.loadStoryScript(target.projectId, target.id), original);
    assert.match(input.diff, /Why run it\?/);
    return JSON.stringify({ answer: "To start the app.", chapters: [attempt === 1 ? oversized : chapter] });
  });
  const result = await engine.askStoryScript(target, "/fixture", source, original, "Why run it?", settings.DEFAULT_STORY_SETTINGS);
  assert.equal(result.chapters.length, 4);
  assert.deepEqual(result.chapters.slice(0, 3), original.chapters);
  assert.equal(result.chapters[3].question, "Why run it?");
  assert.deepEqual(result.followUps, [{ question: "Why run it?", answer: "To start the app." }]);
  assert.deepEqual(scripts.loadStoryScript(target.projectId, target.id), result);
  assert.equal(engine.calls.length, 2);
});

test("repeated invalid answers stop after bounded repairs without exposing schema errors or saving a draft", async () => {
  const target = thread();
  const engine = writer(() => "not JSON");
  await assert.rejects(engine.generateStoryScript(target, "/fixture", source, settings.DEFAULT_STORY_SETTINGS), (error: Error) => {
    assert.match(error.message, /could not finish/i);
    assert.doesNotMatch(error.message, /JSON|schema|Podcast rejected/);
    assert.ok(error.cause instanceof errors.GitReviewError, "Keep the validator diagnostic for server logs");
    return true;
  });
  assert.equal(engine.calls.length, 3);
  assert.equal(scripts.loadStoryScript(target.projectId, target.id), null);
});

test("model failures are not treated as rejected drafts", async () => {
  const failure = new Error("Provider unavailable");
  const engine = writer(() => { throw failure; });
  await assert.rejects(engine.generateStoryScript(thread(), "/fixture", source, settings.DEFAULT_STORY_SETTINGS), (error) => error === failure);
  assert.equal(engine.calls.length, 1);
});
