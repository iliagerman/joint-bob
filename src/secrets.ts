import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gitHubEnvironment } from "./github-auth.js";

export type SecretProvider = "aws" | "google" | "github" | "custom";
export type SecretKind = "value" | "file";
export type SecretScopeType = "project" | "project_type";
export interface SecretVariable { name: string; kind: SecretKind; configured: true }
export interface SecretAccount { id: string; label: string; provider: SecretProvider; variables: SecretVariable[] }
export interface SecretAccountInput { id?: string; label: string; provider: SecretProvider; variables: Array<{ name: string; kind: SecretKind; value?: string }> }
type StoredVariable = { name: string; kind: SecretKind; value: string };
type AccountRow = { id: string; label: string; provider: SecretProvider; variables_encrypted: string };

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const keyPath = path.join(dataDir, "secret.key");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS secret_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, variables_encrypted TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secret_assignments (scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id, account_id));");
  return database;
}

function key(): Buffer {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = randomBytes(32);
    writeFileSync(keyPath, value.toString("base64"), { mode: 0o600 });
    return value;
  }
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

function decrypt(value: string): string {
  const [iv, tag, body] = value.split(".");
  if (!iv || !tag || !body) throw new Error("Stored secret account is invalid");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString("utf8");
}

function assertAccountId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error("Secret account ID must be a UUID");
}

function assertScope(scopeType: string, scopeId: string): asserts scopeType is SecretScopeType {
  if (scopeType !== "project" && scopeType !== "project_type") throw new Error("Secret scope type must be project or project_type");
  if (!scopeId.trim() || scopeId.trim().length > 300) throw new Error("Secret scope ID must be between 1 and 300 characters");
}

function assertInput(input: SecretAccountInput): void {
  if (!(["aws", "google", "github", "custom"] as string[]).includes(input.provider)) throw new Error("Secret provider must be aws, google, github, or custom");
  if (!input.label.trim() || input.label.trim().length > 64 || /[\x00-\x1f\x7f]/.test(input.label)) throw new Error("Secret account label must be between 1 and 64 characters without control characters");
  if (input.variables.length < 1 || input.variables.length > 20) throw new Error("Secret accounts need between 1 and 20 variables");
  const names = new Set<string>();
  for (const variable of input.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) throw new Error("Secret variable name is invalid");
    if (names.has(variable.name)) throw new Error("Secret variable names must be unique");
    names.add(variable.name);
    if (variable.kind !== "value" && variable.kind !== "file") throw new Error("Secret variable kind must be value or file");
    if (variable.value !== undefined && variable.value.length > 100000) throw new Error("Secret value must be at most 100000 characters");
  }
}

function storedVariables(row: AccountRow): StoredVariable[] {
  let value: unknown;
  try { value = JSON.parse(decrypt(row.variables_encrypted)); } catch { throw new Error("Stored secret account is invalid"); }
  if (!Array.isArray(value)) throw new Error("Stored secret account is invalid");
  for (const variable of value) {
    if (!variable || typeof variable !== "object") throw new Error("Stored secret account is invalid");
    const item = variable as Record<string, unknown>;
    if (typeof item.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) || (item.kind !== "value" && item.kind !== "file") || typeof item.value !== "string") throw new Error("Stored secret account is invalid");
  }
  return value as StoredVariable[];
}

