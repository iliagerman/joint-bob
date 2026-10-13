import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUsageDraft, installUsageDraft } from '../src/usage-drafts.js';
import { calendarKey, calendarBounds, calendarHourKey } from '../src/usage-calendar.js';
import { normalizeUsageRecords } from '../src/usage-import.js';
import { suggestRepeatableFlows, suggestSkillImprovements } from '../src/usage-analysis.js';

test('calendar bounds and keys respect DST transitions', () => {
  assert.equal(calendarBounds('2025-03-09', '2025-03-09', 'America/New_York').from, '2025-03-09T05:00:00.000Z');
  assert.equal(calendarBounds('2025-03-09', '2025-03-09', 'America/New_York').to, '2025-03-10T04:00:00.000Z');
  assert.equal(calendarBounds('2025-11-02', '2025-11-02', 'America/New_York').to, '2025-11-03T05:00:00.000Z');
  assert.equal(calendarKey('2025-03-10T03:30:00.000Z', 'America/New_York'), '2025-03-09');
  assert.equal(calendarKey('2025-03-10T04:30:00.000Z', 'America/New_York'), '2025-03-10');
  assert.equal(calendarBounds('2025-03-09', '2025-03-09', 'Asia/Kathmandu').from, '2025-03-08T18:15:00.000Z');
  assert.equal(calendarHourKey('2025-11-02T05:30:00.000Z', 'America/New_York'), '2025-11-02T01-04:00');
  assert.equal(calendarHourKey('2025-11-02T06:30:00.000Z', 'America/New_York'), '2025-11-02T01-05:00');
});

test('skill read attribution requires successful linked tool result and later model request', () => {
  const assistant = (id: string, content: unknown[] = []) => ({ timestamp: '2025-01-01T00:00:00Z', message: { role: 'assistant', id, provider: 'test', model: 'model', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: .01 } }, content } });
  const records = [
    { message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
    assistant('first', [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/skills/review/SKILL.md' } }]),
    { message: { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'version one' }] } },
    assistant('second'),
    { message: { role: 'user', content: [{ type: 'text', text: 'next task' }] } },
    assistant('third'),
  ];
  const events = normalizeUsageRecords('pi', 'session', records, { projectId: 'p', conversationId: 'c', createdAt: '2025-01-01T00:00:00Z' });
  assert.equal(events.length, 3);
  assert.equal(events[0].skillReads, undefined, 'read request is not charged to skill');
  assert.equal(events[1].skillReads?.[0].name, 'review');
  assert.match(events[1].skillReads?.[0].version ?? '', /^[a-f0-9]{16}$/);
  assert.equal(events[2].skillReads, undefined, 'next user turn resets attribution');
  const failed = normalizeUsageRecords('pi', 'session', [records[0], records[1], { message: { role: 'toolResult', toolCallId: 'read-1', isError: true, content: 'failed' } }, records[3]], { projectId: 'p', conversationId: 'c', createdAt: '2025-01-01T00:00:00Z' });
  assert.equal(failed[1].skillReads, undefined);
});

