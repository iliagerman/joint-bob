import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("auto compact threshold is node-local, defaults to 70, and can be disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-auto-compact-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.autoCompactThreshold, 70);

    const base = initial.body as Record<string, unknown> & { syncthing: { endpoint: string } };
    const configured = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, autoCompactThreshold: 84 });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.autoCompactThreshold, 84);

    const disabled = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...configured.body, autoCompactThreshold: null });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.autoCompactThreshold, null);

    const invalid = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...configured.body, autoCompactThreshold: 0 });
    assert.equal(invalid.status, 400);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
