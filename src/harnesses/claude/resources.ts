import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { builtinCommands, type CommandDiscoveryOptions, type HarnessCommand } from "../../commands.js";
import { defaultSkillRoots, parseResourceFrontmatter, readConfiguredSkillPath, readSkillDirectory, type SkillRoots, type SkillSummary } from "../../skills.js";
import { getSettings } from "../../settings.js";
import type { HarnessResources } from "../resource-contract.js";

function missing(error: unknown): boolean { const code = (error as NodeJS.ErrnoException).code; return code === "ENOENT" || code === "ENOTDIR"; }
function pluginInvocation(skill: SkillSummary): SkillSummary { return { ...skill, invocation: `/joint-bob-resources:${skill.name} ` }; }
async function skills(projectPath: string, roots: SkillRoots): Promise<SkillSummary[]> {
  const userRoot = roots.claudeUser ?? roots.user?.claude;
  const sources = await Promise.all([
    ...(userRoot ? [readSkillDirectory(userRoot, "claude", "user")] : []),
    readSkillDirectory(roots.shared, "claude", "user").then((items) => items.map(pluginInvocation)),
    ...(roots.global ?? []).map((root) => readConfiguredSkillPath(root, "claude", "user").then((items) => items.map(pluginInvocation))),
    readSkillDirectory(path.join(projectPath, ".agents", "skills"), "claude", "project"),
    readSkillDirectory(path.join(projectPath, ".claude", "skills"), "claude", "project"),
    ...(roots.project ?? []).map((root) => readConfiguredSkillPath(root, "claude", "project").then((items) => items.map(pluginInvocation))),
  ]);
  return sources.flat().map((skill) => ({ ...skill, invocation: skill.invocation ?? `/${skill.name} ` }));
}
async function markdownCommand(file: string, scope: "user" | "project", prefix = "/"): Promise<HarnessCommand | undefined> {
  try { const fields = parseResourceFrontmatter(await readFile(file, "utf8")); const name = path.basename(file, ".md"); return { harness: "claude", name, description: fields.description ?? "", invocation: `${prefix}${name} `, kind: "prompt", scope }; }
  catch (error) { if (missing(error)) return undefined; throw error; }
}
async function markdownCommands(root: string, scope: "user" | "project", prefix = "/"): Promise<HarnessCommand[]> {
  if (root.endsWith(".md")) { const command = await markdownCommand(root, scope, prefix); return command ? [command] : []; }
  let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
  return (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => markdownCommand(path.join(root, entry.name), scope, prefix)))).filter((item): item is HarnessCommand => Boolean(item));
}
async function commands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const roots = { ...defaultSkillRoots(), ...options, user: { ...defaultSkillRoots().user, ...options.user }, global: options.resourcePaths?.global.skills ?? options.global ?? [], project: options.resourcePaths?.project.skills ?? options.project ?? [] };
  const config = options.claudeConfigPath ?? getSettings().claude.configPath;
  const discoveredSkills = await skills(projectPath, roots);
  const custom = options.resourcePaths ? await Promise.all([...options.resourcePaths.global.prompts.map((root) => markdownCommands(root, "user", "/joint-bob-resources:")), ...options.resourcePaths.project.prompts.map((root) => markdownCommands(root, "project", "/joint-bob-resources:"))]) : [];
  return [...builtinCommands("claude"), { harness: "claude", name: "goal", description: "Set a completion condition", invocation: "/goal ", kind: "builtin" }, ...await markdownCommands(path.join(config, "commands"), "user"), ...discoveredSkills.map((skill): HarnessCommand => ({ harness: "claude", name: skill.name, description: skill.description, invocation: skill.invocation!, kind: "skill", scope: skill.scope })), ...await markdownCommands(path.join(projectPath, ".claude", "commands"), "project"), ...custom.flat()];
}
const resources: HarnessResources = { skills, commands };
export default resources;
