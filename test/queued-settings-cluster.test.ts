import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";
import { seedDevEnvironment, startDevNode, stopDevNode } from "./dev-nodes.js";

test("HTTP cluster events accepts emitted queue settings alongside pending prompts", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-queue-settings-cluster-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [nodeA, nodeB] = environment.nodes;
    const key = `${nodeA.projects[0].id}:settings-http-regression`;
    const settings = { provider: "claude", modelId: "haiku", reasoning: "high" };
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { recordQueueSettings, enqueuePrompt } from './src/prompt-queue.ts';
      import { getClusterMachineToken } from './src/cluster.ts';
      import { DatabaseSync } from 'node:sqlite';
      recordQueueSettings(${JSON.stringify(key)}, ${JSON.stringify(settings)});
      const prompt = enqueuePrompt(${JSON.stringify(key)}, 'pending', 'pending', { messageText: 'pending', promptSuffix: '', displaySuffix: '', attachmentPaths: [] });
      const db = new DatabaseSync(${JSON.stringify(path.join(nodeA.dataDir, "node.db"))});
      const events = db.prepare("SELECT * FROM replication_outbox WHERE entity_type = 'conversation.queue'").all().map(row => ({ id: row.event_id, originNodeId: row.origin_node_id, entityType: row.entity_type, entityKey: row.entity_key, operation: row.operation, payload: JSON.parse(row.payload), createdAt: row.created_at }));
      console.log(JSON.stringify({ events, token: await getClusterMachineToken(), promptId: prompt.id }));
      db.close();
    `], { env: { ...process.env, NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: nodeA.dataDir } });
    const emitted = JSON.parse(stdout) as { events: Array<{ id: string; operation: string }>; token: string; promptId: string };
    assert.deepEqual(emitted.events.map(event => event.operation).sort(), ["settings", "upsert"]);
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    const response = await fetch(`${nodeB.url}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${emitted.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: emitted.events }) });
    assert.equal(response.status, 200, `settings operation must cross HTTP validation: ${await response.clone().text()}`);
    assert.deepEqual((await response.json() as { received: string[] }).received.sort(), emitted.events.map(event => event.id).sort());
    const db = new DatabaseSync(path.join(nodeB.dataDir, "node.db"));
    try {
      const row = db.prepare("SELECT settings FROM queued_prompt_settings WHERE queue_key = ?").get(`${nodeB.projects[0].id}:settings-http-regression`) as { settings: string };
      assert.deepEqual(JSON.parse(row.settings), settings);
      assert.ok(db.prepare("SELECT 1 FROM queued_prompts WHERE id = ?").get(emitted.promptId), "settings must not reject the rest of the batch");
    } finally { db.close(); }
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
