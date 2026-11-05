import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("a topic written on one machine reaches the person's other machine, the newest write wins, and deletes travel too", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "joint-bob-memory-sync-"));
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const sync = await import(`../src/control-center/memory-sync.ts?memory-sync=${Date.now()}`);
    const { memoryRoot } = await import(`../src/control-center/memory-store.ts?memory-sync=${Date.now()}`);
    const db = new DatabaseSync(":memory:");
    const sent = (): Array<{ entityType: string; operation: string; payload: string }> => db.prepare("SELECT entity_type AS entityType, operation, payload FROM replication_outbox ORDER BY rowid").all() as never;

    sync.publishTopic(db, "node-a", "ilia", "release-gate", "---\nname: release-gate\ndescription: Push needs the token\n---\nUse the token.\n");
    sync.publishTopic(db, "node-a", "ilia", "release-gate", null);
    assert.deepEqual(sent().map((event) => [event.entityType, event.operation]), [["control.memory", "upsert"], ["control.memory", "delete"]]);

    const event = (id: string, operation: "upsert" | "delete", text: string | null, updatedAt: string) => ({
      id, originNodeId: "node-b", entityType: "control.memory", entityKey: "ilia:how-ilia-works", operation, createdAt: updatedAt,
      payload: { accountId: "ilia", topic: "how-ilia-works", text, updatedAt, originNodeId: "node-b" },
    });
    const file = path.join(memoryRoot("ilia"), "how-ilia-works.md");
    const text = (body: string) => `---\nname: how-ilia-works\ndescription: How Ilia works\n---\n${body}\n`;
    sync.applyMemoryEvent(db, event("e1", "upsert", text("Plans first."), "2026-11-05T10:00:00.000Z"));
    assert.match(await readFile(file, "utf8"), /Plans first/);
    sync.applyMemoryEvent(db, event("e2", "upsert", text("OLD write arriving late."), "2026-11-05T09:00:00.000Z"));
    assert.match(await readFile(file, "utf8"), /Plans first/, "an older write does not replace a newer one");
    sync.applyMemoryEvent(db, event("e3", "upsert", text("Plans first, then approves."), "2026-11-05T11:00:00.000Z"));
    assert.match(await readFile(file, "utf8"), /then approves/);
    assert.match(await readFile(path.join(memoryRoot("ilia"), "INDEX.md"), "utf8"), /\[\[how-ilia-works\]\]/, "the index follows");
    sync.applyMemoryEvent(db, event("e4", "delete", null, "2026-11-05T12:00:00.000Z"));
    assert.equal(existsSync(file), false);
    assert.equal(sent().length, 2, "applying a received topic does not send it on again");

    assert.throws(() => sync.applyMemoryEvent(db, { ...event("e5", "upsert", "x", "2026-11-05T13:00:00.000Z"), payload: { accountId: "ilia", topic: "../escape", text: "x", updatedAt: "2026-11-05T13:00:00.000Z", originNodeId: "node-b" } }), /Malformed/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
