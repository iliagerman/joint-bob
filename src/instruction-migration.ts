import { copyFileSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalInstructionsPath } from "./agent-instructions.js";
import { agentResourcePaths, type AgentResourcePaths } from "./agent-resources.js";
import { resolveDataDirectory } from "./data-directory.js";
import { INSTRUCTIONS_LIMIT, instructionsVersion, readOptionalText, saveGlobalInstructions } from "./global-instructions.js";
import { getSettings } from "./settings.js";

/**
 * Before the global AGENTS.md, a node imported each harness's own instruction files (Claude's
 * CLAUDE.md and rules, Pi's AGENTS.md) into folders only that harness read, so agents on one
 * node followed different rules. Every agent now reads the same instructions, so those files
 * move into the global AGENTS.md, where they can be seen and edited, and their originals are kept.
 */
const LEGACY_FOLDERS: Array<{ folder: "claudeInstructions" | "piInstructions" | "commonInstructions"; reader?: string }> = [
  { folder: "claudeInstructions", reader: "Claude" },
  { folder: "piInstructions", reader: "Pi" },
  { folder: "commonInstructions" },
];

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function markdownFiles(folder: string): string[] {
  let entries: string[];
  try { entries = readdirSync(folder).sort(); } catch { return []; }
  return entries.flatMap((name) => {
    const entry = path.join(folder, name);
    try {
      if (lstatSync(entry).isDirectory()) return markdownFiles(entry);
      return name.endsWith(".md") && statSync(entry).isFile() ? [entry] : [];
    } catch { return []; } // A broken link carries nothing to keep.
  });
}

/** The import replaced native files with links into the managed copies; each gets its own copy
    back first, so Claude or Pi run outside the app keep the instructions they had. */
function detachNativeLinks(managedRoot: string): void {
  const { claude, pi } = getSettings();
  const folders = [path.join(claude.configPath, "rules"), path.join(os.homedir(), ".agents", "rules")];
  const candidates = [path.join(claude.configPath, "CLAUDE.md"), path.join(pi.configPath, "AGENTS.md"), ...folders];
  for (const folder of folders) {
    try { if (!lstatSync(folder).isSymbolicLink()) candidates.push(...readdirSync(folder).map((name) => path.join(folder, name))); }
    catch { /* No such folder. */ }
  }
  for (const candidate of candidates) {
    let target: string;
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      target = path.resolve(path.dirname(candidate), readlinkSync(candidate));
      if (!inside(target, managedRoot)) continue;
      const copy = `${candidate}.joint-bob-${process.pid}.tmp`;
      if (statSync(target).isDirectory()) cpSync(target, copy, { recursive: true, dereference: true });
      else copyFileSync(target, copy);
      unlinkSync(candidate);
      renameSync(copy, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Moves the files into the global AGENTS.md and the originals into a backup folder; returns how many moved. */
export function consolidateAgentInstructions(originNodeId: string, paths: AgentResourcePaths = agentResourcePaths()): number {
  if (!getSettings().strictResourceIsolation) return 0;
  const global = globalInstructionsPath(paths);
  const managedRoot = path.dirname(paths.commonInstructions);
  const files = LEGACY_FOLDERS.flatMap(({ folder, reader }) => markdownFiles(paths[folder])
    .filter((file) => file !== global)
    .map((file) => ({ file, heading: `${path.relative(managedRoot, file)}${reader ? ` (formerly read by ${reader} only)` : ""}` })));
  if (!files.length) return 0;
  detachNativeLinks(managedRoot);
  const current = readOptionalText(global);
  // A twin may already have sent the same text; it is added once.
  const additions = files.map((part) => ({ ...part, content: readFileSync(part.file, "utf8").trim() }))
    .filter((part) => part.content && !(current ?? "").includes(part.content));
  if (additions.length) {
    const merged = `${[current?.trimEnd(), ...additions.map((part) => `## ${part.heading}\n\n${part.content}`)].filter(Boolean).join("\n\n")}\n`;
    if (Buffer.byteLength(merged) > INSTRUCTIONS_LIMIT) {
      console.warn(`Agent instructions not moved into AGENTS.md: together they exceed ${INSTRUCTIONS_LIMIT} bytes`);
      return 0;
    }
    saveGlobalInstructions(merged, instructionsVersion(current), originNodeId);
  }
  const backup = path.join(resolveDataDirectory(), "instruction-backups", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const { file } of files) {
    const destination = path.join(backup, path.relative(managedRoot, file));
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(file, destination);
  }
  console.log(`Moved ${files.length} agent instruction file(s) into AGENTS.md; originals kept in ${backup}`);
  return files.length;
}
