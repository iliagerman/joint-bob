import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentResourcePaths, claudeAgentResourceArgs } from "../src/agent-resources.js";
import { activeMcpConfig, activeSkillRoot, activationDecision, assertNoBlockedNativeSkills, markReceivedResource, setActivationPreference } from "../src/resource-activation.js";
import { markReceived } from "../src/skill-sharing-files.js";
import { save, settingsDatabase } from "../src/settings-store.js";
import { getSettings } from "../src/settings.js";

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

test("Claude fails closed when native resource discovery cannot enforce a skill block", async () => {
  const project = path.join(fixture, "native-disabled-project");
  const native = path.join(getSettings().claude.configPath, "skills", "blocked-native-fixture");
  await mkdir(native, { recursive: true });
  await writeFile(path.join(native, "SKILL.md"), "---\nname: blocked-native-fixture\ndescription: native\n---\n");
  const previous = getSettings().strictResourceIsolation;
  try {
    setActivationPreference("skill", "blocked-native-fixture", "claude", false);
    save(settingsDatabase(), "strictResourceIsolation", "false");
    assert.throws(() => claudeAgentResourceArgs(undefined, undefined, undefined, project), /Cannot safely suppress blocked native claude skills|Cannot safely enforce blocked Claude skills/);
  } finally {
    save(settingsDatabase(), "strictResourceIsolation", String(previous));
    setActivationPreference("skill", "blocked-native-fixture", "claude", null);
    await rm(native, { recursive: true, force: true });
  }
});

