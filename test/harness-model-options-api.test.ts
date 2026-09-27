import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

interface ModelOptions { providers: Array<{ id: string; label: string }>; models: Array<{ provider: string; id: string; thinkingLevels: string[] }> }

test("each harness lists its usable providers and their models for the Settings pickers", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-model-options-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  try {
    const session = await signIn(environment, node);

    const claude = await api<ModelOptions>(node, session, "GET", "/harnesses/claude/model-options");
    assert.equal(claude.status, 200);
    assert.deepEqual(claude.body.providers, [{ id: "claude", label: "Claude" }]);
    assert.ok(claude.body.models.some((model) => model.id === "sonnet" && model.thinkingLevels.includes("high")));

    for (const id of ["pi", "claude", "kiro"]) {
      const { status, body } = await api<ModelOptions>(node, session, "GET", `/harnesses/${id}/model-options`);
      assert.equal(status, 200, id);
      const providers = new Set(body.providers.map((provider) => provider.id));
      for (const model of body.models) assert.ok(providers.has(model.provider), `${id} model ${model.provider}/${model.id} has a listed provider`);
    }

    assert.equal((await api(node, session, "GET", "/harnesses/archive/model-options")).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
