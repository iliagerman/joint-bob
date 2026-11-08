import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeQuality, redactQualityText, qualityTextIsAbstract } from '../src/server/quality-models.js';
import { qualityClaudeArgs } from '../src/server/quality-claude.js';

test('Claude quality sessions cannot use tools, hooks, MCP or persist their source input', () => {
  const args = qualityClaudeArgs('claude-test');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.ok(!args.includes('--resume'));
});
test('Jev judges all related questions together and retains actual model and distributions', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls++; const body = JSON.parse(String(init!.body));
    assert.deepEqual(Object.keys(body.questions), ['outcome', 'reason_safety', 'support_0', 'type_0']);
    assert.equal(body.questions.type_0.criteria.new_type.includes('different'), true);
    return Response.json({ model: 'jev-1.14.0', answers: {
      reason_safety: { type: 'choice', choice: 'safe', confidence: 1, probabilities: { safe: 1, withhold: 0 } },
      outcome: { type: 'choice', choice: 'issue', confidence: .9, probabilities: { good: 0, issue: .95, unknown: .05 } },
      support_0: { type: 'choice', choice: 'supported', confidence: 1, probabilities: { supported: 1, skip: 0 } },
      type_0: { type: 'choice', choice: 'new_type', confidence: 1, probabilities: { type0: 0, new_type: 1 } },
    } });
  };
  const result = await judgeQuality({ request: 'fix bug', assistant: 'done', feedback: 'Still broken' }, { reason: 'Incorrect completion', issues: [{ type: 'verification', reason: 'No verification', lesson: 'Test changes.', ruleId: '' }] }, ['unsupported-claim'], { endpoint: 'http://127.0.0.1/jev', model: 'jev-latest', stateCharacters: 10000, timeoutMs: 1000 }, 'fixture', new AbortController().signal, fetchImpl);
  assert.equal(calls, 1); assert.equal(result.model, 'jev-1.14.0'); assert.equal(result.answers.outcome.probabilities.issue, .95);
});
test('verbatim source passages cannot become persistent reason prose', () => {
  const evidence = { request: 'Please access the sensitive customer project named Really Private Account and dump its details.', assistant: 'No.', feedback: '' };
  assert.equal(qualityTextIsAbstract(evidence.request, evidence), false);
  assert.equal(qualityTextIsAbstract('Respect the requested access boundary.', evidence), true);
});

test('malformed judgments fail closed and known secrets are removed from derived prose', async () => {
  const input = { request: 'r', assistant: 'a', feedback: '' };
  await assert.rejects(judgeQuality(input, { reason: 'unknown', issues: [] }, [], { endpoint: 'http://127.0.0.1', model: 'jev', stateCharacters: 10000, timeoutMs: 1000 }, 'fixture', new AbortController().signal, async () => Response.json({ model: 'jev', answers: {} })), /incomplete|invalid/);
  assert.equal(redactQualityText('Use private-fixture-token', ['private-fixture-token']), 'Use [redacted]');
});
