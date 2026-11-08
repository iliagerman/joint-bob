import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { systemAiDefaults, systemAiSchema } from '../src/system-ai-config.js';
import { applySystemAiEvent, initSystemAiSettings, saveSystemAiSetting } from '../src/system-ai-replication.js';
import { ensureReplicationSchema, type ReplicationEvent } from '../src/replication.js';
import { QualityStore } from '../src/quality-analytics.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE node_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,is_secret INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)');
  ensureReplicationSchema(db);
  return db;
}
function lastEvent(db: DatabaseSync): ReplicationEvent {
  const row = db.prepare('SELECT * FROM replication_outbox ORDER BY rowid DESC LIMIT 1').get() as Record<string, string>;
  return { id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at };
}

test('system AI settings replicate model and secret IDs but not collection enablement or results', () => {
  const left = fixture(), right = fixture(), origin = randomUUID();
  try {
    const leftQuality = new QualityStore(left), rightQuality = new QualityStore(right);
    leftQuality.setEnabled(true);
    const config = systemAiDefaults(); config.decision.typesafeAccountId = randomUUID();
    saveSystemAiSetting(left, origin, 'systemAI', JSON.stringify(config));
    const event = lastEvent(left); applySystemAiEvent(right, event);
    assert.deepEqual(JSON.parse((right.prepare("SELECT value FROM node_settings WHERE key='systemAI'").get() as { value: string }).value), config);
    assert.equal(leftQuality.enabled(), true); assert.equal(rightQuality.enabled(), false);
    assert.equal(JSON.stringify(event.payload).includes('quality_config'), false);
    assert.throws(() => saveSystemAiSetting(left, origin, 'quality_config', 'true'), /not shared|Invalid/);
    assert.throws(() => systemAiSchema.parse({ ...config, enabled: true }));
    assert.throws(() => applySystemAiEvent(right, { ...event, entityKey: 'quality_config', payload: { ...(event.payload as object), key: 'quality_config' } }));
  } finally { left.close(); right.close(); }
});

test('twins converge after concurrent and out-of-order settings edits without overwriting unrelated settings', () => {
  const left = fixture(), right = fixture(), a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
  try {
    const agent = { harnessId: 'pi', provider: 'fixture', modelId: 'first', thinkingLevel: 'low' };
    saveSystemAiSetting(left, a, 'backgroundAgent', JSON.stringify(agent)); const first = lastEvent(left);
    saveSystemAiSetting(right, b, 'backgroundAgent', JSON.stringify({ ...agent, modelId: 'second' })); const second = lastEvent(right);
    applySystemAiEvent(left, second); applySystemAiEvent(right, first);
    const read = (db: DatabaseSync) => JSON.parse((db.prepare("SELECT value FROM node_settings WHERE key='backgroundAgent'").get() as { value: string }).value);
    assert.equal(read(left).modelId, 'second'); assert.deepEqual(read(left), read(right));
    saveSystemAiSetting(left, a, 'backgroundAgent', JSON.stringify({ ...agent, modelId: 'third' }));
    applySystemAiEvent(right, lastEvent(left)); applySystemAiEvent(right, second);
    assert.equal(read(right).modelId, 'third');
    assert.equal(right.prepare("SELECT count(*) count FROM replication_outbox").get()!.count, 1, 'applying a twin edit does not echo it');
    assert.throws(() => applySystemAiEvent(right, { ...first, originNodeId: b }), /origin/);
  } finally { left.close(); right.close(); }
});

function seed(db: DatabaseSync, key: string, value: string) {
  db.prepare('INSERT INTO node_settings VALUES (?,?,0,?)').run(key, value, '2020-01-01');
}
function events(db: DatabaseSync): ReplicationEvent[] {
  return (db.prepare('SELECT * FROM replication_outbox ORDER BY rowid').all() as Record<string, string>[]).map(row => ({
    id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key,
    operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at,
  }));
}

test('pre-upgrade choices enter catch-up once, without defaults, paths or collection data', () => {
  const left = fixture(), late = fixture(), origin = randomUUID();
  try {
    const agent = JSON.stringify({ harnessId: 'missing-on-twin', provider: 'fixture', modelId: 'saved-model', thinkingLevel: 'low' });
    seed(left, 'dashboards', agent);
    seed(left, 'conversationSummaryInstructions', 'Keep the saved instructions.');
    seed(left, 'projects.homePath', '/private/path');
    seed(left, 'quality_config', 'true');
    saveSystemAiSetting(left, origin, 'systemAI', JSON.stringify(systemAiDefaults()));
    initSystemAiSettings(left, origin); initSystemAiSettings(left, origin);
    const queued = events(left);
    assert.deepEqual(queued.map(event => event.entityKey).sort(), ['conversationSummaryInstructions', 'dashboards', 'systemAI']);
    for (const event of queued) applySystemAiEvent(late, event);
    assert.equal(late.prepare("SELECT value FROM node_settings WHERE key='dashboards'").get()!.value, agent);
    assert.equal(late.prepare("SELECT value FROM node_settings WHERE key='backgroundAgent'").get(), undefined);
    assert.equal(JSON.stringify(queued).includes('/private/path'), false);
  } finally { left.close(); late.close(); }
});

test('initial copies converge even when received before maintenance, and later edits beat every baseline', () => {
  const left = fixture(), right = fixture();
  const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
  const agent = (modelId: string) => JSON.stringify({ harnessId: 'pi', provider: 'fixture', modelId, thinkingLevel: 'low' });
  try {
    seed(left, 'dashboards', agent('left')); seed(right, 'dashboards', agent('right'));
    right.exec('CREATE TABLE cluster_node (id TEXT)'); right.prepare('INSERT INTO cluster_node VALUES (?)').run(b);
    initSystemAiSettings(left, a);
    const first = lastEvent(left);
    applySystemAiEvent(right, first); // must bootstrap right before comparing the incoming baseline
    const second = lastEvent(right);
    applySystemAiEvent(left, second);
    for (const db of [left, right]) assert.equal(db.prepare("SELECT value FROM node_settings WHERE key='dashboards'").get()!.value, agent('right'));
    saveSystemAiSetting(left, a, 'dashboards', agent('edited'));
    applySystemAiEvent(right, lastEvent(left)); applySystemAiEvent(right, first); applySystemAiEvent(right, second);
    assert.equal(right.prepare("SELECT value FROM node_settings WHERE key='dashboards'").get()!.value, agent('edited'));
    const empty = fixture();
    try { initSystemAiSettings(empty, a); assert.equal(events(empty).length, 0); } finally { empty.close(); }
  } finally { left.close(); right.close(); }
});
