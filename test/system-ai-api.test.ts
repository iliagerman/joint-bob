import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, pairTwinNodes } from './dev-nodes.js';
import { isAdminRoute } from '../src/server/admin.js';
import type { SystemAiSettings } from '../src/system-ai-config.js';

test('System AI selects unattached credentials, replicates between twins, and leaves collection local', { timeout: 180000 }, async () => {
  assert.equal(isAdminRoute('GET', '/system-ai'), true);
  assert.equal(isAdminRoute('PUT', '/system-ai'), true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-system-ai-'));
  const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
  const servers = [];
  try {
    servers.push(await startDevNode(env, a), await startDevNode(env, b));
    await pairTwinNodes(env);
    const authA = await signIn(env, a), authB = await signIn(env, b);
    const created = await api<{ account: { id: string } }>(a, authA, 'POST', '/secrets/accounts', { label: 'System fixture', provider: 'typesafe', variables: [{ name: 'TYPESAFE_AI_API_KEY', kind: 'value', value: 'synthetic-jev-for-system' }] });
    assert.equal(created.status, 201);
    const initial = await api<{ system: SystemAiSettings }>(a, authA, 'GET', '/system-ai');
    assert.equal(initial.status, 200);
    const system = initial.body.system;
    system.decision.typesafeAccountId = created.body.account.id;
    system.quality.modelId = 'quality-fixture';
    const agent = { harnessId: 'claude', provider: 'claude', modelId: 'system-fixture', thinkingLevel: 'low' };
    const saved = await api(a, authA, 'PUT', '/system-ai', { system, backgroundAgent: agent });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(!JSON.stringify(saved.body).includes('synthetic-jev-for-system'));
    assert.equal((await api(a, authA, 'PUT', '/system-ai', { system, qualityEnabled: true })).status, 400);
    assert.equal((await api(a, authA, 'PUT', '/system-ai', { system, dashboards: { ...agent, provider: 'wrong-provider' } })).status, 400);
    assert.equal((await api(a, authA, 'PUT', '/system-ai', { system, backgroundAgent: { ...agent, harnessId: 'missing-agent' } })).status, 400);
    const until = Date.now() + 60000;
    let received;
    do {
      received = await api<{ system: SystemAiSettings; backgroundAgent: typeof agent }>(b, authB, 'GET', '/system-ai');
      if (received.body.system.decision.typesafeAccountId === created.body.account.id) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < until);
    assert.deepEqual(received!.body.system, system);
    assert.deepEqual(received!.body.backgroundAgent, agent);
    for (const node of [a, b]) {
      const auth = node === a ? authA : authB;
      assert.equal((await api<{ enabled: boolean }>(node, auth, 'GET', '/quality-analytics')).body.enabled, false);
    }
    const changed = { ...system, quality: { modelId: 'second-fixture' } };
    assert.equal((await api(b, authB, 'PUT', '/system-ai', { system: changed })).status, 200);
    const backUntil = Date.now() + 60000;
    let back;
    do {
      back = await api<{ system: SystemAiSettings }>(a, authA, 'GET', '/system-ai');
      if (back.body.system.quality.modelId === 'second-fixture') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < backUntil);
    assert.equal(back!.body.system.quality.modelId, 'second-fixture');
    // Remove the synthetic key before enabling collection: these tests must never call a provider.
    assert.equal((await api(a, authA, 'DELETE', `/secrets/accounts/${created.body.account.id}`)).status, 200);
    const enabled = await api<{ enabled: boolean }>(a, authA, 'PUT', '/quality-analytics/settings', { enabled: true });
    assert.equal(enabled.body.enabled, true);
    const changedAgain = { ...changed, quality: { modelId: 'third-fixture' } };
    assert.equal((await api(a, authA, 'PUT', '/system-ai', { system: changedAgain })).status, 200, 'preserve a missing selected key without substituting another');
    const finalUntil = Date.now() + 60000;
    let final;
    do {
      final = await api<{ system: SystemAiSettings }>(b, authB, 'GET', '/system-ai');
      if (final.body.system.quality.modelId === 'third-fixture') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < finalUntil);
    assert.equal(final!.body.system.quality.modelId, 'third-fixture');
    assert.equal((await api<{ enabled: boolean }>(a, authA, 'GET', '/quality-analytics')).body.enabled, true);
    assert.equal((await api<{ enabled: boolean }>(b, authB, 'GET', '/quality-analytics')).body.enabled, false, 'a settings save never enables twin collection');
    await api(a, authA, 'PUT', '/quality-analytics/settings', { enabled: false });
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
