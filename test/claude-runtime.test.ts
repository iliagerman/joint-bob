import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("Claude hook lifecycle tracks running transcripts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-runtime-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const runtime = await import(`../src/claude-runtime.js?cache=${Date.now()}-${Math.random()}`);
    const transcript = path.join(root, "session.jsonl");
    const input = (hook_event_name: string) => ({ session_id: "session", transcript_path: transcript, cwd: root, hook_event_name });
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      runtime.recordClaudeHookEvent(input(event));
      assert.equal(runtime.isClaudeSessionRunning(`claude:${transcript}`), true);
    }
    for (const event of ["SessionStart", "Stop", "StopFailure", "SessionEnd"]) {
      runtime.recordClaudeHookEvent(input(event));
      assert.equal(runtime.isClaudeSessionRunning(`claude:${transcript}`), false);
    }
    assert.throws(() => runtime.recordClaudeHookEvent({}), /session_id/);
    runtime.recordClaudeHookEvent(input("UserPromptSubmit"));
    const db = new DatabaseSync(path.join(root, "node.db"));
    db.prepare("UPDATE claude_runtime_sessions SET updated_at = ? WHERE transcript_path = ?").run(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(), transcript);
    assert.equal(runtime.isClaudeSessionRunning(`claude:${transcript}`), false);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
