import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { remoteTerminalAllowed } from "../src/settings.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("a twin gets the terminal by default, any other node does not, and each follows its own switch", () => {
  const defaults = { twins: true, otherNodes: false };
  assert.equal(remoteTerminalAllowed(defaults, true), true);
  assert.equal(remoteTerminalAllowed(defaults, false), false);
  assert.equal(remoteTerminalAllowed({ twins: false, otherNodes: false }, true), false);
  assert.equal(remoteTerminalAllowed({ twins: false, otherNodes: true }, true), false, "enabling other nodes must not re-enable a disabled twin");
  assert.equal(remoteTerminalAllowed({ twins: true, otherNodes: true }, false), true);
});

test("remote terminal access is node-local, twins-only by default, and persists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-remote-terminal-settings-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const initial = await api<Record<string, unknown>>(node, auth, "GET", "/settings");
    assert.deepEqual(initial.body.remoteTerminal, { twins: true, otherNodes: false });

    const base = initial.body;
    const changed = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...base, remoteTerminal: { twins: false, otherNodes: true } });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.remoteTerminal, { twins: false, otherNodes: true });
    assert.deepEqual((await api<Record<string, unknown>>(node, auth, "GET", "/settings")).body.remoteTerminal, { twins: false, otherNodes: true });

    const { remoteTerminal: _stored, ...withoutFlag } = changed.body;
    const untouched = await api<Record<string, unknown>>(node, auth, "PUT", "/settings", { ...withoutFlag, conversationHistoryDays: 31 });
    assert.deepEqual(untouched.body.remoteTerminal, { twins: false, otherNodes: true }, "a save that omits the setting keeps the stored value");

    assert.equal((await api(node, auth, "PUT", "/settings", { ...base, remoteTerminal: { twins: "yes", otherNodes: false } })).status, 400);
    assert.equal((await api(node, auth, "PUT", "/settings", { ...base, remoteTerminal: { twins: true } })).status, 400);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
