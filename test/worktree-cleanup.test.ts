import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { holdEndedRun, releaseEndedRun } from "../src/conversation-runtime.js";
import { setSessionDone } from "../src/names.js";
import { createProjectWorktree, markWorktreeConversation, recordWorktreePullRequest } from "../src/project-worktrees.js";
import { cleanupDoneWorktrees, sweepWorktrees } from "../src/server/worktree-cleanup.js";
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

test("cleanup removes a finished worktree without checking its pull request or local changes", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  context.mock.method(globalThis, "fetch", async () => { throw new Error("cleanup must not contact GitHub"); });
  await recordWorktreePullRequest(project.id, worktree.id, { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/finished", base: "main", baseCommit: "a".repeat(40) });
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 2;\n");
  await setSessionDone(sessionId, true);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
});

test("a damaged baseline does not block removing a finished worktree", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await setSessionDone(sessionId, true);
  await rm(path.join(worktree.path, ".joint-bob-baseline"), { recursive: true, force: true });
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id]);
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
});

test("a worktree with no conversations is removed after ten minutes, with or without edits", async (context) => {
  const { project } = await fixture(context);
  const clean = await createProjectWorktree(project, { name: "abandoned" });
  const edited = await createProjectWorktree(project, { name: "abandoned with edits" });
  await writeFile(path.join(edited.path, "index.ts"), "export const value = 2;\n");
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "a new worktree stays");
  const now = Date.now();
  context.mock.method(Date, "now", () => now + 11 * 60_000);
  const result = await cleanupDoneWorktrees(project);
  assert.deepEqual(new Set(result.deletedWorktreeIds), new Set([clean.id, edited.id]));
  await assert.rejects(access(clean.path), { code: "ENOENT" });
  await assert.rejects(access(edited.path), { code: "ENOENT" });
});

test("the periodic sweep removes finished worktrees even with unmerged edits or a pull request", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 2;\n");
  await recordWorktreePullRequest(project.id, worktree.id, { number: 7, url: "https://github.com/o/r/pull/7", branch: "joint-bob/open", base: "main", baseCommit: "a".repeat(40) });
  await setSessionDone(sessionId, true);
  assert.ok((await sweepWorktrees()).includes(worktree.id));
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
});

test("the periodic sweep keeps a worktree with an undone or running conversation", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  assert.deepEqual(await sweepWorktrees(), [], "an undone conversation keeps it");
  await setSessionDone(sessionId, true);
  holdEndedRun("pi", sessionId, false);
  try { assert.deepEqual(await sweepWorktrees(), [], "running work keeps it"); }
  finally { releaseEndedRun("pi", sessionId); }
  await access(worktree.path);
  assert.deepEqual(await sweepWorktrees(), [worktree.id]);
});
