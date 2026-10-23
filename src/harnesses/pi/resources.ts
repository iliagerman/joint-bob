import { getAgentDir, SettingsManager, type PromptTemplate, type Skill } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { agentResourcePaths, piAgentResourcePaths } from "../../agent-resources.js";
import { builtinCommands, type CommandDiscoveryOptions, type HarnessCommand } from "../../commands.js";
import { readConfiguredSkillPath, readSkillDirectory, type SkillRoots, type SkillSummary } from "../../skills.js";
import { emptyResourcePaths, getSettings } from "../../settings.js";
import { projectFolderResources, withProjectFolderResources } from "../../project-folder-resources.js";
import type { HarnessResources } from "../resource-contract.js";
import { createPiResourceLoader } from "./resource-loader.js";

function scope(value: string): "user" | "project" { return value === "project" ? "project" : "user"; }
function skillCommand(skill: Skill): HarnessCommand { return { harness: "pi", name: `skill:${skill.name}`, description: skill.description, invocation: `/skill:${skill.name} `, kind: "skill", scope: scope(skill.sourceInfo.scope) }; }
function promptCommand(prompt: PromptTemplate): HarnessCommand { return { harness: "pi", name: prompt.name, description: prompt.description, invocation: `/${prompt.name} `, kind: "prompt", scope: scope(prompt.sourceInfo.scope) }; }

async function skills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]> {
  const strict = getSettings().strictResourceIsolation;
  const userRoot = strict ? undefined : (roots.piUser ?? roots.user?.pi);
  const projectRoots = strict ? projectFolderResources(projectPath).skills : [path.join(projectPath, ".agents", "skills"), path.join(projectPath, ".pi", "skills")];
  const sources = await Promise.all([
    ...(userRoot ? [readSkillDirectory(userRoot, "pi", "user")] : []),
    readSkillDirectory(roots.shared, "pi", "user"),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "pi", "user")),
    ...projectRoots.map((root) => readSkillDirectory(root, "pi", "project")),
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "pi", "project")),
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: `/skill:${skill.name} ` }));
}

async function commands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const strict = getSettings().strictResourceIsolation;
  const agentDir = options.piAgentDir || getSettings().pi.configPath || getAgentDir();
  const configured = options.resourcePaths ?? (strict ? { global: emptyResourcePaths(), project: emptyResourcePaths() } : undefined);
  const resources = piAgentResourcePaths(options.resourceRoot, configured && withProjectFolderResources(configured, projectPath));
  const loader = createPiResourceLoader({ cwd: projectPath, agentDir, settingsManager: SettingsManager.create(projectPath, agentDir, { projectTrusted: !strict }), additionalExtensionPaths: resources.extensions, additionalSkillPaths: resources.skills, additionalPromptTemplatePaths: resources.prompts, additionalThemePaths: resources.themes }, strict, agentResourcePaths(options.resourceRoot).piPackages);
  await loader.reload();
  const extensions = loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.values()].map((command): HarnessCommand => ({ harness: "pi", name: command.name, description: command.description ?? "Extension command", invocation: `/${command.name} `, kind: "extension", scope: scope(command.sourceInfo.scope) })));
  const prompts = loader.getPrompts().prompts;
  const skills = loader.getSkills().skills;
  return [...builtinCommands("pi"), { harness: "pi", name: "reload", description: "Reload Pi configuration and resources", invocation: "/reload ", kind: "builtin" }, ...extensions, ...prompts.map(promptCommand), ...skills.map(skillCommand)];
}

const resources: HarnessResources = { skills, commands };
export default resources;
