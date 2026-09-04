import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isHarnessId, type HarnessId } from "./types.js";

export type SecretProvider = "aws" | "google" | "github" | "custom";
export type SecretKind = "value" | "file";
/** Attachment tiers, broadest first. Resolution merges them in this order. */
export type SecretScopeType = "workspace" | "project" | "conversation";
export type ConversationEngineId = HarnessId;
/** A conversation is identified by `<engine>:<sessionId>`. A brand-new conversation has no
    id until its engine reports one, so the accounts chosen in the new-conversation dialog
    travel as `accountIds` until `persistConversationSecretAccounts` can store them. */
export interface SecretConversation { engine: ConversationEngineId; sessionId?: string; accountIds?: string[] }
export interface SecretVariable { name: string; kind: SecretKind; configured: true }
export interface SecretAccount { id: string; label: string; provider: SecretProvider; replicate: boolean; variables: SecretVariable[] }
export interface SecretAccountInput { id?: string; label: string; provider: SecretProvider; replicate?: boolean; variables: Array<{ name: string; kind: SecretKind; value?: string }> }
type StoredVariable = { name: string; kind: SecretKind; value: string };
type AccountRow = { id: string; label: string; provider: SecretProvider; replicate: number; variables_encrypted: string };

/** A `github` account's variable set is fixed: the user never types the name. */
export const GITHUB_TOKEN_VARIABLE = "GH_TOKEN";

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
const keyPath = path.join(dataDir, "secret.key");
const askPassPath = path.join(dataDir, "github-askpass.sh");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database: DatabaseSync | undefined;

/** Creates the secret tables on whichever handle is passed, so `store.ts` and this module agree on shape. */
export function ensureSecretSchema(handle: DatabaseSync): void {
  handle.exec("CREATE TABLE IF NOT EXISTS secret_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, variables_encrypted TEXT NOT NULL, replicate INTEGER NOT NULL DEFAULT 0, origin_node_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secret_assignments (scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY(scope_type, scope_id, account_id)); CREATE INDEX IF NOT EXISTS secret_assignments_account_id ON secret_assignments(account_id);");
  // Homes created before per-account replication still carry the two-column shape.
  const columns = (handle.prepare("PRAGMA table_info(secret_accounts)").all() as unknown as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("replicate")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN replicate INTEGER NOT NULL DEFAULT 0");
  if (!columns.includes("origin_node_id")) handle.exec("ALTER TABLE secret_accounts ADD COLUMN origin_node_id TEXT NOT NULL DEFAULT ''");
}

function db(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureSecretSchema(database);
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
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const value = randomBytes(32);
    writeFileSync(keyPath, value.toString("base64"), { mode: 0o600 });
    return value;
  }
}

/** AES-256-GCM with this node's own key. Exported so the migration and the replication
    inbox can re-encrypt arriving material without a second key implementation. */
export function encryptSecretValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decryptSecretValue(value: string): string {
  const [iv, tag, body] = value.split(".");
  if (!iv || !tag || !body) throw new Error("Stored secret account is invalid");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  cipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(body, "base64")), cipher.final()]).toString("utf8");
}

function assertAccountId(id: string): void {
  if (!UUID_PATTERN.test(id)) throw new Error("Secret account ID must be a UUID");
}

export function conversationScopeId(engine: ConversationEngineId, sessionId: string): string {
  return `${engine}:${sessionId}`;
}

function assertScope(scopeType: string, scopeId: string): asserts scopeType is SecretScopeType {
  if (scopeType !== "workspace" && scopeType !== "project" && scopeType !== "conversation") throw new Error("Secret scope type must be workspace, project, or conversation");
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
  // The GitHub provider owns its variable name, so a typo cannot silently disable git push.
  if (input.provider === "github" && (input.variables.length !== 1 || input.variables[0].name !== GITHUB_TOKEN_VARIABLE || input.variables[0].kind !== "value")) {
    throw new Error(`GitHub secret accounts hold exactly one ${GITHUB_TOKEN_VARIABLE} value`);
  }
}

