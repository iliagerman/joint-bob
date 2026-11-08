import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { QualityStore, type QualityResult } from '../src/quality-analytics.js';
import { QualityCollector, QualityReplyError } from '../src/server/quality-collector.js';
const judgment: QualityResult = { outcome: 'unknown', reason: 'No outcome evidence', issues: [], confidence: .8, probabilities: { unknown: .8 }, claudeModel: 'claude-test', jevModel: 'jev-test', version: '1', usage: null };
const messages = [{ id: 'u', role: 'user', text: 'request' }, { id: 'a', role: 'assistant', text: 'reply', timestamp: '2025-01-01T01:00:00Z' }];
function fixture() {
  const store = new QualityStore(new DatabaseSync(':memory:'));
  let calls = 0;
  const collector = new QualityCollector(store, {
    inventory: async () => Array.from({ length: 60 }, (_, i) => ({ projectId: 'p', conversationId: String(i) })),
    load: async () => ({ messages, lastHarness: 'claude', complete: true }),
    analyze: async () => { calls++; return judgment; }, feedback: async () => null,
  });
  return { store, collector, calls: () => calls };
}
test('default-off performs no model calls; enabling backfills all local records without owner filtering', async () => {
  const f = fixture(); await f.collector.scan(); assert.equal(f.calls(), 0);
  f.store.setEnabled(true); await f.collector.scan(); assert.equal(f.calls(), 60);
  await f.collector.scan(); assert.equal(f.calls(), 60);
  assert.equal(f.store.view(['p'], { page: 0, pageSize: 10 }).total, 60);
});
test('disable aborts in-flight analysis and discards its result', async () => {
  const store = new QualityStore(new DatabaseSync(':memory:')); store.setEnabled(true);
  const collector = new QualityCollector(store, { inventory: async () => [{ projectId: 'p', conversationId: 'c' }], load: async () => ({ messages, lastHarness: 'pi', complete: true }), feedback: async () => null,
    analyze: async (_p, _c, _r, signal) => { store.setEnabled(false); collector.stop(); assert.equal(signal.aborted, true); return judgment; } });
  await collector.scan(); assert.equal(store.view(['p'], { page: 0, pageSize: 10 }).total, 0);
});
test('a malformed reply does not prevent analysis of later replies', async () => {
  const f = fixture(); f.store.setEnabled(true);
  f.collector.runtime.inventory = async () => [{ projectId: 'p', conversationId: 'c' }];
  f.collector.runtime.load = async () => ({ messages: [...messages, { id: 'u2', role: 'user', text: 'another request' }, { id: 'a2', role: 'assistant', text: 'later answer' }], lastHarness: 'pi', complete: true });
  f.collector.runtime.analyze = async (_p, _c, reply) => { if (reply.id === 'a') throw new QualityReplyError('Invalid generated analysis for this reply'); return judgment; };
  await f.collector.scan();
  const view = f.store.view(['p'], { page: 0, pageSize: 10 });
  assert.equal(view.total, 1); assert.equal(view.rows[0].replyId, 'a2'); assert.equal(view.failures.length, 1);
});

test('an appended reply during analysis is picked up without another external change', async () => {
  const f = fixture(); f.store.setEnabled(true);
  f.collector.runtime.inventory = async () => [{ projectId: 'p', conversationId: 'c' }];
  let appended = false;
  f.collector.runtime.load = async () => ({ messages: appended ? [...messages, { id: 'u2', role: 'user', text: 'again' }, { id: 'a2', role: 'assistant', text: 'later answer' }] : messages, lastHarness: 'pi', complete: true });
  f.collector.runtime.analyze = async () => { appended = true; return judgment; };
  await f.collector.scan();
  assert.equal(f.store.view(['p'], { page: 0, pageSize: 10 }).total, 2);
});

test('missing or incomplete inputs and model failures are not successes; restart retries explicitly', async () => {
  const f = fixture(); f.store.setEnabled(true);
  f.collector.runtime.inventory = async () => [{ projectId: 'p', conversationId: 'missing' }, { projectId: 'p', conversationId: 'streaming' }, { projectId: 'p', conversationId: 'failed' }];
  f.collector.runtime.load = async (_p, id) => { if (id === 'missing') return { messages: [], lastHarness: 'pi', complete: false }; return { messages, lastHarness: 'pi', complete: id !== 'streaming' }; };
  f.collector.runtime.analyze = async () => { throw new Error('provider failure carrying private source'); };
  await f.collector.scan();
  const view = f.store.view(['p'], { page: 0, pageSize: 10 });
  assert.equal(view.total, 0); assert.equal(view.failures.length, 2);
  assert.ok(view.failures.every(row => !JSON.stringify(row).includes('private source')));
});
