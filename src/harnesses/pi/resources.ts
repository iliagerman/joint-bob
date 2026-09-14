import { DefaultResourceLoader, getAgentDir, SettingsManager, type PromptTemplate, type Skill } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { piAgentResourcePaths } from "../../agent-resources.js";
import { builtinCommands, type CommandDiscoveryOptions, type HarnessCommand } from "../../commands.js";
import { defaultSkillRoots, readConfiguredSkillPath, readSkillDirectory, type SkillRoots, type SkillSummary } from "../../skills.js";
import { getSettings } from "../../settings.js";
import type { HarnessResources } from "../resource-contract.js";

function scope(value: string): "user" | "project" { return value === "project" ? "project" : "user"; }
function skillCommand(skill: Skill): HarnessCommand { return { harness: "pi", name: `skill:${skill.name}`, description: skill.description, invocation: `/skill:${skill.name} `, kind: "skill", scope: scope(skill.sourceInfo.scope) }; }
function promptCommand(prompt: PromptTemplate): HarnessCommand { return { harness: "pi", name: prompt.name, description: prompt.description, invocation: `/${prompt.name} `, kind: "prompt", scope: scope(prompt.sourceInfo.scope) }; }

async function skills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]> {
  const userRoot = roots.piUser ?? roots.user?.pi;
  const sources = await Promise.all([
    ...(userRoot ? [readSkillDirectory(userRoot, "pi", "user")] : []),
    readSkillDirectory(roots.shared, "pi", "user"),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "pi", "user")),
    readSkillDirectory(path.join(projectPath, ".agents", "skills"), "pi", "project"),
    readSkillDirectory(path.join(projectPath, ".pi", "skills"), "pi", "project"),
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "pi", "project")),
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: `/skill:${skill.name} ` }));
}

async function commands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const agentDir = options.piAgentDir || getSettings().pi.configPath || getAgentDir();
  const resources = piAgentResourcePaths(options.resourceRoot, options.resourcePaths);
  const loader = new DefaultResourceLoader({ cwd: projectPath, agentDir, settingsManager: SettingsManager.create(projectPath, agentDir), additionalExtensionPaths: resources.extensions, additionalSkillPaths: resources.skills, additionalPromptTemplatePaths: resources.prompts, additionalThemePaths: resources.themes });
  await loader.reload();
  const extensions = loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.values()].map((command): HarnessCommand => ({ harness: "pi", name: command.name, description: command.description ?? "Extension command", invocation: `/${command.name} `, kind: "extension", scope: scope(command.sourceInfo.scope) })));
  return [...builtinCommands("pi"), { harness: "pi", name: "reload", description: "Reload Pi configuration and resources", invocation: "/reload ", kind: "builtin" }, ...extensions, ...loader.getPrompts().prompts.map(promptCommand), ...loader.getSkills().skills.map(skillCommand)];
}

const resources: HarnessResources = { skills, commands };
export default resources;
