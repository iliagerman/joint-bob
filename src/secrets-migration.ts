import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decryptSecretValue, encryptSecretValue, ensureSecretSchema, GITHUB_TOKEN_VARIABLE } from "./secrets.js";

/** One marker row per converted source, following the per-module convention every other
    schema change in this repository uses. There is no central migration runner. */
const MARKER = "github-groups-v1";

interface GitHubAccountRow { account: string; token: string; label: string; is_default: number }
interface ProjectAuthRow { project_id: string; account: string; token: string | null }

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((entry) => entry.name === column);
}

/** Attachments are keyed by project id, so an alias merge must move them with the rest of
    the project's state or the merged project silently loses its credentials. */
export function rekeySecretAssignments(db: DatabaseSync, aliasId: string, projectId: string): void {
  if (!tableExists(db, "secret_assignments")) return;
  // The canonical project keeps whatever it already had; the alias's rows join it.
  db.prepare("INSERT OR IGNORE INTO secret_assignments (scope_type, scope_id, account_id) SELECT 'project', ?, account_id FROM secret_assignments WHERE scope_type = 'project' AND scope_id = ?").run(projectId, aliasId);
  db.prepare("DELETE FROM secret_assignments WHERE scope_type = 'project' AND scope_id = ?").run(aliasId);
}

function createGitHubAccount(db: DatabaseSync, label: string, token: string, now: string): string {
  const id = randomUUID();
  const variables = JSON.stringify([{ name: GITHUB_TOKEN_VARIABLE, kind: "value", value: token }]);
  db.prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, origin_node_id, created_at, updated_at) VALUES (?, ?, 'github', ?, 0, '', ?, ?)")
    .run(id, label.slice(0, 64), encryptSecretValue(variables), now, now);
  return id;
}

function attach(db: DatabaseSync, scopeType: "workspace" | "project", scopeId: string, accountId: string): void {
  db.prepare("INSERT OR IGNORE INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)").run(scopeType, scopeId, accountId);
}

/** True when the workspace already has an attached account declaring the GitHub token
    variable, so the default group's account is not added on top of it (FR6.6). */
function workspaceResolvesToken(db: DatabaseSync, workspaceId: string): boolean {
  const rows = db.prepare("SELECT a.variables_encrypted FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = 'workspace' AND s.scope_id = ?").all(workspaceId) as unknown as Array<{ variables_encrypted: string }>;
  return rows.some((row) => {
    const variables = JSON.parse(decryptSecretValue(row.variables_encrypted)) as Array<{ name: string }>;
    return variables.some((variable) => variable.name === GITHUB_TOKEN_VARIABLE);
  });
}

function canonicalProjectId(db: DatabaseSync, projectId: string): string | undefined {
  if (db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return projectId;
  if (!tableExists(db, "project_aliases")) return undefined;
  const alias = db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId) as { project_id: string } | undefined;
  if (!alias) return undefined;
  return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(alias.project_id) ? alias.project_id : undefined;
}

/**
 * Converts the GitHub credential groups into ordinary secret accounts, preserving the token
 * every project resolves today. Runs once per node, is idempotent, and must be called while
 * the `github_*` tables and `workspaces.github_group` still exist.
 */
export function ensureWorkspaceSecretsMigration(db: DatabaseSync): void {
  ensureSecretSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS secrets_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);");
  if (db.prepare("SELECT 1 FROM secrets_migrations WHERE source = ?").get(MARKER)) return;
  if (!tableExists(db, "github_accounts")) {
    // Nothing to convert on a node that never had credential groups; the marker still lands
    // so a later restart does not re-scan for tables that will be dropped in a moment.
    db.prepare("INSERT INTO secrets_migrations (source, migrated_at) VALUES (?, ?)").run(MARKER, new Date().toISOString());
    return;
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const groups = db.prepare("SELECT account, token, label, is_default FROM github_accounts").all() as unknown as GitHubAccountRow[];
    // FR6.2 — one secret account per group, named after the group's label.
    const accountByGroup = new Map<string, string>();
    for (const group of groups) {
      accountByGroup.set(group.account, createGitHubAccount(db, group.label || group.account, decryptSecretValue(group.token), now));
    }

    // FR6.3 — a group assigned to a project type becomes a workspace attachment.
    if (tableExists(db, "workspaces") && tableHasColumn(db, "workspaces", "github_group")) {
      const workspaces = db.prepare("SELECT id, github_group FROM workspaces WHERE github_group IS NOT NULL").all() as unknown as Array<{ id: string; github_group: string }>;
      for (const workspace of workspaces) {
        const accountId = accountByGroup.get(workspace.github_group);
        if (accountId) attach(db, "workspace", workspace.id, accountId);
      }
    }

    if (tableExists(db, "github_project_auth") && tableExists(db, "projects")) {
      const projectAuth = db.prepare("SELECT project_id, account, token FROM github_project_auth").all() as unknown as ProjectAuthRow[];
      for (const entry of projectAuth) {
        const projectId = canonicalProjectId(db, entry.project_id);
        if (!projectId) continue;
        // FR6.5 — a per-project override becomes its own project-scoped account and wins,
        // exactly as the override won the old four-tier chain.
        if (entry.token) {
          const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
          attach(db, "project", projectId, createGitHubAccount(db, `${project?.name ?? projectId} GitHub`, decryptSecretValue(entry.token), now));
          continue;
        }
        // FR6.4 — a group assigned to a project becomes a project attachment.
        const accountId = entry.account ? accountByGroup.get(entry.account) : undefined;
        if (accountId) attach(db, "project", projectId, accountId);
      }
    }

    // FR6.6 — the default group backfills every workspace that still resolves nothing,
    // which is what the old default-group fall-through did for those projects.
    const defaultGroup = groups.find((group) => group.is_default);
    const defaultAccountId = defaultGroup ? accountByGroup.get(defaultGroup.account) : undefined;
    if (defaultAccountId && tableExists(db, "workspaces")) {
      const workspaces = db.prepare("SELECT id FROM workspaces").all() as unknown as Array<{ id: string }>;
      for (const workspace of workspaces) {
        if (!workspaceResolvesToken(db, workspace.id)) attach(db, "workspace", workspace.id, defaultAccountId);
      }
    }

    db.prepare("INSERT INTO secrets_migrations (source, migrated_at) VALUES (?, ?)").run(MARKER, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
