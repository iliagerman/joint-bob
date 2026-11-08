import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backgroundAgentNow, nodeSettings } from '../src/settings.js';
import { save, settingsDatabase } from '../src/settings-store.js';
import { systemAiDefaults, type SystemAiSettings } from '../src/system-ai-config.js';
import { systemDecisionKey } from '../src/system-ai.js';
import { getDifficultyClassifier } from '../src/classifiers/registry.js';
import { createRoutingConfig, routingConfigDatabase, setRoutingConfigSelection } from '../src/routing-configs.js';
import { defaultRoutingPolicy } from '../src/routing-policy.js';
import { saveSecretAccount } from '../src/secrets.js';
import type { ProjectRecord } from '../src/types.js';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';

test('explicit unavailable background choices remain readable but never execute another harness', () => {
  const db = settingsDatabase();
  const choice = { harnessId: 'missing-twin-harness', provider: 'fixture', modelId: 'saved-model', thinkingLevel: 'low' };
  save(db, 'backgroundAgent', JSON.stringify(choice));
  try {
    assert.deepEqual(nodeSettings().backgroundAgent, choice);
    assert.equal(nodeSettings().syncCheck.harnessId, choice.harnessId);
    assert.throws(() => backgroundAgentNow(), /missing-twin-harness.*cannot run/);
  } finally { db.prepare("DELETE FROM node_settings WHERE key='backgroundAgent'").run(); }
});

test('automatic summary uses the system classifier and its credential with project tier mappings', async () => {
  const { summaryRun } = await import('../src/server/conversation-digest-runner.js');
  const db = settingsDatabase(), routing = routingConfigDatabase();
  const secret = await saveSecretAccount({ label: 'Summary Laya fixture', provider: 'custom', replicate: false,
    variables: [{ name: 'LAYA_API_KEY', kind: 'value', value: 'synthetic-summary-laya' }] });
  const system = systemAiDefaults(); system.decision.model = 'laya'; system.decision.layaAccountId = secret.id;
  save(db, 'systemAI', JSON.stringify(system));
  const policy = defaultRoutingPolicy(); policy.classifierId = 'typesafe';
  policy.harnesses.claude = { levels: { '2': { modelId: 'claude-sonnet-4-6', thinkingLevel: 'low', description: 'Project summary tier' } } };
  const config = createRoutingConfig(routing, randomUUID(), 'Summary fixture', policy);
  setRoutingConfigSelection(routing, config.id);
  const classifier = getDifficultyClassifier('laya')!;
  const previous = classifier.classify;
  let calls = 0;
  classifier.classify = async (_text, key, context) => {
    calls++;
    assert.equal(key, 'synthetic-summary-laya');
    assert.deepEqual(context, { options: [{ level: 2, description: 'Project summary tier' }] });
    return { level: 2, score: 2, confidence: 1 };
  };
  try {
    assert.throws(() => systemDecisionKey('typesafe'), /No system TypeSafe/);
    const run = await summaryRun({ updates: 'manual', writer: { source: 'automatic' }, from: { kind: 'node' } },
      { id: randomUUID() } as ProjectRecord, { harnessId: 'claude', provider: 'anthropic', modelId: 'conversation-model' }, [], 'claude', 'Summary material');
    assert.equal(calls, 1);
    assert.equal(run.source, 'classifier');
    assert.equal(run.modelId, 'claude-sonnet-4-6');
  } finally {
    classifier.classify = previous;
    setRoutingConfigSelection(routing, '');
    db.prepare("DELETE FROM node_settings WHERE key='systemAI'").run();
  }
});

test('System AI API rejects invalid local harness/provider choices and retains unchanged missing choices', { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-system-ai-validation-'));
  const env = await seedDevEnvironment(root, 1), [node] = env.nodes;
  const server = await startDevNode(env, node);
  try {
    const auth = await signIn(env, node);
    const initial = await api<{ system: SystemAiSettings }>(node, auth, 'GET', '/system-ai');
    assert.equal(initial.status, 200);
    const system = initial.body.system;
    const agent = { harnessId: 'unknown-harness', provider: 'fixture', modelId: 'fixture', thinkingLevel: 'low' };
    for (const choice of [agent, { ...agent, harnessId: 'claude', provider: 'wrong-provider' }]) {
      for (const key of ['backgroundAgent', 'dashboards', 'syncCheck']) {
        const response = await api(node, auth, 'PUT', '/system-ai', { system, [key]: key === 'syncCheck' ? { ...choice, enabled: true } : choice });
        assert.equal(response.status, 400, `${key}: ${JSON.stringify(response.body)}`);
      }
      for (const operation of ['feedback', 'knowledge']) {
        const response = await api(node, auth, 'PUT', '/system-ai', { system: { ...system, operations: { ...system.operations, [operation]: choice } } });
        assert.equal(response.status, 400, `${operation}: ${JSON.stringify(response.body)}`);
      }
    }
    // Simulate a replicated selection whose harness/secret/profile has not arrived here.
    const { DatabaseSync } = await import('node:sqlite');
    const remote = new DatabaseSync(path.join(node.dataDir, 'node.db'));
    const missing = structuredClone(system);
    missing.operations.feedback = agent as SystemAiSettings['operations']['feedback'];
    missing.decision.typesafeAccountId = randomUUID(); missing.profiles.claude = randomUUID();
    try { save(remote, 'systemAI', JSON.stringify(missing)); save(remote, 'backgroundAgent', JSON.stringify(agent)); }
    finally { remote.close(); }
    const retained = await api<{ system: SystemAiSettings }>(node, auth, 'PUT', '/system-ai', { system: missing, backgroundAgent: agent });
    assert.equal(retained.status, 200, JSON.stringify(retained.body));
    assert.deepEqual(retained.body.system, missing);
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
