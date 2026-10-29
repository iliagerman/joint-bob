import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectsRoot, loadClaudeMessages } from "../src/claude-service.js";
import { listHarnessSessions } from "../src/harnesses.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { claudeProjectDir } from "../src/harnesses/claude/paths.js";
import { WORKTREE_META_DIR } from "../src/project-worktrees.js";
import { loadConversationMessages } from "../src/server/conversation-turns.js";
import { collectStorySources } from "../src/server/git-change-story.js";
import { conversationReviewContext } from "../src/server/git-review-guide.js";
import { addProject } from "../src/store.js";

test("story sources retain real turns across draft segments without opening placeholders as files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-story-segments-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const project = await addProject("Story segments", root, { writeInstructions: false });
    const conversationId = randomUUID();
    const directory = claudeProjectDir(root, claudeProjectsRoot());
    await mkdir(directory, { recursive: true });
    for (const [segmentIndex, engine] of ["claude", "claude", "claude", "claude", "pi"].entries()) {
      const sessionId = segmentIndex === 0 ? conversationId : randomUUID();
      await ensureConversationRecord(project.id, engine, sessionId, "test-node", undefined, { conversationId, segmentIndex });
      if (segmentIndex !== 1 && segmentIndex !== 3) continue;
      const timestamp = new Date().toISOString();
      await writeFile(path.join(directory, `${sessionId}.jsonl`), [
        { type: "user", sessionId, cwd: root, timestamp, message: { role: "user", content: `Question ${segmentIndex}` } },
        { type: "assistant", sessionId, cwd: root, timestamp, message: { role: "assistant", content: [{ type: "text", text: `Answer ${segmentIndex}` }] } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    const listed = (await listHarnessSessions(project)).find((item) => item.conversationId === conversationId)!;
    assert.equal(listed.draft, true, "the newest segment has no transcript");
    assert.equal(listed.segments!.filter((segment) => segment.draft).length, 3, "drafts precede, separate and follow real transcripts");
    const loaded = await loadConversationMessages(project, conversationId);
    assert.deepEqual(loaded.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "Question 1" }, { role: "assistant", text: "Answer 1" },
      { role: "user", text: "Question 3" }, { role: "assistant", text: "Answer 3" },
    ]);
    assert.equal(loaded.lastHarness, "claude");
    const sources = await collectStorySources(project, root, conversationId, { scope: "conversation", pendingPaths: [], includeCommits: false });
    assert.deepEqual(sources.facts.turns.map((turn) => turn.user), ["Question 1", "Question 3"]);
    assert.equal(sources.facts.conversation, true);
    const review = await conversationReviewContext(project, conversationId);
    assert.match(review.transcript, /Question 1[\s\S]*Answer 1[\s\S]*Question 3[\s\S]*Answer 3/);
    assert.equal(review.lastHarness, "claude");
    await assert.rejects(loadClaudeMessages(path.join(root, "outside.jsonl")), /Claude session path is outside Claude projects/, "real path-security violations remain rejected");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unstarted conversation has no story transcript, not a Claude path error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-story-draft-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const project = await addProject("Story draft", root, { writeInstructions: false });
    const sessionId = randomUUID();
    await ensureConversationRecord(project.id, "claude", sessionId, "test-node");
    assert.deepEqual((await loadConversationMessages(project, sessionId)).messages, []);
    await assert.rejects(collectStorySources(project, root, sessionId, { scope: "conversation", pendingPaths: [], includeCommits: false }), /Nothing to explain/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conversation context reads Claude transcripts in a project's worktree, not a synthetic draft path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-context-"));
  const previous = process.env.JOINT_BOB_WORKTREE_ROOT;
  process.env.JOINT_BOB_WORKTREE_ROOT = path.join(root, "worktrees");
  try {
    const projectPath = path.join(root, "project");
    await mkdir(projectPath);
    const project = await addProject("Context worktree", projectPath, { writeInstructions: false });
    const id = randomUUID();
    const worktree = path.join(process.env.JOINT_BOB_WORKTREE_ROOT, project.id, id);
    const metadata = path.join(worktree, WORKTREE_META_DIR);
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(metadata, "worktree.json"), JSON.stringify({
      version: 1, id, name: "Context fixture", color: "teal", createdAt: new Date().toISOString(),
      createdByNodeId: "test-node", baselineDigest: "test", lastMergedAt: null,
    }));
    const sessionId = randomUUID();
    const directory = claudeProjectDir(worktree, claudeProjectsRoot());
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${sessionId}.jsonl`);
    const transcript = [
      { type: "user", sessionId, cwd: worktree, timestamp: new Date().toISOString(), message: { role: "user", content: "What is the phase status?" } },
      { type: "assistant", sessionId, cwd: worktree, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Phase three is still running." }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(file, transcript);
    await ensureConversationRecord(project.id, "claude", sessionId, "test-node");
    const result = await loadConversationMessages(project, sessionId);
    assert.deepEqual(result.messages.map(({ role, text }) => ({ role, text })), [
      { role: "user", text: "What is the phase status?" }, { role: "assistant", text: "Phase three is still running." },
    ]);
    assert.equal(result.lastHarness, "claude");
    assert.equal(await readFile(file, "utf8"), transcript);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_WORKTREE_ROOT;
    else process.env.JOINT_BOB_WORKTREE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
