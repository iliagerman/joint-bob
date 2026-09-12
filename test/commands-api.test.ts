import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serverSource } from "./source.js";

async function writeMarkdown(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

test("Pi commands come from the same resource loader used by Pi sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-commands-pi-"));
  const { listHarnessCommands } = await import("../src/commands.js");

  try {
    const project = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const resourceRoot = path.join(root, "resources");
    const shared = path.join(resourceRoot, "shared", "skills");
    await writeMarkdown(path.join(agentDir, "skills", "debugging", "SKILL.md"), "---\nname: debugging\ndescription: Trace a bug.\n---\n");
    await writeMarkdown(path.join(project, ".pi", "prompts", "review.md"), "---\ndescription: Review current changes.\n---\nReview the changes.");
    await writeMarkdown(path.join(shared, "canonical", "SKILL.md"), "---\nname: canonical\ndescription: Canonical skill.\n---\n");
    await writeMarkdown(path.join(resourceRoot, "pi", "prompts", "canonical-review.md"), "---\ndescription: Canonical prompt.\n---\n");

    const commands = await listHarnessCommands(project, "pi", { piAgentDir: agentDir, resourceRoot, shared });

    assert.ok(commands.some((command) => command.kind === "skill" && command.invocation === "/skill:debugging "));
    assert.ok(commands.some((command) => command.kind === "skill" && command.invocation === "/skill:canonical "));
    assert.ok(commands.some((command) => command.kind === "prompt" && command.invocation === "/review "));
    assert.ok(commands.some((command) => command.kind === "prompt" && command.invocation === "/canonical-review "));
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/model "));
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/skills "));
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/help "));
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/reload "));
    assert.ok(commands.every((command) => command.invocation !== "/goal "));
    assert.ok(commands.every((command) => command.invocation !== "/skill "));
    const configured = { global: { skills: [path.join(root, "global-skills")], prompts: [path.join(root, "global-prompts")], rules: [], plugins: [] }, project: { skills: [path.join(root, "project-skills")], prompts: [path.join(root, "project-prompts")], rules: [], plugins: [] } };
    await writeMarkdown(path.join(configured.global.skills[0], "custom", "SKILL.md"), "---\nname: custom\ndescription: Global custom\n---\n");
    await writeMarkdown(path.join(configured.project.skills[0], "custom", "SKILL.md"), "---\nname: custom\ndescription: Project custom\n---\n");
    await writeMarkdown(path.join(configured.global.prompts[0], "custom.md"), "---\ndescription: Global prompt\n---\n");
    await writeMarkdown(path.join(configured.project.prompts[0], "custom.md"), "---\ndescription: Project prompt\n---\n");
    const configuredCommands = await listHarnessCommands(project, "pi", { piAgentDir: agentDir, resourceRoot, resourcePaths: configured });
    assert.ok(configuredCommands.some((command) => command.name === "skill:custom"));
    assert.ok(configuredCommands.some((command) => command.name === "custom"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command list uses Claude skills and invocation syntax", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-commands-claude-"));
  const { listHarnessCommands } = await import("../src/commands.js");

  try {
    const project = path.join(root, "project");
    const claudeUser = path.join(root, "claude-user");
    const claudeConfigPath = path.join(root, "claude-config");
    const shared = path.join(root, "shared");
    await writeMarkdown(path.join(claudeUser, "push-code", "SKILL.md"), "---\nname: push-code\ndescription: Test and push changes.\n---\n");
    await writeMarkdown(path.join(claudeConfigPath, "commands", "review.md"), "---\ndescription: User review\n---\n");
    await writeMarkdown(path.join(project, ".claude", "commands", "review.md"), "---\ndescription: Project review\n---\n");

    const commands = await listHarnessCommands(project, "claude", {
      claudeUser,
      claudeConfigPath,
      shared,
      resourceRoot: path.join(root, "resources"),
    });

    assert.ok(commands.some((command) => command.kind === "skill" && command.invocation === "/push-code "));
    assert.deepEqual(commands.find((command) => command.invocation === "/review "), {
      harness: "claude",
      name: "review",
      description: "Project review",
      invocation: "/review ",
      kind: "prompt",
      scope: "project",
    });
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/goal "));
    assert.ok(commands.every((command) => command.harness === "claude"));
    const configured = { global: { skills: [path.join(root, "direct-skill")], prompts: [path.join(root, "direct-prompt.md")], rules: [], plugins: [] }, project: { skills: [path.join(root, "project-skills")], prompts: [path.join(root, "project-prompts")], rules: [], plugins: [] } };
    await writeMarkdown(path.join(configured.global.skills[0], "SKILL.md"), "---\nname: direct-skill\ndescription: Direct global skill\n---\n");
    await writeMarkdown(path.join(configured.project.skills[0], "custom", "SKILL.md"), "---\nname: custom\ndescription: Project custom\n---\n");
    await writeMarkdown(configured.global.prompts[0], "---\ndescription: Direct global prompt\n---\n");
    await writeMarkdown(path.join(configured.project.prompts[0], "custom.md"), "---\ndescription: Project prompt\n---\n");
    const configuredCommands = await listHarnessCommands(project, "claude", { claudeUser, claudeConfigPath, shared, resourceRoot: path.join(root, "resources"), resourcePaths: configured });
    assert.deepEqual(configuredCommands.find((command) => command.invocation === "/joint-bob-resources:direct-skill "), { harness: "claude", name: "direct-skill", description: "Direct global skill", invocation: "/joint-bob-resources:direct-skill ", kind: "skill", scope: "user" });
    assert.deepEqual(configuredCommands.find((command) => command.invocation === "/joint-bob-resources:direct-prompt "), { harness: "claude", name: "direct-prompt", description: "Direct global prompt", invocation: "/joint-bob-resources:direct-prompt ", kind: "prompt", scope: "user" });
    assert.deepEqual(configuredCommands.find((command) => command.invocation === "/joint-bob-resources:custom "), { harness: "claude", name: "custom", description: "Project prompt", invocation: "/joint-bob-resources:custom ", kind: "prompt", scope: "project" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project commands endpoint returns commands for one harness", async () => {
  const server = await serverSource();

  assert.match(server, /app\.get\("\/api\/projects\/:projectId\/commands"/);
  assert.match(server, /request\.query\.harness/);
  assert.match(server, /listHarnessCommands\(project\.path, harness, \{ resourcePaths: getScopedResourcePaths\(project\.id\) \}\)/);
});
