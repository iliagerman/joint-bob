import { mkdir, mkdtemp, realpath, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";

export function ensureWebhookWorkspaceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_conversation_workspaces (
    project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
    webhook_id TEXT NOT NULL, directory TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, engine, session_id));`);
}

export async function createWebhookWorkspace(webhookId: string, preserveFiles: boolean): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw new Error("Webhook not found");
  const root = resolveDataDirectory();
  const base = path.join(root, "webhook-workspaces");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new Error("Webhook workspace directory is a link");
  if (!preserveFiles) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `joint-bob-webhook-${webhookId}-`));
    return realpath(directory);
  }
  const directory = path.join(base, webhookId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Webhook workspace directory is a link");
  return realpath(directory);
}

export function setWebhookConversationWorkspace(db: DatabaseSync, projectId: string, engine: string, sessionId: string, webhookId: string, directory: string): void {
  ensureWebhookWorkspaceSchema(db);
  db.prepare(`INSERT INTO webhook_conversation_workspaces(project_id,engine,session_id,webhook_id,directory,created_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,engine,session_id) DO UPDATE SET webhook_id=excluded.webhook_id,directory=excluded.directory,created_at=excluded.created_at`)
    .run(projectId, engine, sessionId, webhookId, directory, new Date().toISOString());
}

export function webhookConversationWorkspace(db: DatabaseSync, projectId: string, engine: string, sessionId: string): string | undefined {
  ensureWebhookWorkspaceSchema(db);
  const row = db.prepare("SELECT directory FROM webhook_conversation_workspaces WHERE project_id=? AND engine=? AND session_id=?")
    .get(projectId, engine, sessionId) as { directory: string } | undefined;
  return row?.directory;
}
