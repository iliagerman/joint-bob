import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { supervisorDatabaseFile } from "./background-tasks.js";
import { resolveDataDirectory } from "./data-directory.js";

export interface BackgroundTaskAgentIdentity {
  projectId: string;
  conversationId: string;
}

function validIdentity(value: unknown): value is [string, string] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 200 && !part.includes("\0"));
}

export function backgroundTaskAgentIdentity(token: string): BackgroundTaskAgentIdentity | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let database: DatabaseSync | undefined;
  try {
    const file = supervisorDatabaseFile(resolveDataDirectory());
    if (!file) return null;
    database = new DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA busy_timeout=5000");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor_task_tokens'").get()) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = database.prepare("SELECT identity FROM supervisor_task_tokens WHERE token_hash=? AND expires_at>?").get(tokenHash, Date.now()) as { identity?: unknown } | undefined;
    if (typeof row?.identity !== "string") return null;
    const identity: unknown = JSON.parse(row.identity);
    if (!validIdentity(identity)) return null;
    return { projectId: identity[0], conversationId: identity[1] };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
