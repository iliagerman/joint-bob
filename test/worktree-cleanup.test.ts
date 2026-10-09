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

test("cleanup removes already-done PR worktrees only after verifying merged contents", async (context) => {
  const { project, worktree, sessionId } = await fixture(context);
  process.env.GH_TOKEN = "fixture-token";
  execFileSync("git", ["init", "-q", project.path]);
  execFileSync("git", ["-C", project.path, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const content = "export const value = 2;\n";
  const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  await recordWorktreePullRequest(project.id, worktree.id, { number: 12, url: "https://github.com/o/r/pull/12", branch: "joint-bob/finished", base: "main", baseCommit: base });
  await writeFile(path.join(worktree.path, "index.ts"), content);
  await setSessionDone(sessionId, true);
  let merged = false;
  let duringCheck: (() => Promise<void>) | undefined;
  let inaccessible = false;
  const calls: string[] = [];
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    assert.equal(init.method, "GET", "cleanup must never mutate GitHub");
    const route = url.replace("https://api.github.com/repos/o/r", "");
    calls.push(route);
    if (inaccessible) return Response.json({}, { status: 403 });
    if (route === "/pulls/12") await duringCheck?.();
    if (route === "/pulls/12") return Response.json({ merged, html_url: "https://github.com/o/r/pull/12", head: { ref: "joint-bob/finished", sha: head }, base: { ref: "main" } });
    if (route.startsWith("/git/commits/")) return Response.json({ tree: { sha: route.endsWith(base) ? base : head } });
    if (route.startsWith("/git/trees/")) return Response.json({ truncated: false, tree: [{ path: "index.ts", type: "blob", mode: "100644", sha: blob(route.includes(base) ? "export const value = 1;\n" : content) }] });
    throw new Error(`Unexpected GitHub route: ${route}`);
  });
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "an open PR is not enough");
  merged = true;
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 3;\n");
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "edits after the PR must survive");
  await access(worktree.path);
  await writeFile(path.join(worktree.path, "index.ts"), "export const value = 1;\n");
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "a post-PR revert to the baseline is also an edit");
  await writeFile(path.join(worktree.path, "index.ts"), content);
  inaccessible = true;
  assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /could not be completed/);
  inaccessible = false;
  duringCheck = () => writeFile(path.join(worktree.path, "index.ts"), "new edit during verification\n");
  assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /changed while cleanup/);
  await writeFile(path.join(worktree.path, "index.ts"), content);
  duringCheck = () => setSessionDone(sessionId, false);
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [], "reopening during verification keeps the worktree");
  await setSessionDone(sessionId, true);
  const switched = randomUUID();
  duringCheck = async () => {
    await ensureConversationRecord(project.id, "claude", switched, "fixture-node", undefined, { conversationId: sessionId, segmentIndex: 1 });
    holdEndedRun("claude", switched, false);
  };
  try {
    assert.match((await cleanupDoneWorktrees(project)).retainedWorktrees[worktree.id], /still running/, "a harness switched during verification is protected");
  } finally { releaseEndedRun("claude", switched); }
  duringCheck = undefined;
  assert.deepEqual((await cleanupDoneWorktrees(project)).deletedWorktreeIds, [worktree.id], "a merged PR replaces the stale baseline check");
  assert.ok(calls.includes("/pulls/12"));
  await assert.rejects(access(worktree.path), { code: "ENOENT" });
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
