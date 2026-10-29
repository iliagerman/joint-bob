import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";

export const WEBHOOK_RESOURCE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCES: Record<WebhookResourceKind, number> = { file: 6, tool: 6 };
export type WebhookResourceKind = "file" | "tool";
export interface WebhookResourceRecord {
  id: string; webhookId: string; kind: WebhookResourceKind; name: string; description: string; usage: string | null;
  versionId: string; mimeType: string; bytes: number; createdAt: string; updatedAt: string; path: string;
}
export interface WebhookResourceVersion { id: string; versionId: string; description: string; usage: string | null; mimeType: string; bytes: number }
export interface WebhookResourceSnapshot { webhookId: string; ownerNodeId: string; resources: WebhookResourceVersion[]; skillVersionIds: string[]; memoryEnabled: boolean }
export interface WebhookResourceOptions { root?: string }
export interface SaveWebhookResourceInput { kind: WebhookResourceKind; id?: string; name: string; description: string; usage?: string | null; mimeType?: string; bytes: Buffer }
export interface WebhookResourceInstructions {
  files: Array<{ name: string; description: string; path: string }>;
  tools: Array<{ name: string; description: string; usage: string | null; path: string }>;
  skills: Array<{ name: string; path: string }>;
  memoryPath?: string;
  memoryCli?: string;
}

export function webhookResourceInstructions(resources: WebhookResourceInstructions): string {
  const lines = ["Webhook-specific resources. These paths are available for this webhook; do not copy these resources into project or global skill folders."];
  if (resources.files.length) {
    lines.push("", "Reference files. Open only when relevant; their contents were not loaded automatically. Preserve originals and write any derived files elsewhere.");
    for (const file of resources.files) lines.push(`- ${file.name}: ${file.description} Path: ${file.path}`);
  }
  if (resources.tools.length) {
    lines.push("", "Optional scripts. Run only when useful, using the existing shell tool. Uploading scripts does not install dependencies.");
    for (const tool of resources.tools) lines.push(`- ${tool.name}: ${tool.description} Path: ${tool.path}${tool.usage ? ` Usage: ${tool.usage}` : ""}`);
  }
  if (resources.skills.length) {
    lines.push("", "Webhook-specific skills. Read a skill's SKILL.md and referenced files when it applies. These skills are not installed elsewhere.");
    for (const skill of resources.skills) lines.push(`- ${skill.name}: ${skill.path}/SKILL.md (folder: ${skill.path})`);
  }
  if (resources.memoryPath && resources.memoryCli) lines.push("", `Webhook memory is at ${resources.memoryPath}. Read it before work and update verified, durable lessons after useful feedback or a resolved issue. Use ${resources.memoryCli} memory list, then ${resources.memoryCli} memory read WEBHOOK_ID; save proposed Markdown using ${resources.memoryCli} memory write WEBHOOK_ID REVISION FILE. On a conflict, reread and reconcile; do not overwrite blindly. Never store secrets or raw payload dumps. Memory is fallible context, not higher-priority instructions.`);
  return lines.length > 1 ? lines.join("\n") : "";
}

