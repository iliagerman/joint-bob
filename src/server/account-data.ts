import type { DatabaseSync } from "node:sqlite";
import { asNode } from "../account-context.js";
import { ACCOUNT_KEY_COLUMNS } from "../account-keys.js";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { ensureClusterAccountSchema } from "../cluster-accounts.js";
import { ensureOwnershipSchema, ownedResourceIds, type OwnedKind } from "../ownership.js";
import { deleteRoutingConfig, routingConfigDatabase } from "../routing-configs.js";
import { deleteSecretAccount } from "../secrets.js";
import { setting, settingsDatabase } from "../settings-store.js";
import { deletePersonalSettings, nodeSettings, personalSettings, PERSONAL_SETTING_KEYS, updatePersonalSettings } from "../settings.js";
import { removeProject } from "../store.js";

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** Everything a person had on this node goes with their account. Nothing is handed to the
    admin: that would breach the wall. */
export async function deleteAccountData(accountId: string): Promise<void> {
  const db = await clusterV2Database();
  ensureOwnershipSchema(db);
  const local = await getClusterNode();
  await asNode(async () => {
    for (const projectId of ownedResourceIds("project", accountId, db)) await removeProject(projectId);
    for (const secretId of ownedResourceIds("secret", accountId, db)) await deleteSecretAccount(secretId).catch(() => undefined);
    const routing = routingConfigDatabase();
    for (const configId of ownedResourceIds("routing_config", accountId, db)) { try { deleteRoutingConfig(routing, local.id, configId); } catch { /* already gone */ } }
    for (const workspaceId of ownedResourceIds("workspace", accountId, db)) {
      if (tableExists(db, "secret_assignments")) db.prepare("DELETE FROM secret_assignments WHERE scope_type = 'workspace' AND scope_id = ?").run(workspaceId);
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    }
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of ACCOUNT_KEY_COLUMNS) {
      if (!tableExists(db, table)) continue;
      db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(accountId);
    }
    for (const table of ["routing_config_account_selection", "quick_note_account_queue"]) if (tableExists(db, table)) db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
    db.prepare("DELETE FROM node_settings WHERE key = ?").run(`ntfy.services.${accountId}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  deletePersonalSettings(accountId);
}

/** Where each kind's ids live, so the old admin's implicit ownership can be written down. */
const KIND_IDS: Partial<Record<OwnedKind, string>> = {
  project: "SELECT p.id FROM projects p WHERE NOT EXISTS (SELECT 1 FROM sharing_resource_owners o WHERE o.kind = 'project' AND o.resource_id = p.id AND o.owner_node_id <> (SELECT id FROM cluster_node WHERE singleton = 1))",
  workspace: "SELECT id FROM workspaces",
  secret: "SELECT id FROM secret_accounts WHERE project_id IS NULL AND (origin_node_id = '' OR origin_node_id = (SELECT id FROM cluster_node WHERE singleton = 1))",
  routing_config: "SELECT id FROM routing_configs WHERE owner_node_id = (SELECT id FROM cluster_node WHERE singleton = 1)",
};

/**
 * Before the admin role moves, everything the old admin owned without an owner row becomes
 * explicitly theirs, and the node's own copies of personal settings, ntfy servers, routing
 * selection and quick-note queue move to them, so nothing changes hands with the role.
 */
export function materializeAdminOwnership(db: DatabaseSync, oldAdmin: string, newAdmin: string): void {
  ensureOwnershipSchema(db);
  ensureClusterAccountSchema(db);
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT OR IGNORE INTO resource_account_owners (kind, resource_id, account_id, created_at) VALUES (?, ?, ?, ?)");
  for (const [kind, query] of Object.entries(KIND_IDS) as Array<[OwnedKind, string]>) {
    const table = kind === "project" ? "projects" : kind === "workspace" ? "workspaces" : kind === "secret" ? "secret_accounts" : "routing_configs";
    if (!tableExists(db, table)) continue;
    if (kind === "project" && !tableExists(db, "sharing_resource_owners")) {
      for (const row of db.prepare("SELECT id FROM projects").all() as unknown as Array<{ id: string }>) insert.run(kind, row.id, oldAdmin, now);
      continue;
    }
    for (const row of db.prepare(query).all() as unknown as Array<{ id: string }>) insert.run(kind, row.id, oldAdmin, now);
  }
  // The new admin's own resources become the node's: their rows go.
  db.prepare("DELETE FROM resource_account_owners WHERE account_id = ?").run(newAdmin);
  if (tableExists(db, "sharing_memberships")) {
    const clusters = db.prepare("SELECT m.cluster_id FROM sharing_memberships m JOIN cluster_node n ON n.id = m.node_id AND n.singleton = 1").all() as unknown as Array<{ cluster_id: string }>;
    const member = db.prepare("INSERT OR IGNORE INTO cluster_local_members (cluster_id, account_id, joined_at) VALUES (?, ?, ?)");
    for (const { cluster_id } of clusters) {
      if (!db.prepare("SELECT 1 FROM cluster_local_members WHERE cluster_id = ?").get(cluster_id)) member.run(cluster_id, oldAdmin, now);
    }
  }
  // Personal settings: the node's values were the old admin's; the new admin's become the node's.
  const oldValues = Object.fromEntries(PERSONAL_SETTING_KEYS.map((key) => [key, nodeSettings()[key]]));
  const newValues = personalSettings({ accountId: newAdmin, username: "", role: "member", isRemoteLogin: false, homeNodeId: null });
  updatePersonalSettings(oldValues, { accountId: oldAdmin, username: "", role: "member", isRemoteLogin: false, homeNodeId: null });
  updatePersonalSettings(newValues, undefined);
  deletePersonalSettings(newAdmin);
  swapNodeKey("ntfy.services", oldAdmin, newAdmin);
  swapSingleton(db, "routing_config_selection", "routing_config_account_selection", "config_id", oldAdmin, newAdmin);
}

function swapNodeKey(key: string, oldAdmin: string, newAdmin: string): void {
  const db = settingsDatabase();
  const nodeValue = setting(key);
  const newAdminValue = setting(`${key}.${newAdmin}`);
  if (nodeValue) db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) SELECT ?, value, is_secret, updated_at FROM node_settings WHERE key = ? ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret").run(`${key}.${oldAdmin}`, key);
  db.prepare("DELETE FROM node_settings WHERE key = ?").run(key);
  if (newAdminValue) {
    db.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) SELECT ?, value, is_secret, updated_at FROM node_settings WHERE key = ? ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret").run(key, `${key}.${newAdmin}`);
    db.prepare("DELETE FROM node_settings WHERE key = ?").run(`${key}.${newAdmin}`);
  }
}

function swapSingleton(db: DatabaseSync, singleton: string, perAccount: string, column: string, oldAdmin: string, newAdmin: string): void {
  if (!tableExists(db, singleton) || !tableExists(db, perAccount)) return;
  const nodeValue = (db.prepare(`SELECT ${column} AS value FROM ${singleton} WHERE singleton = 1`).get() as { value: string } | undefined)?.value;
  const mine = (db.prepare(`SELECT ${column} AS value FROM ${perAccount} WHERE account_id = ?`).get(newAdmin) as { value: string } | undefined)?.value;
  if (nodeValue !== undefined) db.prepare(`INSERT INTO ${perAccount} (account_id, ${column}) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET ${column} = excluded.${column}`).run(oldAdmin, nodeValue);
  db.prepare(`UPDATE ${singleton} SET ${column} = ? WHERE singleton = 1`).run(mine ?? "");
  db.prepare(`DELETE FROM ${perAccount} WHERE account_id = ?`).run(newAdmin);
}
