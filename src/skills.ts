import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "./types.js";

export interface SkillSummary {
  harness: HarnessId;
  name: string;
  description: string;
  scope: "user" | "project";
}

export interface SkillRoots {
  piUser: string;
  claudeUser: string;
}

export function defaultSkillRoots(): SkillRoots {
  return {
    piUser: path.join(os.homedir(), ".pi", "agent", "skills"),
    claudeUser: path.join(os.homedir(), ".claude", "skills"),
  };
}

/** Reads the `name` and `description` keys out of a SKILL.md YAML frontmatter block. */
function parseFrontmatter(contents: string): { name?: string; description?: string } {
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return {};
  const fields: { name?: string; description?: string } = {};
  for (const line of lines.slice(1, closing)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") continue;
    fields[key] = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** The filesystem is a real boundary: an agent that has never been installed simply has no skills directory. */
async function readSkillDirectory(root: string, harness: HarnessId, scope: SkillSummary["scope"]): Promise<SkillSummary[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let contents: string;
    try {
      contents = await readFile(path.join(root, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const fields = parseFrontmatter(contents);
    skills.push({ harness, name: fields.name || entry.name, description: fields.description || "", scope });
  }
  return skills;
}

/**
 * Lists the skills both harnesses can run for a project. Pi and Claude use the
 * same `<dir>/<name>/SKILL.md` layout, so one reader covers both. A project-level
 * skill shadows a user-level skill of the same name for the same harness.
 */
export async function listSkills(projectPath: string, roots: SkillRoots = defaultSkillRoots()): Promise<SkillSummary[]> {
  const found = await Promise.all([
    readSkillDirectory(roots.piUser, "pi", "user"),
    readSkillDirectory(path.join(projectPath, ".pi", "skills"), "pi", "project"),
    readSkillDirectory(roots.claudeUser, "claude", "user"),
    readSkillDirectory(path.join(projectPath, ".claude", "skills"), "claude", "project"),
  ]);

  const byKey = new Map<string, SkillSummary>();
  for (const skill of found.flat()) {
    const key = `${skill.harness}:${skill.name}`;
    // Project scope is read last per harness, so it overwrites the user copy.
    if (skill.scope === "project" || !byKey.has(key)) byKey.set(key, skill);
  }

  return [...byKey.values()].sort((left, right) =>
    left.harness === right.harness ? left.name.localeCompare(right.name) : left.harness.localeCompare(right.harness),
  );
}
