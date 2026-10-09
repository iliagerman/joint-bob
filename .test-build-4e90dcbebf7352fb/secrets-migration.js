import { randomUUID } from "node:crypto";
import { decryptSecretValue, encryptSecretValue, ensureSecretSchema, GITHUB_TOKEN_VARIABLE } from "./secrets.js";
const MARKER = "github-groups-v1";
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}
function rekeySecretAssignments(db, aliasId, projectId) {
  if (!tableExists(db, "secret_assignments")) return;
  db.prepare("INSERT OR IGNORE INTO secret_assignments (scope_type, scope_id, account_id) SELECT 'project', ?, account_id FROM secret_assignments WHERE scope_type = 'project' AND scope_id = ?").run(projectId, aliasId);
  db.prepare("DELETE FROM secret_assignments WHERE scope_type = 'project' AND scope_id = ?").run(aliasId);
}
function createGitHubAccount(db, label, token, now) {
  const id = randomUUID();
  const variables = JSON.stringify([{ name: GITHUB_TOKEN_VARIABLE, kind: "value", value: token }]);
  db.prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, origin_node_id, created_at, updated_at) VALUES (?, ?, 'github', ?, 0, '', ?, ?)").run(id, label.slice(0, 64), encryptSecretValue(variables), now, now);
  return id;
}
function attach(db, scopeType, scopeId, accountId) {
  db.prepare("INSERT OR IGNORE INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)").run(scopeType, scopeId, accountId);
}
function workspaceResolvesToken(db, workspaceId) {
  const rows = db.prepare("SELECT a.variables_encrypted FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = 'workspace' AND s.scope_id = ?").all(workspaceId);
  return rows.some((row) => {
    const variables = JSON.parse(decryptSecretValue(row.variables_encrypted));
    return variables.some((variable) => variable.name === GITHUB_TOKEN_VARIABLE);
  });
}
function canonicalProjectId(db, projectId) {
  if (db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) return projectId;
  if (!tableExists(db, "project_aliases")) return void 0;
  const alias = db.prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(projectId);
  if (!alias) return void 0;
  return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(alias.project_id) ? alias.project_id : void 0;
}
function ensureWorkspaceSecretsMigration(db) {
  ensureSecretSchema(db);
  db.exec("CREATE TABLE IF NOT EXISTS secrets_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);");
  if (db.prepare("SELECT 1 FROM secrets_migrations WHERE source = ?").get(MARKER)) return;
  if (!tableExists(db, "github_accounts")) {
    db.prepare("INSERT INTO secrets_migrations (source, migrated_at) VALUES (?, ?)").run(MARKER, (/* @__PURE__ */ new Date()).toISOString());
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const groups = db.prepare("SELECT account, token, label, is_default FROM github_accounts").all();
    const accountByGroup = /* @__PURE__ */ new Map();
    for (const group of groups) {
      accountByGroup.set(group.account, createGitHubAccount(db, group.label || group.account, decryptSecretValue(group.token), now));
    }
    if (tableExists(db, "workspaces") && tableHasColumn(db, "workspaces", "github_group")) {
      const workspaces = db.prepare("SELECT id, github_group FROM workspaces WHERE github_group IS NOT NULL").all();
      for (const workspace of workspaces) {
        const accountId = accountByGroup.get(workspace.github_group);
        if (accountId) attach(db, "workspace", workspace.id, accountId);
      }
    }
    if (tableExists(db, "github_project_auth") && tableExists(db, "projects")) {
      const projectAuth = db.prepare("SELECT project_id, account, token FROM github_project_auth").all();
      for (const entry of projectAuth) {
        const projectId = canonicalProjectId(db, entry.project_id);
        if (!projectId) continue;
        if (entry.token) {
          const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId);
          attach(db, "project", projectId, createGitHubAccount(db, `${project?.name ?? projectId} GitHub`, decryptSecretValue(entry.token), now));
          continue;
        }
        const accountId = entry.account ? accountByGroup.get(entry.account) : void 0;
        if (accountId) attach(db, "project", projectId, accountId);
      }
    }
    const defaultGroup = groups.find((group) => group.is_default);
    const defaultAccountId = defaultGroup ? accountByGroup.get(defaultGroup.account) : void 0;
    if (defaultAccountId && tableExists(db, "workspaces")) {
      const workspaces = db.prepare("SELECT id FROM workspaces").all();
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
export {
  ensureWorkspaceSecretsMigration,
  rekeySecretAssignments
};