function storedVariables(row: AccountRow): StoredVariable[] {
  let value: unknown;
  try { value = JSON.parse(decryptSecretValue(row.variables_encrypted)); } catch { throw new Error("Stored secret account is invalid"); }
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
  const row = db().prepare("SELECT id, label, provider, replicate, variables_encrypted FROM secret_accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) throw new Error("Secret account not found");
  return row;
}

function publicAccount(row: AccountRow): SecretAccount {
  return { id: row.id, label: row.label, provider: row.provider, replicate: Boolean(row.replicate), variables: storedVariables(row).map(({ name, kind }) => ({ name, kind, configured: true })) };
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
  if (scopeType === "workspace") {
    if (!hasTable("workspaces") || !db().prepare("SELECT 1 FROM workspaces WHERE id = ?").get(requested)) throw new Error("Secret workspace not found");
    return requested;
  }
  if (scopeType === "conversation") {
    // A conversation exists as soon as its engine reports a session id, so the id shape
    // is the only thing to check; there is no row to look up.
    const [engine, sessionId] = requested.split(":", 2);
    if (!isHarnessId(engine) || !sessionId) throw new Error("Secret conversation scope must be <engine>:<sessionId>");
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

/** Joins through `secret_accounts`, so an attachment whose account is gone simply yields
    no row and the remaining scopes still resolve (FR8.5). */
function scopeRows(scopeType: SecretScopeType, scopeId: string): AccountRow[] {
  return db().prepare("SELECT a.id, a.label, a.provider, a.replicate, a.variables_encrypted FROM secret_assignments s JOIN secret_accounts a ON a.id = s.account_id WHERE s.scope_type = ? AND s.scope_id = ? ORDER BY a.id").all(scopeType, scopeId) as unknown as AccountRow[];
}

function assertNoCollision(rows: AccountRow[]): void {
  const names = new Set<string>();
  for (const row of rows) for (const variable of storedVariables(row)) {
    if (names.has(variable.name)) throw new Error("Selected secret accounts have duplicate environment variable names");
    names.add(variable.name);
  }
}

interface ResolvedAccount { row: AccountRow; scope: SecretScopeType }

/** Stored attachments plus any account picked for a conversation that has no id yet,
    deduplicated so a re-resolve after the id lands produces the same set. */
function conversationRows(conversation: SecretConversation): AccountRow[] {
  const stored = conversation.sessionId ? scopeRows("conversation", conversationScopeId(conversation.engine, conversation.sessionId)) : [];
  const seen = new Set(stored.map((row) => row.id));
  const pending = (conversation.accountIds ?? []).filter((id) => !seen.has(id)).map(accountRow);
  return [...stored, ...pending].sort((left, right) => left.id.localeCompare(right.id));
}

/** Broadest first: workspace, then project, then conversation. Callers apply them in this
    order so the most specific value of a given variable name is written last. */
function resolved(project: string, conversation?: SecretConversation): ResolvedAccount[] {
  const projectId = canonicalScopeId("project", project);
  const row = db().prepare("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as { workspace_id: string } | undefined;
  // The workspace id is read straight off the project rather than validated, so a project
  // pointing at a deleted workspace still resolves its project and conversation tiers.
  const workspace = row?.workspace_id ? scopeRows("workspace", row.workspace_id) : [];
  const direct = scopeRows("project", projectId);
  const session = conversation ? conversationRows(conversation) : [];
  return [
    ...workspace.map((account) => ({ row: account, scope: "workspace" as const })),
    ...direct.map((account) => ({ row: account, scope: "project" as const })),
    ...session.map((account) => ({ row: account, scope: "conversation" as const })),
  ];
}

export async function listSecretAccounts(): Promise<SecretAccount[]> {
  return (db().prepare("SELECT id, label, provider, replicate, variables_encrypted FROM secret_accounts ORDER BY label, id").all() as unknown as AccountRow[]).map(publicAccount);
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
  const replicate = input.replicate ? 1 : 0;
  const now = new Date().toISOString();
  db().prepare("INSERT INTO secret_accounts (id, label, provider, variables_encrypted, replicate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, provider = excluded.provider, variables_encrypted = excluded.variables_encrypted, replicate = excluded.replicate, updated_at = excluded.updated_at").run(id, input.label.trim(), input.provider, encryptSecretValue(JSON.stringify(variables)), replicate, now, now);
  clearFiles(id);
  return { id, label: input.label.trim(), provider: input.provider, replicate: Boolean(replicate), variables: variables.map(({ name, kind }) => ({ name, kind, configured: true })) };
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
  const previous = scopeType === "workspace" ? (await getScopeSecretAccounts(scopeType, canonical)).accountIds : [];
  const changed = [...new Set([...previous, ...accountIds])].filter((id) => previous.includes(id) !== accountIds.includes(id));
  db().exec("BEGIN IMMEDIATE");
  try {
    db().prepare("DELETE FROM secret_assignments WHERE scope_type = ? AND scope_id = ?").run(scopeType, canonical);
    const insert = db().prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)");
    for (const id of accountIds) insert.run(scopeType, canonical, id);
    const selectUpdatedAt = db().prepare("SELECT updated_at FROM secret_accounts WHERE id = ?");
    const touch = db().prepare("UPDATE secret_accounts SET updated_at = ? WHERE id = ?");
    for (const id of changed) {
      const row = selectUpdatedAt.get(id) as { updated_at: string };
      touch.run(new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1)).toISOString(), id);
    }
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

/** Written once per account, then handed to the agent as a path so the value never
    reaches an argument list or an environment dump. */
function secretFilePath(accountId: string, name: string, value: string): string {
  const directory = path.join(dataDir, "secret-files", accountId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const filePath = path.join(directory, name);
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

/** `git push` cannot read an environment variable, so it gets a helper script that prints one. */
function ensureAskPassHelper(): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(askPassPath, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$PI_GITHUB_TOKEN" ;;\nesac\n', { mode: 0o700 });
  return askPassPath;
}

/** GitHub is a provider, not a code path: this reads the already-resolved variable map and
    fans one token out to every name the tooling expects. No token means no GitHub variables. */
function applyGitHubEnvironment(values: NodeJS.ProcessEnv): void {
  // The gh CLI reads GH_TOKEN while most other GitHub tooling reads GITHUB_TOKEN, so one pasted token fills both.
  const token = values.GH_TOKEN ?? values.GITHUB_TOKEN;
  if (!token) return;
  values.GH_TOKEN = token;
  values.GITHUB_TOKEN = token;
  values.PI_GITHUB_TOKEN = token;
  values.GIT_ASKPASS = ensureAskPassHelper();
  values.GIT_TERMINAL_PROMPT = "0";
}

export function genericSecretEnvironment(project: string, conversation?: SecretConversation): NodeJS.ProcessEnv {
  const values: NodeJS.ProcessEnv = {};
  for (const { row } of resolved(project, conversation)) for (const variable of storedVariables(row)) {
    values[variable.name] = variable.kind === "value" ? variable.value : secretFilePath(row.id, variable.name, variable.value);
  }
  applyGitHubEnvironment(values);
  return values;
}

export function agentEnvironment(projectId: string, conversation?: SecretConversation): NodeJS.ProcessEnv {
  return genericSecretEnvironment(projectId, conversation);
}

/** Writes the accounts the new-conversation dialog picked, once the engine has reported the
    session id they belong to. Changing this on a running conversation is saved but does not
    restart the process: the environment was composed once, at spawn (FR9.5). */
export async function persistConversationSecretAccounts(engine: ConversationEngineId, sessionId: string, accountIds: string[]): Promise<void> {
  if (!accountIds.length) return;
  await setScopeSecretAccounts("conversation", conversationScopeId(engine, sessionId), accountIds);
}

/** Tells the agent which tool each provider's variables already unlock, so it runs the CLI instead of asking for keys. */
const providerHints: Record<SecretProvider, string> = {
  aws: "the AWS CLI and AWS SDKs read these automatically",
  google: "gcloud and the Google SDKs read GOOGLE_APPLICATION_CREDENTIALS automatically",
  github: "the gh CLI, the GitHub API and git push all read these automatically",
  custom: "plain environment variables for this project",
};

export function agentCredentialContext(project: string, conversation?: SecretConversation): string {
  const accounts = resolved(project, conversation);
  if (!accounts.length) return "";
  const lines = ["## Available secret accounts", "These credentials are already exported into your shell. Use the matching CLI directly and never ask the user for the values, which stay hidden from you."];
  for (const { row, scope } of accounts) {
    const variables = storedVariables(row).map((item) => `${item.name}${item.kind === "file" ? " (secret file path)" : ""}`).join(", ");
    lines.push(`- ${row.provider} ${JSON.stringify(row.label)} (${scope}): ${variables} - ${providerHints[row.provider]}`);
  }
  return lines.join("\n");
}
