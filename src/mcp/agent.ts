import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { actingAccount, type ActingAccount } from "../account-context.js";
import { JOINT_BOB_TOOL_SERVER, reservedMcpServerName } from "../assistant-collaboration/bridge-tools.js";
import { resolveDataDirectory } from "../data-directory.js";
import type { HarnessId } from "../types.js";
import { ManagedMcpStore, type ManagedMcpServer } from "./store.js";

export interface McpAgentIdentity { account: ActingAccount; projectId: string; conversationId: string; engine: HarnessId }
let database: DatabaseSync | undefined;
function db() {
  if (!database) {
    const root = resolveDataDirectory(); mkdirSync(root, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(path.join(root, "node.db"));
    database.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS mcp_agent_tokens (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires INTEGER NOT NULL)");
  }
  return database;
}
export function managedMcpStore(accountId: string) { return new ManagedMcpStore(resolveDataDirectory(), accountId); }
export function mcpAgentEnvironment(projectId: string, engine: HarnessId, conversationId: string): NodeJS.ProcessEnv {
  const account = actingAccount();
  if (!account) return {};
  const token = randomBytes(32).toString("hex"), identity: McpAgentIdentity = { account, projectId, engine, conversationId };
  db().prepare("DELETE FROM mcp_agent_tokens WHERE expires <= ?").run(Date.now());
  db().prepare("INSERT INTO mcp_agent_tokens VALUES (?,?,?)").run(createHash("sha256").update(token).digest("hex"), JSON.stringify(identity), Date.now() + 30 * 86400_000);
  return { JOINT_BOB_MCP_API: `http://127.0.0.1:${process.env.PORT ?? "8790"}/api/mcp/agent`, JOINT_BOB_MCP_TOKEN: token };
}
export function mcpAgentIdentity(token: string): McpAgentIdentity | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = db().prepare("SELECT identity FROM mcp_agent_tokens WHERE hash=? AND expires>?").get(createHash("sha256").update(token).digest("hex"), Date.now()) as { identity: string } | undefined;
  return row ? JSON.parse(row.identity) as McpAgentIdentity : undefined;
}
export function revokeMcpAgentTokens(projectId: string, conversationId?: string) {
  const query = "DELETE FROM mcp_agent_tokens WHERE json_extract(identity,'$.projectId')=?";
  if (conversationId) db().prepare(`${query} AND json_extract(identity,'$.conversationId')=?`).run(projectId, conversationId);
  else db().prepare(query).run(projectId);
}
export function nativeMcpServerConfigs(): Record<string, ManagedMcpServer> {
  const account = actingAccount();
  if (!account) return {};
  return Object.fromEntries(Object.entries(managedMcpStore(account.accountId).servers())
    .filter(([name, server]) => server.authMode === "native" && !reservedMcpServerName(name))
    .map(([name, { authMode: _mode, ...server }]) => [name, server]));
}

export function managedMcpBridgeConfigs(): Record<string, { command: string; args: string[] }> {
  const account = actingAccount();
  if (!account) return {};
  const bridge = fileURLToPath(new URL("../../bin/joint-bob-mcp.mjs", import.meta.url));
  // Joint Bob's own tools ride the same bridge, so every account's agents get it. A stored server by a reserved name never does.
  const names = [...Object.entries(managedMcpStore(account.accountId).servers()).filter(([name, server]) => server.authMode !== "native" && !reservedMcpServerName(name)).map(([name]) => name), JOINT_BOB_TOOL_SERVER];
  return Object.fromEntries(names.map(name => [name, { command: process.execPath, args: [bridge, name] }]));
}
