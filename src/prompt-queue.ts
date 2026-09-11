import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";

export const queuedSettingsSchema = z.object({
  provider: z.string().min(1).max(80), modelId: z.string().min(1).max(200),
  reasoning: z.enum(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  claudeTools: z.object({ available: z.array(z.string()), enabled: z.array(z.string()).nullable() }).strict().optional(),
}).strict().superRefine((value, context) => {
  const invalid = value.provider === "claude" ? ["off", "minimal"].includes(value.reasoning) : value.reasoning === "default";
  if (invalid) context.addIssue({ code: z.ZodIssueCode.custom, message: "Reasoning level does not belong to the selected engine" });
});
export type QueuedSettings = z.infer<typeof queuedSettingsSchema>;
const promptSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid().optional(), dispatchState: z.enum(["pending", "starting"]).default("pending"), promptText: z.string(), displayText: z.string(),
  messageText: z.string().nullable(), promptSuffix: z.string().nullable(), displaySuffix: z.string().nullable(),
  attachmentPaths: z.array(z.string()), images: z.array(z.object({ path: z.string(), mimeType: z.string().min(1) }).strict()).default([]), settings: queuedSettingsSchema.nullable(), revision: z.number().int().positive(),
});
export type QueuedPrompt = z.infer<typeof promptSchema>;
interface Metadata { requestId?: string; messageText: string; promptSuffix: string; displaySuffix: string; attachmentPaths: string[]; images?: Array<{ path: string; mimeType: string }>; settings?: QueuedSettings | null }
interface Row { id: string; queue_key: string; prompt: string; created_at: string; sequence: number; revision: number; origin_node_id: string }
const eventSchema = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1), id: z.string().uuid(), prompt: promptSchema.nullable(), createdAt: z.string(), sequence: z.number().int().positive(), revision: z.number().int().positive(), activeSettings: queuedSettingsSchema.optional() });
let database: DatabaseSync | undefined;

