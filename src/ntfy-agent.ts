import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { AgentCapabilityIdentity } from "./agent-capabilities.js";
import { settingsDatabase } from "./settings-store.js";
import { isHarnessId, type HarnessId } from "./types.js";

const lifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

function database(): DatabaseSync {
  const db = settingsDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS ntfy_agent_tokens (
    token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, engine TEXT NOT NULL,
    conversation_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS ntfy_agent_tokens_expiry ON ntfy_agent_tokens(expires_at);`);
  return db;
}

export function ntfyAgentEnvironment(projectId: string, engine: HarnessId, conversationId: string): NodeJS.ProcessEnv {
  if (!projectId || !conversationId) throw new Error("ntfy agent requires a project and conversation identity");
  if (!isHarnessId(engine)) throw new Error("ntfy agent requires a valid harness identity");
  const db = database();
  db.prepare("DELETE FROM ntfy_agent_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO ntfy_agent_tokens VALUES (?, ?, ?, ?, ?)").run(hash(token), projectId, engine, conversationId, Date.now() + lifetime);
  return {
    JOINT_BOB_NTFY_CLI: fileURLToPath(new URL("../bin/joint-bob-ntfy.mjs", import.meta.url)),
    JOINT_BOB_NTFY_URL: `http://127.0.0.1:${process.env.PORT || 8790}/api/ntfy/agent`,
    JOINT_BOB_NTFY_TOKEN: token,
  };
}

export function ntfyAgentIdentity(token: string): AgentCapabilityIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = database().prepare("SELECT project_id AS projectId, engine, conversation_id AS conversationId FROM ntfy_agent_tokens WHERE token_hash=? AND expires_at>?").get(hash(token), Date.now()) as AgentCapabilityIdentity | undefined;
  return row ? { ...row } : undefined;
}

export const ntfyAgentInstructions = `# Joint Bob ntfy

Use node "$JOINT_BOB_NTFY_CLI" status to list saved server IDs/names and this conversation's default topic. Send only when authorized: node "$JOINT_BOB_NTFY_CLI" send --topic X --message 'done' [--title TITLE] [--service ID]. Treat ntfy/channel and common typo intent as ntfy intent. When no service is specified, use the configured default; if no default is available, ask the user which saved server to use. If no default topic exists, ask for one. Do not use curl or discover addresses or credentials. Do not read or print the capability token. Never retry an uncertain timeout automatically. Success means the ntfy server accepted the request, not that a phone received it. Settings are read fresh; migrated enabled conversation destinations retain their replicated credential snapshot. A one-time send must not change automatic review settings.`;
