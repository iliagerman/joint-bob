import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { holdEndedRun, releaseEndedRun } from "../src/conversation-runtime.js";
import { setSessionDone } from "../src/names.js";
import { createProjectWorktree, markWorktreeConversation } from "../src/project-worktrees.js";
import { cleanupDoneWorktrees } from "../src/server/worktree-cleanup.js";
import { addProject } from "../src/store.js";

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-cleanup-"));
  process.env.JOINT_BOB_WORKTREE_ROOT = path.join(root, "worktrees");
  context.after(async () => { delete process.env.JOINT_BOB_WORKTREE_ROOT; await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "project");
  await mkdir(source);
  await writeFile(path.join(source, "index.ts"), "export const value = 1;\n");
  const project = await addProject("Cleanup fixture", source, { writeInstructions: false });
  const worktree = await createProjectWorktree(project, { name: "finished" });
  const sessionId = randomUUID();
  await markWorktreeConversation(project.id, worktree.id, "pi", sessionId);
  return { project, worktree, sessionId };
}

test("cleanup handles old done marks, keeps new empty worktrees, and is idempotent", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  const empty = await createProjectWorktree(project, { name: "not started" });
  await setSessionDone(sessionId, true);
  const results = await Promise.all([cleanupDoneWorktrees(project), cleanupDoneWorktrees(project)]);
  for (const result of results) assert.deepEqual(result.deletedWorktreeIds, [worktree.id]);
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
  await access(empty.path);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
});

test("cleanup waits for running work, then retries after it ends", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  holdEndedRun("pi", sessionId, false);
  try {
    assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /still running/);
    await access(worktree.path);
  } finally { releaseEndedRun("pi", sessionId); }
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("a switched logical conversation stays until its current segment stops", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  const conversationId = randomUUID();
  const switched = randomUUID();
  await ensureConversationRecord(project.id, "pi", sessionId, "fixture-node", undefined, { conversationId, segmentIndex: 0 });
  await ensureConversationRecord(project.id, "claude", switched, "fixture-node", undefined, { conversationId, segmentIndex: 1 });
  await setSessionDone(conversationId, true);
  holdEndedRun("claude", switched, false);
  try {
    assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /still running/);
  } finally { releaseEndedRun("claude", switched); }
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
});

test("reopened conversations and missing done marks keep the folder", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  await setSessionDone(sessionId, false);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await setSessionDone(sessionId, true);
  await markWorktreeConversation(project.id, worktree.id, "pi", randomUUID());
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, []);
  await access(worktree.path);
});

test("a damaged baseline cannot delete files or prevent saving done", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  await rm(path.join(worktree.path, ".joint-bob-baseline"), { recursive: true, force: true });
  const result = await cleanupDoneWorktrees(project);
  assert.deepEqual(result.deletedWorktreeIds, []);
  assert.match(result.retainedWorktrees[worktree.id], /could not be completed/);
  await access(worktree.path);
});