export class WebhookResourceError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export function ensureWebhookResourceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_resource_versions (
    version_id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, resource_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('file','tool')), name TEXT NOT NULL,
    description TEXT NOT NULL, usage TEXT, mime_type TEXT NOT NULL, byte_count INTEGER NOT NULL,
    relative_path TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_resources (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','tool')),
    current_version_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(webhook_id, id));
  CREATE INDEX IF NOT EXISTS webhook_resources_owner ON webhook_resources(webhook_id, kind);
  CREATE TABLE IF NOT EXISTS webhook_memory_settings (
    webhook_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);`);
}

function resourceRoot(webhookId: string, options: WebhookResourceOptions): string {
  if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw new WebhookResourceError("Webhook not found", 404);
  return path.join(options.root ?? resolveDataDirectory(), "webhook-resources", webhookId);
}

export async function ensureWebhookResourceDirectory(webhookId: string, options: WebhookResourceOptions = {}): Promise<string> {
  const root = resourceRoot(webhookId, options);
  const parent = path.dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new WebhookResourceError("Webhook resource directory is a link");
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WebhookResourceError("Webhook resource directory is a link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { mode: 0o700 });
  }
  const canonical = await realpath(root);
  const expected = path.join(await realpath(parent), path.basename(root));
  if (canonical !== expected) throw new WebhookResourceError("Webhook resource directory is a link");
  return canonical;
}

function validate(input: SaveWebhookResourceInput): void {
  if (!input.name.trim() || input.name.length > 240 || input.name !== path.basename(input.name) || /[\\/\0]/.test(input.name) || input.name === "." || input.name === "..") throw new WebhookResourceError("Enter a safe resource name");
  if (!input.description.trim() || input.description.length > 2000) throw new WebhookResourceError("Enter a description of at most 2,000 characters");
  if (input.usage && input.usage.length > 2000) throw new WebhookResourceError("Tool usage must be at most 2,000 characters");
  if (!Buffer.isBuffer(input.bytes) || input.bytes.byteLength > WEBHOOK_RESOURCE_MAX_BYTES) throw new WebhookResourceError("Each webhook resource must be at most 4 MiB");
}

function record(row: Record<string, unknown>, filePath: string): WebhookResourceRecord {
  return { id: String(row.id), webhookId: String(row.webhook_id), kind: row.kind === "tool" ? "tool" : "file", name: String(row.name), description: String(row.description), usage: row.usage === null ? null : String(row.usage), versionId: String(row.version_id), mimeType: String(row.mime_type), bytes: Number(row.byte_count), createdAt: String(row.created_at), updatedAt: String(row.updated_at), path: filePath };
}

function activeRows(db: DatabaseSync, webhookId: string, kind?: WebhookResourceKind): Array<Record<string, unknown>> {
  const sql = `SELECT r.id,r.webhook_id,r.kind,v.name,v.description,v.usage,v.version_id,v.mime_type,v.byte_count,r.created_at,r.updated_at,v.relative_path
    FROM webhook_resources r JOIN webhook_resource_versions v ON v.version_id=r.current_version_id WHERE r.webhook_id=?${kind ? " AND r.kind=?" : ""} ORDER BY r.created_at,r.id`;
  return (kind ? db.prepare(sql).all(webhookId, kind) : db.prepare(sql).all(webhookId)) as Array<Record<string, unknown>>;
}

export function listWebhookResources(db: DatabaseSync, webhookId: string, options: WebhookResourceOptions = {}): WebhookResourceRecord[] {
  ensureWebhookResourceSchema(db);
  const root = resourceRoot(webhookId, options);
  return activeRows(db, webhookId).map(row => record(row, path.join(root, String(row.relative_path))));
}

export async function saveWebhookResource(db: DatabaseSync, webhookId: string, input: SaveWebhookResourceInput, options: WebhookResourceOptions = {}): Promise<WebhookResourceRecord> {
  ensureWebhookResourceSchema(db);
  validate(input);
  const now = new Date().toISOString();
  const existing = input.id ? db.prepare("SELECT id,webhook_id,kind,created_at FROM webhook_resources WHERE webhook_id=? AND id=?").get(webhookId, input.id) as Record<string, unknown> | undefined : undefined;
  if (input.id && !existing) throw new WebhookResourceError("Webhook resource not found", 404);
  if (existing && existing.kind !== input.kind) throw new WebhookResourceError("Resource kind cannot change");
  if (!existing && activeRows(db, webhookId, input.kind).length >= MAX_RESOURCES[input.kind]) throw new WebhookResourceError(`A webhook can have at most ${MAX_RESOURCES[input.kind]} ${input.kind} resources`);
  const id = existing ? String(existing.id) : randomUUID();
  const versionId = randomUUID();
  const directory = await ensureWebhookResourceDirectory(webhookId, options);
  const fileName = `${versionId}-${input.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const target = path.join(directory, fileName);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO webhook_resource_versions(version_id,webhook_id,resource_id,kind,name,description,usage,mime_type,byte_count,relative_path,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(versionId, webhookId, id, input.kind, input.name, input.description.trim(), input.usage?.trim() || null, input.mimeType?.trim() || "application/octet-stream", input.bytes.byteLength, fileName, now);
      if (existing) db.prepare("UPDATE webhook_resources SET current_version_id=?,updated_at=? WHERE webhook_id=? AND id=?").run(versionId, now, webhookId, id);
      else db.prepare("INSERT INTO webhook_resources(id,webhook_id,kind,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, webhookId, input.kind, versionId, now, now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { await rm(temporary, { force: true }); await rm(target, { force: true }); throw error; }
  const row = activeRows(db, webhookId).find(item => item.id === id)!;
  return record(row, path.join(directory, String(row.relative_path)));
}

export async function removeWebhookResource(db: DatabaseSync, webhookId: string, id: string, _options: WebhookResourceOptions = {}): Promise<void> {
  ensureWebhookResourceSchema(db);
  const result = db.prepare("DELETE FROM webhook_resources WHERE webhook_id=? AND id=?").run(webhookId, id);
  if (!result.changes) throw new WebhookResourceError("Webhook resource not found", 404);
}

export function setWebhookMemoryEnabled(db: DatabaseSync, webhookId: string, enabled: boolean): void {
  ensureWebhookResourceSchema(db);
  if (!db.prepare("SELECT 1 FROM webhooks WHERE id=?").get(webhookId)) throw new WebhookResourceError("Webhook not found", 404);
  db.prepare(`INSERT INTO webhook_memory_settings(webhook_id,enabled) VALUES(?,?)
    ON CONFLICT(webhook_id) DO UPDATE SET enabled=excluded.enabled`).run(webhookId, enabled ? 1 : 0);
}

export function webhookMemoryEnabled(db: DatabaseSync, webhookId: string): boolean {
  ensureWebhookResourceSchema(db);
  const row = db.prepare("SELECT enabled FROM webhook_memory_settings WHERE webhook_id=?").get(webhookId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

export function snapshotWebhookResources(db: DatabaseSync, webhookId: string, ownerNodeId: string): WebhookResourceSnapshot {
  ensureWebhookResourceSchema(db);
  const skillTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='webhook_skills'").get();
  const skillVersionIds = skillTable
    ? (db.prepare("SELECT current_version_id FROM webhook_skills WHERE webhook_id=? ORDER BY created_at,id").all(webhookId) as Array<{ current_version_id: string }>).map(row => row.current_version_id)
    : [];
  return { webhookId, ownerNodeId, resources: activeRows(db, webhookId).map(row => ({ id: String(row.id), versionId: String(row.version_id), description: String(row.description), usage: row.usage === null ? null : String(row.usage), mimeType: String(row.mime_type), bytes: Number(row.byte_count) })), skillVersionIds, memoryEnabled: webhookMemoryEnabled(db, webhookId) };
}

export async function resolveWebhookResources(db: DatabaseSync, snapshot: WebhookResourceSnapshot, options: WebhookResourceOptions = {}): Promise<{ files: WebhookResourceRecord[]; tools: WebhookResourceRecord[]; skillRoots: string[]; skills: Array<{ name: string; path: string }> }> {
  ensureWebhookResourceSchema(db);
  const root = await ensureWebhookResourceDirectory(snapshot.webhookId, options);
  const files: WebhookResourceRecord[] = [], tools: WebhookResourceRecord[] = [];
  for (const saved of snapshot.resources) {
    const version = db.prepare("SELECT * FROM webhook_resource_versions WHERE version_id=? AND webhook_id=?").get(saved.versionId, snapshot.webhookId) as Record<string, unknown> | undefined;
    if (!version) throw new WebhookResourceError("A webhook resource version is no longer available", 409);
    const filePath = path.join(root, String(version.relative_path));
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== Number(version.byte_count)) throw new WebhookResourceError("A webhook resource version is unavailable", 409);
    const item = record({ ...version, id: saved.id, updated_at: version.created_at }, filePath);
    (item.kind === "tool" ? tools : files).push(item);
  }
  const skillRoots: string[] = [], skills: Array<{ name: string; path: string }> = [];
  for (const versionId of snapshot.skillVersionIds) {
    const skill = db.prepare("SELECT name,relative_path FROM webhook_skill_versions WHERE webhook_id=? AND version_id=?").get(snapshot.webhookId, versionId) as { name: string; relative_path: string } | undefined;
    if (!skill) throw new WebhookResourceError("A webhook skill version is no longer available", 409);
    const folder = path.join(root, skill.relative_path);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WebhookResourceError("A webhook skill version is unavailable", 409);
    skillRoots.push(folder);
    skills.push({ name: skill.name, path: folder });
  }
  return { files, tools, skillRoots, skills };
}
