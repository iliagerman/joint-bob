import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { defaultSkillRoots, listSkills, type SkillRoots, type SkillSummary } from "./skills.js";
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

async function listPiCommands(projectPath: string, agentDir: string): Promise<HarnessCommand[]> {
  const settingsManager = SettingsManager.create(projectPath, agentDir);
  const loader = new DefaultResourceLoader({ cwd: projectPath, agentDir, settingsManager });
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

async function listClaudeCommands(projectPath: string, options: CommandDiscoveryOptions): Promise<HarnessCommand[]> {
  const roots = { ...defaultSkillRoots(), ...options };
  const skills = (await listSkills(projectPath, roots)).filter((skill) => skill.harness === "claude");
  return [...builtinCommands("claude"), ...skills.map(claudeSkillCommand)];
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
  return uniqueCommands(await listPiCommands(projectPath, agentDir));
}
