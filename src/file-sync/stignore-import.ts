import type { DatabaseSync } from "node:sqlite";
import { listSettingsRecords, saveSettingsRecord } from "./control.js";
import { userRulesFromSyncthingIgnores } from "./ignore.js";
import { EMPTY_RULE_SETTINGS, type RuleSettings } from "./types.js";

/* A node's own Syncthing ignore lines (the ones Joint Bob did not write) become the project's replicated
   rules, so the engine skips on every node what Syncthing skips on any of them (FILE-SYNC-PLAN.md D11).
   They are node-local in Syncthing: on 2026-10-25 the Mac's Contigos folder ignored `.skill_data` (secrets)
   and `.tmp_*`, the homeserver's did not, and shadow mode counted those files as differences.
   Each node merges its lines once and records itself in importedFrom; if a concurrent record from a peer
   drops it from that list, the next run merges again, so the record converges to the union. */

export interface SyncthingRuleSource {
  /** Folder ids Syncthing has configured on this node; throws when Syncthing does not answer. */
  folders(): Promise<Set<string>>;
  /** The folder's .stignore lines as Syncthing reports them. */
  lines(folderId: string): Promise<string[]>;
}

export interface ImportResult { imported: string[]; unreachable: boolean }

/** `folderIds(projectId)` lists the project's three Syncthing folder ids (project, tickets, worktrees). */
export async function importSyncthingUserRules(db: DatabaseSync, local: string, projectIds: readonly string[], folderIds: (projectId: string) => string[], source: SyncthingRuleSource, now = new Date()): Promise<ImportResult> {
  const held = new Map(listSettingsRecords(db).map((record) => [record.key, record]));
  const pending = projectIds.filter((id) => !held.get(`project:${id}`)?.value.importedFrom.includes(local));
  if (!pending.length) return { imported: [], unreachable: false };
  let configured: Set<string>;
  // Nothing is marked imported while Syncthing is silent: its lines are read on the next start instead.
  try { configured = await source.folders(); } catch { return { imported: [], unreachable: true }; }
  const imported: string[] = [];
  for (const projectId of pending) {
    let lines: string[] = [];
    try {
      for (const folderId of folderIds(projectId)) if (configured.has(folderId)) lines.push(...userRulesFromSyncthingIgnores(await source.lines(folderId)));
    } catch { continue; }
    // No lines of its own: nothing to keep, so no record (it is read again at the next start, which is cheap).
    if (!lines.length) continue;
    const key = `project:${projectId}`;
    const current: RuleSettings = held.get(key)?.value ?? { ...EMPTY_RULE_SETTINGS };
    const userRules = [...new Set([...current.userRules, ...lines])];
    const value: RuleSettings = { ...current, userRules, importedFrom: [...new Set([...current.importedFrom, local])].sort() };
    if (saveSettingsRecord(db, { key, value, updatedAt: now.toISOString(), origin: local })) imported.push(projectId);
  }
  return { imported, unreachable: false };
}
