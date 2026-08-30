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
    await writeMarkdown(path.join(agentDir, "skills", "debugging", "SKILL.md"), "---\nname: debugging\ndescription: Trace a bug.\n---\n");
    await writeMarkdown(path.join(project, ".pi", "prompts", "review.md"), "---\ndescription: Review current changes.\n---\nReview the changes.");

    const commands = await listHarnessCommands(project, "pi", { piAgentDir: agentDir });

    assert.ok(commands.some((command) => command.kind === "skill" && command.invocation === "/skill:debugging "));
    assert.ok(commands.some((command) => command.kind === "prompt" && command.invocation === "/review "));
    assert.ok(commands.some((command) => command.kind === "builtin" && command.invocation === "/model "));
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
    await writeMarkdown(path.join(claudeUser, "push-code", "SKILL.md"), "---\nname: push-code\ndescription: Test and push changes.\n---\n");

    const commands = await listHarnessCommands(project, "claude", { claudeUser });

    assert.ok(commands.some((command) => command.kind === "skill" && command.invocation === "/push-code "));
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
