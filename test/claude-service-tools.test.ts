import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    await writeFile(path.join(resources, "runtime", "common-instructions.md"), "Canonical instructions\nCanonical rule\n");

    const globalSkill = path.join(root, "global-skill");
    const projectSkills = path.join(root, "project-skills");
    const globalPrompt = path.join(root, "global-prompt.md");
    const projectPrompts = path.join(root, "project-prompts");
    const globalRule = path.join(root, "global-rule.md");
    const projectRules = path.join(root, "project-rules");
    const globalPlugin = path.join(root, "global-plugin");
    const projectPlugins = path.join(root, "project-plugins");
    await mkdir(path.join(globalSkill), { recursive: true });
    await mkdir(path.join(projectSkills, "project-skill"), { recursive: true });
    await mkdir(projectPrompts, { recursive: true });
    await mkdir(projectRules, { recursive: true });
    await mkdir(path.join(globalPlugin, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(projectPlugins, "project-plugin", ".claude-plugin"), { recursive: true });
    await writeFile(path.join(globalSkill, "SKILL.md"), "---\nname: global-skill\n---\n");
    await writeFile(path.join(projectSkills, "project-skill", "SKILL.md"), "---\nname: project-skill\n---\n");
    await writeFile(globalPrompt, "Global prompt\n");
    await writeFile(path.join(projectPrompts, "project-prompt.md"), "Project prompt\n");
    await writeFile(globalRule, "Global rule\n");
    await writeFile(path.join(projectRules, "project-rule.md"), "Project rule\n");
    await writeFile(path.join(globalPlugin, ".claude-plugin", "plugin.json"), "{}\n");
    await writeFile(path.join(projectPlugins, "project-plugin", ".claude-plugin", "plugin.json"), "{}\n");
    settings.updateSettings({
      projects: { homePath },
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: fakeClaude, configPath: claudeConfigPath, sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
      resources: { skills: [globalSkill], prompts: [globalPrompt], rules: [globalRule], plugins: [globalPlugin] },
    });
    const projectId = "resource-project";
    settings.updateProjectResourcePaths(projectId, { skills: [projectSkills], prompts: [projectPrompts], rules: [projectRules], plugins: [projectPlugins] });
    const { runClaudePrompt } = await import(`../src/claude-service.ts?claude-tools=${Date.now()}-${Math.random()}`);

    const run = runClaudePrompt({ cwd: root, projectId, prompt: "list files", tools: ["Bash", "Read"], onEvent: () => {} });
    const result = await run.done;

    assert.equal(result.ok, true);
    assert.deepEqual(result.tools, ["Bash", "Read", "Edit"]);
    const args = (await readFile(argsFile, "utf8")).split("\n");
    const toolsIndex = args.indexOf("--tools");
    assert.ok(toolsIndex >= 0, `expected --tools in claude args: ${JSON.stringify(args)}`);
    assert.equal(args[toolsIndex + 1], "Bash,Read");
    const pluginDirectories = args.flatMap((arg, index) => arg === "--plugin-dir" ? [args[index + 1]] : []);
    assert.deepEqual(pluginDirectories.slice(0, 3), [
      path.join(resources, "claude", "plugins", "vendor_two_1"),
      globalPlugin,
      path.join(projectPlugins, "project-plugin"),
    ]);
    const generatedPlugin = pluginDirectories[3];
    assert.ok(generatedPlugin, "configured resources generate a Claude plugin");
    assert.deepEqual(JSON.parse(await readFile(path.join(generatedPlugin, ".claude-plugin", "plugin.json"), "utf8")), { name: "joint-bob-resources" });
    assert.equal(await realpath(path.join(generatedPlugin, "skills", "global-skill")), await realpath(globalSkill));
    assert.equal(await realpath(path.join(generatedPlugin, "skills", "project-skill")), await realpath(path.join(projectSkills, "project-skill")));
    assert.equal(await realpath(path.join(generatedPlugin, "commands", "global-prompt.md")), await realpath(globalPrompt));
    assert.equal(await realpath(path.join(generatedPlugin, "commands", "project-prompt.md")), await realpath(path.join(projectPrompts, "project-prompt.md")));
    const mcpIndex = args.indexOf("--mcp-config");
    assert.equal(args[mcpIndex + 1], path.join(resources, "mcp", "config.json"));
    const instructionIndex = args.indexOf("--append-system-prompt-file");
    const instructions = await readFile(args[instructionIndex + 1], "utf8");
    assert.match(instructions, /Canonical instructions/);
    assert.match(instructions, /Canonical rule/);
    assert.match(instructions, /Global rule/);
    assert.match(instructions, /Project rule/);
  } finally {
    if (previous.dataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous.dataDir;
    await rm(root, { recursive: true, force: true });
  }
});
