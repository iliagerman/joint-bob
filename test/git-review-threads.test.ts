import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDataDirectory } from "../src/data-directory.js";
import {
  appendGitReviewMessages,
  createGitReviewThread,
  deleteGitReviewThread,
  getGitReviewThread,
  GIT_REVIEW_THREAD_TTL_MS,
  listGitReviewThreads,
} from "../src/git-review-threads.js";

function baseInput(overrides: Partial<Parameters<typeof createGitReviewThread>[0]> = {}) {
  return {
    projectId: "project-1",
    conversationId: null,
    harnessId: "pi",
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    thinkingLevel: "medium",
    selection: { scope: "worktree" as const, filePath: "src/app.ts", staged: false },
    snapshot: "@@ -1 +1 @@\n-old\n+new\n",
    question: "Why did this change?",
    answer: "Because the API changed.",
    ...overrides,
  };
}

test("a review thread stores its question, answer, and preserved snapshot", () => {
  const thread = createGitReviewThread(baseInput());
  const loaded = getGitReviewThread(thread.id);
  assert.ok(loaded, "thread should be retrievable");
  assert.equal(loaded.snapshot, "@@ -1 +1 @@\n-old\n+new\n");
  assert.deepEqual(loaded.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(loaded.messages[0].text, "Why did this change?");
  assert.equal(loaded.messages[1].text, "Because the API changed.");
});

test("follow-up appends messages and pushes expiry forward", () => {
  const thread = createGitReviewThread(baseInput());
  const before = Date.parse(thread.expiresAt);
  const updated = appendGitReviewMessages(thread.id, "And the tests?", "The tests were updated too.");
  assert.ok(updated, "follow-up returns the updated thread");
  assert.equal(updated.messages.length, 4);
  assert.equal(updated.messages[2].text, "And the tests?");
  assert.ok(Date.parse(updated.expiresAt) >= before, "expiry does not move backward");
});

test("listing filters by conversation scope", () => {
  const projectId = `project-scope-${Date.now()}`;
  createGitReviewThread(baseInput({ projectId, conversationId: "conversation-a" }));
  createGitReviewThread(baseInput({ projectId, conversationId: null }));
  const all = listGitReviewThreads(projectId);
  assert.equal(all.length, 2, "unfiltered list returns every project review");
  const scoped = listGitReviewThreads(projectId, "conversation-a");
  assert.equal(scoped.length, 1, "conversation filter returns only that conversation's reviews");
  assert.equal(scoped[0].conversationId, "conversation-a");
  const projectLevel = listGitReviewThreads(projectId, null);
  assert.equal(projectLevel.length, 1, "null filter returns only project-level reviews");
  assert.equal(projectLevel[0].conversationId, null);
});

test("an expired thread is pruned on the next read", () => {
  const thread = createGitReviewThread(baseInput({ projectId: `project-expiry-${Date.now()}` }));
  // Reach into the shared node.db to backdate this thread past its TTL, then confirm
  // the next read prunes it. This is the behaviour the whole "expiring" decision rests on.
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  const expired = new Date(Date.now() - GIT_REVIEW_THREAD_TTL_MS - 1000).toISOString();
  db.prepare("UPDATE git_review_threads SET expires_at = ? WHERE id = ?").run(expired, thread.id);
  db.close();
  assert.equal(getGitReviewThread(thread.id), undefined, "expired thread is pruned on read");
});

test("deleting a thread removes it", () => {
  const thread = createGitReviewThread(baseInput());
  assert.equal(deleteGitReviewThread(thread.id), true);
  assert.equal(getGitReviewThread(thread.id), undefined);
  assert.equal(deleteGitReviewThread(thread.id), false, "deleting a missing thread reports false");
});
