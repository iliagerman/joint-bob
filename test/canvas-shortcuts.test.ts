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

test("every delivery order of the same writes leaves the same bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-permute-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const peer = "33333333-0000-4000-8000-000000000003";
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const shortcuts = await import(`../src/canvas-shortcuts.ts?test=${Date.now()}`);
    const assign = (binding: string, sessionId: string, at: string) => ({
      id: randomUUID(), originNodeId: peer, entityType: "canvas.shortcut", entityKey: `ada:${binding}`,
      operation: "upsert", createdAt: at,
      payload: { username: "ada", binding, projectId: "project", engine: "pi", sessionId, updatedAt: at, originNodeId: peer },
    });
    const writes = [
      assign("K", "chat-x", "2026-09-01T10:00:00.000Z"),
      assign("K", "chat-y", "2026-09-01T10:00:01.000Z"),
      assign("J", "chat-y", "2026-09-01T10:00:02.000Z"),
    ];
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const order of permutations) {
      const db = new DatabaseSync(path.join(root, `order-${order.join("")}.db`));
      shortcuts.ensureCanvasShortcutSchema(db);
      for (const index of order) shortcuts.applyCanvasShortcutEvent(db, writes[index]);
      const rows = db.prepare("SELECT binding, session_id FROM canvas_shortcuts WHERE username = 'ada' ORDER BY binding").all() as unknown as Array<{ binding: string; session_id: string }>;
      db.close();
      assert.deepEqual(rows.map((row) => `${row.binding}:${row.session_id}`), ["J:chat-y"], `order ${order.join(",")}`);
    }
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("closing a conversation the node has not heard about yet still frees it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-early-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const localNode = "44444444-0000-4000-8000-000000000004";
  const peer = "00000000-0000-4000-8000-000000000000";
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const shortcuts = await import(`../src/canvas-shortcuts.ts?test=${Date.now()}`);
    const conversation = { projectId: "project", engine: "pi" as const, sessionId: "chat-late" };

    // This node holds no binding for the conversation: the peer's assignment is still
    // in flight. Closing the pane must still be published, or that assignment lands.
    shortcuts.releaseCanvasShortcuts("ada", [conversation], localNode);
    const db = new DatabaseSync(path.join(root, "data", "node.db"));
    const published = db.prepare("SELECT operation, payload FROM replication_outbox WHERE entity_type = 'canvas.shortcut'").all() as unknown as Array<{ operation: string; payload: string }>;
    assert.equal(published.length, 1, "the release is replicated even with nothing to delete locally");
    assert.equal(published[0].operation, "delete");
    assert.equal(JSON.parse(published[0].payload).sessionId, "chat-late");

    shortcuts.applyCanvasShortcutEvent(db, {
      id: randomUUID(), originNodeId: peer, entityType: "canvas.shortcut", entityKey: "ada:5",
      operation: "upsert", createdAt: "2026-09-01T09:00:00.000Z",
      payload: { username: "ada", binding: "5", ...conversation, updatedAt: "2026-09-01T09:00:00.000Z", originNodeId: peer },
    });
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), [], "the in-flight assignment loses to the close that overtook it");
    db.close();
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a node never reuses a write stamp, even across a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-clock-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const localNode = "55555555-0000-4000-8000-000000000005";
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const stamps = async (marker: string, sessions: string[]) => {
      const shortcuts = await import(`../src/canvas-shortcuts.ts?clock=${marker}`);
      for (const [index, sessionId] of sessions.entries()) {
        shortcuts.setCanvasShortcut("ada", String(index + 1), { projectId: "project", engine: "pi", sessionId }, localNode);
      }
    };
    // Two runs of the process, each writing faster than the clock ticks.
    await stamps("first", ["a", "b", "c"]);
    await stamps("second", ["d", "e", "f"]);
    const databaseFile = path.join(root, "data", "node.db");
    const db = new DatabaseSync(databaseFile);
    const rows = db.prepare("SELECT payload FROM replication_outbox WHERE entity_type = 'canvas.shortcut' ORDER BY created_at, event_id").all() as unknown as Array<{ payload: string }>;
    db.close();
    const issued = rows.map((row) => JSON.parse(row.payload).updatedAt as string);
    assert.ok(issued.length >= 6, `every write was published (${issued.length})`);
    assert.equal(new Set(issued).size, issued.length, `no stamp is reused: ${issued.join(", ")}`);

    // The proof is the persisted clock, not the wall clock: wind it far ahead, and a
    // fresh process must still issue something past it rather than repeating the past.
    const ahead = new DatabaseSync(databaseFile);
    const future = Date.now() + 3_600_000;
    ahead.prepare("UPDATE canvas_shortcut_clock SET last_issued_at = ?").run(future);
    ahead.close();
    await stamps("third", ["g"]);
    const after = new DatabaseSync(databaseFile);
    const latest = (after.prepare("SELECT last_issued_at FROM canvas_shortcut_clock WHERE singleton = 1").get() as { last_issued_at: number }).last_issued_at;
    after.close();
    assert.ok(latest > future, `a restart issues past the persisted clock (${latest} vs ${future})`);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing shortcut table is carried into the mark registers on upgrade", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-upgrade-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const peer = "66666666-0000-4000-8000-000000000006";
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const databaseFile = path.join(root, "data", "node.db");
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec(`CREATE TABLE canvas_shortcuts (username TEXT NOT NULL, binding TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, binding));
      CREATE TABLE canvas_shortcut_tombstones (username TEXT NOT NULL, binding TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, binding));`);
    legacy.prepare("INSERT INTO canvas_shortcuts VALUES ('ada', '1', 'project', 'pi', 'kept', '2026-09-01T12:00:00.000Z', ?)").run(peer);
    legacy.prepare("INSERT INTO canvas_shortcut_tombstones VALUES ('ada', '2', '2026-09-01T12:00:00.000Z', ?)").run(peer);
    legacy.close();

    const shortcuts = await import(`../src/canvas-shortcuts.ts?upgrade=${Date.now()}`);
    const db = new DatabaseSync(databaseFile);
    shortcuts.ensureCanvasShortcutSchema(db);
    const stale = (binding: string, sessionId: string) => ({
      id: randomUUID(), originNodeId: peer, entityType: "canvas.shortcut", entityKey: `ada:${binding}`,
      operation: "upsert", createdAt: "2026-09-01T11:00:00.000Z",
      payload: { username: "ada", binding, projectId: "project", engine: "pi", sessionId, updatedAt: "2026-09-01T11:00:00.000Z", originNodeId: peer },
    });
    shortcuts.applyCanvasShortcutEvent(db, stale("1", "overwritten"));
    shortcuts.applyCanvasShortcutEvent(db, stale("2", "resurrected"));
    db.close();
    assert.deepEqual(listing(shortcuts.listCanvasShortcuts("ada")), ["1:kept"],
      "an older event cannot overwrite a carried-over binding or revive a released key");
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("opening a database repairs rows and a clock left behind by an older build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcuts-repair-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  const peer = "77777777-0000-4000-8000-000000000007";
  const future = new Date(Date.now() + 3_600_000).toISOString();
  try {
    await mkdir(process.env.JOINT_BOB_DATA_DIR, { recursive: true });
    const databaseFile = path.join(root, "data", "node.db");
    const older = new DatabaseSync(databaseFile);
    older.exec(`CREATE TABLE canvas_shortcuts (username TEXT NOT NULL, binding TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, binding));
      CREATE TABLE canvas_shortcut_binding_marks (username TEXT NOT NULL, binding TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, binding));
      CREATE TABLE canvas_shortcut_conversation_marks (username TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, PRIMARY KEY (username, project_id, engine, session_id));`);
    // A row the earlier build left behind: its key register has already moved past it.
    older.prepare("INSERT INTO canvas_shortcuts VALUES ('ada', 'K', 'project', 'pi', 'stale', '2026-09-01T10:00:00.000Z', ?)").run(peer);
    older.prepare("INSERT INTO canvas_shortcut_binding_marks VALUES ('ada', 'K', ?, ?)").run(future, peer);
    older.prepare("INSERT INTO canvas_shortcut_conversation_marks VALUES ('ada', 'project', 'pi', 'stale', '2026-09-01T10:00:00.000Z', ?)").run(peer);
    older.close();

    const shortcuts = await import(`../src/canvas-shortcuts.ts?repair=${Date.now()}`);
    assert.deepEqual(shortcuts.listCanvasShortcuts("ada"), [],
      "a binding whose register has moved on does not survive the upgrade");

    // The clock starts from what the registers already show, not from the wall clock.
    shortcuts.setCanvasShortcut("ada", "3", { projectId: "project", engine: "pi", sessionId: "fresh" }, peer);
    const issued = shortcuts.listCanvasShortcuts("ada")[0].updatedAt;
    assert.ok(issued > future, `a first write after the upgrade outranks the newest mark (${issued} vs ${future})`);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
