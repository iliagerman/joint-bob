import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("the dashboard agent's harness, model and effort are per-node settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboard-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, any>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.dashboards.harnessId, "pi");
    assert.deepEqual(
      { provider: initial.body.dashboards.provider, modelId: initial.body.dashboards.modelId, thinkingLevel: initial.body.dashboards.thinkingLevel },
      initial.body.conversationDefaults.pi,
      "the default is the harness's conversation default",
    );

    const unknownHarness = await api(node, auth, "PUT", "/settings", { ...initial.body, dashboards: { ...initial.body.dashboards, harnessId: "nope" } });
    assert.equal(unknownHarness.status, 400);
    const extraKey = await api(node, auth, "PUT", "/settings", { ...initial.body, dashboards: { ...initial.body.dashboards, enabled: true } });
    assert.equal(extraKey.status, 400);

    const custom = { ...initial.body.dashboards, modelId: "custom-dashboard-model", thinkingLevel: "high" };
    const saved = await api<Record<string, any>>(node, auth, "PUT", "/settings", { ...initial.body, dashboards: custom });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.dashboards, custom);
    const { dashboards: _omitted, ...without } = saved.body;
    const kept = await api<Record<string, any>>(node, auth, "PUT", "/settings", without);
    assert.equal(kept.body.dashboards.modelId, "custom-dashboard-model", "a save that omits dashboards keeps them");
  } finally {
    if (server) await stopDevNode(server);
  }
});
