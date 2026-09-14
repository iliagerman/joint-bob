import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "./types.js";
import { agentResourcePaths } from "./agent-resources.js";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";

export interface SkillSummary {
  harness: HarnessId;
  name: string;
  description: string;
  scope: "user" | "project";
  invocation?: string;
}

export interface SkillRoots {
  user?: Partial<Record<HarnessId, string>>;
  piUser?: string;
  claudeUser?: string;
  shared: string;
  global?: string[];
  project?: string[];
  [legacyUserRoot: `${string}User`]: string | undefined;
}

export function defaultSkillRoots(): SkillRoots {
  const user: Partial<Record<HarnessId, string>> = {};
  const roots: SkillRoots = { user, shared: agentResourcePaths().sharedSkills, global: [], project: [] };
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const runtime = configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir()));
    const skillRoot = path.join(runtime.configPath, "skills");
    user[adapter.id] = skillRoot;
    roots[`${adapter.id}User`] = skillRoot;
  }
  return roots;
}

/** Reads the `name` and `description` keys out of a SKILL.md YAML frontmatter block. */
export function parseResourceFrontmatter(contents: string): { name?: string; description?: string } {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return {};
  const fields: { name?: string; description?: string } = {};
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") continue;
    let value = line.slice(separator + 1).trim();
    const block = /^([>|])([+-]?)$/.exec(value);
    if (block) {
      const collected: string[] = [];
      while (index + 1 < closing) {
        const next = lines[index + 1];
        if (next.trim() === "") { collected.push(""); index += 1; continue; }
        if (!/^[ \t]/.test(next)) break;
        collected.push(next.replace(/^[ \t]+/, ""));
        index += 1;
      }
      value = block[1] === ">" ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n").trimEnd();
    }
    fields[key] = value.replace(/^["']|["']$/g, "");
  }
  return fields;
}

function missingDirectory(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readSkill(root: string, name: string, harness: HarnessId, scope: SkillSummary["scope"]): Promise<SkillSummary | undefined> {
  try {
    const fields = parseResourceFrontmatter(await readFile(path.join(root, "SKILL.md"), "utf8"));
    return { harness, name: fields.name || name, description: fields.description || "", scope };
  } catch (error) {
    if (missingDirectory(error)) return undefined;
    throw error;
  }
}

export async function readSkillDirectory(root: string, harness: HarnessId, scope: SkillSummary["scope"]): Promise<SkillSummary[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (missingDirectory(error)) return []; throw error; }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skill = await readSkill(path.join(root, entry.name), entry.name, harness, scope);
    if (skill) skills.push(skill);
  }
  return skills;
}

export async function readConfiguredSkillPath(root: string, harness: HarnessId, scope: SkillSummary["scope"]): Promise<SkillSummary[]> {
  const skill = await readSkill(root, path.basename(root), harness, scope);
  return skill ? [skill] : readSkillDirectory(root, harness, scope);
}

export async function listSkills(projectPath: string, roots: SkillRoots = defaultSkillRoots()): Promise<SkillSummary[]> {
  const groups = await Promise.all(listDiscoveredHarnesses().flatMap(async (adapter) => {
    if (!adapter.resources) return [];
    return (await adapter.resources()).skills(projectPath, roots);
  }));
  const byKey = new Map<string, SkillSummary>();
  for (const skill of groups.flat()) byKey.set(`${skill.harness}:${skill.name}`, skill);
  return [...byKey.values()].sort((left, right) => left.harness.localeCompare(right.harness) || left.name.localeCompare(right.name));
}
