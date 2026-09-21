import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { isHarnessId } from "./types.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";

export const queuedSettingsSchema = z.object({
  harnessId: z.string().refine(isHarnessId).optional(),
  provider: z.string().min(1).max(80), modelId: z.string().min(1).max(200),
  reasoning: z.enum(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  enabledTools: z.array(z.string()).optional(),
  claudeTools: z.object({ available: z.array(z.string()), enabled: z.array(z.string()).nullable() }).strict().optional(),
}).strict();
export type QueuedSettings = z.infer<typeof queuedSettingsSchema>;
const promptSchema = z.object({
  id: z.string().uuid(), requestId: z.string().uuid().optional(), systemEventId: z.string().uuid().optional(), dispatchState: z.enum(["pending", "starting"]).default("pending"), promptText: z.string(), displayText: z.string(),
  messageText: z.string().nullable(), promptSuffix: z.string().nullable(), displaySuffix: z.string().nullable(),
  attachmentPaths: z.array(z.string()), images: z.array(z.object({ path: z.string(), mimeType: z.string().min(1) }).strict()).default([]), settings: queuedSettingsSchema.nullable(), revision: z.number().int().positive(),
});
export type QueuedPrompt = z.infer<typeof promptSchema>;
interface Metadata { requestId?: string; systemEventId?: string; messageText: string; promptSuffix: string; displaySuffix: string; attachmentPaths: string[]; images?: Array<{ path: string; mimeType: string }>; settings?: QueuedSettings | null }
export type SystemPromptState = "pending" | "starting" | "consumed" | "missing";
interface Row { id: string; queue_key: string; prompt: string; created_at: string; sequence: number; revision: number; origin_node_id: string }
export interface QueuedPromptRef { id: string; revision: number }
const eventSchema = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1), id: z.string().uuid(), prompt: promptSchema.nullable(), createdAt: z.string(), sequence: z.number().int().positive(), revision: z.number().int().positive(), activeSettings: queuedSettingsSchema.optional() });
let database: DatabaseSync | undefined;

