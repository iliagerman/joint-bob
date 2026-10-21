import type { ToolTarget } from "./types.js";

const TARGET_LIMIT = 160;
const TARGET_KEYS = ["path", "file_path", "command", "pattern", "url", "query"] as const;

/** Names what a tool call acted on, so a reader sees it on the collapsed chat row. A read of a
 * SKILL.md or a Skill call names the skill it loads, the same rule usage analysis counts as a read. */
export function toolTarget(toolName: string, args: unknown): ToolTarget | undefined {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (toolName === "Skill" && typeof input.skill === "string" && input.skill.trim()) return { skill: input.skill.trim() };
  const file = [input.path, input.file_path].find((value): value is string => typeof value === "string");
  if (file && /(?:^|\/)SKILL\.md$/.test(file) && /(?:^|\.)read$/i.test(toolName)) {
    const skill = file.split("/").at(-2);
    if (skill) return { skill };
  }
  const key = TARGET_KEYS.find((name) => typeof input[name] === "string" && input[name].trim());
  if (!key) return undefined;
  const target = (input[key] as string).replace(/\s+/g, " ").trim().slice(0, TARGET_LIMIT);
  return { target };
}
