// Transcript loaders must surface each message's recorded wall-clock time so
// the browser can show when a replayed message was actually written. Every
// harness stores an ISO timestamp per line; a line without one stays unstamped
// rather than being invented.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Claude transcript messages carry their recorded timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-stamps-claude-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });
    const settings = await import("../src/settings.js");
    settings.updateSettings({ pi: { executable: "pi", configPath: "", sessionPath: "" }, claude: { executable: "claude", configPath: "", sessionPath: sessionRoot }, syncthing: { endpoint: "" } });
    const sessionPaths = await import("../src/session-paths.js");
    const claude = await import("../src/claude-service.js");
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });
    const transcript = path.join(projectDir, "stamped.jsonl");
    await writeFile(transcript, [
      { type: "user", cwd: projectCwd, timestamp: "2026-09-14T08:30:00.000Z", message: { role: "user", content: [{ text: "Hello there" }] } },
      { type: "assistant", cwd: projectCwd, timestamp: "2026-09-14T08:31:05.000Z", effort: "high", message: { role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: "Hi back" }] } },
      { type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: "No stamp on this line" }] } },
      { type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: "<local-command-caveat>Caveat</local-command-caveat>\n<command-name>/compact</command-name>\n<local-command-stdout>Compacted</local-command-stdout>" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const messages = await claude.loadClaudeMessages(`claude:${transcript}`);
    assert.equal(messages.length, 3, "local command metadata stays out of the chat transcript");
    assert.equal(messages[0].timestamp, "2026-09-14T08:30:00.000Z", "user message keeps its recorded time");
    assert.equal(messages[1].timestamp, "2026-09-14T08:31:05.000Z", "assistant message keeps its recorded time");
    assert.deepEqual(messages[1].attribution, { harnessId: "claude", provider: "claude", modelId: "claude-fable-5-1", reasoning: "high" });
    assert.equal(messages[2].timestamp, undefined, "a line without a timestamp stays unstamped");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi transcript messages carry their recorded timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-stamps-pi-"));
  try {
    const transcript = path.join(root, "session.jsonl");
    await writeFile(transcript, [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-09-14T08:00:00.000Z", cwd: root },
      { type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-sol" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      { type: "message", timestamp: "2026-09-14T08:30:00.000Z", message: { role: "user", content: [{ type: "text", text: "Hello there" }] } },
      { type: "message", timestamp: "2026-09-14T08:31:05.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "text", text: "Hi back" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "No stamp on this line" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    const pi = await import("../src/pi-service.js");
    const messages = await pi.loadPiMessages(transcript);
    assert.equal(messages.length, 3, "all three fixture messages load");
    assert.equal(messages[0].timestamp, "2026-09-14T08:30:00.000Z", "user message keeps its recorded time");
    assert.equal(messages[1].timestamp, "2026-09-14T08:31:05.000Z", "assistant message keeps its recorded time");
    assert.deepEqual(messages[1].attribution, { harnessId: "pi", provider: "openai-codex", modelId: "gpt-5.6-sol", reasoning: "high" });
    assert.equal(messages[2].timestamp, undefined, "a line without a timestamp stays unstamped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
