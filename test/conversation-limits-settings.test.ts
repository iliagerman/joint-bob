import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { conversationLimits } from "../scripts/conversation-limits.mjs";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("conversation limits default to none, validate API values, persist across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-conversation-limits-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    let auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.conversationCpuLimitCores, null);
    assert.equal(initial.body.conversationMemoryLimitGb, null);
    assert.deepEqual(conversationLimits(node.dataDir), { cpuCores: null, memoryGb: null });
    for (const invalid of [0, -1, 0.05, 1025, "2", true]) {
      const rejected = await api(node, auth, "PUT", "/settings", { ...initial.body, conversationCpuLimitCores: invalid });
      assert.equal(rejected.status, 400, `cores ${JSON.stringify(invalid)}`);
    }
    for (const invalid of [0, -1, 0.05, 4097, "8", true]) {
      const rejected = await api(node, auth, "PUT", "/settings", { ...initial.body, conversationMemoryLimitGb: invalid });
      assert.equal(rejected.status, 400, `GB ${JSON.stringify(invalid)}`);
    }
    for (const [cores, gigabytes] of [[0.1, 4096], [1024, 0.1], [2.5, 8]]) {
      const updated = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...initial.body, conversationCpuLimitCores: cores, conversationMemoryLimitGb: gigabytes });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.conversationCpuLimitCores, cores);
      assert.equal(updated.body.conversationMemoryLimitGb, gigabytes);
      // The supervisor reads the same stored values without asking the app.
      assert.deepEqual(conversationLimits(node.dataDir), { cpuCores: cores, memoryGb: gigabytes });
    }
    const { conversationCpuLimitCores: omittedCores, conversationMemoryLimitGb: omittedMemory, ...oldClient } = initial.body;
    const kept = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", oldClient);
    assert.equal(kept.body.conversationCpuLimitCores, 2.5, "a client that predates the limits leaves them alone");
    assert.equal(kept.body.conversationMemoryLimitGb, 8);
    await stopDevNode(server);
    server = await startDevNode(environment, node);
    auth = await signIn(environment, node);
    const reloaded = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(reloaded.body.conversationCpuLimitCores, 2.5);
    assert.equal(reloaded.body.conversationMemoryLimitGb, 8);
    const cleared = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...reloaded.body, conversationCpuLimitCores: null });
    assert.equal(cleared.body.conversationCpuLimitCores, null, "null removes a limit");
    assert.deepEqual(conversationLimits(node.dataDir), { cpuCores: null, memoryGb: 8 });
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
