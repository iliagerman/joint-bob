import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("runClaudePrompt restricts tools and reports the session tool list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-tools-"));
  const previous = { dataDir: process.env.JOINT_BOB_DATA_DIR };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  try {
    const argsFile = path.join(root, "args.txt");
    const fakeClaude = path.join(root, "claude-fake");
    await writeFile(fakeClaude, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
      `echo '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111","tools":["Bash","Read","Edit"]}'`,
      `echo '{"type":"result","subtype":"success"}'`,
      "",
    ].join("\n"), "utf8");
    await chmod(fakeClaude, 0o755);

    const settings = await import(`../src/settings.ts?claude-tools=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: fakeClaude, configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-tools=${Date.now()}-${Math.random()}`);

    const run = runClaudePrompt({ cwd: root, prompt: "list files", tools: ["Bash", "Read"], onEvent: () => {} });
    const result = await run.done;

    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, ["Bash", "Read", "Edit"]);
    const args = (await readFile(argsFile, "utf8")).split("\n");
    const toolsIndex = args.indexOf("--tools");
    assert.ok(toolsIndex >= 0, `expected --tools in claude args: ${JSON.stringify(args)}`);
    assert.equal(args[toolsIndex + 1], "Bash,Read");
  } finally {
    if (previous.dataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous.dataDir;
    await rm(root, { recursive: true, force: true });
  }
});
