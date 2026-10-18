import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentResourcePaths, claudeAgentResourceArgs } from "../src/agent-resources.js";
import { claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { resourceInventory } from "../src/resource-inventory.js";
import { setActivationPreference } from "../src/resource-activation.js";
import { getSettings } from "../src/settings.js";
import { save, settingsDatabase } from "../src/settings-store.js";
import { markReceived } from "../src/skill-sharing-files.js";

const root = path.join(os.homedir(), "activation-regressions");
async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
test.after(() => rm(root, { recursive: true, force: true }));

test("final Claude and Kiro MCP merges cannot restore disabled project servers", async () => {
  const cwd = path.join(root, "mcp-project");
  await write(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { blocked: { command: "fixture" }, allowed: { command: "fixture" } } }));
  await write(path.join(cwd, ".kiro/settings/mcp.json"), JSON.stringify({ mcpServers: { blocked: { command: "fixture" }, allowed: { command: "fixture" } } }));
  await write(path.join(getSettings().claude.configPath, "settings.json"), JSON.stringify({ enableAllProjectMcpServers: true }));
  try {
    for (const harness of ["claude", "kiro"] as const) setActivationPreference("mcp", "blocked", harness, false);
    const args = claudeResourceIsolationArgs(cwd, []);
    const claude = JSON.parse(await readFile(args[args.indexOf("--mcp-config") + 1], "utf8"));
    assert.deepEqual(Object.keys(claude.mcpServers), ["allowed"]);
    const name = await kiroAgentProfile({ cwd, sessionId: "activation-regression" }, "");
    const kiro = JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${name}.json`), "utf8"));
    assert.deepEqual(Object.keys(kiro.mcpServers), ["allowed"]);
  } finally {
    for (const harness of ["claude", "kiro"] as const) setActivationPreference("mcp", "blocked", harness, null);
    await rm(path.join(getSettings().claude.configPath, "settings.json"), { force: true });
  }
});

test("native discovery fails closed for plugin and MCP disables", async () => {
  save(settingsDatabase(), "strictResourceIsolation", "false");
  try {
    setActivationPreference("plugin", "native-kit", "claude", false);
    assert.throws(() => claudeAgentResourceArgs(), /Cannot safely enforce blocked claude plugin/);
    setActivationPreference("plugin", "native-kit", "claude", null);
    setActivationPreference("mcp", "native-server", "claude", false);
    assert.throws(() => claudeResourceIsolationArgs(root, []), /Cannot safely enforce blocked claude mcp/);
    setActivationPreference("mcp", "native-server", "kiro", false);
    await assert.rejects(kiroAgentProfile({ cwd: root, sessionId: "native-block" }, ""), /Cannot safely enforce blocked kiro mcp/);
  } finally {
    save(settingsDatabase(), "strictResourceIsolation", "true");
    setActivationPreference("plugin", "native-kit", "claude", null);
    for (const harness of ["claude", "kiro"] as const) setActivationPreference("mcp", "native-server", harness, null);
  }
});

test("configured-only plugin aliases share effective activation in runtime and node-wide inventory", async () => {
  const kit = path.join(root, "configured", "kit"), alias = path.join(root, "configured", "alias");
  await write(path.join(kit, ".claude-plugin/plugin.json"), '{"name":"kit"}');
  await symlink(kit, alias, "dir");
  const empty = { skills: [], prompts: [], rules: [], plugins: [] };
  const configured = { global: { ...empty, plugins: [kit, alias] }, project: empty };
  save(settingsDatabase(), "resources.plugins", JSON.stringify([kit, alias]));
  try {
    setActivationPreference("plugin", "kit", "claude", false);
    const args = claudeAgentResourceArgs(undefined, configured);
    assert.equal(args.includes(alias), false, "configured alias must not reintroduce disabled target");
    const inventory = await resourceInventory();
    for (const name of ["kit", "alias"]) {
      const row = inventory.plugins.find((item) => item.name === name && item.harnesses.includes("claude"));
      assert.equal(row?.source, "global");
      assert.equal(row?.activation.claude?.enabled, false);
    }
  } finally {
    setActivationPreference("plugin", "kit", "claude", null);
    save(settingsDatabase(), "resources.plugins", "[]");
  }
});

test("project aliases of received skills keep managed provenance and default-off inventory", async () => {
  const shared = agentResourcePaths().sharedSkills;
  const skill = path.join(shared, "received-alias-test");
  await write(path.join(skill, "SKILL.md"), "---\nname: received-alias-test\ndescription: received alias\n---\n");
  await markReceived(shared, "received-alias-test", "fixture-owner");
  const cwd = path.join(root, "skill-project");
  await mkdir(path.join(cwd, ".pi/skills"), { recursive: true });
  await symlink(skill, path.join(cwd, ".pi/skills/alias"), "dir");
  save(settingsDatabase(), "autoActivateSharedSkills", "false");
  try {
    const rows = (await resourceInventory({ projectPath: cwd })).skills.filter((item) => item.name === "received-alias-test");
    assert.ok(rows.length);
    for (const row of rows) {
      assert.equal(row.origin, "shared");
      for (const decision of Object.values(row.activation ?? {})) assert.equal(decision?.enabled, false);
    }
  } finally { save(settingsDatabase(), "autoActivateSharedSkills", "true"); }
});

test("plugin MCP inventory follows containing plugin disable and blocked skills", async () => {
  const paths = agentResourcePaths(path.join(root, "plugin-mcp"));
  const kit = path.join(paths.claudePlugins, "mcp-kit");
  await write(path.join(kit, ".claude-plugin/plugin.json"), '{"name":"mcp-kit"}');
  await write(path.join(kit, ".mcp.json"), '{"mcpServers":{"docs":{"command":"fixture"}}}');
  await write(path.join(kit, "skills/hidden/SKILL.md"), "---\nname: hidden\ndescription: fixture\n---\n");
  try {
    for (const kind of ["plugin", "skill"] as const) {
      const name = kind === "plugin" ? "mcp-kit" : "hidden";
      setActivationPreference(kind, name, "claude", false);
      const server = (await resourceInventory({ resourceRoot: paths.root })).mcpServers.find((item) => item.source === "plugin");
      assert.equal(server?.enabled, false);
      assert.equal(server?.activation?.claude?.enabled, false);
      setActivationPreference(kind, name, "claude", null);
    }
  } finally {
    setActivationPreference("plugin", "mcp-kit", "claude", null);
    setActivationPreference("skill", "hidden", "claude", null);
  }
});
