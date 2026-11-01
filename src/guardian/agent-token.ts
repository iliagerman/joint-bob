import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { settingsDatabase } from "../settings-store.js";

// The Claude hook asks the server for Guardian's decision with this token. It names the one
// conversation a Claude run belongs to, so a hook can only ever ask about that conversation.
const lifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface GuardianAgentIdentity { projectId: string; conversationId: string; cwd: string }

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS guardian_agent_tokens (
    token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, cwd TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS guardian_agent_tokens_expiry ON guardian_agent_tokens(expires_at);`);
  return db;
}

/** What a Claude run's hook needs to reach Guardian: the hook script, the address and the token. */
export function guardianHookEnvironment(projectId: string, conversationId: string, cwd: string): NodeJS.ProcessEnv {
  const db = database();
  db.prepare("DELETE FROM guardian_agent_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO guardian_agent_tokens VALUES (?, ?, ?, ?, ?)").run(hash(token), projectId, conversationId, cwd, Date.now() + lifetime);
  return {
    JOINT_BOB_GUARDIAN_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/guardian/agent`,
    JOINT_BOB_GUARDIAN_TOKEN: token,
  };
}

export const guardianHookScript = () => fileURLToPath(new URL("../../bin/joint-bob-guardian.mjs", import.meta.url));

export function guardianAgentIdentity(token: string): GuardianAgentIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = database().prepare("SELECT project_id AS projectId, conversation_id AS conversationId, cwd FROM guardian_agent_tokens WHERE token_hash=? AND expires_at>?").get(hash(token), Date.now()) as GuardianAgentIdentity | undefined;
  return row ? { ...row } : undefined;
}

export function revokeGuardianAgentTokens(projectId: string, conversationId?: string): void {
  if (conversationId) database().prepare("DELETE FROM guardian_agent_tokens WHERE project_id = ? AND conversation_id = ?").run(projectId, conversationId);
  else database().prepare("DELETE FROM guardian_agent_tokens WHERE project_id = ?").run(projectId);
}
