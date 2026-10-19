import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveDataDirectory } from "./data-directory.js";
import { activationDecision } from "./resource-activation.js";
import { settingsDatabase } from "./settings-store.js";
import type { HarnessId } from "./types.js";

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

export interface SkillScopeContext { projectId?: string; conversationId?: string }

/** Resource path objects carry their scope through all harness adapters. */
export function skillScopeContext(configured?: object): SkillScopeContext {
  return (configured as { skillScope?: SkillScopeContext } | undefined)?.skillScope ?? {};
}

/** Names, not paths: a native or renamed symlink must not bypass a managed scope. */
export function unavailableSkillNames(context: SkillScopeContext = {}): string[] {
  const db = settingsDatabase();
  const unavailable = new Set<string>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='skill_scope_shares'").get()) {
    const rows = db.prepare("SELECT name,kind,target_id,project_id FROM skill_scope_shares").all() as Array<{ name: string; kind: string; target_id: string; project_id: string }>;
    const allowed = new Set<string>();
    for (const row of rows) {
      unavailable.add(row.name);
      if (!context.projectId) continue;
      if (row.kind === "project" && row.target_id === context.projectId
        || row.kind === "conversation" && row.project_id === context.projectId && row.target_id === context.conversationId
        || row.kind === "workspace" && db.prepare("SELECT 1 FROM projects WHERE id=? AND workspace_id=?").get(context.projectId, row.target_id)) allowed.add(row.name);
    }
    for (const name of allowed) unavailable.delete(name);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='revoked_scoped_skills'").get()) {
    for (const row of db.prepare("SELECT name FROM revoked_scoped_skills").all() as Array<{ name: string }>) unavailable.add(row.name);
  }
  for (const entry of readScopedSkillIndex()) {
    if (!context.projectId || !(entry.projectIds.includes(context.projectId) || entry.conversations.some((item) => item.projectId === context.projectId && item.conversationId === context.conversationId))) unavailable.add(entry.name);
  }
  return [...unavailable];
}

/** Skill roots granted to this project, or to this one conversation in it. */
export function scopedSkillRoots(projectId?: string, conversationId?: string, harness?: HarnessId): string[] {
  if (!projectId) return [];
  return readScopedSkillIndex()
    .filter((entry) => (entry.projectIds.includes(projectId)
      || Boolean(conversationId) && entry.conversations.some((item) => item.projectId === projectId && item.conversationId === conversationId))
      && (!harness || activationDecision("skill", entry.name, harness, true).enabled))
    .map((entry) => scopedSkillParent(entry.name));
}
