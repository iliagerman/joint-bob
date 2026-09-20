import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** A CLI that answers and then fails still knows why, so the run reports that reason. */
test("runClaudePrompt reports the CLI failure reason after output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-failure-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, [
      "#!/bin/sh",
      "cat >/dev/null",
      `echo '{"type":"system","subtype":"init","session_id":"22222222-2222-4222-8222-222222222222","tools":["Bash"]}'`,
      `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Here is the answer."}]}}'`,
      `echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You have reached your Fable 5 limit."}'`,
      "exit 1",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-failure=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-failure=${Date.now()}-${Math.random()}`);

    const run = runClaudePrompt({ cwd: root, projectId: "failure-project", prompt: "hello", onEvent: () => {} });
    const result = await run.done;

    assert.equal(result.ok, false);
    assert.equal(result.sawOutput, true);
    assert.equal(result.error, "You have reached your Fable 5 limit.");
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
});

/** A CLI that dies without a result record still has stderr, so that becomes the reason. */
test("runClaudePrompt falls back to stderr when the CLI reports no result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-stderr-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, [
      "#!/bin/sh",
      "cat >/dev/null",
      `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Partial answer."}]}}'`,
      "echo 'transport closed unexpectedly' >&2",
      "exit 3",
      "",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-stderr=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-stderr=${Date.now()}-${Math.random()}`);

    const result = await runClaudePrompt({ cwd: root, projectId: "stderr-project", prompt: "hello", onEvent: () => {} }).done;

    assert.equal(result.ok, false);
    assert.equal(result.sawOutput, true);
    assert.equal(result.error, "transport closed unexpectedly");
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
});
