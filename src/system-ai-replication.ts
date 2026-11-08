import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { backgroundAgentSchema, dashboardAgentSchema, syncCheckSchema } from './settings.js';
import { summaryInstructionsSchema, summaryPolicySchema } from './conversation-summary-policy.js';
import { systemAiSchema } from './system-ai-config.js';
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from './replication.js';
import { save, settingsDatabase } from './settings-store.js';
import { getClusterNode } from './cluster.js';

export const SYSTEM_AI_KEYS = ['systemAI', 'backgroundAgent', 'syncCheck', 'dashboards', 'conversationSummary', 'conversationSummaryInstructions'] as const;
type SharedKey = typeof SYSTEM_AI_KEYS[number];
const eventSchema = z.object({ key: z.enum(SYSTEM_AI_KEYS), value: z.string().max(30000), revision: z.number().int().positive(), originNodeId: z.string().uuid() }).strict();
function validate(key: string, value: string): SharedKey {
  const parsed = z.enum(SYSTEM_AI_KEYS).parse(key);
  const schemas = { systemAI: systemAiSchema, backgroundAgent: backgroundAgentSchema, syncCheck: syncCheckSchema, dashboards: dashboardAgentSchema, conversationSummary: summaryPolicySchema };
  if (parsed === 'conversationSummaryInstructions') summaryInstructionsSchema.parse(value);
  else schemas[parsed].parse(JSON.parse(value));
  return parsed;
}
function schema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS system_ai_versions (key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL,origin_node_id TEXT NOT NULL)');
}
function store(db: DatabaseSync, input: z.infer<typeof eventSchema>): void {
  save(db, input.key, input.value);
  db.prepare('INSERT INTO system_ai_versions VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=excluded.revision,origin_node_id=excluded.origin_node_id')
    .run(input.key, input.value, input.revision, input.originNodeId);
}
/** Only persisted, valid allowlisted choices are migrated, never generated defaults. */
function bootstrap(db: DatabaseSync, originNodeId: string, excluding: readonly string[] = []): void {
  schema(db); ensureReplicationSchema(db);
  for (const key of SYSTEM_AI_KEYS) {
    if (excluding.includes(key) || db.prepare('SELECT 1 FROM system_ai_versions WHERE key=?').get(key)) continue;
    const row = db.prepare('SELECT value FROM node_settings WHERE key=? AND is_secret=0').get(key) as { value: string } | undefined;
    if (!row) continue;
    try { validate(key, row.value); } catch { continue; }
    // All initial copies have the same revision; origin breaks ties independently of arrival order.
    const payload = eventSchema.parse({ key, value: row.value, revision: 1, originNodeId });
    store(db, payload);
    enqueueReplicationEvent(db, { originNodeId, entityType: 'system.ai', entityKey: key, operation: 'upsert', payload });
  }
}
/** Maintenance calls this before sending. Safe to repeat, including inside a transaction. */
export function initSystemAiSettings(db: DatabaseSync, originNodeId: string): void {
  db.exec('SAVEPOINT system_ai_bootstrap');
  try { bootstrap(db, originNodeId); db.exec('RELEASE system_ai_bootstrap'); }
  catch (error) { db.exec('ROLLBACK TO system_ai_bootstrap; RELEASE system_ai_bootstrap'); throw error; }
}
/** Caller owns the transaction; edits to different settings never overwrite each other. */
export function saveSystemAiSetting(db: DatabaseSync, originNodeId: string, key: string, value: string): void {
  validate(key, value);
  bootstrap(db, originNodeId, [key]);
  publishValue(db, originNodeId, key, value);
}
function publishValue(db: DatabaseSync, originNodeId: string, key: string, value: string): void {
  const sharedKey = validate(key, value);
  const old = db.prepare('SELECT value FROM system_ai_versions WHERE key=?').get(key) as { value: string } | undefined;
  if (old?.value === value) return;
  const revision = Number(db.prepare('SELECT max(coalesce(max(revision),1),1)+1 revision FROM system_ai_versions').get()!.revision);
  const payload = eventSchema.parse({ key: sharedKey, value, revision, originNodeId });
  store(db, payload);
  enqueueReplicationEvent(db, { originNodeId, entityType: 'system.ai', entityKey: key, operation: 'upsert', payload });
}
export function applySystemAiEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const input = eventSchema.parse(event.payload);
  if (event.entityType !== 'system.ai' || event.operation !== 'upsert' || input.key !== event.entityKey || input.originNodeId !== event.originNodeId) throw new Error('Invalid system AI event origin or key');
  validate(input.key, input.value); schema(db);
  // Seed the receiver's pre-upgrade choices before an incoming event can overwrite them.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_node'").get()) {
    const local = db.prepare('SELECT id FROM cluster_node LIMIT 1').get() as { id: string } | undefined;
    if (local) initSystemAiSettings(db, local.id);
  }
  const old = db.prepare('SELECT revision,origin_node_id FROM system_ai_versions WHERE key=?').get(input.key) as { revision: number; origin_node_id: string } | undefined;
  if (old && (old.revision > input.revision || old.revision === input.revision && old.origin_node_id >= input.originNodeId)) return;
  store(db, input);
}
/** Existing settings endpoints publish only these fields, never paths or collection state. */
export async function publishSystemAiSettings(keys: readonly string[]): Promise<void> {
  const { id } = await getClusterNode(), db = settingsDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    bootstrap(db, id, keys);
    for (const key of keys) {
      const row = db.prepare('SELECT value FROM node_settings WHERE key=?').get(key) as { value: string } | undefined;
      if (row) publishValue(db, id, key, row.value);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
