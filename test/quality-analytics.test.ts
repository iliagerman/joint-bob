import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { QualityStore, replyWindows, type QualityResult } from '../src/quality-analytics.js';

const result: QualityResult = { outcome: 'issue', reason: 'The user corrected an unsupported claim.', issues: [{ type: 'unsupported-claim', reason: 'Claim lacked evidence.', lesson: 'Check evidence before claiming success.', ruleId: '', adoptedAt: '' }], confidence: 0.9, probabilities: { issue: 0.9, unknown: 0.1 }, claudeModel: 'claude-test', jevModel: 'jev-test', version: '1', usage: null };
function fixture() { return new QualityStore(new DatabaseSync(':memory:')); }

test('aggregation is default-off and its switch is local, with resumable work', () => {
  const store = fixture();
  assert.equal(store.enabled(), false);
  store.setEnabled(true); store.enqueue('p', 'c');
  assert.deepEqual(store.next(), { projectId: 'p', conversationId: 'c' });
  store.jobState('p', 'c', 'running'); store.recover();
  assert.deepEqual(store.next(), { projectId: 'p', conversationId: 'c' });
  store.setEnabled(false); assert.equal(store.enabled(), false);
});

test('source-dated reply metrics deduplicate issues, respect projects, and survive unavailable source', () => {
  const store = fixture();
  const sample = { projectId: 'p', conversationId: 'c', replyId: 'r', at: '2025-01-02T01:00:00Z', harness: 'claude', model: 'source-model', fingerprint: 'f', result };
  store.put(sample); store.put({ ...sample, result: { ...result, issues: [...result.issues, { ...result.issues[0], type: 'verification' }] } });
  store.put({ ...sample, projectId: 'private', conversationId: 'secret', replyId: 'secret' });
  store.jobState('p', 'c', 'unavailable', 'No local transcript');
  const view = store.view(['p'], { page: 0, pageSize: 10 });
  assert.equal(view.totals.replies, 1); assert.equal(view.totals.issues, 1);
  assert.equal(view.trends[0].day, '2025-01-02'); assert.equal(view.issues.length, 2);
  assert.equal(view.jobs[0].state, 'unavailable'); assert.equal(view.total, 1);
  assert.equal(store.view([], { page: 0, pageSize: 10 }).totals.replies, 0);
  assert.equal(store.view(['p'], { page: 0, pageSize: 10, model: 'different' }).total, 0);
});

test('unknown is not success and pagination does not change totals', () => {
  const store = fixture();
  for (let i = 0; i < 5; i++) store.put({ projectId: 'p', conversationId: 'c', replyId: String(i), at: '', harness: 'pi', model: '', fingerprint: String(i), result: { ...result, outcome: 'unknown', issues: [] } });
  const view = store.view(['p'], { page: 1, pageSize: 2 });
  assert.equal(view.totals.unknown, 5); assert.equal(view.totals.good, 0); assert.equal(view.rows.length, 2); assert.equal(view.total, 5);
});

test('unchanged inventory revisions do not reread completed history', () => {
  const store = fixture();
  store.enqueue('p', 'c', false, 'revision1'); store.jobState('p', 'c', 'complete');
  store.enqueue('p', 'c', false, 'revision1'); assert.equal(store.next(), undefined);
  store.enqueue('p', 'c', false, 'revision2'); assert.equal(store.next()?.conversationId, 'c');
});

test('removed feedback is no longer counted', () => {
  const store = fixture();
  store.feedback('p', 'c', 'bad', 'manual'); store.clearFeedback('p', 'c');
  assert.equal(store.view(['p'], { page: 0, pageSize: 10 }).feedback.length, 0);
});

test('accepted lesson comparisons count all cohort replies, not just affected ones', () => {
  const store = fixture();
  for (let i = 1; i <= 4; i++) store.put({ projectId: 'p', conversationId: 'c', replyId: String(i), at: `2025-01-0${i}T12:00:00Z`, harness: 'claude', model: 'm', fingerprint: String(i), result: i === 1 ? { ...result, issues: [{ ...result.issues[0], ruleId: 'r-test', adoptedAt: '2025-01-03' }] } : { ...result, outcome: 'good', issues: [] } });
  const row = store.view(['p'], { page: 0, pageSize: 10, issue: 'unsupported-claim' }).lessons[0];
  assert.equal(row.beforeReplies, 2); assert.equal(row.beforeIssues, 1);
  assert.equal(row.afterReplies, 2); assert.equal(row.afterIssues, 0);
});

test('issue drill-down filters accepted lessons before the result limit', () => {
  const store = fixture();
  for (let i = 0; i < 105; i++) store.put({ projectId: 'p', conversationId: 'c', replyId: String(i), at: '2025-01-02', harness: 'claude', model: '', fingerprint: String(i), result: { ...result, issues: [{ ...result.issues[0], type: i === 0 ? 'old-target' : `type-${i}`, ruleId: `r-${i}`, adoptedAt: i === 0 ? '2024-01-01' : '2025-01-01' }] } });
  assert.equal(store.view(['p'], { page: 0, pageSize: 10, issue: 'old-target' }).lessons.length, 1);
});

test('reply windows cover long text and subsequent user feedback without copying conversation ratings', () => {
  const windows = replyWindows([{ role: 'user', text: 'request' }, { role: 'assistant', text: 'x'.repeat(17000), timestamp: '2025-01-02T01:00:00Z' }, { role: 'user', text: 'That is wrong' }], 'claude');
  assert.equal(windows.length, 1); assert.equal(windows[0].chunks.map(c => c.assistant).join(''), 'x'.repeat(17000));
  assert.equal(windows[0].chunks[0].feedback, 'That is wrong');
  assert.equal(replyWindows([{ role: 'user', text: 'draft' }], 'pi').length, 0);
});