export function ensurePromptQueueSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS queued_prompts (
    id TEXT PRIMARY KEY, queue_key TEXT NOT NULL, prompt TEXT NOT NULL,
    created_at TEXT NOT NULL, sequence INTEGER NOT NULL, revision INTEGER NOT NULL, origin_node_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS queued_prompts_order ON queued_prompts(queue_key, sequence, id);
    CREATE TABLE IF NOT EXISTS queued_prompt_sequences (queue_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queued_prompt_settings (queue_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL, settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queued_prompt_tombstones (id TEXT PRIMARY KEY, queue_key TEXT NOT NULL);`);
}

function queueDatabase(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensurePromptQueueSchema(db);
  ensureReplicationSchema(db);
  try { migrateLegacyPrompts(db); }
  catch (error) { db.close(); throw error; }
  database = db;
  return db;
}

function origin(db: DatabaseSync): string {
  const node = db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined;
  if (!node) throw new Error("Queue requires a node identity");
  return node.id;
}

/** Resolve old segment keys through node-local conversation records. */
export function logicalQueueKey(queueKey: string): string {
  return resolveQueueKey(queueDatabase(), queueKey);
}

function resolveQueueKey(db: DatabaseSync, queueKey: string): string {
  const separator = queueKey.indexOf(":");
  const project = resolveProjectAlias(db, queueKey.slice(0, separator));
  const session = queueKey.slice(separator + 1);
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_records'").get();
  const record = exists ? db.prepare("SELECT conversation_id FROM conversation_records WHERE project_id = ? AND session_id = ? AND conversation_id IS NOT NULL").get(project, session) as { conversation_id: string } | undefined : undefined;
  return `${project}:${record ? record.conversation_id : session}`;
}

function publish(db: DatabaseSync, row: Row, prompt: QueuedPrompt | null): void {
  const separator = row.queue_key.indexOf(":");
  enqueueReplicationEvent(db, {
    originNodeId: origin(db), entityType: "conversation.queue", entityKey: row.id, operation: prompt ? "upsert" : "delete",
    payload: { projectId: row.queue_key.slice(0, separator), conversationId: row.queue_key.slice(separator + 1), id: row.id, prompt, createdAt: row.created_at, sequence: row.sequence, revision: row.revision },
  });
}

function transaction<T>(db: DatabaseSync, change: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = change(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function migrateLegacyPrompts(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversation_prompt_queue'").get()) return;
  const rows = db.prepare("SELECT * FROM conversation_prompt_queue ORDER BY id").all();
  transaction(db, () => {
    for (const row of rows) {
      const prompt: QueuedPrompt = { id: randomUUID(), dispatchState: "pending", promptText: String(row.prompt_text), displayText: String(row.display_text), messageText: typeof row.message_text === "string" ? row.message_text : null, promptSuffix: typeof row.prompt_suffix === "string" ? row.prompt_suffix : null, displaySuffix: typeof row.display_suffix === "string" ? row.display_suffix : null, attachmentPaths: row.attachment_paths ? JSON.parse(String(row.attachment_paths)) : [], images: [], settings: null, revision: 1 };
      const stored: Row = { id: prompt.id, queue_key: resolveQueueKey(db, String(row.queue_key)), prompt: JSON.stringify(prompt), created_at: String(row.created_at), sequence: nextSequence(db, resolveQueueKey(db, String(row.queue_key))), revision: 1, origin_node_id: origin(db) };
      insert(db, stored);
      publish(db, stored, prompt);
    }
    db.exec("DROP TABLE conversation_prompt_queue");
  });
}

function nextSequence(db: DatabaseSync, key: string): number {
  return (db.prepare(`INSERT INTO queued_prompt_sequences VALUES (?, 1) ON CONFLICT(queue_key) DO UPDATE SET sequence = sequence + 1 RETURNING sequence`).get(key) as { sequence: number }).sequence;
}

function insert(db: DatabaseSync, row: Row): void {
  db.prepare("INSERT INTO queued_prompt_sequences VALUES (?, ?) ON CONFLICT(queue_key) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)").run(row.queue_key, row.sequence);
  db.prepare(`INSERT INTO queued_prompts VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    queue_key = excluded.queue_key, prompt = excluded.prompt, revision = excluded.revision, origin_node_id = excluded.origin_node_id`)
    .run(row.id, row.queue_key, row.prompt, row.created_at, row.sequence, row.revision, row.origin_node_id);
}

export function enqueuePrompt(queueKey: string, promptText: string, displayText: string, metadata: Metadata): QueuedPrompt {
  const db = queueDatabase();
  const prompt = promptSchema.parse({ id: randomUUID(), promptText, displayText, ...metadata, settings: metadata.settings ?? null, revision: 1 });
  const key = logicalQueueKey(queueKey);
  transaction(db, () => {
    const row: Row = { id: prompt.id, queue_key: key, prompt: JSON.stringify(prompt), created_at: new Date().toISOString(), sequence: nextSequence(db, key), revision: 1, origin_node_id: origin(db) };
    insert(db, row); publish(db, row, prompt);
  });
  return prompt;
}

export function listQueuedPrompts(queueKey: string): QueuedPrompt[] {
  return (queueDatabase().prepare("SELECT prompt FROM queued_prompts WHERE queue_key = ? ORDER BY sequence, id").all(logicalQueueKey(queueKey)) as { prompt: string }[]).map((row) => promptSchema.parse(JSON.parse(row.prompt)));
}

function remove(db: DatabaseSync, row: Row): QueuedPrompt {
  db.prepare("DELETE FROM queued_prompts WHERE id = ?").run(row.id);
  db.prepare("INSERT OR IGNORE INTO queued_prompt_tombstones VALUES (?, ?)").run(row.id, row.queue_key);
  publish(db, row, null);
  return promptSchema.parse(JSON.parse(row.prompt));
}

export function recordQueueSettings(queueKey: string, settings: QueuedSettings): void {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  const activeSettings = queuedSettingsSchema.parse(settings);
  transaction(db, () => storeQueueSettings(db, key, activeSettings));
}

function storeQueueSettings(db: DatabaseSync, key: string, activeSettings: QueuedSettings): void {
  const sequence = nextSequence(db, key);
  db.prepare("INSERT INTO queued_prompt_settings VALUES (?, ?, ?) ON CONFLICT(queue_key) DO UPDATE SET sequence = excluded.sequence, settings = excluded.settings").run(key, sequence, JSON.stringify(activeSettings));
  const separator = key.indexOf(":");
  enqueueReplicationEvent(db, { originNodeId: origin(db), entityType: "conversation.queue", entityKey: key, operation: "settings", payload: { projectId: key.slice(0, separator), conversationId: key.slice(separator + 1), id: randomUUID(), prompt: null, createdAt: new Date().toISOString(), revision: 1, sequence, activeSettings } });
}

export function readQueueSettings(queueKey: string): QueuedSettings | null {
  const db = queueDatabase();
  const row = db.prepare("SELECT settings FROM queued_prompt_settings WHERE queue_key = ?").get(logicalQueueKey(queueKey)) as { settings: string } | undefined;
  return row ? queuedSettingsSchema.parse(JSON.parse(row.settings)) : null;
}

export function beginQueuedPrompt(id: string, revision: number): boolean {
  return transitionQueueAttempt(id, "starting", revision);
}

export function resetQueuedPromptAttempt(id: string): boolean {
  return transitionQueueAttempt(id, "pending");
}

function transitionQueueAttempt(id: string, dispatchState: "pending" | "starting", revision?: number): boolean {
  const db = queueDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM queued_prompts WHERE id = ?").get(id) as unknown as Row | undefined;
    if (!row || revision !== undefined && row.revision !== revision) return false;
    const previous = promptSchema.parse(JSON.parse(row.prompt));
    if (previous.dispatchState === dispatchState) return false;
    const prompt = { ...previous, dispatchState, revision: row.revision + 1 };
    const updated = { ...row, prompt: JSON.stringify(prompt), revision: prompt.revision, origin_node_id: origin(db) };
    insert(db, updated); publish(db, updated, prompt);
    return true;
  });
}

export function claimQueuedPrompt(id: string, settings: QueuedSettings | null = null): boolean {
  const db = queueDatabase();
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM queued_prompts WHERE id = ?").get(id) as unknown as Row | undefined;
    if (!row) return false;
    remove(db, row);
    if (settings) storeQueueSettings(db, row.queue_key, queuedSettingsSchema.parse(settings));
    return true;
  });
}

export function cancelQueuedPrompt(queueKey: string, id: string, expectedRevision?: number): QueuedPrompt | null {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ? AND id = ?").get(key, id) as unknown as Row | undefined;
    return row && (expectedRevision === undefined || row.revision === expectedRevision) ? remove(db, row) : null;
  });
}

export function editQueuedPrompt(queueKey: string, id: string, promptText: string, displayText: string, messageText: string, settings?: QueuedSettings | null, expectedRevision?: number): boolean {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const row = db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ? AND id = ?").get(key, id) as unknown as Row | undefined;
    if (!row || expectedRevision !== undefined && row.revision !== expectedRevision) return false;
    const existing = promptSchema.parse(JSON.parse(row.prompt));
    const prompt = promptSchema.parse({ ...existing, dispatchState: "pending", promptText, displayText, messageText, settings: settings === undefined ? existing.settings : settings, revision: row.revision + 1 });
    const updated = { ...row, prompt: JSON.stringify(prompt), revision: prompt.revision, origin_node_id: origin(db) };
    insert(db, updated);
    publish(db, updated, prompt);
    return true;
  });
}

export function clearQueuedPrompts(queueKey: string): void {
  for (const prompt of listQueuedPrompts(queueKey)) cancelQueuedPrompt(queueKey, prompt.id);
}

export function rekeyQueuedPrompts(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const db = queueDatabase();
  transaction(db, () => {
    for (const row of db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ?").all(fromKey) as unknown as Row[]) {
      const prompt = promptSchema.parse(JSON.parse(row.prompt));
      prompt.revision += 1;
      const updated = { ...row, queue_key: toKey, revision: prompt.revision, prompt: JSON.stringify(prompt), origin_node_id: origin(db) };
      insert(db, updated);
      publish(db, updated, prompt);
    }
  });
}

export function queuedPromptSnapshot(queueKey: string): ReplicationEvent[] {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  const separator = key.indexOf(":");
  const projectId = key.slice(0, separator);
  const conversationId = key.slice(separator + 1);
  const base = { originNodeId: origin(db), entityType: "conversation.queue", createdAt: new Date().toISOString() };
  const active = (db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ?").all(key) as unknown as Row[]).map((row) => ({
    ...base, id: randomUUID(), entityKey: row.id, operation: "upsert", payload: { projectId, conversationId, id: row.id, prompt: JSON.parse(row.prompt), revision: row.revision, sequence: row.sequence, createdAt: row.created_at },
  }));
  const removed = (db.prepare("SELECT id FROM queued_prompt_tombstones WHERE queue_key = ?").all(key) as { id: string }[]).map((row) => ({
    ...base, id: randomUUID(), entityKey: row.id, operation: "delete", payload: { projectId, conversationId, id: row.id, prompt: null, revision: 1, sequence: 1, createdAt: base.createdAt },
  }));
  const settings = db.prepare("SELECT sequence, settings FROM queued_prompt_settings WHERE queue_key = ?").get(key) as { sequence: number; settings: string } | undefined;
  const state: ReplicationEvent[] = settings ? [{ ...base, id: randomUUID(), entityKey: key, operation: "settings", payload: { projectId, conversationId, id: randomUUID(), prompt: null, revision: 1, sequence: settings.sequence, activeSettings: JSON.parse(settings.settings), createdAt: base.createdAt } }] : [];
  return [...active, ...removed, ...state];
}

/** Deletion is terminal, including against a delayed edit with a higher revision. */
export function applyQueuedPromptEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const payload = eventSchema.parse(event.payload);
  if (event.entityType !== "conversation.queue" || event.entityKey !== (event.operation === "settings" ? `${payload.projectId}:${payload.conversationId}` : payload.id) || !["upsert", "delete", "settings"].includes(event.operation) || (event.operation === "upsert") !== Boolean(payload.prompt)) throw new Error("Malformed queue replication event");
  if (payload.prompt && (payload.prompt.id !== payload.id || payload.prompt.revision !== payload.revision)) throw new Error("Malformed queue replication revision");
  ensurePromptQueueSchema(db);
  const key = `${resolveProjectAlias(db, payload.projectId)}:${payload.conversationId}`;
  if (event.operation === "settings") {
    if (!payload.activeSettings) throw new Error("Missing conversation settings");
    db.prepare("INSERT INTO queued_prompt_sequences VALUES (?, ?) ON CONFLICT(queue_key) DO UPDATE SET sequence = MAX(sequence, excluded.sequence)").run(key, payload.sequence);
    db.prepare("INSERT INTO queued_prompt_settings VALUES (?, ?, ?) ON CONFLICT(queue_key) DO UPDATE SET sequence = excluded.sequence, settings = excluded.settings WHERE excluded.sequence > sequence").run(key, payload.sequence, JSON.stringify(payload.activeSettings));
    return;
  }
  if (!payload.prompt) {
    db.prepare("DELETE FROM queued_prompts WHERE id = ?").run(payload.id);
    db.prepare("INSERT OR IGNORE INTO queued_prompt_tombstones VALUES (?, ?)").run(payload.id, key);
    return;
  }
  if (db.prepare("SELECT 1 FROM queued_prompt_tombstones WHERE id = ?").get(payload.id)) return;
  const current = db.prepare("SELECT revision, origin_node_id FROM queued_prompts WHERE id = ?").get(payload.id) as { revision: number; origin_node_id: string } | undefined;
  if (current && (current.revision > payload.revision || current.revision === payload.revision && current.origin_node_id >= event.originNodeId)) return;
  insert(db, { id: payload.id, queue_key: key, prompt: JSON.stringify(payload.prompt), created_at: payload.createdAt, sequence: payload.sequence, revision: payload.revision, origin_node_id: event.originNodeId });
}
