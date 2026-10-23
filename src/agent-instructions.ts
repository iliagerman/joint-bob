import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentResourcePaths } from "./agent-resources.js";
import { memoryInstructionFile } from "./agent-memory.js";
import { projectInstructionFile, projectSteeringFiles } from "./project-folder-resources.js";
import { getSettings } from "./settings.js";

export interface InstructionFile { path: string; label: string; content: string }

/** One AGENTS.md for every project, kept with the common instructions so every harness reads it. */
export function globalInstructionsPath(paths: AgentResourcePaths): string {
  return path.join(paths.commonInstructions, "AGENTS.md");
}

function markdownFiles(source: string, found: string[]): void {
  if (!existsSync(source)) return;
  if (lstatSync(source).isDirectory()) for (const name of readdirSync(source).sort()) markdownFiles(path.join(source, name), found);
  else if (source.endsWith(".md")) found.push(source);
}

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

/**
 * Everything an agent is told before the conversation, in the order it reads it: the global
 * AGENTS.md, the app's instructions and rules, then the project's own instructions. Under strict
 * isolation the harnesses discover no instruction file themselves, so the project's AGENTS.md
 * (or its CLAUDE.md) and always-on steering arrive only from here.
 */
export function agentInstructionFiles(paths: AgentResourcePaths, harness: "pi" | "claude" | "kiro", options: { cwd?: string; rules?: string[]; memory?: string } = {}): InstructionFile[] {
  const read = (file: string, label: string): InstructionFile => ({ path: file, label, content: readFileSync(file, "utf8") });
  const global = globalInstructionsPath(paths);
  const files = isFile(global) ? [read(global, "Global instructions (AGENTS.md)")] : [];
  const app: string[] = [];
  markdownFiles(paths.commonInstructions, app);
  if (harness === "claude") markdownFiles(paths.claudeInstructions, app);
  if (harness === "pi") markdownFiles(paths.piInstructions, app);
  for (const rule of options.rules ?? []) markdownFiles(rule, app);
  for (const file of [...new Set(app)].filter((file) => file !== global).sort()) {
    const relative = path.relative(paths.commonInstructions, file);
    files.push(read(file, relative.startsWith("..") ? path.basename(file) : relative));
  }
  if (options.cwd && getSettings().strictResourceIsolation) {
    const project = projectInstructionFile(options.cwd);
    if (project) files.push(read(project, `Project instructions (${path.basename(project)})`));
    for (const steering of projectSteeringFiles(options.cwd)) files.push(read(steering, `Project steering (${path.basename(steering)})`));
  }
  // Claude reads the same folder through its own auto-memory, pointed there by the app.
  if (options.memory && harness !== "claude" && getSettings().strictResourceIsolation) files.push(memoryInstructionFile(options.memory));
  return files;
}

/** Claude and Kiro take one document; each part keeps a heading that says where it came from. */
export function renderInstructions(files: InstructionFile[]): string {
  return files.map((file) => `# ${file.label}\n\n${file.content.trimEnd()}\n`).join("\n");
}
