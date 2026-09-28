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
    await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { approved: { command: "/usr/bin/node", args: ["server.js"] }, pending: { command: "npx" } } }));
    await writeFile(claudeUserConfig, JSON.stringify({
      mcpServers: { personal: { command: "/opt/bin/personal-mcp", args: ["--token", "secret"], env: { API_KEY: "secret" } } },
      projects: { [project]: { enabledMcpjsonServers: ["approved"] } },
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
    assert.deepEqual([byName.personal.source, byName.personal.target, byName.personal.enabled], ["user", "personal-mcp", true]);
    assert.deepEqual([byName.approved.enabled, byName.pending.enabled], [true, false]);
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
