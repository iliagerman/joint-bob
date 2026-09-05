import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const homePath = path.join(root, "home");
    const claudeConfigPath = path.join(root, "claude-config");
    const resources = path.join(homePath, ".agent-resources");
    await mkdir(path.join(resources, "claude", "plugins", "vendor_one_1", ".claude-plugin"), { recursive: true });
    await mkdir(path.join(resources, "claude", "plugins", "vendor_two_1", ".claude-plugin"), { recursive: true });
    await writeFile(path.join(resources, "claude", "plugins", "vendor_one_1", ".claude-plugin", "plugin.json"), "{}\n");
    await writeFile(path.join(resources, "claude", "plugins", "vendor_two_1", ".claude-plugin", "plugin.json"), "{}\n");
    await mkdir(path.join(claudeConfigPath, "plugins"), { recursive: true });
    await writeFile(path.join(claudeConfigPath, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "vendor/one@1": [{ scope: "user" }] },
    }));
    await mkdir(path.join(resources, "mcp"), { recursive: true });
    await mkdir(path.join(resources, "runtime"), { recursive: true });
    await writeFile(path.join(resources, "mcp", "config.json"), "{}\n");
    await writeFile(path.join(resources, "runtime", "common-instructions.md"), "Instructions\n");
    settings.updateSettings({
      projects: { homePath },
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: fakeClaude, configPath: claudeConfigPath, sessionPath: path.join(root, "claude-projects") },
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
    assert.deepEqual(args.filter((arg) => arg === "--plugin-dir"), ["--plugin-dir"]);
    const pluginIndex = args.indexOf("--plugin-dir");
    assert.equal(args[pluginIndex + 1], path.join(resources, "claude", "plugins", "vendor_two_1"));
    const mcpIndex = args.indexOf("--mcp-config");
    assert.equal(args[mcpIndex + 1], path.join(resources, "mcp", "config.json"));
    const instructionIndex = args.indexOf("--append-system-prompt-file");
    assert.equal(args[instructionIndex + 1], path.join(resources, "runtime", "common-instructions.md"));
  } finally {
    if (previous.dataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous.dataDir;
    await rm(root, { recursive: true, force: true });
  }
});
