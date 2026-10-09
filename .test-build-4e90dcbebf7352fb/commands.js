import { listDiscoveredHarnesses } from "./harnesses/registry.js";
const UNIVERSAL_COMMANDS = [
  { name: "help", description: "Show available commands" },
  { name: "skills", description: "Browse installed skills" },
  { name: "model", description: "Choose the session model" },
  { name: "tools", description: "Configure available tools" },
  { name: "compact", description: "Compact conversation context" },
  { name: "bob-btw", description: "Open a temporary side conversation" },
  { name: "bob-goal", description: "Run an objective to completion; arguments: <objective>, status, cancel" }
];
function builtinCommands(harness) {
  return UNIVERSAL_COMMANDS.map((command) => ({ harness, ...command, invocation: `/${command.name} `, kind: "builtin" }));
}
async function listHarnessCommands(projectPath, harness, options = {}) {
  const adapter = listDiscoveredHarnesses().find((candidate) => candidate.id === harness);
  if (!adapter) throw new Error(`Unknown harness: ${harness}`);
  const discovered = adapter.resources ? await (await adapter.resources()).commands(projectPath, options) : [];
  const commands = [...builtinCommands(harness), ...discovered];
  return [...new Map(commands.map((command) => [command.invocation, command])).values()].sort((left, right) => left.name.localeCompare(right.name));
}
export {
  builtinCommands,
  listHarnessCommands
};