function accountRow(id: string): AccountRow {
  assertAccountId(id);
  const row = db().prepare("SELECT id, label, provider, variables_encrypted FROM secret_accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) throw new Error("Secret account not found");
  return row;
}

function publicAccount(row: AccountRow): SecretAccount {
  return { id: row.id, label: row.label, provider: row.provider, variables: storedVariables(row).map(({ name, kind }) => ({ name, kind, configured: true })) };
}

function clearFiles(id: string): void {
  rmSync(path.join(dataDir, "secret-files", id), { recursive: true, force: true });
}

function hasTable(name: string): boolean {
  return Boolean(db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function canonicalScopeId(scopeType: SecretScopeType, scopeId: string): string {
  assertScope(scopeType, scopeId);
  const requested = scopeId.trim();
  if (scopeType === "project_type") {
    if (!hasTable("project_types") || !db().prepare("SELECT 1 FROM project_types WHERE id = ?").get(requested)) throw new Error("Secret project type not found");
    return requested;
  }
  if (!hasTable("projects")) throw new Error("Secret project not found");
  const alias = hasTable("project_aliases")
    ? db().prepare("SELECT project_id FROM project_aliases WHERE alias_id = ?").get(requested) as { project_id: string } | undefined
    : undefined;
  const canonical = alias?.project_id ?? requested;
  if (!db().prepare("SELECT 1 FROM projects WHERE id = ?").get(canonical)) throw new Error("Secret project not found");
  return canonical;
}

function scopeRows(scopeType: SecretScopeType, scopeId: string): AccountRow[] {
  return db().prepare("SELECT a.id, a.label, a.provider, a.variables_encrypted FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = ? AND s.scope_id = ? ORDER BY a.id").all(scopeType, scopeId) as unknown as AccountRow[];
}

function assertNoCollision(rows: AccountRow[]): void {
  const names = new Set<string>();
  for (const row of rows) for (const variable of storedVariables(row)) {
    if (names.has(variable.name)) throw new Error("Selected secret accounts have duplicate environment variable names");
    names.add(variable.name);
  }
}

function resolved(project: string): Array<{ row: AccountRow; direct: boolean }> {
  const projectId = canonicalScopeId("project", project);
  const type = db().prepare("SELECT project_type FROM projects WHERE id = ?").get(projectId) as { project_type: string } | undefined;
  const inherited = type?.project_type ? scopeRows("project_type", canonicalScopeId("project_type", type.project_type)) : [];
  const direct = scopeRows("project", projectId);
  const directIds = new Set(direct.map((row) => row.id));
  return [...inherited.filter((row) => !directIds.has(row.id)).map((row) => ({ row, direct: false })), ...direct.map((row) => ({ row, direct: true }))];
}

export async function listSecretAccounts(): Promise<SecretAccount[]> {
  return (db().prepare("SELECT id, label, provider, variables_encrypted FROM secret_accounts ORDER BY label, id").all() as unknown as AccountRow[]).map(publicAccount);
}

export async function saveSecretAccount(input: SecretAccountInput): Promise<SecretAccount> {
  assertInput(input);
  const id = input.id ?? randomUUID();
  if (input.id) assertAccountId(id);
  const old = input.id ? accountRow(id) : undefined;
  const oldValues = new Map((old ? storedVariables(old) : []).map((item) => [`${item.name}:${item.kind}`, item.value]));
  const variables = input.variables.map((item) => {
    const value = item.value === undefined || item.value === "" ? oldValues.get(`${item.name}:${item.kind}`) : item.value;
    if (value === undefined) throw new Error("New secret variables require a value");
    return { name: item.name, kind: item.kind, value };
  });
  const now = new Date().toISOString();
  db().prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, provider = excluded.provider, variables_encrypted = excluded.variables_encrypted, updated_at = excluded.updated_at").run(id, input.label.trim(), input.provider, encrypt(JSON.stringify(variables)), now, now);
  clearFiles(id);
  return { id, label: input.label.trim(), provider: input.provider, variables: variables.map(({ name, kind }) => ({ name, kind, configured: true })) };
}

export async function deleteSecretAccount(accountId: string): Promise<void> {
  const row = accountRow(accountId);
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM secret_assignments WHERE account_id = ?").run(row.id);
    db().prepare("DELETE FROM secret_accounts WHERE id = ?").run(row.id);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  clearFiles(row.id);
}

export async function getScopeSecretAccounts(scopeType: SecretScopeType, scopeId: string): Promise<{ accountIds: string[] }> {
  const canonical = canonicalScopeId(scopeType, scopeId);
  const rows = db().prepare("SELECT account_id FROM secret_assignments WHERE scope_type = ? AND scope_id = ? ORDER BY account_id").all(scopeType, canonical) as unknown as Array<{ account_id: string }>;
  return { accountIds: rows.map((row) => row.account_id) };
}

export async function setScopeSecretAccounts(scopeType: SecretScopeType, scopeId: string, accountIds: string[]): Promise<void> {
  const canonical = canonicalScopeId(scopeType, scopeId);
  if (new Set(accountIds).size !== accountIds.length) throw new Error("Secret account IDs must be unique");
  const rows = accountIds.map(accountRow);
  assertNoCollision(rows);
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM secret_assignments WHERE scope_type = ? AND scope_id = ?").run(scopeType, canonical);
    const insert = db().prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)");
    for (const id of accountIds) insert.run(scopeType, canonical, id);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

export function genericSecretEnvironment(project: string): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const { row, direct } of resolved(project)) for (const variable of storedVariables(row)) {
    if (!direct && variable.name in values) continue;
    if (variable.kind === "value") values[variable.name] = variable.value;
    else {
      const directory = path.join(dataDir, "secret-files", row.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const filePath = path.join(directory, variable.name);
      writeFileSync(filePath, variable.value, { mode: 0o600 });
      chmodSync(filePath, 0o600);
      values[variable.name] = filePath;
    }
  }
  // The gh CLI reads GH_TOKEN while most other GitHub tooling reads GITHUB_TOKEN, so one pasted token fills both.
  if (values.GH_TOKEN && !values.GITHUB_TOKEN) values.GITHUB_TOKEN = values.GH_TOKEN;
  if (values.GITHUB_TOKEN && !values.GH_TOKEN) values.GH_TOKEN = values.GITHUB_TOKEN;
  return values;
}

export function agentEnvironment(projectId: string): NodeJS.ProcessEnv {
  return { ...gitHubEnvironment(projectId), ...genericSecretEnvironment(projectId) };
}

/** Tells the agent which tool each provider's variables already unlock, so it runs the CLI instead of asking for keys. */
const providerHints: Record<SecretProvider, string> = {
  aws: "the AWS CLI and AWS SDKs read these automatically",
  google: "gcloud and the Google SDKs read GOOGLE_APPLICATION_CREDENTIALS automatically",
  github: "the gh CLI and the GitHub API read these automatically; git pushes use the GitHub group set for the project",
  custom: "plain environment variables for this project",
};

export function agentCredentialContext(project: string): string {
  const accounts = resolved(project);
  const github = gitHubEnvironment(project);
  if (!accounts.length && !github.GH_TOKEN) return "";
  const lines = ["## Available secret accounts", "These credentials are already exported into your shell. Use the matching CLI directly and never ask the user for the values, which stay hidden from you."];
  if (github.GH_TOKEN) lines.push(`- github "GitHub groups": GH_TOKEN, GITHUB_TOKEN - ${providerHints.github}`);
  for (const { row } of accounts) {
    const variables = storedVariables(row).map((item) => `${item.name}${item.kind === "file" ? " (secret file path)" : ""}`).join(", ");
    lines.push(`- ${row.provider} ${JSON.stringify(row.label)}: ${variables} - ${providerHints[row.provider]}`);
  }
  return lines.join("\n");
}
