import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureUserPinSchema, type UserPins } from "../src/user-pins.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("stale pins can be removed without their conversation or project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-stale-pins-"));
  let server: ChildProcess | undefined;
  t.after(async () => {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const targets = [
    { kind: "conversation", projectId: node.projects[0].id, engine: "pi", sessionId: "missing-transcript" },
    { kind: "conversation", projectId: "deleted-project", engine: "claude", sessionId: "old-segment" },
    { kind: "project", projectId: "deleted-project" },
  ] as const;
  // Model persisted pins whose filesystem-owned targets are no longer available.
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    ensureUserPinSchema(db);
    for (const target of targets) {
      db.prepare("INSERT INTO user_pins VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(
        environment.username, target.kind, target.projectId,
        target.kind === "conversation" ? target.engine : "",
        target.kind === "conversation" ? target.sessionId : "",
        new Date().toISOString(), node.nodeId,
      );
    }
  } finally { db.close(); }
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  const initial = await api<UserPins>(node, session, "GET", "/pins");
  assert.equal(initial.body.conversations.length, 2);
  assert.deepEqual(initial.body.projectIds, ["deleted-project"]);
  for (const target of targets) {
    await t.test(`unpin ${target.kind} in ${target.projectId}`, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const removed = await api<UserPins>(node, session, "PUT", "/pins", { ...target, pinned: false });
        assert.equal(removed.status, 200, "unpin must not require a local target and must be idempotent");
        assert.ok(target.kind === "project"
          ? !removed.body.projectIds.includes(target.projectId)
          : !removed.body.conversations.some((pin) => pin.projectId === target.projectId && pin.engine === target.engine && pin.sessionId === target.sessionId));
      }
      const repin = await api(node, session, "PUT", "/pins", { ...target, pinned: true });
      assert.equal(repin.status, 404, "creating a pin still requires an existing target");
    });
  }
  assert.deepEqual((await api<UserPins>(node, session, "GET", "/pins")).body, { projectIds: [], conversations: [] });
});
