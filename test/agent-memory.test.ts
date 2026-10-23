import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentInstructionFiles } from "../src/agent-instructions.js";
import { conversationMemoryDirectory, ensureProjectMemory, prepareProjectMemory, projectMemoryDirectory } from "../src/agent-memory.js";
import { agentResourcePaths } from "../src/agent-resources.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { claudeProjectDir } from "../src/harnesses/claude/paths.js";
import { claudeResourceIsolationArgs } from "../src/harnesses/claude/resources.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { internalSessionId } from "../src/internal-sessions.js";
import { getSettings } from "../src/settings.js";

const project = path.join(os.homedir(), "memory-fixture", "project");
const nativeMemory = path.join(claudeProjectDir(project, path.join(getSettings().claude.configPath, "projects")), "memory");

test.before(async () => { await mkdir(project, { recursive: true }); });
test.after(async () => {
  await rm(path.join(os.homedir(), "memory-fixture"), { recursive: true, force: true });
  await rm(path.dirname(nativeMemory), { recursive: true, force: true });
  await rm(path.join(resolveDataDirectory(), "memory"), { recursive: true, force: true });
});

test("a project's memory lives in the app's data folder and starts once from Claude's own notes", async () => {
  await mkdir(nativeMemory, { recursive: true });
  await writeFile(path.join(nativeMemory, "MEMORY.md"), "- [Deploys](deploys.md) — how releases reach the machines\n");
  await writeFile(path.join(nativeMemory, "deploys.md"), "---\nname: deploys\n---\nPush, then wait.");
  const directory = ensureProjectMemory("memory-project", project);
  assert.equal(directory, path.join(resolveDataDirectory(), "memory", "memory-project"));
  assert.equal(await readFile(path.join(directory, "deploys.md"), "utf8"), "---\nname: deploys\n---\nPush, then wait.");
  assert.ok(existsSync(path.join(nativeMemory, "deploys.md")), "Claude in a terminal keeps its own copy");

  await writeFile(path.join(nativeMemory, "later.md"), "Written by Claude in a terminal afterwards");
  ensureProjectMemory("memory-project", project);
  assert.equal(existsSync(path.join(directory, "later.md")), false, "the import runs once; the app's folder is then its own");
  assert.match(projectMemoryDirectory("../escape"), /memory\/Li4vZXNjYXBl$/, "an unsafe id never leaves the memory folder");
});

test("background runs keep no memory, and Claude's own memory is pointed at the app's folder", async () => {
  assert.equal(await prepareProjectMemory("memory-project", internalSessionId()), undefined);
  assert.equal(conversationMemoryDirectory("memory-project", internalSessionId()), undefined);
  assert.equal(await prepareProjectMemory(undefined, "conversation"), undefined);
  const directory = projectMemoryDirectory("memory-project");
  assert.equal(conversationMemoryDirectory("memory-project", "conversation"), directory);

  const settings = async (memory?: string) => {
    const args = claudeResourceIsolationArgs(project, [], memory);
    return JSON.parse(await readFile(args[args.indexOf("--settings") + 1], "utf8"));
  };
  assert.equal((await settings(directory)).autoMemoryDirectory, directory);
  assert.equal((await settings()).autoMemoryEnabled, false, "with no project memory Claude keeps none, rather than its own");
});

test("Pi and Kiro read the same notes and are told how to keep them", async () => {
  const directory = projectMemoryDirectory("memory-project");
  await writeFile(path.join(directory, "MEMORY.md"), "- [Deploys](deploys.md) — how releases reach the machines\n");
  const memory = agentInstructionFiles(agentResourcePaths(), "pi", { cwd: project, memory: directory }).at(-1)!;
  assert.equal(memory.label, "Memory");
  assert.ok(memory.content.includes(`memory folder at \`${directory}\``));
  assert.match(memory.content, /MEMORY\.md now reads:\n\n- \[Deploys\]\(deploys\.md\)/);
  assert.equal(agentInstructionFiles(agentResourcePaths(), "claude", { cwd: project, memory: directory }).some((file) => file.label === "Memory"), false, "Claude reads it through its own auto-memory");

  const name = await kiroAgentProfile({ cwd: project, projectId: "memory-project", sessionId: "memory-kiro" }, "");
  const profile = JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${name}.json`), "utf8"));
  assert.match(profile.prompt, /# Memory\n\nThis project has a memory folder/);
});
