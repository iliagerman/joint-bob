import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("shell command time limit is node-local, unlimited by default, and bounded when set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-shell-timeout-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.shellCommandTimeoutSeconds, null);

    const base = initial.body as Record<string, unknown> & { syncthing: { endpoint: string } };
    const limited = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, shellCommandTimeoutSeconds: 600 });
    assert.equal(limited.status, 200);
    assert.equal(limited.body.shellCommandTimeoutSeconds, 600);
    assert.equal((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.shellCommandTimeoutSeconds, 600);

    const unlimited = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...limited.body, shellCommandTimeoutSeconds: null });
    assert.equal(unlimited.status, 200);
    assert.equal(unlimited.body.shellCommandTimeoutSeconds, null);

    for (const invalid of [0, -1, 1.5, 86_401]) {
      const rejected = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...limited.body, shellCommandTimeoutSeconds: invalid });
      assert.equal(rejected.status, 400, `limit ${invalid} must be rejected`);
    }
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
