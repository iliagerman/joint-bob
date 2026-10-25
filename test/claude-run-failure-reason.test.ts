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
    assert.equal(result.error, "transport closed unexpectedly (Claude exited with code 3)");
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
});

/** A CLI that exits without reading its prompt breaks the pipe; the run fails, the process lives on. */
test("runClaudePrompt survives a CLI that exits before reading the prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-epipe-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, ["#!/bin/sh", "echo 'claude: unknown option' >&2", "exit 2", ""].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-epipe=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-epipe=${Date.now()}-${Math.random()}`);

    // Larger than a pipe's buffer, so the write is still going when the CLI has gone.
    const result = await runClaudePrompt({ cwd: root, projectId: "epipe-project", prompt: "x".repeat(4 * 1024 * 1024), onEvent: () => {} }).done;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.ok, false);
    assert.equal(result.error, "claude: unknown option (Claude exited with code 2)");
    assert.deepEqual(uncaught, [], "the broken pipe is not an uncaught error");
  } finally {
    process.off("uncaughtException", onUncaught);
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
});

async function runFake(label: string, script: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), `joint-bob-claude-${label}-`));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, ["#!/bin/sh", "cat >/dev/null", ...script, ""].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);
    const settings = await import(`../src/settings.ts?claude-${label}=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-${label}=${Date.now()}-${Math.random()}`);
    return await runClaudePrompt({ cwd: root, projectId: `${label}-project`, prompt: "hello", onEvent: () => {} }).done;
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
}

/** A CLI that dies silently mid-tool still says how it ended and what it was running, not "failed after output". */
test("runClaudePrompt names the exit and the unfinished tool when the CLI dies silently", async () => {
  const result = await runFake("silent", [
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Running the tests."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}'`,
    "exit 1",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.sawOutput, true);
  assert.equal(result.error, "Claude exited with code 1 while running Bash; it wrote nothing to stderr");
});

/** A finished tool is not blamed, and a kill by signal says so. */
test("runClaudePrompt reports a CLI killed by a signal", async () => {
  const result = await runFake("signal", [
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}'`,
    `echo '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}'`,
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Read it."}]}}'`,
    "kill -KILL $$",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Claude was killed (SIGKILL), often because the machine ran out of memory; it wrote nothing to stderr");
});

/** An error result without text still carries its subtype. */
test("runClaudePrompt keeps the result subtype when the error has no text", async () => {
  const result = await runFake("subtype", [
    `echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working."}]}}'`,
    `echo '{"type":"result","subtype":"error_max_turns","is_error":true}'`,
    "exit 1",
  ]);
  assert.equal(result.error, "Claude run failed (error_max_turns)");
});

/** Background agents outlive the answer; Joint Bob's watchdog, not the CLI's ceiling, ends stale ones. */
test("runClaudePrompt lets background agents run past the CLI's wait ceiling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-bg-ceiling-"));
  const previousDataDir = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, [
      "#!/bin/sh",
      "cat >/dev/null",
      `echo '{"type":"system","subtype":"init","session_id":"44444444-4444-4444-8444-444444444444","tools":["Bash"]}'`,
      `echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ceiling=$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS\\"}]}}"`,
      `echo '{"type":"result","subtype":"success","is_error":false,"result":"done"}'`,
      "",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-bg-ceiling=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      projects: { homePath: path.join(root, "home") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-bg-ceiling=${Date.now()}-${Math.random()}`);

    const result = await runClaudePrompt({ cwd: root, projectId: "bg-ceiling-project", prompt: "hello", onEvent: () => {} }).done;

    assert.equal(result.ok, true);
    assert.equal(result.assistantText, "ceiling=0");
  } finally {
    if (previousDataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previousDataDir;
  }
});
