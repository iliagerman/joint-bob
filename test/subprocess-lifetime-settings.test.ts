import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { subprocessLifetimeMs, validSubprocessLifetime } from "../scripts/subprocess-lifetime.mjs";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("subprocess lifetime defaults to 360, validates API values, persists across restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-lifetime-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    let auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.subprocessMaxLifetimeMinutes, 360);
    for (const invalid of [0, -1, 1.5, 10081, null, "60", true]) {
      assert.equal(validSubprocessLifetime(invalid), false);
      const rejected = await api(node, auth, "PUT", "/settings", { ...initial.body, subprocessMaxLifetimeMinutes: invalid });
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
    }
    for (const minutes of [1, 10080, 240]) {
      const updated = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...initial.body, subprocessMaxLifetimeMinutes: minutes });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.subprocessMaxLifetimeMinutes, minutes);
      assert.equal(subprocessLifetimeMs(node.dataDir), minutes * 60_000);
    }
    const { subprocessMaxLifetimeMinutes: omitted, ...oldClient } = initial.body;
    assert.equal((await api<Record<string, unknown>>(node, auth, "PUT", "/settings", oldClient)).body.subprocessMaxLifetimeMinutes, 240);
    await stopDevNode(server);
    server = await startDevNode(environment, node);
    auth = await signIn(environment, node);
    assert.equal((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.subprocessMaxLifetimeMinutes, 240);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing persisted setting uses six hours", () => {
  assert.equal(subprocessLifetimeMs(path.join(os.tmpdir(), "nonexistent-jb-policy")), 360 * 60_000);
});
