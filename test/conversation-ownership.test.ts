import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const engine = "pi" as const;
const sessionId = "session-owned";
const sourceNodeId = "11111111-1111-4111-8111-111111111111";
const destinationNodeId = "22222222-2222-4222-8222-222222222222";

function runNode(dataDir: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(),
      env: { ...process.env, JOINT_BOB_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

test("conversation ownership is epoch-monotonic, persistent, and takeover-idempotent", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ownership-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  try {
    const ownership = await import(`../src/conversation-ownership.ts?ownership=${Date.now()}-${Math.random()}`);
    assert.deepEqual(await ownership.claimConversationOwnership(engine, sessionId, sourceNodeId), {
      engine, sessionId, ownerNodeId: sourceNodeId, epoch: 1, status: "owned", transferToNodeId: null,
    });
    const taken = await ownership.takeConversationOwnership(engine, sessionId, destinationNodeId);
    assert.equal(taken.epoch, 2);
    assert.equal(taken.ownerNodeId, destinationNodeId);
    assert.deepEqual(await ownership.takeConversationOwnership(engine, sessionId, destinationNodeId), taken);

    const output = await runNode(dataDir, `
      const ownership = await import('./src/conversation-ownership.ts');
      console.log(JSON.stringify(await ownership.getConversationOwnership('pi', '${sessionId}')));
    `);
    assert.deepEqual(JSON.parse(output), taken);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("replicated ownership rejects stale epochs and persists split-brain fencing with safe diagnostics", async () => {
  const ownership = await import("../src/conversation-ownership.ts");
  const db = new DatabaseSync(":memory:");
  ownership.ensureConversationOwnershipSchema(db);
  const event = (ownerNodeId: string, epoch: number) => ({
    id: `${ownerNodeId}-${epoch}`,
    originNodeId: ownerNodeId,
    entityType: "conversation.ownership",
    entityKey: `${engine}:${sessionId}`,
    operation: "upsert",
    payload: { engine, sessionId, ownerNodeId, epoch, status: "owned", transferToNodeId: null, originNodeId: ownerNodeId },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(ownership.applyConversationOwnershipEvent(db, event(sourceNodeId, 2)).accepted, true);
  const oldPhaseEvent = event(sourceNodeId, 2);
  oldPhaseEvent.payload.status = "claiming";
  assert.equal(ownership.applyConversationOwnershipEvent(db, oldPhaseEvent).accepted, false);
  assert.equal(ownership.applyConversationOwnershipEvent(db, oldPhaseEvent).current?.status, "owned");
  const stale = ownership.applyConversationOwnershipEvent(db, event(destinationNodeId, 1));
  assert.equal(stale.accepted, false);
  assert.equal(stale.current?.ownerNodeId, sourceNodeId);
  assert.equal(stale.current?.epoch, 2);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const conflict = ownership.applyConversationOwnershipEvent(db, event(destinationNodeId, 2));
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.current?.status, "conflict");
  } finally {
    console.warn = originalWarn;
  }
  const diagnostic = JSON.parse(warnings[0]);
  assert.equal(diagnostic.event, "conversation_ownership_split_brain");
  assert.equal(diagnostic.sessionId, sessionId);
  assert.equal(diagnostic.ownerNodeId, sourceNodeId);
  const persisted = db.prepare("SELECT status, transfer_to_node_id FROM conversation_ownership").get() as { status: string; transfer_to_node_id: string };
  assert.equal(persisted.status, "conflict");
  assert.equal(persisted.transfer_to_node_id, destinationNodeId);
  // A conflicted conversation is fenced at equal epochs, but a takeover at a higher
  // epoch must be able to replace the conflict; otherwise takeover could never
  // replicate and the nodes would stay divergent forever.
  const takeover = ownership.applyConversationOwnershipEvent(db, event(sourceNodeId, 3));
  assert.equal(takeover.accepted, true);
  assert.equal(takeover.current?.status, "owned");
  assert.equal(takeover.current?.ownerNodeId, sourceNodeId);
  assert.equal(takeover.current?.epoch, 3);
  const persistedTakeover = db.prepare("SELECT status, owner_node_id, epoch FROM conversation_ownership").get() as { status: string; owner_node_id: string; epoch: number };
  assert.equal(persistedTakeover.status, "owned");
  assert.equal(persistedTakeover.owner_node_id, sourceNodeId);
  assert.equal(persistedTakeover.epoch, 3);
  assert.doesNotMatch(warnings[0], /transcript|token|credential/i);
});

test("a stale local two-phase claim heals only against the exact claiming record", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ownership-heal-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = dataDir;
  try {
    const ownership = await import(`../src/conversation-ownership.ts?heal=${Date.now()}-${Math.random()}`);
    const claiming = { engine, sessionId: "session-claiming", ownerNodeId: sourceNodeId, epoch: 1, status: "claiming" as const, transferToNodeId: null };
    await ownership.compareAndSetConversationOwnership(undefined, claiming, sourceNodeId);

    const healed = await ownership.healStaleLocalClaim(engine, claiming.sessionId, claiming);
    assert.deepEqual(healed, { engine, sessionId: claiming.sessionId, ownerNodeId: sourceNodeId, epoch: 2, status: "owned", transferToNodeId: null });
    // A concurrent identical heal is returned as-is instead of failing.
    assert.deepEqual(await ownership.healStaleLocalClaim(engine, claiming.sessionId, claiming), healed);

    // Ownership that changed after the caller's read must not be stolen: the
    // heal rejects the concurrent record instead of bumping over it.
    const stolenFrom = { engine, sessionId: "session-raced", ownerNodeId: sourceNodeId, epoch: 1, status: "claiming" as const, transferToNodeId: null };
    await ownership.compareAndSetConversationOwnership(undefined, stolenFrom, sourceNodeId);
    await ownership.takeConversationOwnership(engine, stolenFrom.sessionId, destinationNodeId);
    await assert.rejects(ownership.healStaleLocalClaim(engine, stolenFrom.sessionId, stolenFrom), (error: unknown) => {
      assert.ok(error instanceof ownership.ConversationOwnershipError);
      assert.equal(error.ownership.ownerNodeId, destinationNodeId);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
