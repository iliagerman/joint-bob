import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeProjectsRoot } from "../src/claude-service.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { claudeProjectDir } from "../src/harnesses/claude/paths.js";
import { WORKTREE_META_DIR } from "../src/project-worktrees.js";
import { loadConversationMessages } from "../src/server/conversation-turns.js";
import { addProject } from "../src/store.js";

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
