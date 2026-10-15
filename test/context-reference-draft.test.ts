import assert from "node:assert/strict";
import test from "node:test";
import { referenceDraft } from "../public/app/context-reference-draft.js";

test("context references stay lightweight and identify selected work", () => {
  const draft = referenceDraft({
    projectId: "project-1",
    worktrees: [{
      id: "worktree-1", name: "Fix search", path: "/worktrees/fix-search",
      pullRequest: { number: 42, url: "https://github.test/pull/42", branch: "joint-bob/fix", base: "main" },
    }],
    conversations: [{
      id: "conversation-1", title: "Investigate search", agentLabel: "Pi", path: "/sessions/conversation-1.jsonl",
      worktree: { id: "worktree-1", name: "Fix search" },
    }],
  });

  assert.match(draft, /pointers only; content is not preloaded/);
  assert.match(draft, /Worktree: Fix search[\s\S]*Pull request: #42[\s\S]*joint-bob\/fix -> main/);
  assert.match(draft, /Conversation: Investigate search[\s\S]*conversation-1[\s\S]*\/sessions\/conversation-1\.jsonl/);
  assert.match(draft, /worktree CLI list command before any PR, merge, or delete operation/);
  assert.ok(draft.endsWith("Task:\n"));
});

test("draft conversations omit their unavailable transcript path", () => {
  const draft = referenceDraft({
    projectId: "project-1",
    worktrees: [],
    conversations: [{ id: "draft-1", title: "New work", harnessId: "claude", path: "draft:claude:draft-1" }],
  });

  assert.doesNotMatch(draft, /Transcript path/);
  assert.match(draft, /Agent: claude/);
});
