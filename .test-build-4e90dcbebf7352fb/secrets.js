import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { isHarnessId } from "./types.js";
import { isTrustedTwin, mayReceiveResource } from "./cluster-sharing-policy.js";
import { ClusterV2HttpError } from "./cluster-v2-errors.js";
import { applyGithubAccounts, assertGithubAccountsDistinct, assertGithubVariableNames, finalizeGithubVariables, githubAccount, githubAccountContext, githubAccountSummary, githubOwnerFromRemote, GITHUB_TOKEN_VARIABLE } from "./github-credentials.js";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
const keyPath = path.join(dataDir, "secret.key");
const askPassPath = path.join(dataDir, "github-askpass.sh");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database;
function ensureSecretSchema(handle) {
  handle.exec("CREATE TABLE IF NOT EXISTS secret_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, variables_encrypted TEXT NOT NULL, replicate INTEGER NOT NULL DEFAULT 0, origin_node_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secret_assignments (scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id, account_id)); CREATE INDEX IF NOT EXISTS secret_assignments_account_id ON secret_assignments(account_id);");
  const columns = handle.prepare("PRAGMA table_info(secret_accounts)").all().map((column) => column.name);
  if (!columns.includes("replicate")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN replicate INTEGER NOT NULL DEFAULT 0");
  if (!columns.includes("origin_node_id")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("website_origin")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN website_origin TEXT");
  if (!columns.includes("project_id")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN project_id TEXT");
}
function db() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureSecretSchema(database);
  return database;
}
function key() {
  const configured = process.env.JOINT_BOB_SECRET_KEY ?? process.env.MASTER_BOB_SECRET_KEY;
  if (configured) {
    const value = Buffer.from(configured, "base64");
    if (value.length !== 32) throw new Error("JOINT_BOB_SECRET_KEY must be a base64-encoded 32-byte key");
    return value;
  }
  try {
    const value = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (value.length !== 32) throw new Error("Joint Bob secret key is invalid");
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(dataDir, { recursive: true, mode: 448 });
    const value = randomBytes(32);
    writeFileSync(keyPath, value.toString("base64"), { mode: 384 });
    return value;
  }
}
function encryptSecretValue(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}
function decryptSecretValue(value) {
  const [iv, tag, body] = value.split(".");
  if (!iv || !tag || !body) throw new Error("Stored secret account is invalid");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString("utf8");
}
function normalizeWebsiteOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Website origin must be a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Website origin must use HTTPS, except loopback HTTP");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Website origin must not contain credentials, path, query, or hash");
  return url.origin;
}
function assertAccountId(id) {
  if (!UUID_PATTERN.test(id)) throw new Error("Secret account ID must be a UUID");
}
function conversationScopeId(engine, sessionId) {
  return `${engine}:${sessionId}`;
}
function assertScope(scopeType, scopeId) {
  if (scopeType !== "workspace" && scopeType !== "project" && scopeType !== "conversation") throw new Error("Secret scope type must be workspace, project, or conversation");
  if (!scopeId.trim() || scopeId.trim().length > 300) throw new Error("Secret scope ID must be between 1 and 300 characters");
}
function assertInput(input) {
  if (!["aws", "google", "github", "stripe", "cloudflare", "openai", "zai", "grafana", "datadog", "postgres", "mssql", "mongodb", "custom", "website"].includes(input.provider)) throw new Error("Secret provider is invalid");
  if (!input.label.trim() || input.label.trim().length > 64 || /[\x00-\x1f\x7f]/.test(input.label)) throw new Error("Secret account label must be between 1 and 64 characters without control characters");
  if (input.variables.length < 1 || input.variables.length > 20) throw new Error("Secret accounts need between 1 and 20 variables");
  const names = /* @__PURE__ */ new Set();
  for (const variable of input.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error("Secret variable name is invalid");
    if (names.has(variable.name)) throw new Error("Secret variable names must be unique");
    names.add(variable.name);
    if (variable.kind !== "value" && variable.kind !== "file") throw new Error("Secret variable kind must be value or file");
    if (variable.value !== void 0 && variable.value.length > 1e5) throw new Error("Secret value must be at most 100000 characters");
  }
  if (input.provider === "github") assertGithubVariableNames(input.variables);
  if (input.provider === "stripe" && (input.variables.length !== 1 || input.variables[0].name !== "STRIPE_API_KEY" || input.variables[0].kind !== "value")) {
    throw new Error("Stripe secret accounts hold exactly one STRIPE_API_KEY value");
  }
  if (input.provider === "cloudflare" && input.variables.some((variable) => !["CLOUDFLARE_API_KEY", "CLOUDFLARE_STREAM_API_TOKEN", "CLOUDFLARE_STREAM_ACCOUNT_ID", "CLOUDFLARE_STREAM_CUSTOMER_CODE", "CLOUDFLARE_STREAM_SIGNING_KEY_ID", "CLOUDFLARE_STREAM_SIGNING_PRIVATE_KEY"].includes(variable.name) || variable.kind !== "value")) {
    throw new Error("Cloudflare accounts accept only supported Cloudflare environment variables as values");
  }
}
function storedVariables(row) {
  let value;
  try {
    value = JSON.parse(decryptSecretValue(row.variables_encrypted));
  } catch {
    throw new Error("Stored secret account is invalid");
  }
  if (!Array.isArray(value)) throw new Error("Stored secret account is invalid");
  for (const variable of value) {
    if (!variable || typeof variable !== "object") throw new Error("Stored secret account is invalid");
    const item = variable;
    if (typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || item.kind !== "value" && item.kind !== "file" || typeof item.value !== "string") throw new Error("Stored secret account is invalid");
  }
  return value;
}
function accountRow(id) {
  assertAccountId(id);
  const row = db().prepare("SELECT id, label, provider, replicate, variables_encrypted, website_origin, project_id, origin_node_id FROM secret_accounts WHERE id = ?").get(id);
  if (!row) throw new Error("Secret account not found");
  return row;
}
function publicAccount(row) {
  const local = hasTable("cluster_node") ? db().prepare("SELECT id FROM cluster_node LIMIT 1").get() : void 0;
  const readOnly = Boolean(row.origin_node_id && row.origin_node_id !== local?.id);
  const shared = readOnly || hasTable("cluster_v2_secret_grants") && Boolean(db().prepare("SELECT 1 FROM cluster_v2_secret_grants WHERE account_id=? LIMIT 1").get(row.id)) || hasTable("cluster_v2_share_selections") && Boolean(db().prepare("SELECT 1 FROM secret_assignments a JOIN cluster_v2_share_selections s ON s.kind='workspace' AND s.resource_id=a.scope_id WHERE a.account_id=? AND a.scope_type='workspace' LIMIT 1").get(row.id)) || Boolean(row.replicate && hasTable("sharing_resource_shares") && db().prepare("SELECT 1 FROM secret_assignments a JOIN sharing_resource_shares s ON s.kind='project' AND s.resource_id=a.scope_id WHERE a.account_id=? AND a.scope_type='project' LIMIT 1").get(row.id));
  return { id: row.id, label: row.label, provider: row.provider, replicate: Boolean(row.replicate), variables: storedVariables(row).map(({ name, kind }) => ({ name, kind, configured: true })), ...row.provider === "github" ? { github: githubAccountSummary(githubAccount(row.id, row.label, storedVariables(row))) } : {}, ...row.website_origin ? { websiteOrigin: row.website_origin } : {}, ...row.project_id ? { projectId: row.project_id } : {}, ...shared ? { shared: true } : {}, ...readOnly ? { readOnly: true, ownerNodeId: row.origin_node_id } : {} };
}
function clearSecretAccountFiles(id) {
  rmSync(path.join(dataDir, "secret-files", id), { recursive: true, force: true });
}
function hasTable(name) {
  return Boolean(db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function canonicalScopeId(scopeType, scopeId) {
  assertScope(scopeType, scopeId);
  const requested = scopeId.trim();
  if (scopeType === "workspace") {
    if (!hasTable("workspaces") || !db().prepare("SELECT 1 FROM workspaces WHERE id = ?").get(requested)) throw new Error("Secret workspace not found");
    return requested;
  }
  if (scopeType === "conversation") {
    const [engine, sessionId] = requested.split(":", 2);
    if (!isHarnessId(engine) || !sessionId) throw new Error("Secret conversation scope must be <engine>:<sessionId>");
    return requested;
  }
  if (!hasTable("projects")) throw new Error("Secret project not found");
  const alias = hasTable("project_aliases") ? db().prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(requested) : void 0;
  const canonical = alias?.project_id ?? requested;
  if (!db().prepare("SELECT 1 FROM projects WHERE id = ?").get(canonical)) throw new Error("Secret project not found");
  return canonical;
}
function scopeRows(scopeType, scopeId) {
  return db().prepare("SELECT a.id, a.label, a.provider, a.replicate, a.variables_encrypted, a.website_origin, a.project_id FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = ? AND s.scope_id = ? ORDER BY a.id").all(scopeType, scopeId);
}
function assertNoCollision(rows) {
  const origins = /* @__PURE__ */ new Set();
  assertGithubAccountsDistinct(rows.filter((row) => row.provider === "github").map(rowGithubAccount));
  for (const row of rows) if (row.website_origin) {
    if (origins.has(row.website_origin)) throw new Error("Selected website accounts have duplicate origins");
    origins.add(row.website_origin);
  }
}
function conversationRows(conversation) {
  const stored = conversation.sessionId ? scopeRows("conversation", conversationScopeId(conversation.engine, conversation.sessionId)) : [];
  const seen = new Set(stored.map((row) => row.id));
  const pending = (conversation.accountIds ?? []).filter((id) => !seen.has(id)).map(accountRow);
  return [...stored, ...pending].sort((left, right) => left.id.localeCompare(right.id));
}
function accountAllowedForProject(accountId, projectId) {
  const handle = db();
  const { origin_node_id: origin, project_id: ownerProject } = handle.prepare("SELECT origin_node_id,project_id FROM secret_accounts WHERE id=?").get(accountId);
  if (ownerProject && ownerProject !== projectId) return false;
  if (!origin) return true;
  const { id: local } = handle.prepare("SELECT id FROM cluster_node LIMIT 1").get();
  if (origin === local) return true;
  if (isTrustedTwin(handle, local, origin)) return true;
  const policy = handle.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(projectId);
  if (!hasTable("cluster_v2_scoped_secret_copies")) return Boolean(policy && !policy.deleted && mayReceiveResource(handle, local, "project", projectId) && mayReceiveResource(handle, origin, "project", projectId));
  const grants = handle.prepare("SELECT grants FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?").get(origin, accountId);
  if (ownerProject && (!policy || policy.deleted || !mayReceiveResource(handle, local, "project", projectId) || !mayReceiveResource(handle, origin, "project", projectId))) return false;
  if (grants && JSON.parse(grants.grants).some((grant) => handle.prepare("SELECT 1 FROM sharing_memberships a JOIN sharing_memberships b ON a.cluster_id=b.cluster_id WHERE a.cluster_id=? AND a.node_id=? AND b.node_id=?").get(grant.clusterId, local, origin) && (!ownerProject || handle.prepare("SELECT 1 FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(ownerProject, grant.clusterId)))) return true;
  if (!policy || policy.deleted || !mayReceiveResource(handle, local, "project", projectId) || !mayReceiveResource(handle, origin, "project", projectId)) return false;
  const copy = handle.prepare("SELECT scopes FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?").get(origin, accountId);
  return !copy || JSON.parse(copy.scopes).some((scope) => scope.projectIds.includes(projectId));
}
function resolved(project, conversation) {
  const projectId = canonicalScopeId("project", project);
  const row = db().prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId);
  const workspace = row?.workspace_id ? scopeRows("workspace", row.workspace_id) : [];
  const direct = scopeRows("project", projectId);
  const session = conversation ? conversationRows(conversation) : [];
  return [
    ...workspace.map((account) => ({ row: account, scope: "workspace" })),
    ...direct.map((account) => ({ row: account, scope: "project" })),
    ...session.map((account) => ({ row: account, scope: "conversation" }))
  ].filter((account) => accountAllowedForProject(account.row.id, projectId));
}
async function listSecretAccounts() {
  return db().prepare("SELECT id, label, provider, replicate, variables_encrypted, website_origin, project_id, origin_node_id FROM secret_accounts ORDER BY label, id").all().map(publicAccount);
}
async function saveSecretAccount(input) {
  assertInput(input);
  const id = input.id ?? randomUUID();
  if (input.id) assertAccountId(id);
  const old = input.id ? accountRow(id) : void 0;
  if (old && (old.origin_node_id && hasTable("cluster_node") && old.origin_node_id !== db().prepare("SELECT id FROM cluster_node LIMIT 1").get()?.id || hasTable("cluster_v2_scoped_secret_copies") && db().prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id=?").get(id))) throw new ClusterV2HttpError(403, "Shared secret accounts are read-only on this node");
  const websiteOrigin = input.websiteOrigin === void 0 ? old?.website_origin ?? null : input.websiteOrigin === null ? null : normalizeWebsiteOrigin(input.websiteOrigin);
  if (input.provider === "website" && !websiteOrigin) throw new Error("Website secret accounts require a website origin");
  if (websiteOrigin && input.variables.some((variable) => variable.kind === "file")) throw new Error("Website credential accounts cannot contain file variables");
  const projectId = old ? old.project_id : input.projectId === void 0 ? null : canonicalScopeId("project", input.projectId);
  if (projectId && input.replicate) throw new Error("Project-scoped secret accounts cannot replicate");
  if (old && websiteOrigin) {
    const duplicate = db().prepare("SELECT 1 FROM secret_assignments own JOIN secret_assignments other ON other.scope_type = own.scope_type AND other.scope_id = own.scope_id AND other.account_id <> own.account_id JOIN secret_accounts account ON account.id = other.account_id WHERE own.account_id = ? AND account.website_origin = ? LIMIT 1").get(id, websiteOrigin);
    if (duplicate) throw new Error("Selected website accounts have duplicate origins");
  }
  const oldValues = new Map((old ? storedVariables(old) : []).map((item) => [`${item.name}:${item.kind}`, item.value]));
  const merged = input.variables.map((item) => {
    const value = item.value === void 0 || item.value === "" ? oldValues.get(`${item.name}:${item.kind}`) : item.value;
    if (value === void 0) throw new Error("New secret variables require a value");
    return { name: item.name, kind: item.kind, value };
  });
  const variables = input.provider === "github" ? finalizeGithubVariables(merged) : merged;
  const replicate = input.replicate ? 1 : 0;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, website_origin, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, provider = excluded.provider, variables_encrypted = excluded.variables_encrypted, replicate = excluded.replicate, website_origin = excluded.website_origin, updated_at = excluded.updated_at").run(id, input.label.trim(), input.provider, encryptSecretValue(JSON.stringify(variables)), replicate, websiteOrigin, projectId, now, now);
    if (!old && projectId) db().prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES ('project', ?, ?)").run(projectId, id);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  clearSecretAccountFiles(id);
  return { id, label: input.label.trim(), provider: input.provider, replicate: Boolean(replicate), variables: variables.map(({ name, kind }) => ({ name, kind, configured: true })), ...input.provider === "github" ? { github: githubAccountSummary(githubAccount(id, input.label.trim(), variables)) } : {}, ...websiteOrigin ? { websiteOrigin } : {}, ...projectId ? { projectId } : {} };
}
async function deleteSecretAccount(accountId) {
  const row = accountRow(accountId);
  if (row.origin_node_id && hasTable("cluster_node") && row.origin_node_id !== db().prepare("SELECT id FROM cluster_node LIMIT 1").get()?.id || hasTable("cluster_v2_scoped_secret_copies") && db().prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id=?").get(accountId)) throw new ClusterV2HttpError(403, "Shared secret accounts are read-only on this node");
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM secret_assignments WHERE account_id = ?").run(row.id);
    if (hasTable("cluster_v2_secret_grants")) db().prepare("DELETE FROM cluster_v2_secret_grants WHERE account_id=?").run(row.id);
    db().prepare("DELETE FROM secret_accounts WHERE id = ?").run(row.id);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  clearSecretAccountFiles(row.id);
}
async function getScopeSecretAccounts(scopeType, scopeId) {
  const canonical = canonicalScopeId(scopeType, scopeId);
  const rows = db().prepare("SELECT account_id FROM secret_assignments WHERE scope_type = ? AND scope_id = ? ORDER BY account_id").all(scopeType, canonical);
  return { accountIds: rows.map((row) => row.account_id) };
}
async function setScopeSecretAccounts(scopeType, scopeId, accountIds) {
  const canonical = canonicalScopeId(scopeType, scopeId);
  if (new Set(accountIds).size !== accountIds.length) throw new Error("Secret account IDs must be unique");
  const rows = accountIds.map(accountRow);
  assertNoCollision(rows);
  const previous = scopeType === "workspace" ? (await getScopeSecretAccounts(scopeType, canonical)).accountIds : [];
  const changed = [.../* @__PURE__ */ new Set([...previous, ...accountIds])].filter((id) => previous.includes(id) !== accountIds.includes(id));
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM secret_assignments WHERE scope_type = ? AND scope_id = ?").run(scopeType, canonical);
    const insert = db().prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)");
    for (const id of accountIds) insert.run(scopeType, canonical, id);
    if (hasTable("cluster_v2_local_secret_assignments")) {
      db().prepare("DELETE FROM cluster_v2_local_secret_assignments WHERE scope_type=? AND scope_id=?").run(scopeType, canonical);
      for (const id of accountIds) if (db().prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id=? AND grants<>'[]'").get(id)) db().prepare("INSERT INTO cluster_v2_local_secret_assignments VALUES(?,?,?)").run(scopeType, canonical, id);
    }
    const selectUpdatedAt = db().prepare("SELECT updated_at FROM secret_accounts WHERE id = ?");
    const touch = db().prepare("UPDATE secret_accounts SET updated_at = ? WHERE id = ?");
    for (const id of changed) {
      const row = selectUpdatedAt.get(id);
      if (!hasTable("cluster_v2_scoped_secret_copies") || !db().prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id=?").get(id)) touch.run(new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString(), id);
    }
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}
function secretFilePath(accountId, name, value) {
  const directory = path.join(dataDir, "secret-files", accountId);
  mkdirSync(directory, { recursive: true, mode: 448 });
  chmodSync(directory, 448);
  const filePath = path.join(directory, name);
  writeFileSync(filePath, value, { mode: 384 });
  chmodSync(filePath, 384);
  return filePath;
}
function ensureAskPassHelper() {
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  writeFileSync(askPassPath, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$PI_GITHUB_TOKEN" ;;\nesac\n', { mode: 448 });
  return askPassPath;
}
function applyGitHubEnvironment(values) {
  const token = values.GH_TOKEN ?? values.GITHUB_TOKEN;
  if (!token) return;
  values.GH_TOKEN = token;
  values.GITHUB_TOKEN = token;
  values.PI_GITHUB_TOKEN = token;
  values.GIT_ASKPASS = ensureAskPassHelper();
  values.GIT_TERMINAL_PROMPT = "0";
}
const appTokens = /* @__PURE__ */ new Map();
function installationToken(account) {
  const app = account.app;
  const cacheKey = createHash("sha256").update(JSON.stringify([account.id, app.appId, app.installationId, app.privateKey])).digest("hex");
  const cached = appTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 5 * 6e4) return cached.token;
  const script = fileURLToPath(new URL("../scripts/github-app-token.mjs", import.meta.url));
  let issued;
  try {
    issued = JSON.parse(execFileSync(process.execPath, [script], {
      input: JSON.stringify(app),
      encoding: "utf8",
      timeout: 2e4,
      stdio: ["pipe", "pipe", "ignore"]
    }));
  } catch {
    throw new Error(`Could not obtain GitHub App installation token for ${account.label}`);
  }
  if (issued.expiresAt <= Date.now() + 5 * 6e4) throw new Error("GitHub App installation token expires too soon");
  appTokens.set(cacheKey, issued);
  return issued.token;
}
function rowGithubAccount(row) {
  return githubAccount(row.id, row.label, storedVariables(row));
}
function resolvedGithubAccounts(project, conversation) {
  return resolved(project, conversation).filter(({ row }) => row.provider === "github").map(({ row }) => {
    const account = rowGithubAccount(row);
    return account.app ? { ...account, token: installationToken(account) } : account;
  }).reverse();
}
function githubAccountsForProject(project, conversation) {
  return resolvedGithubAccounts(project, conversation);
}
function projectRepoOwner(project) {
  if (!hasTable("projects") || !db().prepare("PRAGMA table_info(projects)").all().some((column) => column.name === "path")) return void 0;
  const row = db().prepare("SELECT path FROM projects WHERE id = ?").get(canonicalScopeId("project", project));
  if (!row?.path) return void 0;
  try {
    const config = readFileSync(path.join(row.path, ".git", "config"), "utf8");
    const url = config.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1];
    return url ? githubOwnerFromRemote(url) : void 0;
  } catch {
    return void 0;
  }
}
function genericSecretEnvironment(project, conversation) {
  const values = {};
  const accounts = resolved(project, conversation);
  for (const scope of ["workspace", "project", "conversation"]) {
    const rows = accounts.filter((account) => account.scope === scope && !account.row.website_origin && account.row.provider !== "github").map(({ row }) => ({ row, variables: storedVariables(row) }));
    const counts = /* @__PURE__ */ new Map();
    for (const { variables } of rows) for (const { name } of variables) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const { row, variables } of rows) if (variables.some(({ name }) => counts.get(name) > 1)) {
      for (const { name } of variables) delete values[name];
    }
    for (const { row, variables } of rows) {
      if (variables.some(({ name }) => counts.get(name) > 1)) continue;
      for (const variable of variables) values[variable.name] = variable.kind === "value" ? variable.value : secretFilePath(row.id, variable.name, variable.value);
    }
  }
  const github = resolvedGithubAccounts(project, conversation);
  applyGithubAccounts(values, github, {
    dataDir,
    repoOwner: github.filter((account) => account.token).length > 1 ? projectRepoOwner(project) : void 0,
    keyFile: (account) => secretFilePath(account.id, "GITHUB_SSH_KEY", account.sshKey)
  });
  applyGitHubEnvironment(values);
  return values;
}
function websiteCredentialSnapshot(project, conversation) {
  const groups = /* @__PURE__ */ new Map();
  for (const { row } of resolved(project, conversation)) {
    if (!row.website_origin) continue;
    const group = groups.get(row.website_origin) ?? { id: row.id, origin: row.website_origin, variables: /* @__PURE__ */ new Map() };
    for (const variable of storedVariables(row)) group.variables.set(variable.name, variable);
    group.id = row.id;
    groups.set(row.website_origin, group);
  }
  return Array.from(groups.values(), ({ id, origin, variables }) => ({ id, origin, variables: Array.from(variables.values()) }));
}
function agentEnvironment(projectId, conversation) {
  return genericSecretEnvironment(projectId, conversation);
}
function accountsForAgent(project, conversation) {
  return resolved(project, conversation).filter(({ row }) => !row.website_origin).map(({ row, scope }) => ({
    id: row.id,
    label: row.label,
    provider: row.provider,
    scope,
    variables: storedVariables(row).map(({ name }) => name)
  }));
}
function accountEnvironmentForAgent(project, conversation, accountId) {
  const accounts = resolved(project, conversation);
  const account = accounts.find(({ row: row2 }) => row2.id === accountId);
  if (!account || account.row.website_origin) throw new Error("Secret account is not available to this conversation");
  const { row } = account;
  const removeNames = new Set(accounts.filter((entry) => entry.row.provider === row.provider && !entry.row.website_origin).flatMap((entry) => storedVariables(entry.row).map(({ name }) => name)));
  const values = {};
  if (row.provider === "aws" || storedVariables(row).some(({ name }) => name.startsWith("AWS_"))) {
    for (const name of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"]) removeNames.add(name);
  }
  if (row.provider === "github" || storedVariables(row).some(({ name }) => name === "GH_TOKEN" || name === "GITHUB_TOKEN")) {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "PI_GITHUB_TOKEN", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "GIT_SSH_COMMAND"]) removeNames.add(name);
  }
  if (row.provider === "github") {
    const github = rowGithubAccount(row);
    applyGithubAccounts(values, [github.app ? { ...github, token: installationToken(github) } : github], {
      dataDir,
      keyFile: () => secretFilePath(row.id, "GITHUB_SSH_KEY", github.sshKey)
    });
    applyGitHubEnvironment(values);
  } else for (const variable of storedVariables(row)) {
    values[variable.name] = variable.kind === "value" ? variable.value : secretFilePath(row.id, variable.name, variable.value);
  }
  return { values, removeNames: [...removeNames] };
}
async function persistConversationSecretAccounts(engine, sessionId, accountIds) {
  if (!accountIds.length) return;
  await setScopeSecretAccounts("conversation", conversationScopeId(engine, sessionId), accountIds);
}
const providerHints = {
  aws: "the AWS CLI and AWS SDKs read these automatically",
  google: "gcloud and the Google SDKs read GOOGLE_APPLICATION_CREDENTIALS automatically",
  github: "the gh CLI, the GitHub API and git push all read these automatically",
  stripe: "use STRIPE_API_KEY to configure the Stripe CLI or SDK",
  cloudflare: "use configured Cloudflare API or Stream credentials (CLOUDFLARE_STREAM_*)",
  openai: "use OPENAI_API_KEY with OpenAI tools and SDKs",
  zai: "use ZAI_API_KEY with Z.AI tools and SDKs",
  grafana: "use GRAFANA_API_KEY with Grafana APIs",
  datadog: "use DD_API_KEY with Datadog tools and SDKs",
  postgres: "use DATABASE_URL to connect to PostgreSQL",
  mssql: "use MSSQL_CONNECTION_STRING to connect to Microsoft SQL Server",
  mongodb: "use MONGODB_URI to connect to MongoDB",
  custom: "plain environment variables for this project",
  website: "structured website sign-in credentials filled through login-fill at the bound origin"
};
function agentCredentialContext(project, conversation) {
  const accounts = resolved(project, conversation);
  if (!accounts.length) return "## Available secret accounts\nNo secret accounts are attached for this message. This replaces any earlier account list.";
  const ordinary = accounts.filter(({ row }) => !row.website_origin);
  const effectiveRows = new Map(accounts.filter(({ row }) => row.website_origin).map((account) => [account.row.id, account]));
  const lines = ["## Available secret accounts", "This is the current account list for this message, replacing any earlier list."];
  if (ordinary.length) lines.push(`Accounts with unique variables are exported automatically. When accounts in the same scope reuse names, none of those accounts is exported by default. Run node "$JOINT_BOB_SECRET_CLI" run ACCOUNT_ID -- COMMAND ARGS to run one command with that account's variables; never print, expand or inspect secret values. The command runs with the chosen account only, without changing other shell commands. Website accounts use login-fill instead.`);
  for (const { row, scope } of ordinary) {
    if (row.provider === "github") {
      lines.push(`- github ${JSON.stringify(row.label)} (${scope}), account ${row.id}: ${githubAccountContext(rowGithubAccount(row))}. The gh CLI, the GitHub API and git read these automatically.`);
      continue;
    }
    const variables = storedVariables(row).map((item) => `${item.name}${item.kind === "file" ? " (secret file path)" : ""}`).join(", ");
    lines.push(`- ${row.provider} ${JSON.stringify(row.label)} (${scope}), account ${row.id}: ${variables} - ${providerHints[row.provider]}`);
  }
  for (const snapshot of websiteCredentialSnapshot(project, conversation)) {
    const { row, scope } = effectiveRows.get(snapshot.id);
    const variables = snapshot.variables.map(({ name }) => name).join(", ");
    lines.push(`- website ${JSON.stringify(row.label)} (${scope}), account ${snapshot.id}, exact origin ${snapshot.origin}: ${variables}. Variables inherit per name from broader scopes and the narrowest account ID identifies the effective login. Use login-fill SELECTOR ${snapshot.id} VARIABLE.`);
  }
  return lines.join("\n");
}
export {
  GITHUB_TOKEN_VARIABLE,
  accountEnvironmentForAgent,
  accountsForAgent,
  agentCredentialContext,
  agentEnvironment,
  clearSecretAccountFiles,
  conversationScopeId,
  decryptSecretValue,
  deleteSecretAccount,
  encryptSecretValue,
  ensureSecretSchema,
  genericSecretEnvironment,
  getScopeSecretAccounts,
  githubAccountsForProject,
  listSecretAccounts,
  normalizeWebsiteOrigin,
  persistConversationSecretAccounts,
  saveSecretAccount,
  setScopeSecretAccounts,
  websiteCredentialSnapshot
};
