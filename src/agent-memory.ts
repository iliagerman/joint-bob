import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeHome, usingServiceRuntime } from "./account-runtime.js";
import { resolveDataDirectory } from "./data-directory.js";
import { getSettings } from "./settings.js";
import { claudeProjectDir } from "./harnesses/claude/paths.js";
import { isInternalSession } from "./internal-sessions.js";
import type { InstructionFile } from "./agent-instructions.js";

export const MEMORY_INDEX = "MEMORY.md";
/** As much of the index as Claude itself reads into a conversation. */
const INDEX_LINES = 200;

/**
 * One memory folder per project, owned by the app instead of a harness. Claude, Pi and Kiro all
 * read and write it, worktrees and tickets of the project share it, and it stays on this machine.
 */
export function projectMemoryDirectory(projectId: string): string {
  const name = /^[A-Za-z0-9_-]{1,200}$/.test(projectId) ? projectId : Buffer.from(projectId).toString("base64url");
  // An account's agents run as that account, which must be able to write the folder.
  const base = usingServiceRuntime() ? resolveDataDirectory() : path.join(runtimeHome(), ".joint-bob");
  return path.join(base, "memory", name);
}

/**
 * Creates the project's memory folder. The first time, it starts from the notes Claude kept for the
 * project folder in its own config, copied so that Claude in a terminal keeps its own.
 */
export function ensureProjectMemory(projectId: string, projectPath: string | undefined): string {
  const directory = projectMemoryDirectory(projectId);
  if (existsSync(directory) || !usingServiceRuntime()) return directory;
  const temporary = `${directory}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    const native = projectPath ? path.join(claudeProjectDir(projectPath, path.join(getSettings().claude.configPath, "projects")), "memory") : undefined;
    if (native && existsSync(native)) for (const name of readdirSync(native)) {
      const source = path.join(native, name);
      if (name.endsWith(".md") && statSync(source).isFile()) copyFileSync(source, path.join(temporary, name));
    }
    try { renameSync(temporary, directory); }
    catch (error) { if (!existsSync(directory)) throw error; }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return directory;
}

/** The memory folder a conversation's agent uses, ready before it starts. Background runs
    (summaries, reviews, label icons) get none: they must neither read nor write the project's notes. */
export async function prepareProjectMemory(projectId: string | undefined, sessionId: string | undefined): Promise<string | undefined> {
  if (!projectId || (sessionId && isInternalSession(sessionId))) return undefined;
  if (existsSync(projectMemoryDirectory(projectId))) return projectMemoryDirectory(projectId);
  // Loaded here, not at the top: the store reaches most of the app.
  const { getProject } = await import("./store.js");
  return ensureProjectMemory(projectId, (await getProject(projectId))?.path);
}

/** Where a conversation's agent keeps its notes, for the launches that cannot wait for {@link prepareProjectMemory}. */
export function conversationMemoryDirectory(projectId: string | undefined, sessionId: string | undefined): string | undefined {
  return !projectId || (sessionId && isInternalSession(sessionId)) ? undefined : projectMemoryDirectory(projectId);
}

/** Claude brings its own memory instructions; Pi and Kiro are told the same folder and conventions here. */
export function memoryInstructionFile(directory: string): InstructionFile {
  const indexFile = path.join(directory, MEMORY_INDEX);
  let index = "";
  try { index = readFileSync(indexFile, "utf8").split("\n").slice(0, INDEX_LINES).join("\n").trimEnd(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const content = [
    `This project has a memory folder at \`${directory}\`, shared by every agent that works on the project in Joint Bob.`,
    "",
    "- Read the index below, and open a note when it bears on the task.",
    "- Save only what a future conversation needs and cannot get from the code or git history: the user's preferences and corrections, decisions with their reasons, non-obvious facts about the project.",
    `- One fact per Markdown file, starting with frontmatter that has \`name\`, \`description\` and \`metadata.type\` (user, feedback, project or reference). Then add one line to \`${MEMORY_INDEX}\` in the folder: \`- [Title](file.md) — hook\`.`,
    "- Update a note instead of adding a second one about the same thing, and delete notes that turn out to be wrong.",
    "",
    index ? `${MEMORY_INDEX} now reads:\n\n${index}` : `${MEMORY_INDEX} is empty so far.`,
  ].join("\n");
  return { path: indexFile, label: "Memory", content };
}
