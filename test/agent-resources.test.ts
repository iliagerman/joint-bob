import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function write(root: string, relative: string, contents: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

test("reconciles native agent resources into canonical links without copying secrets", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "joint-bob-agent-resources-"));
  const root = path.join(fixture, "home", ".agent-resources");
  const pi = path.join(fixture, "pi");
  const claude = path.join(fixture, "claude");
  const agents = path.join(fixture, "agents");
  const data = path.join(fixture, "data");
  const { reconcileAgentResources, agentResourcePaths } = await import("../src/agent-resources.js");
  try {
    await write(path.join(fixture, "targets"), "skill/SKILL.md", "---\nname: shared\ndescription: Shared skill\n---\n");
    await mkdir(path.join(agents, "skills"), { recursive: true });
    await symlink(path.join(fixture, "targets", "skill"), path.join(agents, "skills", "skill"), "dir");
    await write(pi, "settings.json", JSON.stringify({
      packages: ["portable-package", { source: path.join(fixture, "local-package") }],
    }));
    await write(pi, "extensions/example.ts", "export default {};\n");
    await write(pi, "prompts/review.md", "---\ndescription: Review\n---\nReview\n");
    await write(pi, "themes/dark.json", "{}\n");
    await write(pi, "AGENTS.md", "Pi instructions\n");
    await write(pi, "extensions/.env", "secret\n");
    await write(pi, "extensions/.npmrc", "secret\n");
    await write(pi, "extensions/.pypirc", "secret\n");
    await write(pi, "extensions/.netrc", "secret\n");
    await write(pi, "extensions/credentials.json", "secret\n");
    await write(pi, "extensions/service-account-dev.json", "secret\n");
    await write(pi, "extensions/id_rsa", "secret\n");
    await write(pi, "extensions/id_ed25519", "secret\n");
    await write(pi, "extensions/id_ecdsa", "secret\n");
    await write(pi, "extensions/node_modules/skip.js", "skip\n");
    await write(claude, "commands/check.md", "---\ndescription: Check it\n---\nCheck\n");
    await write(claude, "agents/reviewer.md", "Review\n");
    await write(claude, "rules/style.md", "Use spaces.\n");
    await write(claude, "CLAUDE.md", "Claude instructions\n");
    await write(agents, "rules/common.md", "Common instructions\n");
    await write(claude, "plugins/plugin-source/.claude-plugin/plugin.json", "{\"name\":\"plugin\"}\n");
    await write(claude, "settings.json", "{\"enabledPlugins\":{\"vendor/plugin@1\":true}}\n");
    await write(claude, "plugins/installed_plugins.json", JSON.stringify({ plugins: { "vendor/plugin@1": [{ scope: "user", installPath: path.join(claude, "plugins/plugin-source") }] } }));

    const result = await reconcileAgentResources({ root, piConfigPath: pi, claudeConfigPath: claude, agentsConfigPath: agents, dataDir: data });
    const paths = agentResourcePaths(root);
    assert.deepEqual(result.conflicts, []);
    assert.equal(await readFile(path.join(paths.sharedSkills, "skill", "SKILL.md"), "utf8"), "---\nname: shared\ndescription: Shared skill\n---\n");
    assert.equal(await readFile(path.join(paths.piExtensions, "example.ts"), "utf8"), "export default {};\n");
    assert.equal(await readFile(path.join(paths.piPrompts, "review.md"), "utf8"), "---\ndescription: Review\n---\nReview\n");
    assert.equal(await readFile(path.join(paths.piThemes, "dark.json"), "utf8"), "{}\n");
    assert.equal(await readFile(path.join(paths.piInstructions, "AGENTS.md"), "utf8"), "Pi instructions\n");
    assert.equal(await readFile(path.join(paths.claudeCommands, "check.md"), "utf8"), "---\ndescription: Check it\n---\nCheck\n");
    assert.equal(await readFile(path.join(paths.claudeAgents, "reviewer.md"), "utf8"), "Review\n");
    assert.equal(await readFile(path.join(paths.claudeInstructions, "CLAUDE.md"), "utf8"), "Claude instructions\n");
    const packages = JSON.parse(await readFile(paths.piPackages, "utf8")) as { packages: unknown[] };
    assert.deepEqual(packages.packages, ["portable-package"]);
    const localSettings = await readFile(path.join(pi, "settings.json"), "utf8");
    assert.match(localSettings, /portable-package/);
    assert.match(localSettings, /local-package/);
    for (const resourcePath of [paths.piExtensions, paths.sharedSkills, paths.piPrompts, paths.piThemes]) {
      assert.equal(localSettings.split(resourcePath).length - 1, 1);
    }
    for (const name of [
      ".env",
      ".npmrc",
      ".pypirc",
      ".netrc",
      "credentials.json",
      "service-account-dev.json",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
    ]) {
      await assert.rejects(readFile(path.join(paths.piExtensions, name)));
    }
    await assert.rejects(readFile(path.join(paths.piExtensions, "node_modules", "skip.js")));
    assert.equal(await readFile(path.join(paths.claudePlugins, "vendor_plugin_1", ".claude-plugin", "plugin.json"), "utf8"), "{\"name\":\"plugin\"}\n");
    assert.match(await readFile(paths.commonInstructionsFile, "utf8"), /Common instructions/);
    assert.ok((await lstat(path.join(pi, "extensions", "example.ts"))).isSymbolicLink());
    assert.equal(await readlink(path.join(pi, "extensions", "example.ts")), path.join(paths.piExtensions, "example.ts"));
    assert.ok((await lstat(path.join(data, "agent-resources-backups"))).isDirectory());
    const repeat = await reconcileAgentResources({ root, piConfigPath: pi, claudeConfigPath: claude, agentsConfigPath: agents, dataDir: data });
    assert.deepEqual(repeat.conflicts, []);
    const repeatedSettings = await readFile(path.join(pi, "settings.json"), "utf8");
    for (const resourcePath of [paths.piExtensions, paths.sharedSkills, paths.piPrompts, paths.piThemes]) {
      assert.equal(repeatedSettings.split(resourcePath).length - 1, 1);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("imports a resource source below an ancestor named build", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "joint-bob-agent-resource-build-"));
  const root = path.join(fixture, "resources");
  const pi = path.join(fixture, "build", "pi");
  const { agentResourcePaths, reconcileAgentResources } = await import("../src/agent-resources.js");
  try {
    await write(pi, "prompts/review.md", "Review\n");
    await reconcileAgentResources({
      root,
      piConfigPath: pi,
      claudeConfigPath: path.join(fixture, "claude"),
      agentsConfigPath: path.join(fixture, "agents"),
      dataDir: path.join(fixture, "data"),
    });
    assert.equal(await readFile(path.join(agentResourcePaths(root).piPrompts, "review.md"), "utf8"), "Review\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("preserves differing native entries as conflicts", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "joint-bob-agent-resource-conflict-"));
  const root = path.join(fixture, "resources");
  const pi = path.join(fixture, "pi");
  const { reconcileAgentResources, agentResourcePaths } = await import("../src/agent-resources.js");
  try {
    const paths = agentResourcePaths(root);
    await write(paths.piPrompts, "review.md", "canonical\n");
    await write(pi, "prompts/review.md", "native\n");
    const result = await reconcileAgentResources({ root, piConfigPath: pi, claudeConfigPath: path.join(fixture, "claude"), agentsConfigPath: path.join(fixture, "agents"), dataDir: path.join(fixture, "data") });
    assert.deepEqual(result.conflicts, [{ source: path.join(pi, "prompts", "review.md"), destination: path.join(paths.piPrompts, "review.md") }]);
    assert.equal(await readFile(path.join(pi, "prompts", "review.md"), "utf8"), "native\n");
    assert.equal(await readFile(path.join(paths.piPrompts, "review.md"), "utf8"), "canonical\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