test('a skill Claude loads through its Skill tool is attributed for the rest of the turn', () => {
  const assistant = (id: string, content: unknown[] = []) => ({ type: 'assistant', timestamp: '2025-01-01T00:00:00Z', message: { role: 'assistant', id, model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content } });
  const result = (toolId: string, content: string, failed = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, ...(failed ? { is_error: true } : {}) }] } });
  const user = (text: string, isMeta = false) => ({ type: 'user', ...(isMeta ? { isMeta: true } : {}), message: { role: 'user', content: [{ type: 'text', text }] } });
  const context = { projectId: 'p', conversationId: 'c', createdAt: '2025-01-01T00:00:00Z' };
  const events = normalizeUsageRecords('claude', 'session', [
    user('ship it'),
    assistant('first', [{ type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'push-code' } }]),
    result('skill-1', 'Launching skill: push-code'),
    // Claude adds the skill's body as a meta message; that is not the person starting a new turn.
    user('Base directory for this skill: /home/me/.claude/skills/push-code', true),
    assistant('second'),
    user('thanks'),
    assistant('third'),
  ], context);
  assert.deepEqual(events.map((event) => event.skillReads?.map((skill) => [skill.name, skill.version])), [undefined, [['push-code', 'unknown']], undefined]);
  assert.equal(events[1].skillTurnId?.length, 64);

  const failed = normalizeUsageRecords('claude', 'session', [user('ship it'), assistant('first', [{ type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'push-code' } }]), result('skill-1', 'Unknown skill', true), assistant('second')], context);
  assert.equal(failed[1].skillReads, undefined, 'a skill that failed to load is not attributed');

  const read = normalizeUsageRecords('claude', 'session', [user('review'), assistant('first', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/home/me/.claude/skills/review/SKILL.md' } }]), result('read-1', 'the skill text'), assistant('second')], context);
  assert.equal(read[1].skillReads?.[0].name, 'review');
  assert.match(read[1].skillReads?.[0].version ?? '', /^[a-f0-9]{16}$/, 'a file read still records which content was read');
});

test('only explicit skill command, not an arbitrary slash command, counts as invocation', () => {
  const assistant = { timestamp: '2025-01-01T00:00:00Z', message: { role: 'assistant', id: 'r', provider: 'test', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
  const context = { projectId: 'p', conversationId: 'c', createdAt: '2025-01-01T00:00:00Z' };
  const event = (text: string) => normalizeUsageRecords('pi', 's', [{ message: { role: 'user', content: [{ type: 'text', text }] } }, assistant], context)[0];
  assert.equal(event('/clear').skillInvocations, undefined);
  assert.equal(event('/skill:review').skillInvocations?.[0].name, 'review');
});

test('tool duration uses observed call/result timestamps, never a guessed duration', () => {
  const context = { projectId: 'p', conversationId: 'c', createdAt: '2025-01-01T00:00:00Z' };
  const records = [
    { timestamp: '2025-01-01T00:00:00.000Z', message: { role: 'assistant', id: 'r1', provider: 'test', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: 'toolCall', id: 't', name: 'bash' }] } },
    { timestamp: '2025-01-01T00:00:02.000Z', message: { role: 'toolResult', toolCallId: 't', content: 'done' } },
  ];
  assert.equal(normalizeUsageRecords('pi', 's', records, context)[0].toolDurationMs, 2000);
  assert.equal(normalizeUsageRecords('pi', 's', records.slice(0, 1), context)[0].toolDurationMs, undefined);
});

test('analysis emits review-only evidence and no invented savings or leaked title', () => {
  const candidates = [1, 2, 3].map((number) => ({ projectId: 'p', conversationId: `c${number}`, title: `Deploy private-secret-${number}`, costUsd: 2, durationMs: null }));
  const result = suggestRepeatableFlows(candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'script');
  assert.equal(result[0].associatedCostUsd, 6);
  assert.equal(result[0].estimatedSavings, null);
  assert.equal(result[0].evidence.length, 3);
  assert.ok(result[0].evidence[0].href.includes('conversationId=c1'));
  assert.ok(!JSON.stringify(result).includes('private-secret'));
});

test('improvement suggestion needs observed errors in distinct conversations', () => {
  const row = (conversationId: string, toolErrors: number) => ({ skillId: 'skill:v1', projectId: 'p', conversationId, costUsd: 2, durationMs: 1000, toolErrors });
  assert.equal(suggestSkillImprovements([row('a', 1), row('a', 0)]).length, 0);
  const result = suggestSkillImprovements([row('a', 1), row('b', 0)]);
  assert.equal(result[0].kind, 'improvement');
  assert.equal(result[0].evidence.length, 2);
  assert.equal(result[0].estimatedSavings, null);
});

test('reviewed draft installs once without overwrite or symlink traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'joint-bob-insights-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'joint-bob-insights-other-'));
  try {
    const draft = createUsageDraft('owner', { projectId: 'p', name: 'review-flow', kind: 'skill', content: 'Check evidence before making edits.', evidenceConversationIds: ['c1', 'c2', 'c3'] });
    await assert.rejects(() => installUsageDraft('owner', draft.id, '0'.repeat(64), root), /changed/);
    assert.equal(await installUsageDraft('other', draft.id, draft.reviewedSha256, root), null);
    const result = await installUsageDraft('owner', draft.id, draft.reviewedSha256, root);
    assert.match(await readFile(result!.path, 'utf8'), /Check evidence before making edits/);
    await assert.rejects(() => installUsageDraft('owner', draft.id, draft.reviewedSha256, root), /already installed/);
    const symlinked = createUsageDraft('owner', { projectId: 'p', name: 'bad-path', kind: 'skill', content: 'Check evidence before making edits.', evidenceConversationIds: ['c1', 'c2', 'c3'] });
    const newRoot = await mkdtemp(path.join(os.tmpdir(), 'joint-bob-insights-symlink-'));
    try {
      await symlink(other, path.join(newRoot, '.agents'));
      await assert.rejects(() => installUsageDraft('owner', symlinked.id, symlinked.reviewedSha256, newRoot), /real directory/);
    } finally { await rm(newRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('invalid timezone rejected instead of silently shifting usage', () => {
  assert.throws(() => calendarBounds('2025-03-09', '2025-03-09', 'Mars/Olympus'));
});
