import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const target = (sessionId: string, engine: "pi" | "claude" = "pi") => ({ projectId: "project", engine, sessionId });
const listing = (rows: Array<{ binding: string; sessionId: string }>) => rows.map((row) => `${row.binding}:${row.sessionId}`);

test("canvas shortcuts are per account, exclusive, and replicated through the outbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const originNodeId = randomUUID();
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const shortcuts = await import(`../src/canvas-shortcuts.ts?test=${Date.now()}`);

    shortcuts.setCanvasShortcut("ada", "1", target("s-one"), originNodeId);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["1:s-one"]);

    // Two accounts on one node keep entirely separate bindings.
    assert.deepEqual(shortcuts.listCanvasShortcuts("grace"), []);
    shortcuts.setCanvasShortcut("grace", "1", target("s-two"), originNodeId);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["1:s-one"]);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("grace")), ["1:s-two"]);

    // A conversation holds at most one binding: assigning a second one moves it.
    shortcuts.setCanvasShortcut("ada", "B", target("s-one"), originNodeId);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["B:s-one"]);

    // A binding is a slot: pointing it at another conversation takes it over.
    shortcuts.setCanvasShortcut("ada", "B", target("s-three"), originNodeId);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["B:s-three"]);

    // Closing the conversation releases whatever binding it held.
    shortcuts.releaseCanvasShortcuts("ada", [target("s-three")], originNodeId);
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), []);

    shortcuts.setCanvasShortcut("ada", "9", target("s-four", "claude"), originNodeId);
    shortcuts.clearCanvasShortcut("ada", "9", originNodeId);
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), []);

    for (const binding of ["", "AB", "!", "cmd"]) {
      assert.throws(() => shortcuts.setCanvasShortcut("ada", binding, target("s-five"), originNodeId), /binding/i, binding);
    }
    // Lower case is the same key as upper case.
    shortcuts.setCanvasShortcut("ada", "c", target("s-five"), originNodeId);
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["C:s-five"]);

    const outbox = new DatabaseSync(path.join(root, "data", "node.db"));
    const events = outbox.prepare("SELECT operation, entity_key FROM replication_outbox WHERE entity_type = 'canvas.shortcut' ORDER BY created_at, event_id").all() as unknown as Array<{ operation: string; entity_key: string }>;
    assert.ok(events.some((event) => event.operation === "upsert" && event.entity_key === "ada:1"));
    // Moving a conversation to another key publishes only the new assignment: every
    // node displaces the old key from it, so a second event would say nothing more.
    assert.ok(events.some((event) => event.operation === "upsert" && event.entity_key === "ada:B"));
    assert.ok(events.some((event) => event.operation === "delete" && event.entity_key === "ada:9"), "an explicit release is published");
    assert.ok(events.some((event) => event.entity_key === "grace:1"), "each account replicates under its own name");
    outbox.close();
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("replicated shortcut events resolve by recency and respect releases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-replica-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const peerNodeId = randomUUID();
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const shortcuts = await import(`../src/canvas-shortcuts.ts?test=${Date.now()}`);
    const db = new DatabaseSync(path.join(root, "data", "node.db"));
    shortcuts.ensureCanvasShortcutSchema(db);
    const event = (operation: string, payload: Record<string, unknown>) => ({
      id: randomUUID(), originNodeId: peerNodeId, entityType: "canvas.shortcut",
      entityKey: `${payload.username}:${payload.binding}`, operation, payload,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const base = { username: "ada", binding: "4", projectId: "project", engine: "pi", originNodeId: peerNodeId };
    // A release names its conversation when the releasing node knew it, or nothing at all.
    const releaseEvent = (payload: Record<string, unknown>) => event("delete", payload);

    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "remote-one", updatedAt: "2026-09-01T10:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["4:remote-one"]);

    // An older event that arrives late never overwrites the newer value.
    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "stale", updatedAt: "2026-09-01T09:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["4:remote-one"]);

    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "remote-two", updatedAt: "2026-09-01T11:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["4:remote-two"]);

    // A release wins over anything older, and survives a stale upsert delivered after it.
    shortcuts.applyCanvasShortcutEvent(db, releaseEvent({ username: "ada", binding: "4", updatedAt: "2026-09-01T12:00:00.000Z", originNodeId: peerNodeId }));
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), []);
    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "resurrected", updatedAt: "2026-09-01T11:30:00.000Z" }));
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), [], "a released binding is not resurrected by an older assignment");

    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "reassigned", updatedAt: "2026-09-01T13:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["4:reassigned"]);

    // One conversation still holds one binding when two nodes bind it at once.
    const other = { ...base, binding: "7" };
    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...other, sessionId: "reassigned", updatedAt: "2026-09-01T14:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["7:reassigned"], "the newer binding displaces the older one");
    // The displaced key stays displaced even when its assignment is delivered late.
    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "reassigned", updatedAt: "2026-09-01T13:00:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["7:reassigned"]);
    // An older assignment of the same conversation to a third key loses outright.
    shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, binding: "8", sessionId: "reassigned", updatedAt: "2026-09-01T13:30:00.000Z" }));
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["7:reassigned"]);

    // Same-instant writes from two nodes must settle the same way everywhere.
    const tie = "2026-09-01T15:00:00.000Z";
    const lowNode = "00000000-0000-4000-8000-000000000001";
    const highNode = "ffffffff-0000-4000-8000-000000000001";
    const tieEvent = (nodeId: string, sessionId: string) => ({
      id: randomUUID(), originNodeId: nodeId, entityType: "canvas.shortcut", entityKey: "ada:2",
      operation: "upsert", createdAt: tie,
      payload: { username: "ada", binding: "2", projectId: "project", engine: "pi", sessionId, updatedAt: tie, originNodeId: nodeId },
    });
    shortcuts.applyCanvasShortcutEvent(db, tieEvent(highNode, "from-high"));
    shortcuts.applyCanvasShortcutEvent(db, tieEvent(lowNode, "from-low"));
    const settled = shortcuts.listCanvasShortcuts("ada").find((row: { binding: string }) => row.binding === "2");
    assert.equal(settled.sessionId, "from-high", "an identical timestamp is broken by node identity, not arrival order");

    assert.throws(() => shortcuts.applyCanvasShortcutEvent(db, event("upsert", { ...base, sessionId: "", updatedAt: "2026-09-01T14:00:00.000Z" })), /malformed/i);
    assert.throws(() => shortcuts.applyCanvasShortcutEvent(db, { ...event("upsert", { ...base, sessionId: "x", updatedAt: "2026-09-01T14:00:00.000Z" }), entityKey: "wrong" }), /malformed/i);
    db.close();
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("two nodes settle on the same bindings whatever order the events arrive in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-order-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const nodeOne = "11111111-0000-4000-8000-000000000001";
  const nodeTwo = "22222222-0000-4000-8000-000000000002";
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const shortcuts = await import(`../src/canvas-shortcuts.ts?test=${Date.now()}`);
    const assign = (binding: string, sessionId: string, at: string, nodeId = nodeOne) => ({
      id: randomUUID(), originNodeId: nodeId, entityType: "canvas.shortcut", entityKey: `ada:${binding}`,
      operation: "upsert", createdAt: at,
      payload: { username: "ada", binding, projectId: "project", engine: "pi", sessionId, updatedAt: at, originNodeId: nodeId },
    });
    const free = (binding: string, sessionId: string, at: string, nodeId = nodeTwo) => ({
      id: randomUUID(), originNodeId: nodeId, entityType: "canvas.shortcut", entityKey: `ada:${binding}`,
      operation: "delete", createdAt: at,
      payload: { username: "ada", binding, projectId: "project", engine: "pi", sessionId, updatedAt: at, originNodeId: nodeId },
    });
    const settle = (name: string, events: unknown[]) => {
      const db = new DatabaseSync(path.join(root, `${name}.db`));
      shortcuts.ensureCanvasShortcutSchema(db);
      for (const event of events) shortcuts.applyCanvasShortcutEvent(db, event);
      const rows = db.prepare("SELECT binding, session_id FROM canvas_shortcuts WHERE username = 'ada' ORDER BY binding").all() as unknown as Array<{ binding: string; session_id: string }>;
      db.close();
      return rows.map((row) => `${row.binding}:${row.session_id}`);
    };

    // One conversation moved from key A to key B, seen in both directions.
    const moves = [assign("A", "chat-x", "2026-09-01T10:00:00.000Z"), assign("B", "chat-x", "2026-09-01T10:00:01.000Z"), assign("B", "chat-y", "2026-09-01T10:00:02.000Z")];
    assert.deepEqual(settle("forwards", moves), ["B:chat-y"]);
    assert.deepEqual(settle("backwards", [...moves].reverse()), ["B:chat-y"], "reversed delivery reaches the same bindings");
    assert.deepEqual(settle("shuffled", [moves[1], moves[2], moves[0]]), ["B:chat-y"]);

    // A release competing with another node's assignment of the same conversation.
    const raced = [assign("C", "chat-z", "2026-09-01T11:00:00.000Z"), free("D", "chat-z", "2026-09-01T11:00:01.000Z")];
    assert.deepEqual(settle("raced", raced), []);
    assert.deepEqual(settle("raced-reversed", [...raced].reverse()), [], "a release frees the conversation whenever it lands");

    // Two writes one node made inside the same millisecond keep their order.
    const shortcutsForNode = await import(`../src/canvas-shortcuts.ts?stamp=${Date.now()}`);
    shortcutsForNode.setCanvasShortcut("ada", "1", { projectId: "project", engine: "pi", sessionId: "rapid" }, nodeOne);
    shortcutsForNode.setCanvasShortcut("ada", "2", { projectId: "project", engine: "pi", sessionId: "rapid" }, nodeOne);
    const stamps = shortcutsForNode.listCanvasShortcuts("ada").map((row: { updatedAt: string }) => row.updatedAt);
    assert.equal(new Set(stamps).size, stamps.length, "no two writes from one node share a stamp");
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
