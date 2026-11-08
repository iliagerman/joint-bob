import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { getClusterNode } from '../src/cluster.js';
import { getOrCreateClusterIdentity } from '../src/cluster-identity.js';
import { clusterV2Database } from '../src/cluster-v2-store.js';
import { addProject } from '../src/store.js';
import path from 'node:path';
import { saveSecretAccount, deleteSecretAccount, genericSecretEnvironment, systemSecretVariable } from '../src/secrets.js';
import { setResourceOwner } from '../src/ownership.js';
import { save, settingsDatabase } from '../src/settings-store.js';
import { systemAiDefaults } from '../src/system-ai-config.js';
import { systemDecisionKey, withSystemAiProfile } from '../src/system-ai.js';
import { mayReplicateEvent, replicationDeliveryBatches, sendReplicationV2 } from '../src/server/replication-v2.js';
import { DatabaseSync } from 'node:sqlite';
import type { ReplicationEvent } from '../src/replication.js';

test('system keys resolve a selected account only, survive no project grants, and never fall back after deletion', async () => {
  await getClusterNode();
  const make = (label: string) => saveSecretAccount({ label, provider: 'typesafe', variables: [{ name: 'TYPESAFE_AI_API_KEY', kind: 'value', value: `synthetic-${label}` }] });
  const first = await make('first'), second = await make('second');
  const config = systemAiDefaults();
  const persist = () => save(settingsDatabase(), 'systemAI', JSON.stringify(config));
  persist();
  assert.throws(() => systemDecisionKey('typesafe'), /Several TypeSafe accounts/);
  config.decision.typesafeAccountId = first.id; persist();
  assert.equal(systemDecisionKey('typesafe'), 'synthetic-first');
  const project = await addProject('Unattached fixture', path.join(process.env.HOME!, 'project'));
  assert.deepEqual(genericSecretEnvironment(project.id), {});
  setResourceOwner('secret', second.id, 'other-member', settingsDatabase());
  assert.throws(() => systemSecretVariable(second.id, 'TYPESAFE_AI_API_KEY'), /not available for system/);
  await deleteSecretAccount(first.id);
  assert.throws(() => systemDecisionKey('typesafe'), /not available for system/);
  config.profiles.claude = randomUUID(); persist();
  let ran = false;
  assert.throws(() => withSystemAiProfile('claude', 'anthropic', () => { ran = true; }), /administrator|profile/i);
  assert.equal(ran, false, 'an unavailable pinned sign-in cannot run with machine credentials');
  await deleteSecretAccount(second.id);
  save(settingsDatabase(), 'systemAI', JSON.stringify(systemAiDefaults()));
});

test('system events stay twin-only and an older receiver never loses ordinary event delivery', async () => {
  const local = await getClusterNode(), peer = randomUUID();
  getOrCreateClusterIdentity(await clusterV2Database(), local.id);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sharing_twins (left_node_id TEXT,right_node_id TEXT)');
  db.prepare('INSERT INTO sharing_twins VALUES (?,?)').run(...[local.id, peer].sort());
  const system: ReplicationEvent = { id: randomUUID(), originNodeId: local.id, entityType: 'system.ai', entityKey: 'systemAI', operation: 'upsert', payload: {}, createdAt: new Date().toISOString() };
  assert.equal(mayReplicateEvent(db, local.id, peer, system), true);
  assert.equal(mayReplicateEvent(db, local.id, randomUUID(), system), false);
  db.close();
  const ordinary = { ...system, id: randomUUID(), entityType: 'name.override' };
  const routes: string[] = [];
  const server = createServer((request, response) => {
    routes.push(request.url!);
    if (request.url !== '/api/cluster/v2/events') { response.writeHead(404).end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const events = JSON.parse(body).events as ReplicationEvent[];
      assert.ok(events.every(event => event.entityType !== 'system.ai'));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ received: events.map(event => event.id) }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const [normal, settings] = replicationDeliveryBatches([system, ordinary]);
    assert.deepEqual(await sendReplicationV2({ nodeId: peer, name: 'old twin', url }, normal), { received: [ordinary.id] });
    await assert.rejects(sendReplicationV2({ nodeId: peer, name: 'old twin', url }, settings), /404/);
    assert.deepEqual(routes, ['/api/cluster/v2/events', '/api/cluster/v2/system-ai/events']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
