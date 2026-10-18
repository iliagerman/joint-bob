import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writeSkill(root: string, name: string, description: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  return directory;
}

test("scanning a local skills folder reports new, changed, installed and linked skills", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-scan-"));
  try {
    const { agentResourcePaths, scanLocalSkills, syncLocalSkills } = await import("../src/agent-resources.js");
    const managed = path.join(fixture, "managed");
    const shared = agentResourcePaths(managed).sharedSkills;
    const source = path.join(fixture, "agents/skills");
    await writeSkill(source, "fresh", "Not imported yet");
    const same = await writeSkill(source, "same", "Already imported");
    const edited = await writeSkill(source, "edited", "Imported, then edited");
    await syncLocalSkills([same, edited], { root: managed, dataDir: path.join(fixture, "data") });
    await writeFile(path.join(edited, "notes.md"), "local edit");
    // A secret file is never published, so it must not make an imported skill look changed.
    await writeFile(path.join(same, ".env"), "TOKEN=x\n");
    await writeSkill(shared, "linked", "Already the shared copy");
    await symlink(path.join(shared, "linked"), path.join(source, "linked"), "dir");
    await mkdir(path.join(source, "not-a-skill"));

    const candidates = await scanLocalSkills(source, { root: managed });
    assert.deepEqual(candidates.map((candidate) => [candidate.name, candidate.status]), [["edited", "changed"], ["fresh", "new"], ["linked", "linked"], ["same", "installed"]]);
    assert.equal(candidates.find((candidate) => candidate.name === "fresh")?.description, "Not imported yet");
    await assert.rejects(scanLocalSkills("relative/path", { root: managed }), /absolute/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("inventory activation uses YAML-parsed skill names", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-yaml-"));
  const { agentResourcePaths } = await import("../src/agent-resources.js");
  const { resourceInventory } = await import("../src/resource-inventory.js");
  const { setActivationPreference } = await import("../src/resource-activation.js");
  const managed = path.join(fixture, "managed");
  const folder = path.join(agentResourcePaths(managed).sharedSkills, "comment");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "---\nname: comment # valid YAML comment\ndescription: parser fixture\n---\n");
    setActivationPreference("skill", "comment", "pi", false);
    const skill = (await resourceInventory({ resourceRoot: managed })).skills.find((item) => item.name === "comment");
    assert.equal(skill?.activation?.pi?.enabled, false);
    assert.equal(skill?.name.includes("#"), false);
  } finally {
    setActivationPreference("skill", "comment", "pi", null);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("inventory ignores nested metadata names just like runtime activation filtering", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-nested-name-"));
  const { agentResourcePaths } = await import("../src/agent-resources.js");
  const { resourceInventory } = await import("../src/resource-inventory.js");
  const managed = path.join(fixture, "managed");
  const folder = path.join(agentResourcePaths(managed).sharedSkills, "actual");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "---\nmetadata:\n  name: unrelated\ndescription: nested metadata fixture\n---\n");
    const skills = (await resourceInventory({ resourceRoot: managed })).skills;
    assert.ok(skills.some((skill) => skill.name === "actual"));
    assert.equal(skills.some((skill) => skill.name === "unrelated"), false);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("configured plugin collections list individual activation identities", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-plugins-"));
  const { agentResourcePaths } = await import("../src/agent-resources.js");
  const { resourceInventory } = await import("../src/resource-inventory.js");
  const { addProject, removeProject } = await import("../src/store.js");
  const { updateProjectResourcePaths } = await import("../src/settings.js");
  const { setActivationPreference } = await import("../src/resource-activation.js");
  const paths = agentResourcePaths(path.join(fixture, "managed"));
  const projectPath = path.join(fixture, "project");
  const collection = path.join(fixture, "plugin-collection");
  let project: Awaited<ReturnType<typeof addProject>> | undefined;
  try {
    for (const name of ["kit", "other"]) {
      const folder = path.join(collection, name, ".claude-plugin");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "plugin.json"), JSON.stringify({ name }));
    }
    const piExtension = path.join(collection, "pi-extension.ts");
    const archive = path.join(fixture, "uninspectable.zip");
    await writeFile(piExtension, "export default {};\\n");
    await writeFile(archive, "fixture archive");
    await mkdir(path.dirname(paths.piPackages), { recursive: true });
    await writeFile(paths.piPackages, JSON.stringify({ packages: ["npm:fixture-pi-package@1.2.3"] }));
    await mkdir(projectPath, { recursive: true });
    project = await addProject("Inventory plugins", projectPath, { writeInstructions: false });
    updateProjectResourcePaths(project.id, { skills: [], prompts: [], rules: [], plugins: [collection, archive] });
    const inventory = await resourceInventory({ projectPath, projectId: project.id, resourceRoot: paths.root });
    assert.deepEqual(inventory.plugins.filter((plugin) => plugin.source === "project").map((plugin) => plugin.name).sort(), ["kit", "other"]);
    assert.ok(inventory.plugins.some((plugin) => plugin.name === "pi-extension.ts" && plugin.harnesses.includes("pi") && plugin.source === "configured"));
    assert.ok(inventory.plugins.some((plugin) => plugin.name === "fixture-pi-package" && plugin.harnesses.includes("pi") && plugin.source === "configured"));
    assert.ok(inventory.plugins.some((plugin) => plugin.name === "uninspectable.zip" && plugin.source === "unverified" && plugin.activation.claude?.enabled === false));
    setActivationPreference("plugin", "kit", "claude", false);
    const updated = await resourceInventory({ projectPath, projectId: project.id, resourceRoot: paths.root });
    assert.equal(updated.plugins.find((plugin) => plugin.name === "kit")?.activation?.claude?.enabled, false);
    assert.equal(updated.plugins.find((plugin) => plugin.name === "other")?.activation?.claude?.enabled, true);
  } finally {
    setActivationPreference("plugin", "kit", "claude", null);
    if (project) await removeProject(project.id);
    await rm(fixture, { recursive: true, force: true });
  }
});

