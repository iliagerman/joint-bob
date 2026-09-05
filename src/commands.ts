import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultSkillRoots, listSkills, parseResourceFrontmatter, type SkillRoots, type SkillSummary } from "./skills.js";
import { piAgentResourcePaths } from "./agent-resources.js";
import { getSettings } from "./settings.js";
import type { HarnessId } from "./types.js";

export type HarnessCommandKind = "builtin" | "extension" | "prompt" | "skill";

export interface HarnessCommand {
  harness: HarnessId;
  name: string;
  description: string;
  invocation: string;
  kind: HarnessCommandKind;
  scope?: "user" | "project";
}

export interface CommandDiscoveryOptions extends Partial<SkillRoots> {
  piAgentDir?: string;
  resourceRoot?: string;
  claudeConfigPath?: string;
}

const BUILTIN_COMMANDS = [
  { name: "help", description: "Show available commands" },
  { name: "skills", description: "Browse installed skills" },
  { name: "model", description: "Choose the session model" },
  { name: "tools", description: "Configure available tools" },
  { name: "compact", description: "Compact conversation context" },
] as const;

const CLAUDE_BUILTIN_COMMANDS = [
  { name: "goal", description: "Set a completion condition" },
] as const;

function commandScope(scope: string): HarnessCommand["scope"] {
  return scope === "project" ? "project" : "user";
}

function builtinCommands(harness: HarnessId): HarnessCommand[] {
  const commands = harness === "claude"
    ? [...BUILTIN_COMMANDS, ...CLAUDE_BUILTIN_COMMANDS]
    : BUILTIN_COMMANDS;
  return commands.map((command) => ({
    harness,
    ...command,
    invocation: `/${command.name} `,
    kind: "builtin",
  }));
}

function piSkillCommand(skill: Skill): HarnessCommand {
  return {
    harness: "pi",
    name: `skill:${skill.name}`,
    description: skill.description,
    invocation: `/skill:${skill.name} `,
    kind: "skill",
    scope: commandScope(skill.sourceInfo.scope),
  };
}

function piPromptCommand(prompt: PromptTemplate): HarnessCommand {
  return {
    harness: "pi",
    name: prompt.name,
    description: prompt.description,
    invocation: `/${prompt.name} `,
    kind: "prompt",
    scope: commandScope(prompt.sourceInfo.scope),
  };
}

async function listPiCommands(projectPath: string, agentDir: string, resourceRoot?: string): Promise<HarnessCommand[]> {
  const settingsManager = SettingsManager.create(projectPath, agentDir);
  const resources = piAgentResourcePaths(resourceRoot);
  const loader = new DefaultResourceLoader({
    cwd: projectPath,
    agentDir,
    settingsManager,
    additionalExtensionPaths: resources.extensions,
    additionalSkillPaths: resources.skills,
    additionalPromptTemplatePaths: resources.prompts,
    additionalThemePaths: resources.themes,
  });
  await loader.reload();
  const extensions = loader.getExtensions().extensions.flatMap((extension) =>
    [...extension.commands.values()].map((command): HarnessCommand => ({
      harness: "pi",
      name: command.name,
      description: command.description ?? "Extension command",
      invocation: `/${command.name} `,
      kind: "extension",
      scope: commandScope(command.sourceInfo.scope),
    })),
  );
  return [
    ...builtinCommands("pi"),
    ...extensions,
    ...loader.getPrompts().prompts.map(piPromptCommand),
    ...loader.getSkills().skills.map(piSkillCommand),
  ];
}

function claudeSkillCommand(skill: SkillSummary): HarnessCommand {
  return {
    harness: "claude",
    name: skill.name,
    description: skill.description,
    invocation: `/${skill.name} `,
    kind: "skill",
    scope: skill.scope,
  };
}

async function markdownCommands(directory: string, scope: "user" | "project"): Promise<HarnessCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: HarnessCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const contents = await readFile(path.join(directory, entry.name), "utf8");
      const fields = parseResourceFrontmatter(contents);
      const name = path.basename(entry.name, ".md");
      commands.push({
        harness: "claude",
        name,
        description: fields.description ?? "",
        invocation: `/${name} `,
        kind: "prompt",
        scope,
      });
    } catch {
      continue;
    }
  }
  return commands;
}

async function listClaudeCommands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const roots = { ...defaultSkillRoots(), ...options };
  const config = options.claudeConfigPath ?? getSettings().claude.configPath;
  const [global, skills, project] = await Promise.all([
    markdownCommands(path.join(config, "commands"), "user"),
    listSkills(projectPath, roots),
    markdownCommands(path.join(projectPath, ".claude", "commands"), "project"),
  ]);
  return [
    ...builtinCommands("claude"),
    ...global,
    ...skills.filter((skill) => skill.harness === "claude").map(claudeSkillCommand),
    ...project,
  ];
}

function uniqueCommands(commands: HarnessCommand[]): HarnessCommand[] {
  return [...new Map(commands.map((command) => [command.invocation, command])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listHarnessCommands(
  projectPath: string,
  harness: HarnessId,
  options: CommandDiscoveryOptions = {},
): Promise<HarnessCommand[]> {
  if (harness === "claude") return uniqueCommands(await listClaudeCommands(projectPath, options));
  const agentDir = options.piAgentDir || getSettings().pi.configPath || getAgentDir();
  return uniqueCommands(await listPiCommands(projectPath, agentDir, options.resourceRoot));
}
