import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";

/** A received skill that loads only in some projects' or conversations' sessions on this node. */
export interface ScopedSkillEntry {
  name: string;
  projectIds: string[];
  conversations: Array<{ projectId: string; conversationId: string }>;
}

export function scopedSkillsRoot(): string { return path.join(resolveDataDirectory(), "scoped-skills"); }

/** Each skill gets its own parent folder, so every harness can load it as an ordinary skills root. */
export function scopedSkillParent(name: string): string { return path.join(scopedSkillsRoot(), name); }
export function scopedSkillDirectory(name: string): string { return path.join(scopedSkillParent(name), name); }

function indexFile(): string { return path.join(scopedSkillsRoot(), "index.json"); }

export function writeScopedSkillIndex(entries: ScopedSkillEntry[]): void {
  mkdirSync(scopedSkillsRoot(), { recursive: true });
  const temporary = `${indexFile()}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
  renameSync(temporary, indexFile());
}

export function readScopedSkillIndex(): ScopedSkillEntry[] {
  try { return JSON.parse(readFileSync(indexFile(), "utf8")) as ScopedSkillEntry[]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Skill roots granted to this project, or to this one conversation in it. */
export function scopedSkillRoots(projectId?: string, conversationId?: string): string[] {
  if (!projectId) return [];
  return readScopedSkillIndex()
    .filter((entry) => entry.projectIds.includes(projectId)
      || Boolean(conversationId) && entry.conversations.some((item) => item.projectId === projectId && item.conversationId === conversationId))
    .map((entry) => scopedSkillParent(entry.name));
}
