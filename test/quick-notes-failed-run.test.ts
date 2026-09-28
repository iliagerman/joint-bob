import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";

test("a dispatched note stays consumed after failure, edit, retry, and restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-note-consumed-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = randomUUID();
  const store = await import(`../src/store.js?consumed=${token}`);
  const notes = await import(`../src/quick-notes.js?consumed=${token}`);
  try {
    const project = await store.addProject("Consumed notes", root);
    const input = { projectId: project.id, title: "Run once", content: "Never replay", harnessId: "pi" };
    const note = notes.createQuickNote(input);
    const pending = notes.createQuickNote({ ...input, title: "Still pending" });
    assert.equal(pending.dispatchedAt, null);
    const sessionId = randomUUID();
    notes.claimQuickNoteForLaunch(note.id, sessionId, randomUUID());
    notes.markQuickNoteDispatched(note.id);
    notes.markQuickNoteStarted(note.id);
    notes.finishQuickNote(note.id, "failed", "This operation was aborted");
    const failed = notes.getQuickNote(note.id)!;
    assert.ok(failed.dispatchedAt, "dispatch must survive a later failure");
    assert.equal(failed.sessionId, sessionId, "the original conversation remains linked");
    assert.equal(failed.status, "failed");
    assert.deepEqual(notes.listPendingQuickNoteSummaries().map(note => note.id), [pending.id]);
    assert.throws(() => notes.updateQuickNote(note.id, input), /already.*dispatched/i);
    assert.throws(() => notes.moveQuickNote(note.id, pending.id), /backlog/);
    assert.equal(notes.claimQuickNoteForLaunch(note.id, randomUUID(), randomUUID(), ["pending", "failed"]), undefined);
    assert.equal(notes.getQuickNote(note.id)!.sessionId, sessionId, "retry must not overwrite the conversation link");

    const interrupted = notes.createQuickNote({ ...input, title: "Uncertain send" });
    notes.claimQuickNoteForLaunch(interrupted.id, randomUUID(), randomUUID());
    notes.markQuickNoteDispatched(interrupted.id);
    notes.recoverUncertainQuickNoteLaunches();
    assert.ok(notes.getQuickNote(interrupted.id)!.dispatchedAt);
    assert.equal(notes.claimQuickNoteForLaunch(interrupted.id, randomUUID(), randomUUID(), ["failed"]), undefined);

    const preflight = notes.createQuickNote({ ...input, title: "Failed before sending" });
    notes.claimQuickNoteForLaunch(preflight.id, randomUUID(), randomUUID());
    notes.finishQuickNote(preflight.id, "failed", "Node unavailable");
    assert.equal(notes.getQuickNote(preflight.id)!.dispatchedAt, null);
    assert.equal(notes.claimQuickNoteForLaunch(preflight.id, randomUUID(), randomUUID(), ["failed"])!.status, "starting");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("upgrading old failed notes preserves their original conversation without rearming them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-note-migration-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = randomUUID();
  const store = await import(`../src/store.js?migration=${token}`);
  const notes = await import(`../src/quick-notes.js?migration=${token}`);
  try {
    const project = await store.addProject("Legacy notes", root);
    const input = { projectId: project.id, title: "Old failed run", content: "Body", harnessId: "pi" };
    const failed = notes.createQuickNote(input);
    const pending = notes.createQuickNote({ ...input, title: "Untouched draft" });
    const sessionId = randomUUID();
    notes.claimQuickNoteForLaunch(failed.id, sessionId, randomUUID());
    notes.finishQuickNote(failed.id, "failed", "Claude prompt failed after output");
    const database = new DatabaseSync(path.join(root, "data", "node.db"));
    try { database.exec("ALTER TABLE quick_notes DROP COLUMN dispatched_at"); }
    finally { database.close(); }
    const upgraded = await import(`../src/quick-notes.js?upgraded=${token}`);
    assert.ok(upgraded.getQuickNote(failed.id)!.dispatchedAt, "old uncertain failures must be consumed on upgrade");
    assert.equal(upgraded.getQuickNote(failed.id)!.sessionId, sessionId);
    assert.equal(upgraded.getQuickNote(pending.id)!.dispatchedAt, null);
    assert.equal(upgraded.claimQuickNoteForLaunch(failed.id, randomUUID(), randomUUID(), ["failed"]), undefined);

    const preflight = upgraded.createQuickNote({ ...input, title: "New preflight failure" });
    upgraded.claimQuickNoteForLaunch(preflight.id, randomUUID(), randomUUID());
    upgraded.finishQuickNote(preflight.id, "failed", "Node offline before dispatch");
    const reopened = await import(`../src/quick-notes.js?reopened=${token}`);
    assert.equal(reopened.getQuickNote(preflight.id)!.dispatchedAt, null, "backfill runs once, not on every restart");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
