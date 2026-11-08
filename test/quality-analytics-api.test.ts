import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from './dev-nodes.js';
import { isAdminRoute } from '../src/server/admin.js';

test('quality routes are admin-only and default off on a disposable machine', { timeout: 120000 }, async () => {
  assert.equal(isAdminRoute('GET', '/quality-analytics'), true);
  assert.equal(isAdminRoute('PUT', '/quality-analytics/settings'), true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jb-quality-api-'));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);
    const response = await api<any>(node, session, 'GET', '/quality-analytics');
    assert.equal(response.status, 200); assert.equal(response.body.enabled, false);
    assert.equal(response.body.totals.replies, 0);
    const invalid = await api(node, session, 'GET', '/quality-analytics?page=-1'); assert.equal(invalid.status, 400);
    const invalidToggle = await api(node, session, 'PUT', '/quality-analytics/settings', { enabled: 'yes' }); assert.equal(invalidToggle.status, 400);
    const toggle = await api<any>(node, session, 'PUT', '/quality-analytics/settings', { enabled: false }); assert.equal(toggle.body.enabled, false);
    const retry = await api(node, session, 'POST', '/quality-analytics/retry', {}); assert.equal(retry.status, 409);
    const enabled = await api<any>(node, session, 'PUT', '/quality-analytics/settings', { enabled: true }); assert.equal(enabled.body.enabled, true);
    let collected;
    for (let attempt = 0; attempt < 100; attempt++) {
      collected = await api<any>(node, session, 'GET', '/quality-analytics');
      if (collected.body.jobs.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(collected!.body.jobs.length > 0, 'real local inventory is queued without a display listing');
    const disabled = await api<any>(node, session, 'PUT', '/quality-analytics/settings', { enabled: false }); assert.equal(disabled.body.enabled, false);
  } finally { await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
