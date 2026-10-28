import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const nameSchema = z.string().trim().min(1).max(80);
export const automationTagAssignmentSchema = z.object({
  managedTagIds: z.array(z.string().uuid()).max(20).default([]),
  manualTags: z.array(nameSchema).max(20).default([]),
}).strict().transform(({ managedTagIds, manualTags }) => ({
  managedTagIds: [...new Set(managedTagIds)],
  manualTags: manualTags.filter((name, index) => manualTags.findIndex(candidate => normalizeTagName(candidate) === normalizeTagName(name)) === index),
})).superRefine((value, context) => {
  if (value.managedTagIds.length + value.manualTags.length > 20) context.addIssue({ code: "custom", message: "Use no more than 20 tags" });
});
export type AutomationTagAssignment = z.infer<typeof automationTagAssignmentSchema>;
export const tagSnapshotSchema = z.object({ key: z.string().min(1).max(80), name: z.string().min(1).max(80), managedTagId: z.string().uuid().nullable() }).strict();
export type TagSnapshot = z.infer<typeof tagSnapshotSchema>
export interface AutomationTag { id: string; workspaceId: string; ownerNodeId: string; name: string; normalizedName: string; updatedAt: string; retired: boolean }

export function normalizeTagName(name: string): string { return name.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }

export function ensureAutomationTagSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS automation_tags (
    id TEXT PRIMARY KEY, owner_node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
    updated_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
    UNIQUE(owner_node_id, workspace_id, normalized_name));
    CREATE INDEX IF NOT EXISTS automation_tags_workspace ON automation_tags(owner_node_id, workspace_id, retired, name);`);
}

export function automationWorkspaceIdentity(db: DatabaseSync, localNodeId: string, workspaceId: string): { ownerNodeId: string; workspaceId: string } {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_v2_shared_workspaces'").get();
  const mapped = exists ? db.prepare("SELECT owner_node_id ownerNodeId,source_workspace_id workspaceId FROM cluster_v2_shared_workspaces WHERE workspace_id=? ORDER BY owner_node_id LIMIT 1").get(workspaceId) as { ownerNodeId: string; workspaceId: string } | undefined : undefined;
  return mapped ?? { ownerNodeId: localNodeId, workspaceId };
}

export const automationWorkspaceKey = (identity: { ownerNodeId: string; workspaceId: string }): string => `${identity.ownerNodeId}:${identity.workspaceId}`;

export function listAutomationTags(db: DatabaseSync, workspaceId: string, ownerNodeId = "local"): AutomationTag[] {
  ensureAutomationTagSchema(db);
  const rows = db.prepare("SELECT id,workspace_id workspaceId,owner_node_id ownerNodeId,name,normalized_name normalizedName,updated_at updatedAt,retired FROM automation_tags WHERE workspace_id=? AND owner_node_id=? ORDER BY normalized_name,id").all(workspaceId, ownerNodeId) as unknown as Array<Omit<AutomationTag, "retired"> & { retired: number }>;
  return rows.map(row => ({ ...row, retired: Boolean(row.retired) }));
}

export function saveAutomationTag(db: DatabaseSync, input: { workspaceId: string; name: string; ownerNodeId?: string }): AutomationTag {
  ensureAutomationTagSchema(db);
  const name = nameSchema.parse(input.name), normalizedName = normalizeTagName(name), ownerNodeId = input.ownerNodeId ?? "local";
  const count = (db.prepare("SELECT COUNT(*) AS count FROM automation_tags WHERE workspace_id=? AND owner_node_id=? AND retired=0").get(input.workspaceId, ownerNodeId) as { count: number }).count;
  if (count >= 500) throw new Error("A workspace can have at most 500 managed tags");
  const id = randomUUID(), updatedAt = new Date().toISOString();
  try { db.prepare("INSERT INTO automation_tags(id,owner_node_id,workspace_id,name,normalized_name,updated_at) VALUES(?,?,?,?,?,?)").run(id, ownerNodeId, input.workspaceId, name, normalizedName, updatedAt); }
  catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("A tag with that name already exists in this workspace");
    throw error;
  }
  return { id, workspaceId: input.workspaceId, ownerNodeId, name, normalizedName, updatedAt, retired: false };
}

export function renameAutomationTag(db: DatabaseSync, workspaceId: string, id: string, rawName: string, ownerNodeId = "local"): AutomationTag {
  ensureAutomationTagSchema(db);
  const name = nameSchema.parse(rawName), normalizedName = normalizeTagName(name), updatedAt = new Date().toISOString();
  try {
    const result = db.prepare("UPDATE automation_tags SET name=?,normalized_name=?,updated_at=? WHERE workspace_id=? AND owner_node_id=? AND id=? AND retired=0").run(name, normalizedName, updatedAt, workspaceId, ownerNodeId, id);
    if (!result.changes) throw new Error("Automation tag not found");
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("A tag with that name already exists in this workspace");
    throw error;
  }
  return listAutomationTags(db, workspaceId, ownerNodeId).find(tag => tag.id === id)!;
}

export function retireAutomationTag(db: DatabaseSync, workspaceId: string, id: string, ownerNodeId = "local"): void {
  ensureAutomationTagSchema(db);
  const result = db.prepare("UPDATE automation_tags SET retired=1,updated_at=? WHERE workspace_id=? AND owner_node_id=? AND id=? AND retired=0").run(new Date().toISOString(), workspaceId, ownerNodeId, id);
  if (!result.changes) throw new Error("Automation tag not found");
}

export function validateAutomationTagAssignments(db: DatabaseSync, workspaceId: string, raw: AutomationTagAssignment, ownerNodeId = "local"): void {
  ensureAutomationTagSchema(db);
  const assignments = automationTagAssignmentSchema.parse(raw);
  const managed = db.prepare("SELECT 1 FROM automation_tags WHERE workspace_id=? AND owner_node_id=? AND retired=0 AND id=?");
  for (const id of assignments.managedTagIds) if (!managed.get(workspaceId, ownerNodeId, id)) throw new Error("Managed automation tag is unavailable in this workspace");
}

export function snapshotAutomationTags(db: DatabaseSync, workspaceId: string, raw: AutomationTagAssignment, ownerNodeId = "local"): TagSnapshot[] {
  ensureAutomationTagSchema(db);
  const assignments = automationTagAssignmentSchema.parse(raw), tags: TagSnapshot[] = [];
  const managed = db.prepare("SELECT id,name,normalized_name normalizedName FROM automation_tags WHERE workspace_id=? AND owner_node_id=? AND retired=0 AND id=?");
  for (const id of assignments.managedTagIds) {
    const row = managed.get(workspaceId, ownerNodeId, id) as { id: string; name: string; normalizedName: string } | undefined;
    if (!row) continue;
    tags.push({ key: row.normalizedName, name: row.name, managedTagId: row.id });
  }
  for (const name of assignments.manualTags) tags.push({ key: normalizeTagName(name), name, managedTagId: null });
  return [...new Map(tags.map(tag => [tag.key, tag])).values()];
}