export function ensurePromptQueueSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS queued_prompts (
    id TEXT PRIMARY KEY, queue_key TEXT NOT NULL, prompt TEXT NOT NULL,
    created_at TEXT NOT NULL, sequence INTEGER NOT NULL, revision INTEGER NOT NULL, origin_node_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS queued_prompts_order ON queued_prompts(queue_key, sequence, id);
    CREATE TABLE IF NOT EXISTS queued_prompt_sequences (queue_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS queued_prompt_settings (queue_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL, settings TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS queued_prompt_tombstones (id TEXT PRIMARY KEY, queue_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_routing_state (queue_key TEXT PRIMARY KEY, prompt_count INTEGER NOT NULL DEFAULT 0, last_eval_ordinal INTEGER, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');`);
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
    queue_key = excluded.queue_key, prompt = excluded.prompt, created_at = excluded.created_at, sequence = excluded.sequence, revision = excluded.revision, origin_node_id = excluded.origin_node_id`)
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

export function enqueueSystemPrompt(queueKey: string, id: string, text: string): "queued" | "consumed" {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const tombstone = db.prepare("SELECT queue_key FROM queued_prompt_tombstones WHERE id = ?").get(id) as { queue_key: string } | undefined;
    const existing = db.prepare("SELECT queue_key FROM queued_prompts WHERE id = ?").get(id) as { queue_key: string } | undefined;
    const found = tombstone ?? existing;
    if (found && found.queue_key !== key) throw new Error("System prompt id belongs to a different queue");
    if (tombstone) return "consumed";
    if (existing) return "queued";
    const prompt = promptSchema.parse({ id, requestId: id, systemEventId: id, dispatchState: "pending", promptText: text, displayText: text, messageText: null, promptSuffix: null, displaySuffix: null, attachmentPaths: [], images: [], settings: null, revision: 1 });
    const row: Row = { id, queue_key: key, prompt: JSON.stringify(prompt), created_at: new Date().toISOString(), sequence: nextSequence(db, key), revision: 1, origin_node_id: origin(db) };
    insert(db, row);
    publish(db, row, prompt);
    return "queued";
  });
}

export function systemPromptState(queueKey: string, id: string): SystemPromptState {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  const row = db.prepare("SELECT queue_key,prompt FROM queued_prompts WHERE id = ?").get(id) as { queue_key: string; prompt: string } | undefined;
  if (row) {
    if (row.queue_key !== key) throw new Error("System prompt id belongs to a different queue");
    return promptSchema.parse(JSON.parse(row.prompt)).dispatchState;
  }
  const tombstone = db.prepare("SELECT queue_key FROM queued_prompt_tombstones WHERE id = ?").get(id) as { queue_key: string } | undefined;
  if (tombstone) {
    if (tombstone.queue_key !== key) throw new Error("System prompt id belongs to a different queue");
    return "consumed";
  }
  return "missing";
}

export function listPendingSystemQueues(limit = 100): Array<{ queueKey: string; id: string }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid system queue limit");
  const file = path.join(resolveDataDirectory(), "node.db");
  if (!database && !existsSync(file)) return [];
  const db = database ?? new DatabaseSync(file, { readOnly: true });
  const owned = db !== database;
  try {
    if (owned) db.exec("PRAGMA busy_timeout=5000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='queued_prompts'").get()) return [];
    const rows = db.prepare(`SELECT queue_key,prompt FROM queued_prompts
      WHERE json_extract(prompt,'$.systemEventId') IS NOT NULL
        AND COALESCE(json_extract(prompt,'$.dispatchState'),'pending')='pending'
      ORDER BY created_at,sequence,id LIMIT ?`).all(limit) as unknown as Array<{ queue_key: string; prompt: string }>;
    return rows.map((row) => {
      const prompt = promptSchema.parse(JSON.parse(row.prompt));
      return { queueKey: row.queue_key, id: prompt.id };
    });
  } finally { if (owned) db.close(); }
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

export function prioritizeQueuedPrompt(queueKey: string, id: string, expectedRevision: number): boolean {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const rows = db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ? ORDER BY sequence, id").all(key) as unknown as Row[];
    const targetIndex = rows.findIndex((row) => row.id === id && row.revision === expectedRevision);
    if (targetIndex < 0) return false;
    const target = promptSchema.parse(JSON.parse(rows[targetIndex].prompt));
    if (target.dispatchState !== "pending") return false;
    if (targetIndex === 0) return true;
    const sequences = rows.slice(0, targetIndex + 1).map((row) => row.sequence);
    const reordered = [rows[targetIndex], ...rows.slice(0, targetIndex)];
    for (const [index, row] of reordered.entries()) {
      const prompt = promptSchema.parse(JSON.parse(row.prompt));
      const updatedPrompt = { ...prompt, revision: row.revision + 1 };
      const updated = { ...row, sequence: sequences[index], revision: updatedPrompt.revision, prompt: JSON.stringify(updatedPrompt), origin_node_id: origin(db) };
      insert(db, updated);
      publish(db, updated, updatedPrompt);
    }
    return true;
  });
}

export function swapQueuedPrompts(queueKey: string, refs: QueuedPromptRef[]): boolean {
  if (refs.length !== 2) return false;
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const rows = refs.map(({ id }) => db.prepare("SELECT * FROM queued_prompts WHERE queue_key = ? AND id = ?").get(key, id) as unknown as Row | undefined);
    if (refs[0].id === refs[1].id || rows.some((row, index) => !row || row.revision !== refs[index].revision)) return false;
    const [first, second] = rows as [Row, Row];
    const prompts = rows.map((row) => promptSchema.parse(JSON.parse(row!.prompt)));
    if (prompts.some((prompt) => prompt.dispatchState !== "pending")) return false;
    for (const [row, sequence, previous] of [[first, second.sequence, prompts[0]], [second, first.sequence, prompts[1]]] as const) {
      const prompt = { ...previous, revision: row.revision + 1 };
      const updated = { ...row, sequence, prompt: JSON.stringify(prompt), revision: prompt.revision, origin_node_id: origin(db) };
      insert(db, updated);
      publish(db, updated, prompt);
    }
    return true;
  });
}

export function mergeQueuedPrompts(queueKey: string, refs: QueuedPromptRef[]): QueuedPrompt | null {
  if (refs.length < 2 || new Set(refs.map(({ id }) => id)).size !== refs.length) return null;
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const expected = new Map(refs.map(({ id, revision }) => [id, revision]));
    const rows = db.prepare(`SELECT * FROM queued_prompts WHERE queue_key = ? AND id IN (${refs.map(() => "?").join(",")}) ORDER BY sequence, id`).all(key, ...refs.map(({ id }) => id)) as unknown as Row[];
    if (rows.length !== refs.length || rows.some((row) => row.revision !== expected.get(row.id))) return null;
    const prompts = rows.map((row) => promptSchema.parse(JSON.parse(row.prompt)));
    if (prompts.some((prompt) => prompt.dispatchState !== "pending")) return null;
    const modern = prompts.every((prompt) => prompt.messageText !== null);
    const join = (values: Array<string | null>): string => values.filter((value): value is string => Boolean(value)).join("\n\n");
    const messageText = modern ? join(prompts.map((prompt) => prompt.messageText)) : null;
    const promptSuffix = modern ? join(prompts.map((prompt) => prompt.promptSuffix)) : null;
    const displaySuffix = modern ? join(prompts.map((prompt) => prompt.displaySuffix)) : null;
    const first = prompts[0];
    const prompt = promptSchema.parse({
      ...first,
      promptText: modern ? join([messageText, promptSuffix]) : join(prompts.map((item) => item.promptText)),
      displayText: modern ? join([messageText, displaySuffix]) : join(prompts.map((item) => item.displayText)),
      messageText, promptSuffix, displaySuffix,
      attachmentPaths: prompts.flatMap((item) => item.attachmentPaths),
      images: prompts.flatMap((item) => item.images),
      revision: rows[0].revision + 1,
    });
    for (const row of rows.slice(1)) remove(db, row);
    const updated = { ...rows[0], prompt: JSON.stringify(prompt), revision: prompt.revision, origin_node_id: origin(db) };
    insert(db, updated);
    publish(db, updated, prompt);
    return prompt;
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

/** Mark an automatic system prompt handled without ever making it dispatchable.
 * Pending prompts are removed; missing prompts receive a tombstone so a later
 * completion retry cannot recreate them. A starting prompt may already have
 * crossed the harness boundary and therefore remains fenced as uncertain. */
export function acknowledgeSystemPrompt(queueKey: string, id: string): boolean {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const tombstone = db.prepare("SELECT queue_key FROM queued_prompt_tombstones WHERE id = ?").get(id) as { queue_key: string } | undefined;
    const row = db.prepare("SELECT * FROM queued_prompts WHERE id = ?").get(id) as unknown as Row | undefined;
    const found = tombstone ?? row;
    if (found && found.queue_key !== key) throw new Error("System prompt id belongs to a different queue");
    if (tombstone) return true;
    if (row) {
      if (promptSchema.parse(JSON.parse(row.prompt)).dispatchState !== "pending") return false;
      remove(db, row);
      return true;
    }
    const createdAt = new Date().toISOString();
    const synthetic: Row = {
      id,
      queue_key: key,
      prompt: "",
      created_at: createdAt,
      sequence: nextSequence(db, key),
      revision: 1,
      origin_node_id: origin(db),
    };
    db.prepare("INSERT INTO queued_prompt_tombstones VALUES (?, ?)").run(id, key);
    publish(db, synthetic, null);
    return true;
  });
}
export interface ConversationRoutingState { promptCount: number; lastEvalOrdinal: number | null }

const routingStateEventSchema = z.object({
  projectId: z.string().min(1), conversationId: z.string().min(1),
  promptCount: z.number().int().min(0), lastEvalOrdinal: z.number().int().min(1).nullable(),
  updatedAt: z.string().min(1), originNodeId: z.string().min(1),
}).strict();

function readRoutingStateRow(db: DatabaseSync, key: string): (ConversationRoutingState & { updatedAt: string; originNodeId: string }) | undefined {
  const row = db.prepare("SELECT prompt_count, last_eval_ordinal, updated_at, origin_node_id FROM conversation_routing_state WHERE queue_key = ?").get(key) as { prompt_count: number; last_eval_ordinal: number | null; updated_at: string; origin_node_id: string } | undefined;
  return row ? { promptCount: row.prompt_count, lastEvalOrdinal: row.last_eval_ordinal, updatedAt: row.updated_at, originNodeId: row.origin_node_id } : undefined;
}

export function readRoutingState(queueKey: string): ConversationRoutingState {
  const row = readRoutingStateRow(queueDatabase(), logicalQueueKey(queueKey));
  return { promptCount: row?.promptCount ?? 0, lastEvalOrdinal: row?.lastEvalOrdinal ?? null };
}

function writeRoutingState(db: DatabaseSync, key: string, state: ConversationRoutingState, updatedAt?: string): void {
  const stamp = updatedAt ?? new Date().toISOString();
  db.prepare(`INSERT INTO conversation_routing_state(queue_key,prompt_count,last_eval_ordinal,updated_at,origin_node_id) VALUES (?,?,?,?,?)
    ON CONFLICT(queue_key) DO UPDATE SET prompt_count=excluded.prompt_count, last_eval_ordinal=excluded.last_eval_ordinal, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(key, state.promptCount, state.lastEvalOrdinal, stamp, origin(db));
  const separator = key.indexOf(":");
  enqueueReplicationEvent(db, {
    originNodeId: origin(db), entityType: "conversation.routing", entityKey: key, operation: "upsert",
    payload: { projectId: key.slice(0, separator), conversationId: key.slice(separator + 1), promptCount: state.promptCount, lastEvalOrdinal: state.lastEvalOrdinal, updatedAt: stamp, originNodeId: origin(db) },
  });
}

/** Counts one dispatched user prompt and returns its 1-based ordinal in the conversation. */
export function bumpRoutingPromptCount(queueKey: string): number {
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  return transaction(db, () => {
    const current = readRoutingStateRow(db, key);
    const ordinal = (current?.promptCount ?? 0) + 1;
    writeRoutingState(db, key, { promptCount: ordinal, lastEvalOrdinal: current?.lastEvalOrdinal ?? null });
    return ordinal;
  });
}

/** Marks an evaluation as consumed at this ordinal, so retries and later prompts
    continue the cadence from here instead of re-evaluating. */
export function recordRoutingEval(queueKey: string, ordinal: number): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("Routing eval ordinal must be a positive integer");
  const db = queueDatabase();
  const key = logicalQueueKey(queueKey);
  transaction(db, () => {
    const current = readRoutingStateRow(db, key);
    writeRoutingState(db, key, { promptCount: Math.max(current?.promptCount ?? 0, ordinal), lastEvalOrdinal: Math.max(current?.lastEvalOrdinal ?? 0, ordinal) });
  });
}

export function applyConversationRoutingEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "conversation.routing" || event.operation !== "upsert") throw new Error("Unsupported routing state replication event");
  const payload = routingStateEventSchema.parse(event.payload);
  if (event.entityKey !== `${payload.projectId}:${payload.conversationId}` || payload.originNodeId !== event.originNodeId) throw new Error("Malformed routing state replication event");
  ensurePromptQueueSchema(db);
  const key = `${resolveProjectAlias(db, payload.projectId)}:${payload.conversationId}`;
  const current = readRoutingStateRow(db, key);
  if (current && `${payload.updatedAt}\n${payload.originNodeId}` <= `${current.updatedAt}\n${current.originNodeId}`) return;
  db.prepare(`INSERT INTO conversation_routing_state(queue_key,prompt_count,last_eval_ordinal,updated_at,origin_node_id) VALUES (?,?,?,?,?)
    ON CONFLICT(queue_key) DO UPDATE SET prompt_count=excluded.prompt_count, last_eval_ordinal=excluded.last_eval_ordinal, updated_at=excluded.updated_at, origin_node_id=excluded.origin_node_id`)
    .run(key, payload.promptCount, payload.lastEvalOrdinal, payload.updatedAt, payload.originNodeId);
}
