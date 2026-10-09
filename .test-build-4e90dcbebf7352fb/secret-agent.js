import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId } from "./types.js";
import { accountEnvironmentForAgent, accountsForAgent } from "./secrets.js";
const lifetime = 30 * 24 * 60 * 60 * 1e3;
let database;
function db() {
  if (!database) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 448 });
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
function identity(token) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Secret account access is unavailable");
  const row = db().prepare("SELECT project_id AS projectId, engine, session_id AS sessionId FROM secret_agent_tokens WHERE token_hash=? AND expires_at>?").get(createHash("sha256").update(token).digest("hex"), Date.now());
  if (!row || !isHarnessId(row.engine)) throw new Error("Secret account access is unavailable");
  return { projectId: row.projectId, conversation: { engine: row.engine, sessionId: row.sessionId } };
}
function secretAgentEnvironment(projectId, engine, sessionId) {
  if (!projectId || !isHarnessId(engine) || !sessionId) throw new Error("Secret agent requires a project and session identity");
  const token = randomBytes(32).toString("hex");
  db().prepare("INSERT INTO secret_agent_tokens (token_hash, project_id, engine, session_id, expires_at) VALUES (?, ?, ?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), projectId, engine, sessionId, Date.now() + lifetime);
  return {
    JOINT_BOB_SECRET_CLI: fileURLToPath(new URL("../bin/joint-bob-secret.mjs", import.meta.url)),
    JOINT_BOB_SECRET_TOKEN: token
  };
}
function secretAgentAccounts(token) {
  const { projectId, conversation } = identity(token);
  return accountsForAgent(projectId, conversation);
}
function secretAgentAccountEnvironment(token, accountId) {
  const { projectId, conversation } = identity(token);
  return accountEnvironmentForAgent(projectId, conversation, accountId);
}
export {
  secretAgentAccountEnvironment,
  secretAgentAccounts,
  secretAgentEnvironment
};
