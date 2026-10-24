import type { ScopedResourcePaths } from "./settings.js";
import type { SkillRoots } from "./skills.js";
import type { HarnessId } from "./types.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { skillScopeContext, unavailableSkillNames } from "./scoped-skills.js";

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
  resourcePaths?: ScopedResourcePaths;
}

const UNIVERSAL_COMMANDS = [
  { name: "help", description: "Show available commands" },
  { name: "skills", description: "Browse installed skills" },
  { name: "model", description: "Choose the session model" },
  { name: "tools", description: "Configure available tools" },
  { name: "compact", description: "Compact conversation context" },
  { name: "bob-restart", description: "Close and reopen the harness without starting a new conversation" },
  { name: "bob-btw", description: "Ask about this conversation in read-only Chat" },
  { name: "bob-goal", description: "Run an objective to completion; arguments: <objective>, status, cancel" },
] as const;

export function builtinCommands(harness: HarnessId): HarnessCommand[] {
  return UNIVERSAL_COMMANDS.map((command) => ({ harness, ...command, invocation: `/${command.name} `, kind: "builtin" }));
}

export async function listHarnessCommands(projectPath: string, harness: HarnessId, options: CommandDiscoveryOptions = {}): Promise<HarnessCommand[]> {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === harness);
  if (!adapter) throw new Error(`Unknown harness: ${harness}`);
  const discovered = adapter.resources ? await (await adapter.resources()).commands(projectPath, options) : [];
  const unavailable = new Set(unavailableSkillNames(options.skillScope ?? skillScopeContext(options.resourcePaths)));
  const commands = [...builtinCommands(harness), ...discovered].filter((command) => command.kind !== "skill" || !unavailable.has(command.name.replace(/^skill:/, "")));
  return [...new Map(commands.map((command) => [command.invocation, command])).values()].sort((left, right) => left.name.localeCompare(right.name));
}
