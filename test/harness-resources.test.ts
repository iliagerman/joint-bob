import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listHarnessCommands } from "../src/commands.js";
import { expandKiroPrompt } from "../src/harnesses/kiro/resources.js";
import { updateProjectResourcePaths } from "../src/settings.js";
import { listSkills, type SkillRoots } from "../src/skills.js";
import { sessionWatchDirs } from "../src/watcher.js";

async function skill(root: string, name: string): Promise<void> {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n`);
}

test("Kiro discovers shared and project skills with model-facing invocations", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `joint-bob-resources-${process.pid}`), { recursive: true }).then(() => path.join(os.tmpdir(), `joint-bob-resources-${process.pid}`));
  const shared = path.join(root, "shared");
  const projectSkills = path.join(root, "project-skills");
  try {
    await skill(shared, "shared-skill");
    await skill(projectSkills, "project-skill");
    const roots: SkillRoots = { piUser: path.join(root, "pi"), claudeUser: path.join(root, "claude"), user: { kiro: path.join(root, "kiro") }, shared, global: [], project: [projectSkills] };
    const kiro = (await listSkills(root, roots)).filter((item) => item.harness === "kiro");
    assert.deepEqual(kiro.map(({ name, invocation }) => ({ name, invocation })), [
      { name: "project-skill", invocation: "Use the project-skill skill. " },
      { name: "shared-skill", invocation: "Use the shared-skill skill. " },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown command harness fails instead of falling back to Pi", async () => {
  await assert.rejects(() => listHarnessCommands(process.cwd(), "missing" as never), /Unknown harness/);
});

test("Kiro expands configured prompt templates and preserves arguments", async () => {
  const prompts = path.join(os.homedir(), ".kiro", "prompts");
  await mkdir(prompts, { recursive: true });
  const file = path.join(prompts, "review.md");
  await writeFile(file, "Review this change.");
  try {
    assert.equal(await expandKiroPrompt("/review focus on tests", process.cwd()), "Review this change.\n\nfocus on tests");
    assert.equal(await expandKiroPrompt("/compact now", process.cwd()), "/compact now");
  } finally { await rm(file, { force: true }); }
});

test("Kiro project prompt templates override native templates and accept explicit files", async () => {
  const root = path.join(os.tmpdir(), `joint-bob-prompts-${process.pid}`);
  const native = path.join(root, ".kiro", "prompts");
  const configured = path.join(root, "configured");
  const explicit = path.join(root, "direct.md");
  const projectId = `resource-project-${process.pid}`;
  await mkdir(native, { recursive: true });
  await mkdir(configured, { recursive: true });
  await writeFile(path.join(native, "review.md"), "Native review");
  await writeFile(path.join(configured, "review.md"), "Project review");
  await writeFile(explicit, "Direct template");
  updateProjectResourcePaths(projectId, { prompts: [configured, explicit], rules: [], skills: [], plugins: [] });
  try {
    assert.equal(await expandKiroPrompt("/review", root, projectId), "Project review");
    assert.equal(await expandKiroPrompt("/direct details", root, projectId), "Direct template\n\ndetails");
  } finally {
    updateProjectResourcePaths(projectId, { prompts: [], rules: [], skills: [], plugins: [] });
    await rm(root, { recursive: true, force: true });
  }
});

test("session watch directories come from every configured adapter", () => {
  const directories = sessionWatchDirs({ path: "/workspace/project", macPath: null, locations: [] });
  assert.ok(directories.includes(path.join(os.homedir(), ".kiro", "sessions")));
  assert.ok(directories.includes(path.join(os.homedir(), ".kiro", "sessions", "joint-bob")));
  assert.ok(directories.some((directory) => directory.startsWith(path.join(os.homedir(), ".pi", "agent", "sessions"))));
  assert.ok(directories.some((directory) => directory.startsWith(path.join(os.homedir(), ".claude", "projects"))));
});
