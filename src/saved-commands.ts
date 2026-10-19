import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getSharingCluster, listSharingClusterMembers, listSharingMemberships } from "./cluster-sharing-policy.js";

export const commandPresetSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(10_000) }).strict();
export type CommandPreset = z.infer<typeof commandPresetSchema>;
export const commandSelectionSchema = z.object({
  clusterIds: z.array(z.string().uuid()).max(100).default([]),
  nodeIds: z.array(z.string().uuid()).max(100).default([]),
  workspaceIds: z.array(z.string().min(1).max(300)).max(100).default([]),
  projectIds: z.array(z.string().min(1).max(300)).max(500).default([]),
  conversations: z.array(z.object({ projectId: z.string().min(1).max(300), conversationId: z.string().min(1).max(300) }).strict()).max(500).default([]),
}).strict();
export type CommandSelection = z.infer<typeof commandSelectionSchema>;
export const emptyCommandSelection = (): CommandSelection => ({ clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [], conversations: [] });

/** Old clients omit IDs. Match unchanged names/prompts, never reuse another row's ID. */
export function identifyCommandPresets(presets: CommandPreset[], previous: CommandPreset[] = []): Array<CommandPreset & { id: string }> {
  const used = new Set(presets.flatMap((p) => p.id ? [p.id] : []));
  if (used.size !== presets.filter((p) => p.id).length) throw new Error("Duplicate command IDs");
  return presets.map((preset) => {
    if (preset.id) return { ...preset, id: preset.id };
    const prior = previous.find((p) => p.id && !used.has(p.id) && p.name === preset.name)
      ?? previous.find((p) => p.id && !used.has(p.id) && p.prompt === preset.prompt);
    const id = prior?.id ?? randomUUID();
    used.add(id);
    return { ...preset, id };
  });
}
export function commandId(node: string, account: string, preset: string): string { return `${node}/${account}/${preset}`; }

export function ensureCommandSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS command_policies (
    account_id TEXT NOT NULL,preset_id TEXT NOT NULL,node_settings INTEGER NOT NULL,selection TEXT NOT NULL,incarnations TEXT NOT NULL,
    PRIMARY KEY(account_id,preset_id));
    CREATE TABLE IF NOT EXISTS command_recency (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,project_id TEXT NOT NULL,command_id TEXT NOT NULL,
    UNIQUE(account_id,project_id,command_id));`);
}
export interface CommandPolicy { accountId: string; presetId: string; nodeSettings: boolean; selection: CommandSelection; incarnations: Array<{ clusterId: string; owner: number; nodeId?: string; receiver?: number }> }
export function commandPolicies(db: DatabaseSync): CommandPolicy[] {
  ensureCommandSchema(db);
  return (db.prepare("SELECT * FROM command_policies").all() as Array<{account_id:string;preset_id:string;node_settings:number;selection:string;incarnations:string}>).map((r) => ({ accountId: r.account_id, presetId: r.preset_id, nodeSettings: Boolean(r.node_settings), selection: JSON.parse(r.selection), incarnations: JSON.parse(r.incarnations) }));
}
export function setCommandPolicy(db: DatabaseSync, owner: string, account: string, preset: string, nodeSettings: boolean, selection: CommandSelection): CommandPolicy {
  ensureCommandSchema(db);
  const memberships = listSharingMemberships(db, owner).filter((m) => !getSharingCluster(db, m.clusterId).closed);
  const incarnations: CommandPolicy["incarnations"] = [];
  for (const clusterId of selection.clusterIds) {
    const membership = memberships.find((m) => m.clusterId === clusterId);
    if (!membership) throw new Error("Cluster is not available");
    incarnations.push({ clusterId, owner: membership.joinSequence });
  }
  for (const nodeId of selection.nodeIds) {
    const membership = memberships.find((m) => listSharingClusterMembers(db, m.clusterId).some((n) => n.nodeId === nodeId));
    if (!membership || nodeId === owner) throw new Error("Node is not available");
    const receiver = listSharingClusterMembers(db, membership.clusterId).find((n) => n.nodeId === nodeId)!;
    incarnations.push({ clusterId: membership.clusterId, owner: membership.joinSequence, nodeId, receiver: receiver.joinSequence });
  }
  // Scoped grants are also tied to the owner's current memberships, never a later rejoin.
  for (const m of memberships) if (!incarnations.some((i) => i.clusterId === m.clusterId && !i.nodeId)) incarnations.push({ clusterId: m.clusterId, owner: m.joinSequence });
  db.prepare("INSERT OR REPLACE INTO command_policies VALUES(?,?,?,?,?)").run(account, preset, Number(nodeSettings), JSON.stringify(selection), JSON.stringify(incarnations));
  return { accountId: account, presetId: preset, nodeSettings, selection, incarnations };
}
export function commandPeerGrant(db: DatabaseSync, owner: string, receiver: string, policy: CommandPolicy): { common: boolean; global: boolean; clusterIds: string[] } {
  const memberships = listSharingMemberships(db, owner);
  const valid = policy.incarnations.filter((i) => memberships.some((m) => m.clusterId === i.clusterId && m.joinSequence === i.owner)
    && !getSharingCluster(db, i.clusterId).closed
    && listSharingClusterMembers(db, i.clusterId).some((m) => m.nodeId === receiver && (!i.nodeId || i.nodeId === receiver && m.joinSequence === i.receiver)));
  const broad = valid.filter((i) => i.nodeId === receiver || policy.selection.clusterIds.includes(i.clusterId));
  return { common: valid.length > 0, global: broad.length > 0, clusterIds: [...new Set((broad.length ? broad : valid).map((i) => i.clusterId))] };
}
export function commandInScope(selection: Pick<CommandSelection, "projectIds" | "conversations">, projectId: string, conversationId?: string): boolean {
  return selection.projectIds.includes(projectId) || selection.conversations.some((c) => c.projectId === projectId && c.conversationId === conversationId);
}
export function recordCommandUse(db: DatabaseSync, account: string, project: string, id: string): void {
  ensureCommandSchema(db);
  db.exec("SAVEPOINT command_use");
  try {
    db.prepare("DELETE FROM command_recency WHERE account_id=? AND project_id=? AND command_id=?").run(account, project, id);
    db.prepare("INSERT INTO command_recency(account_id,project_id,command_id) VALUES(?,?,?)").run(account, project, id);
    db.prepare("DELETE FROM command_recency WHERE account_id=? AND project_id=? AND sequence NOT IN (SELECT sequence FROM command_recency WHERE account_id=? AND project_id=? ORDER BY sequence DESC LIMIT 5)").run(account, project, account, project);
    db.exec("RELEASE command_use");
  } catch (error) { db.exec("ROLLBACK TO command_use; RELEASE command_use"); throw error; }
}
export function recentCommandIds(db: DatabaseSync, account: string, project: string): string[] {
  ensureCommandSchema(db);
  return (db.prepare("SELECT command_id FROM command_recency WHERE account_id=? AND project_id=? ORDER BY sequence DESC LIMIT 5").all(account, project) as Array<{command_id:string}>).map((r) => r.command_id);
}