test("strict Claude runs never refuse over native skill copies, which the CLI no longer loads, and keep blocked project copies out", async () => {
  const project = path.join(os.homedir(), "strict-home-projects", "project");
  const copies = [path.join(os.homedir(), ".agents", "skills"), path.join(os.homedir(), ".claude", "skills"), path.join(os.homedir(), "strict-home-projects", ".claude", "skills"), path.join(project, ".claude", "skills")]
    .map((root) => path.join(root, "blocked-home-fixture"));
  for (const copy of copies) {
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(copy, "SKILL.md"), "---\nname: blocked-home-fixture\ndescription: native\n---\n");
  }
  await mkdir(project, { recursive: true });
  const previous = getSettings().strictResourceIsolation;
  try {
    setActivationPreference("skill", "blocked-home-fixture", "claude", false);
    save(settingsDatabase(), "strictResourceIsolation", "true");
    const args = claudeAgentResourceArgs(undefined, undefined, undefined, project);
    const plugin = args[args.indexOf("--plugin-dir") + 1];
    assert.equal(existsSync(path.join(plugin ?? "", "skills", "blocked-home-fixture")), false, "the blocked project copy is not passed in");
    // The non-strict check stops where the CLI stops: a folder between the project and home counts, home does not.
    assert.throws(() => assertNoBlockedNativeSkills("claude", project), /Cannot safely suppress blocked native claude skills in .*strict-home-projects/);
    await rm(path.dirname(copies[2]), { recursive: true, force: true });
    await rm(path.dirname(copies[3]), { recursive: true, force: true });
    assert.doesNotThrow(() => assertNoBlockedNativeSkills("claude", project));
    assert.doesNotThrow(() => assertNoBlockedNativeSkills("claude", os.homedir()));
  } finally {
    save(settingsDatabase(), "strictResourceIsolation", String(previous));
    setActivationPreference("skill", "blocked-home-fixture", "claude", null);
    for (const copy of copies) await rm(copy, { recursive: true, force: true });
    await rm(path.join(os.homedir(), "strict-home-projects"), { recursive: true, force: true });
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

test("configured plugin aliases obey managed and received activation choices", async () => {
  const paths = agentResourcePaths(path.join(fixture, "configured-plugin-managed"));
  const configured = path.join(fixture, "configured-plugins");
  const plugin = path.join(paths.claudePlugins, "kit");
  const alias = path.join(configured, "plugin-alias");
  await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  await mkdir(configured, { recursive: true });
  await symlink(plugin, alias, "dir");
  const empty = { skills: [], prompts: [], rules: [], plugins: [] };
  const scoped = { global: { ...empty, plugins: [configured] }, project: empty };
  try {
    assert.ok(claudeAgentResourceArgs(paths.root, scoped).includes(alias));
    setActivationPreference("plugin", "kit", "claude", false);
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(alias), false, "renamed alias cannot bypass explicit disable");
    setActivationPreference("plugin", "kit", "claude", null);
    markReceivedResource("plugin", "kit", true);
    save(settingsDatabase(), "autoActivateSharedSkills", "false");
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(alias), false, "renamed alias cannot bypass received-resource default");
    setActivationPreference("plugin", "kit", "claude", true);
    assert.ok(claudeAgentResourceArgs(paths.root, scoped).includes(alias), "explicit enable overrides node default");
  } finally {
    setActivationPreference("plugin", "kit", "claude", null);
    markReceivedResource("plugin", "kit", false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
  }
});

test("managed plugin symlinks expose stable, separately actionable activation identities", async () => {
  const { resourceInventory } = await import("../src/resource-inventory.js");
  const paths = agentResourcePaths(path.join(fixture, "managed-plugin-aliases"));
  const plugin = path.join(paths.claudePlugins, "kit");
  const alias = path.join(paths.claudePlugins, "alias");
  const configured = path.join(fixture, "configured-parent-alias");
  const parentAlias = path.join(configured, "parent");
  const renamed = path.join(configured, "renamed");
  const directAliasRoot = path.join(fixture, "configured-external-alias");
  const directAlias = path.join(directAliasRoot, "alias");
  const external = path.join(fixture, "external-plugin-target");
  await mkdir(paths.claudePlugins, { recursive: true });
  await symlink(path.join(fixture, "missing-managed-plugin"), path.join(paths.claudePlugins, "000-broken"), "dir");
  await mkdir(path.join(external, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(external, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  await symlink(external, plugin, "dir");
  await symlink(plugin, alias, "dir");
  await mkdir(configured, { recursive: true });
  await symlink(paths.claudePlugins, parentAlias, "dir");
  await symlink(path.join(parentAlias, "kit"), renamed, "dir");
  await mkdir(directAliasRoot, { recursive: true });
  await symlink(external, directAlias, "dir");
  const empty = { skills: [], prompts: [], rules: [], plugins: [] };
  const scoped = { global: { ...empty, plugins: [configured, directAliasRoot] }, project: empty };
  try {
    markReceivedResource("plugin", "kit", true);
    assert.ok(claudeAgentResourceArgs(paths.root).includes(alias));
    assert.ok(claudeAgentResourceArgs(paths.root, scoped).includes(renamed), "nested parent symlinks resolve to the managed target identity");
    assert.ok(claudeAgentResourceArgs(paths.root, scoped).includes(directAlias), "independent external aliases resolve to a managed target identity");
    setActivationPreference("plugin", "kit", "claude", false);
    assert.equal(claudeAgentResourceArgs(paths.root).includes(plugin), false);
    assert.equal(claudeAgentResourceArgs(paths.root).includes(alias), false, "managed alias respects target disable");
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(renamed), false, "parent-symlink alias respects target disable");
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(directAlias), false, "independent external alias respects target disable");
    setActivationPreference("plugin", "kit", "claude", null);
    save(settingsDatabase(), "autoActivateSharedSkills", "false");
    assert.equal(claudeAgentResourceArgs(paths.root).includes(plugin), false);
    assert.equal(claudeAgentResourceArgs(paths.root).includes(alias), false, "managed alias respects received default");
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(renamed), false, "parent-symlink alias respects received default");
    assert.equal(claudeAgentResourceArgs(paths.root, scoped).includes(directAlias), false, "independent external alias respects received default");
    setActivationPreference("plugin", "kit", "claude", true);
    const enabledArgs = claudeAgentResourceArgs(paths.root, scoped);
    assert.ok(enabledArgs.includes(plugin));
    assert.ok(enabledArgs.includes(alias));
    const enabledInventory = await resourceInventory({ resourceRoot: paths.root });
    assert.equal(enabledInventory.plugins.find((item) => item.source === "managed" && item.name === "kit")?.activation.claude?.enabled, true);
    assert.equal(enabledInventory.plugins.find((item) => item.source === "managed" && item.name === "alias")?.activation.claude?.enabled, true);
    setActivationPreference("plugin", "alias", "claude", false);
    const blockedArgs = claudeAgentResourceArgs(paths.root, scoped);
    assert.equal(blockedArgs.includes(plugin), false);
    assert.equal(blockedArgs.includes(alias), false);
    const blockedInventory = await resourceInventory({ resourceRoot: paths.root });
    assert.equal(blockedInventory.plugins.find((item) => item.source === "managed" && item.name === "kit")?.activation.claude?.enabled, false);
    assert.equal(blockedInventory.plugins.find((item) => item.source === "managed" && item.name === "kit")?.activation.claude?.preference, true);
    assert.equal(blockedInventory.plugins.find((item) => item.source === "managed" && item.name === "alias")?.activation.claude?.preference, false);
    setActivationPreference("plugin", "alias", "claude", null);
    assert.ok(claudeAgentResourceArgs(paths.root, scoped).includes(plugin), "clearing alias block restores effective activation");
    setActivationPreference("plugin", "kit", "claude", null);
    const resetInventory = await resourceInventory({ resourceRoot: paths.root });
    assert.equal(resetInventory.plugins.find((item) => item.source === "managed" && item.name === "kit")?.activation.claude?.enabled, false, "the kit identity stays visible after enabling and resetting");
  } finally {
    setActivationPreference("plugin", "kit", "claude", null);
    markReceivedResource("plugin", "kit", false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
  }
});

test("uninspectable ZIP plugins fail closed without aborting Claude resource setup", async () => {
  const paths = agentResourcePaths(path.join(fixture, "zip-plugin-managed"));
  const archive = path.join(fixture, "not-a-real-plugin.zip");
  await writeFile(archive, "archive fixture");
  const empty = { skills: [], prompts: [], rules: [], plugins: [] };
  const configured = { global: { ...empty, plugins: [archive] }, project: empty };
  assert.doesNotThrow(() => claudeAgentResourceArgs(paths.root, configured));
  assert.equal(claudeAgentResourceArgs(paths.root, configured).includes(archive), false);
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
