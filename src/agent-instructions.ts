import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentResourcePaths } from "./agent-resources.js";
import { memoryInstructionFile } from "./agent-memory.js";
import { projectInstructionSources, type ProjectInstructionSource } from "./project-folder-resources.js";
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

/** Claude follows its instruction files' `@path` lines five deep. */
const IMPORT_DEPTH = 5;

/**
 * Expands `@path` lines as Claude does, so every harness reads the imported text: a path resolves
 * from the importing file's folder, then from the project root; only Markdown is imported, nothing
 * inside a code block, and a file already on the chain is left as its line. Every file read is
 * added to `included`, so one imported elsewhere is not read a second time as its own source.
 */
function expandImports(content: string, file: string, root: string, included: Set<string>, chain: string[] = [realpathSync(file)]): string {
  let fenced = false;
  return content.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const target = fenced || chain.length > IMPORT_DEPTH ? undefined : /^@(\S+\.md)$/.exec(line.trim())?.[1];
    if (!target) return line;
    const candidates = target.startsWith("~/") ? [path.join(os.homedir(), target.slice(2))] : [path.resolve(path.dirname(file), target), path.resolve(root, target)];
    const found = candidates.find(isFile);
    if (!found || chain.includes(realpathSync(found))) return line;
    included.add(realpathSync(found));
    return expandImports(readFileSync(found, "utf8").trimEnd(), found, root, included, [...chain, realpathSync(found)]);
  }).join("\n");
}

/** Rules meant only for some files are named with their patterns rather than read in full, as Claude loads them on demand. */
function scopedRules(cwd: string, sources: ProjectInstructionSource[]): InstructionFile {
  const lines = sources.map((source) => `- \`${source.relative}\` applies to files matching ${source.patterns!.map((pattern) => `\`${pattern}\``).join(", ")}: read it before working on such files.`);
  return { path: path.join(cwd, ".claude/rules"), label: "Project rules for specific files", content: lines.join("\n") };
}

/**
 * Everything an agent is told before the conversation, in the order it reads it: the global
 * AGENTS.md, the app's instructions and rules, then the project's own instruction files from the
 * folder the agent runs in. Under strict isolation the harnesses discover no instruction file
 * themselves, so a project's AGENTS.md, CLAUDE.md files, `.claude/rules` and Kiro steering reach
 * every harness only from here.
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
    const sources = projectInstructionSources(options.cwd);
    const included = new Set<string>();
    for (const source of sources.filter((candidate) => !candidate.patterns)) {
      if (included.has(realpathSync(source.file))) continue;
      included.add(realpathSync(source.file));
      files.push({ path: source.file, label: `Project instructions (${source.relative})`, content: expandImports(readFileSync(source.file, "utf8"), source.file, options.cwd, included) });
    }
    const scoped = sources.filter((candidate) => candidate.patterns);
    if (scoped.length) files.push(scopedRules(options.cwd, scoped));
  }
  // Claude reads the same folder through its own auto-memory, pointed there by the app.
  if (options.memory && harness !== "claude" && getSettings().strictResourceIsolation) files.push(memoryInstructionFile(options.memory));
  // A file left empty (an AGENTS.md created and not yet written) adds nothing but its heading.
  return files.filter((file) => file.content.trim());
}

/** Claude and Kiro take one document; each part keeps a heading that says where it came from. */
export function renderInstructions(files: InstructionFile[]): string {
  return files.map((file) => `# ${file.label}\n\n${file.content.trimEnd()}\n`).join("\n");
}
