import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
    assert.ok(commands.every((command) => command.invocation !== "/goal "));
    assert.ok(commands.every((command) => command.invocation !== "/skill "));
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project commands endpoint returns commands for one harness", async () => {
  const server = await readFile("src/server.ts", "utf8");

  assert.match(server, /app\.get\("\/api\/projects\/:projectId\/commands"/);
  assert.match(server, /request\.query\.harness/);
  assert.match(server, /listHarnessCommands\(project\.path, harness\)/);
});
