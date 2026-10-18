import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId, type HarnessId } from "./types.js";
import { accountEnvironmentForAgent, accountsForAgent, agentEnvironment, secretEnvironmentRevision, type SecretConversation } from "./secrets.js";

const lifetime = 30 * 24 * 60 * 60 * 1000;
let database: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (!database) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(path.join(directory, "node.db"));
    database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS secret_agent_tokens (
        token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        engine TEXT NOT NULL, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS secret_agent_tokens_expiry ON secret_agent_tokens(expires_at);`);
  }
  database.prepare("DELETE FROM secret_agent_tokens WHERE expires_at <= ?").run(Date.now());
  return database;
}

export function secretAgentIdentity(token: string): { projectId: string; conversation: SecretConversation } {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Secret account access is unavailable");
  const row = db().prepare("SELECT project_id AS projectId, engine, session_id AS sessionId FROM secret_agent_tokens WHERE token_hash=? AND expires_at>?")
    .get(createHash("sha256").update(token).digest("hex"), Date.now()) as { projectId: string; engine: HarnessId; sessionId: string } | undefined;
  if (!row || !isHarnessId(row.engine)) throw new Error("Secret account access is unavailable");
  return { projectId: row.projectId, conversation: { engine: row.engine, sessionId: row.sessionId } };
}

export function secretAgentEnvironment(projectId: string, engine: HarnessId, sessionId: string): NodeJS.ProcessEnv {
  if (!projectId || !isHarnessId(engine) || !sessionId) throw new Error("Secret agent requires a project and session identity");
  const token = randomBytes(32).toString("hex");
  db().prepare("INSERT INTO secret_agent_tokens (token_hash, project_id, engine, session_id, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(createHash("sha256").update(token).digest("hex"), projectId, engine, sessionId, Date.now() + lifetime);
  return {
    JOINT_BOB_SECRET_CLI: fileURLToPath(new URL("../bin/joint-bob-secret.mjs", import.meta.url)),
    JOINT_BOB_SECRET_TOKEN: token,
  };
}

export function secretAgentAccounts(token: string) {
  const { projectId, conversation } = secretAgentIdentity(token);
  return accountsForAgent(projectId, conversation);
}

export function secretAgentAccountEnvironment(token: string, accountId: string): { values: NodeJS.ProcessEnv; removeNames: string[] } {
  const { projectId, conversation } = secretAgentIdentity(token);
  return accountEnvironmentForAgent(projectId, conversation, accountId);
}

/** Refresh only the child command, not its running agent or browser credential snapshot.
    Capability settings retain precedence over secret variables, as they do at startup. */
export function refreshSecretAgentEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.JOINT_BOB_SECRET_TOKEN) return env;
  const { projectId, conversation } = secretAgentIdentity(env.JOINT_BOB_SECRET_TOKEN);
  const previous: unknown = JSON.parse(env.JOINT_BOB_SECRET_ENV_NAMES ?? "[]");
  if (!Array.isArray(previous) || previous.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("Invalid secret environment names");
  // Unchanged attachments need no file rewrites or fresh GitHub App token exchange
  // in each short-lived shell process. Normal agent turns still refresh expiring tokens.
  if (env.JOINT_BOB_SECRET_ENV_REVISION === secretEnvironmentRevision(projectId, conversation)) return env;
  const next = agentEnvironment(projectId, conversation);
  const protectedNames = new Set(["PATH", "CLAUDE_CODE_SHELL", "KIRO_CHAT_SHELL", "BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"]);
  const mutable = (name: string) => !name.startsWith("JOINT_BOB_") && !protectedNames.has(name);
  const refreshed = { ...env };
  for (const name of previous) if (mutable(name)) delete refreshed[name];
  for (const [name, value] of Object.entries(next)) if (mutable(name)) refreshed[name] = value;
  refreshed.JOINT_BOB_SECRET_ENV_NAMES = next.JOINT_BOB_SECRET_ENV_NAMES;
  refreshed.JOINT_BOB_SECRET_ENV_REVISION = next.JOINT_BOB_SECRET_ENV_REVISION;
  return refreshed;
}
