import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { piAgentResourcePaths } from "../../agent-resources.js";
import { builtinCommands } from "../../commands.js";
import { readConfiguredSkillPath, readSkillDirectory } from "../../skills.js";
import { getSettings } from "../../settings.js";
function scope(value) {
  return value === "project" ? "project" : "user";
}
function skillCommand(skill) {
  return { harness: "pi", name: `skill:${skill.name}`, description: skill.description, invocation: `/skill:${skill.name} `, kind: "skill", scope: scope(skill.sourceInfo.scope) };
}
function promptCommand(prompt) {
  return { harness: "pi", name: prompt.name, description: prompt.description, invocation: `/${prompt.name} `, kind: "prompt", scope: scope(prompt.sourceInfo.scope) };
}
async function skills(projectPath, roots) {
  const userRoot = roots.piUser ?? roots.user?.pi;
  const sources = await Promise.all([
    ...userRoot ? [readSkillDirectory(userRoot, "pi", "user")] : [],
    readSkillDirectory(roots.shared, "pi", "user"),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "pi", "user")),
    readSkillDirectory(path.join(projectPath, ".agents", "skills"), "pi", "project"),
    readSkillDirectory(path.join(projectPath, ".pi", "skills"), "pi", "project"),
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "pi", "project"))
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: `/skill:${skill.name} ` }));
}
async function commands(projectPath, options) {
  const agentDir = options.piAgentDir || getSettings().pi.configPath || getAgentDir();
  const resources2 = piAgentResourcePaths(options.resourceRoot, options.resourcePaths);
  const loader = new DefaultResourceLoader({ cwd: projectPath, agentDir, settingsManager: SettingsManager.create(projectPath, agentDir), additionalExtensionPaths: resources2.extensions, additionalSkillPaths: resources2.skills, additionalPromptTemplatePaths: resources2.prompts, additionalThemePaths: resources2.themes });
  await loader.reload();
  const extensions = loader.getExtensions().extensions.flatMap((extension) => [...extension.commands.values()].map((command) => ({ harness: "pi", name: command.name, description: command.description ?? "Extension command", invocation: `/${command.name} `, kind: "extension", scope: scope(command.sourceInfo.scope) })));
  return [...builtinCommands("pi"), { harness: "pi", name: "reload", description: "Reload Pi configuration and resources", invocation: "/reload ", kind: "builtin" }, ...extensions, ...loader.getPrompts().prompts.map(promptCommand), ...loader.getSkills().skills.map(skillCommand)];
}
const resources = { skills, commands };
var resources_default = resources;
export {
  resources_default as default
};