test("malformed skill metadata is omitted without breaking healthy inventory entries", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-malformed-"));
  const { agentResourcePaths } = await import("../src/agent-resources.js");
  const { resourceInventory } = await import("../src/resource-inventory.js");
  const paths = agentResourcePaths(path.join(fixture, "managed"));
  try {
    for (const [name, content] of [
      ["healthy-skill", "---\nname: healthy-skill\ndescription: healthy\n---\n"],
      ["broken-skill", "---\nname: [broken\ndescription: broken\n---\n"],
    ] as const) {
      const folder = path.join(paths.sharedSkills, name);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "SKILL.md"), content);
    }
    await mkdir(path.join(paths.claudePlugins, "healthy-plugin", ".claude-plugin"), { recursive: true });
    await writeFile(path.join(paths.claudePlugins, "healthy-plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "healthy-plugin" }));
    await mkdir(path.dirname(paths.mcpConfig), { recursive: true });
    await writeFile(paths.mcpConfig, JSON.stringify({ mcpServers: { healthy: { url: "https://mcp.fixture.example" } } }));
    const inventory = await resourceInventory({ resourceRoot: paths.root });
    assert.ok(inventory.skills.some((item) => item.name === "healthy-skill"));
    assert.equal(inventory.skills.some((item) => item.name === "broken-skill"), false);
    assert.ok(inventory.plugins.some((item) => item.name === "healthy-plugin"));
    assert.ok(inventory.mcpServers.some((item) => item.name === "healthy"));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("the inventory merges harnesses per skill and lists MCP servers without arguments or secrets", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "resource-inventory-"));
  const claudeUserConfig = path.join(os.homedir(), ".claude.json");
  try {
    const { agentResourcePaths } = await import("../src/agent-resources.js");
    const { resourceInventory, shareMcpServers } = await import("../src/resource-inventory.js");
    const managed = path.join(fixture, "managed");
    const paths = agentResourcePaths(managed);
    const project = path.join(fixture, "project");
    await writeSkill(paths.sharedSkills, "everywhere", "Shared with every agent");
    await writeSkill(path.join(project, ".claude/skills"), "claude-only", "Project skill for Claude");
    await mkdir(path.dirname(paths.mcpConfig), { recursive: true });
    await writeFile(paths.mcpConfig, JSON.stringify({ mcpServers: { docs: { url: "https://docs.example.com/mcp?token=secret" } } }));
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { approved: { command: "/usr/bin/node", args: ["server.js"] }, pending: { command: "npx" }, rejected: { command: "rejected" } } }));
    await writeFile(claudeUserConfig, JSON.stringify({
      mcpServers: { personal: { command: "/opt/bin/personal-mcp", args: ["--token", "secret"], env: { API_KEY: "secret" } } },
      projects: { [project]: { enabledMcpjsonServers: ["approved", "rejected"], disabledMcpjsonServers: ["rejected"] } },
    }));

    const inventory = await resourceInventory({ projectPath: project, resourceRoot: managed });
    const everywhere = inventory.skills.find((skill) => skill.name === "everywhere");
    assert.equal(everywhere?.origin, "shared");
    assert.deepEqual([...everywhere!.harnesses].sort(), ["claude", "kiro", "pi"]);
    assert.deepEqual(inventory.skills.find((skill) => skill.name === "claude-only")?.harnesses, ["claude"]);
    assert.equal(inventory.skills.find((skill) => skill.name === "claude-only")?.origin, "project");

    const byName = Object.fromEntries(inventory.mcpServers.map((server) => [server.name, server]));
    assert.deepEqual([byName.docs.source, byName.docs.transport, byName.docs.target], ["shared", "http", "https://docs.example.com"]);
    assert.deepEqual([...byName.docs.harnesses].sort(), ["claude", "kiro"]);
    assert.deepEqual([byName.personal.source, byName.personal.target, byName.personal.enabled], ["user", "personal-mcp", false]);
    assert.deepEqual([byName.approved.enabled, byName.pending.enabled, byName.rejected.enabled], [true, false, false]);
    assert.doesNotMatch(JSON.stringify(inventory), /secret/);
    assert.equal(inventory.harnesses.find((harness) => harness.id === "pi")?.mcp, false);

    assert.deepEqual(await shareMcpServers(claudeUserConfig, ["personal", "missing"], { projectPath: project, resourceRoot: managed }), { added: ["personal"], skipped: ["missing"] });
    const shared = JSON.parse(await readFile(paths.mcpConfig, "utf8"));
    assert.deepEqual(Object.keys(shared.mcpServers), ["docs", "personal"]);
    assert.equal(shared.mcpServers.personal.env.API_KEY, "secret");
    await assert.rejects(shareMcpServers(path.join(fixture, "elsewhere.json"), ["personal"], { resourceRoot: managed }), /Unknown MCP config source/);
  } finally {
    await rm(claudeUserConfig, { force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});
