import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { saveServingSettings } from "../src/relay/store.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("other nodes may not run here by default, the choice is node-local and persists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runner-access-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.deepEqual(initial.body.runnerAccess, { otherNodes: false });

    const changed = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { otherNodes: true } });
    assert.equal(changed.status, 200);
    assert.deepEqual((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.runnerAccess, { otherNodes: true });

    const { runnerAccess: _stored, ...withoutFlag } = changed.body;
    const untouched = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...withoutFlag, conversationHistoryDays: 31 });
    assert.deepEqual(untouched.body.runnerAccess, { otherNodes: true }, "a save that omits the setting keeps the stored value");

    assert.equal((await api(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { otherNodes: "yes" } })).status, 400);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a node serving a relay accepts runs from other nodes until told otherwise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-runner-access-relay-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    saveServingSettings(db, { enabled: true, origin: "https://relay.example.test", environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapBytes: 0, alertTopic: "", ownMachinesOnly: false });
    db.close();
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.deepEqual(initial.body.runnerAccess, { otherNodes: true });
    const off = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...initial.body, runnerAccess: { otherNodes: false } });
    assert.deepEqual(off.body.runnerAccess, { otherNodes: false });
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
