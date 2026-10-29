import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ensureWebhookResourceDirectory, setWebhookMemoryEnabled as setEnabled, type WebhookResourceOptions, WebhookResourceError } from "./webhook-resources.js";
import { ensureWebhookResourceSchema } from "./webhook-resources.js";

export const WEBHOOK_MEMORY_MAX_BYTES = 200_000;
const memoryLocks = new Map<string, Promise<void>>();
export interface WebhookMemory { content: string; revision: string; path: string }

function memoryPath(directory: string): string { return path.join(directory, "MEMORY.md"); }
async function readMemoryBytes(file: string): Promise<Buffer> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new WebhookResourceError("Webhook memory file is unavailable", 409);
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}
function revision(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export function setWebhookMemoryEnabled(db: DatabaseSync, webhookId: string, enabled: boolean): void {
  setEnabled(db, webhookId, enabled);
}

export async function readWebhookMemory(webhookId: string, options: WebhookResourceOptions = {}): Promise<WebhookMemory> {
  const file = memoryPath(await ensureWebhookResourceDirectory(webhookId, options));
  const bytes = await readMemoryBytes(file);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new WebhookResourceError("Webhook memory is not valid UTF-8", 409); }
  return { content, revision: revision(bytes), path: file };
}

async function withMemoryLock<T>(webhookId: string, work: () => Promise<T>): Promise<T> {
  const previous = memoryLocks.get(webhookId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  memoryLocks.set(webhookId, queued);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (memoryLocks.get(webhookId) === queued) memoryLocks.delete(webhookId);
  }
}

export async function writeWebhookMemory(db: DatabaseSync, webhookId: string, expectedRevision: string, content: string, options: WebhookResourceOptions = {}): Promise<WebhookMemory> {
  ensureWebhookResourceSchema(db);
  if (!db.prepare("SELECT 1 FROM webhooks WHERE id=?").get(webhookId)) throw new WebhookResourceError("Webhook not found", 404);
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > WEBHOOK_MEMORY_MAX_BYTES) throw new WebhookResourceError("Webhook memory must be at most 200,000 bytes");
  const directory = await ensureWebhookResourceDirectory(webhookId, options);
  const file = memoryPath(directory);
  const temporary = `${file}.${randomUUID()}.tmp`;
  return withMemoryLock(webhookId, async () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = await readMemoryBytes(file);
      if (revision(current) !== expectedRevision) throw new WebhookResourceError("Webhook memory changed since you read it. Reload and reconcile before saving.", 409);
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      await rm(temporary, { force: true });
      throw error;
    }
    return { content, revision: revision(bytes), path: file };
  });
}
