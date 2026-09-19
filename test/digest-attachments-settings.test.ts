import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("attachment digest is node-local, off by default, and persists when switched on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-digest-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.equal(initial.body.digestAttachments, false);

    const base = initial.body as Record<string, unknown> & { syncthing: { endpoint: string } };
    const enabled = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, digestAttachments: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.digestAttachments, true);
    assert.equal((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.digestAttachments, true);

    const { digestAttachments: _stored, ...withoutFlag } = enabled.body;
    const untouched = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...withoutFlag, conversationHistoryDays: 31 });
    assert.equal(untouched.body.digestAttachments, true, "a save that omits the flag keeps the stored value");

    const disabled = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, digestAttachments: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.digestAttachments, false);

    const rejected = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, digestAttachments: "yes" });
    assert.equal(rejected.status, 400);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
