import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentResourcePaths, claudeAgentResourceArgs } from "../src/agent-resources.js";
import { activeMcpConfig, activeSkillRoot, activationDecision, assertNoBlockedNativeSkills, markReceivedResource, setActivationPreference } from "../src/resource-activation.js";
import { markReceived } from "../src/skill-sharing-files.js";
import { save, settingsDatabase } from "../src/settings-store.js";

const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-activation-"));
test.after(() => rm(fixture, { recursive: true, force: true }));

async function installed(name: string): Promise<string> {
  const root = agentResourcePaths(path.join(fixture, "managed")).sharedSkills;
  const folder = path.join(root, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  await markReceived(root, name, "owner");
  return root;
}

test("received skills default to on, or off when node setting is disabled; each harness keeps its own choice", async () => {
  const root = await installed("received-test");
  try {
    assert.equal(activationDecision("skill", "received-test", "pi", true).enabled, true);
    save(settingsDatabase(), "autoActivateSharedSkills", "false");
    for (const harness of ["pi", "claude", "kiro"] as const) {
      assert.equal(activationDecision("skill", "received-test", harness, true).enabled, false);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, root), "received-test")), false);
    }
    setActivationPreference("skill", "received-test", "claude", true);
    assert.equal(activationDecision("skill", "received-test", "claude", true).enabled, true);
    assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot("claude", root), "received-test", "SKILL.md")), true);
    assert.equal(activationDecision("skill", "received-test", "pi", true).enabled, false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    setActivationPreference("skill", "received-test", "pi", false);
    assert.equal(activationDecision("skill", "received-test", "pi", true).enabled, false);
    assert.equal(activationDecision("skill", "received-test", "kiro", true).enabled, true);
    await writeFile(path.join(root, "received-test", "SKILL.md"), "---\nname: received-test\ndescription: updated\n---\n");
    assert.equal(activationDecision("skill", "received-test", "pi", true).enabled, false, "updating contents does not clear the choice");
    assert.equal(activationDecision("skill", "received-test", "claude", true).enabled, true);
  } finally {
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    for (const harness of ["pi", "claude", "kiro"] as const) setActivationPreference("skill", "received-test", harness, null);
  }
});

test("blocked configured skills are absent from every harness root and native Claude project copies fail closed", async () => {
  const project = path.join(fixture, "blocked-project");
  const configured = path.join(fixture, "configured-skills");
  for (const root of [configured, path.join(project, ".claude", "skills")]) {
    const skill = path.join(root, "blocked-fixture");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: blocked-fixture\ndescription: test\n---\n");
  }
  const aliased = path.join(configured, "alias");
  await mkdir(aliased, { recursive: true });
  await writeFile(path.join(aliased, "SKILL.md"), "---\nname: 'blocked-fixture' # quoted alias\ndescription: alias\n---\n");
  const nested = path.join(configured, "category", "blocked-nested-fixture");
  const allowed = path.join(configured, "category", "allowed-nested-fixture");
  await mkdir(nested, { recursive: true });
  await mkdir(allowed, { recursive: true });
  await writeFile(path.join(nested, "SKILL.md"), "---\nname: blocked-fixture # inline comment\ndescription: nested\n---\n");
  await writeFile(path.join(allowed, "SKILL.md"), "---\nname: allowed-nested-fixture\ndescription: allowed\n---\n");
  try {
    for (const harness of ["pi", "claude", "kiro"] as const) {
      setActivationPreference("skill", "blocked-fixture", harness, false);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, configured), "blocked-fixture", "SKILL.md")), false);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, configured), "alias", "SKILL.md")), false);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, configured), "category", "blocked-nested-fixture", "SKILL.md")), false);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, configured), "category", "allowed-nested-fixture", "SKILL.md")), true);
      assert.equal((await import("node:fs")).existsSync(path.join(activeSkillRoot(harness, path.join(aliased, "SKILL.md")), "SKILL.md")), false);
    }
    assert.throws(() => assertNoBlockedNativeSkills("claude", project), /Cannot safely suppress blocked native claude skills/);
  } finally {
    for (const harness of ["pi", "claude", "kiro"] as const) setActivationPreference("skill", "blocked-fixture", harness, null);
  }
});

test("a plugin cannot reintroduce a blocked skill", async () => {
  const paths = agentResourcePaths(path.join(fixture, "plugin-managed"));
  const plugin = path.join(paths.claudePlugins, "kit");
  const skill = path.join(plugin, "skills", "blocked-plugin-fixture");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: blocked-plugin-fixture\ndescription: test\n---\n");
  try {
    assert.ok(claudeAgentResourceArgs(paths.root).includes(plugin));
    setActivationPreference("skill", "blocked-plugin-fixture", "claude", false);
    assert.equal(claudeAgentResourceArgs(paths.root).includes(plugin), false);
    await rm(skill, { recursive: true });
    const external = path.join(fixture, "external-blocked-skill");
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "SKILL.md"), "---\nname: blocked-plugin-fixture # inline comment\ndescription: external\n---\n");
    await symlink(external, skill, "dir");
    assert.equal(claudeAgentResourceArgs(paths.root).includes(plugin), false, "symlinked plugin skills cannot bypass the block");
  } finally { setActivationPreference("skill", "blocked-plugin-fixture", "claude", null); }
});

test("received Git plugins use the node default and explicit Claude disables", () => {
  markReceivedResource("plugin", "received-plugin-fixture", true);
  try {
    assert.equal(activationDecision("plugin", "received-plugin-fixture", "claude", true).enabled, true);
    save(settingsDatabase(), "autoActivateSharedSkills", "false");
    assert.equal(activationDecision("plugin", "received-plugin-fixture", "claude", true).enabled, false);
    setActivationPreference("plugin", "received-plugin-fixture", "claude", true);
    assert.equal(activationDecision("plugin", "received-plugin-fixture", "claude", true).enabled, true);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    setActivationPreference("plugin", "received-plugin-fixture", "claude", false);
    assert.equal(activationDecision("plugin", "received-plugin-fixture", "claude", true).enabled, false);
  } finally {
    setActivationPreference("plugin", "received-plugin-fixture", "claude", null);
    markReceivedResource("plugin", "received-plugin-fixture", false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
  }
});

test("received Git MCP servers use the node default with independent Claude/Kiro choices", async () => {
  const file = path.join(fixture, "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: { receivedTest: { command: "fixture-command" } } }));
  markReceivedResource("mcp", "receivedTest", true);
  save(settingsDatabase(), "autoActivateSharedSkills", "false");
  try {
    for (const harness of ["claude", "kiro"] as const) {
      assert.equal(activationDecision("mcp", "receivedTest", harness, true).enabled, false);
      assert.deepEqual(JSON.parse(await readFile(activeMcpConfig(harness, file), "utf8")).mcpServers, {});
    }
    setActivationPreference("mcp", "receivedTest", "claude", true);
    assert.ok(JSON.parse(await readFile(activeMcpConfig("claude", file), "utf8")).mcpServers.receivedTest);
    assert.deepEqual(JSON.parse(await readFile(activeMcpConfig("kiro", file), "utf8")).mcpServers, {});
  } finally {
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    setActivationPreference("mcp", "receivedTest", "claude", null);
    markReceivedResource("mcp", "receivedTest", false);
  }
});
