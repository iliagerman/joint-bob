import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentInstructionFiles, globalInstructionsPath } from "../src/agent-instructions.js";
import { agentResourcePaths, claudeAgentResourceArgs } from "../src/agent-resources.js";
import { disableInheritedKiroResources, kiroAgentProfile } from "../src/harnesses/kiro/resources.js";
import { projectFolderResources } from "../src/project-folder-resources.js";
import { getSettings, updateSettings } from "../src/settings.js";

const root = path.join(os.homedir(), "agent-instructions");
const project = path.join(root, "workspace", "project");

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

test.before(async () => {
  await mkdir(project, { recursive: true });
  assert.equal(getSettings().strictResourceIsolation, true);
  updateSettings({ syncthing: { endpoint: "" }, projects: { homePath: root } });
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test("agents read the global AGENTS.md, the app's instructions, then the project's own, and nothing from parent folders", async () => {
  const paths = agentResourcePaths();
  await write(globalInstructionsPath(paths), "GLOBAL_WORD");
  await write(path.join(paths.commonInstructions, "style.md"), "COMMON_WORD");
  await write(path.join(paths.claudeInstructions, "claude.md"), "CLAUDE_ONLY_WORD");
  await write(path.join(root, "rules", "rule.md"), "RULE_WORD");
  await write(path.join(project, "AGENTS.md"), "PROJECT_WORD");
  await write(path.join(project, "CLAUDE.md"), "PROJECT_CLAUDE_WORD");
  await write(path.join(project, ".kiro/steering/always.md"), "STEERING_WORD");
  await write(path.join(project, ".kiro/steering/manual.md"), "---\ninclusion: manual\n---\nMANUAL_WORD");
  await write(path.join(root, "workspace", "AGENTS.md"), "PARENT_WORD");
  await write(path.join(project, "nested", "AGENTS.md"), "NESTED_WORD");

  const files = agentInstructionFiles(paths, "claude", { cwd: project, rules: [path.join(root, "rules")] });
  assert.deepEqual(files.map((file) => file.content), ["GLOBAL_WORD", "CLAUDE_ONLY_WORD", "COMMON_WORD", "RULE_WORD", "PROJECT_WORD", "PROJECT_CLAUDE_WORD", "STEERING_WORD"]);
  assert.deepEqual(files.map((file) => file.label).slice(-3), ["Project instructions (AGENTS.md)", "Project instructions (CLAUDE.md)", "Project instructions (.kiro/steering/always.md)"]);
  assert.equal(agentInstructionFiles(paths, "kiro", { cwd: project }).some((file) => file.content === "CLAUDE_ONLY_WORD"), false);

  await rm(path.join(project, "AGENTS.md"));
  assert.ok(agentInstructionFiles(paths, "pi", { cwd: project }).some((file) => file.content === "PROJECT_CLAUDE_WORD" && file.label === "Project instructions (CLAUDE.md)"));

  updateSettings({ syncthing: { endpoint: "" }, strictResourceIsolation: false });
  try {
    // Without strict isolation the harnesses still read project files themselves; the app must not add them twice.
    assert.equal(agentInstructionFiles(paths, "pi", { cwd: project }).some((file) => file.content === "PROJECT_CLAUDE_WORD"), false);
  } finally { updateSettings({ syncthing: { endpoint: "" }, strictResourceIsolation: true }); }

  const args = claudeAgentResourceArgs(undefined, undefined, undefined, project);
  const instructions = await readFile(args[args.indexOf("--append-system-prompt-file") + 1], "utf8");
  assert.match(instructions, /# Global instructions \(AGENTS\.md\)\n\nGLOBAL_WORD/);
  assert.match(instructions, /# Project instructions \(CLAUDE\.md\)\n\nPROJECT_CLAUDE_WORD/);
  assert.doesNotMatch(instructions, /PARENT_WORD|NESTED_WORD|MANUAL_WORD/);
  await write(globalInstructionsPath(paths), "  \n");
  assert.equal(agentInstructionFiles(paths, "pi", { cwd: project }).some((file) => file.label.startsWith("Global")), false, "an empty AGENTS.md adds nothing");
  await rm(path.join(project, "CLAUDE.md"));
});

test("every instruction file the project folder carries reaches the agents, with Claude's imports expanded", async () => {
  const paths = agentResourcePaths();
  const folder = path.join(root, "imports-project");
  await write(path.join(folder, "CLAUDE.md"), "ROOT_CLAUDE");
  await mkdir(folder, { recursive: true });
  await symlink("CLAUDE.md", path.join(folder, "AGENTS.md"));
  await write(path.join(folder, ".claude/CLAUDE.md"), "DOT_CLAUDE\n@.claude/rules/stub.md\n```\n@method/inside-fence.md\n```\n@secrets.env");
  await write(path.join(folder, "CLAUDE.local.md"), "LOCAL_NOTES");
  await write(path.join(folder, ".claude/rules/stub.md"), "STUB\n@../../method/org.md");
  await write(path.join(folder, "method/org.md"), "ORG_METHOD\n@team.md");
  await write(path.join(folder, "method/team.md"), "TEAM_METHOD\n@org.md");
  await write(path.join(folder, "method/inside-fence.md"), "FENCED_IMPORT");
  await write(path.join(folder, "secrets.env"), "NOT_MARKDOWN");
  await write(path.join(folder, ".claude/rules/frontend.md"), "---\npaths:\n  - \"web/**/*.tsx\"\n---\nFRONTEND_ONLY");
  await write(path.join(folder, ".kiro/steering/api.md"), "---\ninclusion: fileMatch\nfileMatchPattern: \"api/**/*.ts\"\n---\nAPI_ONLY");
  await write(path.join(folder, ".kiro/steering/manual.md"), "---\ninclusion: manual\n---\nMANUAL_ONLY");

  const files = agentInstructionFiles(paths, "kiro", { cwd: folder }).filter((file) => file.label.startsWith("Project"));
  assert.deepEqual(files.map((file) => file.label), [
    "Project instructions (AGENTS.md)",
    "Project instructions (.claude/CLAUDE.md)",
    "Project instructions (CLAUDE.local.md)",
    "Project rules for specific files",
  ], "the linked CLAUDE.md counts once, and the rule .claude/CLAUDE.md already imported is not read again");
  const dotClaude = files[1].content;
  assert.match(dotClaude, /^DOT_CLAUDE\nSTUB\nORG_METHOD\nTEAM_METHOD\n@org\.md\n```\n@method\/inside-fence\.md\n```\n@secrets\.env$/, "imports resolve from the file, then the project root; a loop, a code block and a non-Markdown file stay as lines");
  assert.equal(files[3].content, "- `.claude/rules/frontend.md` applies to files matching `web/**/*.tsx`: read it before working on such files.\n- `.kiro/steering/api.md` applies to files matching `api/**/*.ts`: read it before working on such files.");
  assert.equal(files.some((file) => file.content.includes("MANUAL_ONLY") || file.content.includes("FRONTEND_ONLY")), false);
});

test("Claude gets the project folder's skills, commands and agents from every harness's folder through the app", async () => {
  const skill = (folder: string, name: string) => write(path.join(project, folder, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  await skill(".pi/skills", "pi-skill");
  await skill(".agents/skills", "agents-skill");
  await mkdir(path.join(project, ".claude"), { recursive: true });
  await symlink(path.join(project, ".agents/skills"), path.join(project, ".claude/skills"));
  await write(path.join(project, ".kiro/prompts/kiro-prompt.md"), "Kiro prompt");
  await write(path.join(project, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview it.");

  assert.deepEqual(projectFolderResources(project).skills.map((folder) => path.relative(realpathSync(project), folder)), [".agents/skills", ".pi/skills"], "a linked folder counts once");
  const args = claudeAgentResourceArgs(undefined, undefined, undefined, project);
  const plugin = args[args.indexOf("--plugin-dir") + 1];
  assert.equal(realpathSync(path.join(plugin, "skills", "pi-skill")), realpathSync(path.join(project, ".pi/skills/pi-skill")));
  assert.ok(existsSync(path.join(plugin, "skills", "agents-skill", "SKILL.md")));
  assert.equal(await readFile(path.join(plugin, "commands", "kiro-prompt.md"), "utf8"), "Kiro prompt");
  assert.match(await readFile(path.join(plugin, "agents", "reviewer.md"), "utf8"), /Review it/);
});

test("Kiro profiles carry the project's instructions themselves and stop Kiro's own default resources", async () => {
  const kiro = getSettings().runtimes.kiro.configPath;
  await write(path.join(kiro, "settings", "cli.json"), JSON.stringify({ "chat.enableAutoAgentUpgrade": true }));
  await write(path.join(project, "AGENTS.md"), "KIRO_PROJECT_WORD");
  const name = await kiroAgentProfile({ cwd: project, sessionId: "instructions-test" }, "");
  const profile = JSON.parse(await readFile(path.join(kiro, "agents", `${name}.json`), "utf8"));
  assert.match(profile.prompt, /# Project instructions \(AGENTS\.md\)\n\nKIRO_PROJECT_WORD/);
  assert.equal(profile.resources.some((resource: string) => resource.startsWith("file://")), false, "the app passes AGENTS.md, Kiro does not load it");
  assert.ok(profile.resources.some((resource: string) => resource.includes(".pi/skills")), "a project skill from another harness's folder reaches Kiro");
  assert.deepEqual(JSON.parse(await readFile(path.join(kiro, "settings", "cli.json"), "utf8")), { "chat.enableAutoAgentUpgrade": true, "chat.disableInheritingDefaultResources": true });
  await write(path.join(kiro, "settings", "cli.json"), "[]");
  await assert.rejects(disableInheritedKiroResources(kiro), /must be a JSON object/);
  await rm(path.join(kiro, "settings", "cli.json"));
});
