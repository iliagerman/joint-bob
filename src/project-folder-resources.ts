import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getSettings, type ScopedResourcePaths } from "./settings.js";

/**
 * Agent resources a project folder carries for the harnesses to discover on their own. Under
 * strict isolation no harness discovers anything itself: the app reads these folders and passes
 * the same set to Claude, Pi and Kiro, so a project's skills work in every harness.
 */
export const PROJECT_SKILL_FOLDERS = [".claude/skills", ".agents/skills", ".pi/skills", ".kiro/skills"];
export const PROJECT_PROMPT_FOLDERS = [".claude/commands", ".pi/prompts", ".kiro/prompts"];
export const PROJECT_AGENT_FOLDERS = [".claude/agents"];
/** The first one present is the project's instructions; CLAUDE.md serves projects that never added an AGENTS.md. */
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export interface ProjectFolderResources { skills: string[]; prompts: string[]; agents: string[] }

/** Existing folders only, once each and by their real path: `.claude/skills` is often a link to
    `.agents/skills`, and the plugin builder does not follow a linked root. */
function existingFolders(cwd: string, relatives: string[]): string[] {
  const folders: string[] = [];
  for (const relative of relatives) {
    const folder = path.join(cwd, relative);
    try {
      if (!statSync(folder).isDirectory()) continue;
      const real = realpathSync(folder);
      if (!folders.includes(real)) folders.push(real);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return folders;
}

export function projectFolderResources(cwd: string): ProjectFolderResources {
  return {
    skills: existingFolders(cwd, PROJECT_SKILL_FOLDERS),
    prompts: existingFolders(cwd, PROJECT_PROMPT_FOLDERS),
    agents: existingFolders(cwd, PROJECT_AGENT_FOLDERS),
  };
}

/** Adds the project folder's skills and prompts ahead of the configured project paths, which win a name clash.
    Without strict isolation the harnesses still discover these themselves, so nothing is added. */
export function withProjectFolderResources<T extends ScopedResourcePaths>(configured: T, cwd: string | undefined): T {
  if (!cwd || !getSettings().strictResourceIsolation) return configured;
  const folder = projectFolderResources(cwd);
  if (!folder.skills.length && !folder.prompts.length) return configured;
  return {
    ...configured,
    project: {
      ...configured.project,
      skills: [...new Set([...folder.skills, ...configured.project.skills])],
      prompts: [...new Set([...folder.prompts, ...configured.project.prompts])],
    },
  };
}

/** The project's instruction file at the root of the folder the agent runs in, never a nested or parent one. */
export function projectInstructionFile(cwd: string): string | undefined {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const file = path.join(cwd, name);
    try {
      if (statSync(file).isFile()) return file;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  return undefined;
}

/** Root instruction files a harness would read in the folder it runs in: Pi and Kiro take AGENTS.md,
    Claude its CLAUDE.md files, including the personal, untracked CLAUDE.local.md. */
const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];

/** A project instruction file the app passes in; `patterns` marks one meant only for matching files. */
export interface ProjectInstructionSource { file: string; relative: string; patterns?: string[] }

function frontmatter(file: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
  if (!match) return undefined;
  try {
    const fields: unknown = parseYaml(match[1]);
    return fields && typeof fields === "object" && !Array.isArray(fields) ? fields as Record<string, unknown> : {};
  } catch { return {}; }
}

function patternList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function markdownTree(folder: string): string[] {
  let names: string[];
  try { if (!statSync(folder).isDirectory()) return []; names = readdirSync(folder).sort(); } catch { return []; }
  return names.flatMap((name) => {
    const entry = path.join(folder, name);
    try {
      if (statSync(entry).isDirectory()) return markdownTree(entry);
      return name.endsWith(".md") && statSync(entry).isFile() ? [entry] : [];
    } catch { return []; }
  });
}

/**
 * Every instruction file the project folder carries, once each, in the order the harnesses read
 * them natively: root files, then `.claude/rules` and Kiro steering. A rule limited by `paths`
 * (or steering limited to a file match) keeps its patterns; steering included only by hand stays out.
 */
export function projectInstructionSources(cwd: string): ProjectInstructionSource[] {
  const candidates: ProjectInstructionSource[] = [];
  for (const relative of ROOT_INSTRUCTION_FILES) {
    const file = path.join(cwd, relative);
    try { if (statSync(file).isFile()) candidates.push({ file, relative }); } catch { /* Not in this project. */ }
  }
  for (const file of markdownTree(path.join(cwd, ".claude/rules"))) {
    const patterns = patternList(frontmatter(file)?.paths);
    candidates.push({ file, relative: path.relative(cwd, file), ...(patterns.length ? { patterns } : {}) });
  }
  for (const file of markdownTree(path.join(cwd, ".kiro/steering")).filter((file) => path.dirname(file) === path.join(cwd, ".kiro/steering"))) {
    const fields = frontmatter(file);
    const inclusion = fields?.inclusion ?? "always";
    if (inclusion === "always") candidates.push({ file, relative: path.relative(cwd, file) });
    else if (inclusion === "fileMatch" && patternList(fields?.fileMatchPattern).length) candidates.push({ file, relative: path.relative(cwd, file), patterns: patternList(fields?.fileMatchPattern) });
  }
  // AGENTS.md is often a link to CLAUDE.md, or a copy of it.
  const seen = new Set<string>();
  return candidates.filter(({ file }) => {
    const keys = [`file:${realpathSync(file)}`, `text:${readFileSync(file, "utf8").trim()}`];
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.add(key);
    return true;
  });
}
