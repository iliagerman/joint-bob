import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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

/** Kiro steering a project marks for every conversation; files included only on a file match or by hand stay out. */
export function projectSteeringFiles(cwd: string): string[] {
  const folder = path.join(cwd, ".kiro/steering");
  if (!existsSync(folder) || !lstatSync(folder).isDirectory()) return [];
  return readdirSync(folder).filter((name) => name.endsWith(".md")).sort().map((name) => path.join(folder, name)).filter((file) => {
    if (!statSync(file).isFile()) return false;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
    if (!frontmatter) return true;
    let fields: unknown;
    try { fields = parseYaml(frontmatter[1]); } catch { return false; }
    const inclusion = fields && typeof fields === "object" ? (fields as { inclusion?: unknown }).inclusion : undefined;
    return inclusion === undefined || inclusion === "always";
  });
}
