import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("quick notes persist without creating a conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-store-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const project = await store.addProject("notes", path.join(root, "notes"));
    const created = notes.createQuickNote({
      projectId: project.id,
      title: "  Keep this  ",
      content: "An inert reminder",
      harnessId: "pi",
      provider: "openai-codex",
      modelId: "gpt-5.2-codex",
    });
    assert.equal(created.title, "Keep this");
    assert.deepEqual(notes.listQuickNotes(project.id), [created]);
    assert.equal(notes.getQuickNote(created.id)?.content, "An inert reminder");
    assert.equal(notes.deleteQuickNote(created.id), true);
    assert.deepEqual(notes.listQuickNotes(project.id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quick notes store launch metadata, scheduling, accounts, and filesystem-owned images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-draft-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const project = await store.addProject("drafts", path.join(root, "drafts"));
    const secretAccountId = randomUUID();
    const imageId = randomUUID();
    const data = Buffer.from("fake-png-bytes").toString("base64");
    const scheduledAt = new Date("2026-01-02T03:04:05.000Z").toISOString();
    const created = notes.createQuickNote({
      projectId: project.id,
      title: "Draft with everything",
      content: "Run this later",
      harnessId: "pi",
      nodeId: null,
      secretAccountIds: [secretAccountId],
      scheduledAt,
      images: [{ id: imageId, kind: "image", name: "chart.png", mimeType: "image/png", data }],
    });
    assert.equal(created.status, "pending");
    assert.equal(created.error, null);
    assert.equal(created.sessionId, null);
    assert.equal(created.scheduledAt, scheduledAt);
    assert.deepEqual(created.secretAccountIds, [secretAccountId]);
    assert.deepEqual(created.images, [{ id: imageId, kind: "image", name: "chart.png", mimeType: "image/png", data }]);

    // Image bytes live on the node's filesystem, never as base64 inside SQLite.
    const imagePath = path.join(root, "data", "quick-note-images", created.id, imageId);
    assert.deepEqual(await readFile(imagePath), Buffer.from("fake-png-bytes"));
    const database = new DatabaseSync(path.join(root, "data", "node.db"));
    try {
      const imageColumns = (database.prepare("PRAGMA table_info(quick_note_images)").all() as Array<{ name: string }>).map((column) => column.name);
      assert.ok(!imageColumns.includes("data"), `image data must stay out of SQLite, columns: ${imageColumns.join(",")}`);
      for (const file of ["node.db", "node.db-wal"]) {
        const raw = await readFile(path.join(root, "data", file)).catch(() => Buffer.alloc(0));
        assert.ok(!raw.includes(data), `${file} must not contain the base64 image payload`);
      }
    } finally {
      database.close();
    }

    // A replacement image set drops the previous row and its file.
    const replacementId = randomUUID();
    const replacementData = Buffer.from("replacement-bytes").toString("base64");
    const updated = notes.updateQuickNote(created.id, {
      projectId: project.id,
      title: "Draft with everything",
      content: "Run this later",
      harnessId: "pi",
      images: [{ id: replacementId, kind: "image", name: "shot.png", mimeType: "image/png", data: replacementData }],
    })!;
    assert.deepEqual(updated.images.map((image) => image.id), [replacementId]);
    assert.deepEqual(await readdir(path.join(root, "data", "quick-note-images", created.id)), [replacementId]);

    assert.equal(notes.deleteQuickNote(created.id), true);
    assert.deepEqual(await readdir(path.join(root, "data", "quick-note-images")), [], "deleting a note must remove its image directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quick note queue settings default off with one slot and clamp updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-queue-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    assert.deepEqual(notes.getQuickNoteQueue(), { enabled: false, maxParallel: 1 });
    assert.deepEqual(notes.setQuickNoteQueue({ enabled: true }), { enabled: true, maxParallel: 1 });
    assert.deepEqual(notes.setQuickNoteQueue({ maxParallel: 20 }), { enabled: true, maxParallel: 20 });
    assert.deepEqual(notes.setQuickNoteQueue({ maxParallel: 3 }), { enabled: true, maxParallel: 3 });
    for (const invalid of [0, -1, 21, 1.5, Number.NaN]) {
      assert.throws(() => notes.setQuickNoteQueue({ maxParallel: invalid }), undefined, `maxParallel ${invalid} must be rejected`);
    }
    assert.deepEqual(notes.setQuickNoteQueue({ enabled: false }), { enabled: false, maxParallel: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quick note launch claims are exclusive and leave the backlog once running", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-lifecycle-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const project = await store.addProject("lifecycle", path.join(root, "lifecycle"));
    const created = notes.createQuickNote({ projectId: project.id, title: "One at a time", content: "Body", harnessId: "pi" });
    const sessionId = randomUUID();
    const requestId = randomUUID();

    const claimed = notes.claimQuickNoteForLaunch(created.id, sessionId, requestId);
    assert.equal(claimed?.status, "starting");
    assert.equal(claimed?.sessionId, sessionId);
    assert.equal(claimed?.launchRequestId, requestId);
    assert.equal(notes.claimQuickNoteForLaunch(created.id, randomUUID(), randomUUID()), undefined, "a second claim must never win");
    assert.ok(!notes.listQuickNotes(project.id).some((note) => note.id === created.id), "a starting note leaves the backlog listing");

    notes.markQuickNoteStarted(created.id);
    assert.equal(notes.getQuickNote(created.id)?.status, "started");
    assert.equal(notes.claimQuickNoteForLaunch(created.id, randomUUID(), randomUUID(), ["pending", "failed"]), undefined, "an already started note cannot be claimed again");
    notes.finishQuickNote(created.id, "completed", null);
    assert.equal(notes.getQuickNote(created.id)?.status, "completed");

    // A failed launch returns to the backlog and a manual claim can pick it up again.
    const retried = notes.createQuickNote({ projectId: project.id, title: "Retry me", content: "Body", harnessId: "pi" });
    notes.finishQuickNote(retried.id, "failed", "Selected node is unavailable");
    const failedNote = notes.getQuickNote(retried.id)!;
    assert.equal(failedNote.status, "failed");
    assert.equal(failedNote.error, "Selected node is unavailable");
    assert.ok(notes.listQuickNotes(project.id).some((note) => note.id === retried.id), "a failed note stays visible in the backlog");
    assert.equal(notes.listPendingQuickNoteSummaries().some((note) => note.id === retried.id), false, "a failed note never auto-dispatches");
    const reclaimed = notes.claimQuickNoteForLaunch(retried.id, randomUUID(), randomUUID(), ["pending", "failed"]);
    assert.equal(reclaimed?.status, "starting");

    // Editing is a backlog action: it resets a failed draft but refuses a launched one,
    // and an uncertain launch's durable session id is never casually cleared.
    notes.finishQuickNote(retried.id, "failed", "Selected node is unavailable");
    const edited = notes.updateQuickNote(retried.id, { projectId: project.id, title: "Edited", content: "New body", harnessId: "pi" })!;
    assert.equal(edited.status, "pending");
    assert.equal(edited.error, null);
    assert.equal(edited.sessionId, reclaimed!.sessionId, "uncertain launch metadata survives an edit");
    notes.markQuickNoteStarted(notes.claimQuickNoteForLaunch(retried.id, randomUUID(), randomUUID())!.id);
    assert.throws(() => notes.updateQuickNote(retried.id, { projectId: project.id, title: "Too late", content: "Body", harnessId: "pi" }), /launch/i);
    notes.finishQuickNote(retried.id, "completed", null);
    assert.throws(() => notes.updateQuickNote(retried.id, { projectId: project.id, title: "Done", content: "Body", harnessId: "pi" }), /launch/i, "a completed note must not re-enter the backlog via edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image ids are per-note, so a colliding client id cannot corrupt another note", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-collision-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const project = await store.addProject("collision", path.join(root, "collision"));
    const sharedId = randomUUID();
    const first = notes.createQuickNote({
      projectId: project.id, title: "First", content: "Body", harnessId: "pi",
      images: [{ id: sharedId, kind: "image", name: "first.png", mimeType: "image/png", data: Buffer.from("first-bytes").toString("base64") }],
    });
    const second = notes.createQuickNote({
      projectId: project.id, title: "Second", content: "Body", harnessId: "pi",
      images: [{ id: sharedId, kind: "image", name: "second.png", mimeType: "image/png", data: Buffer.from("second-bytes").toString("base64") }],
    });
    assert.equal(notes.getQuickNote(first.id)!.images[0].name, "first.png");
    assert.equal(notes.getQuickNote(second.id)!.images[0].name, "second.png");
    assert.deepEqual(await readFile(path.join(root, "data", "quick-note-images", first.id, sharedId)), Buffer.from("first-bytes"));
    assert.deepEqual(await readFile(path.join(root, "data", "quick-note-images", second.id, sharedId)), Buffer.from("second-bytes"));
    // Editing the first note's image set leaves the second note untouched.
    notes.updateQuickNote(first.id, { projectId: project.id, title: "First", content: "Body", harnessId: "pi", images: [] });
    assert.deepEqual(notes.getQuickNote(second.id)!.images.map((image) => image.name), ["second.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing image bytes fail visibly and never silently become empty", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-missing-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  const { unlink } = await import("node:fs/promises");
  try {
    const project = await store.addProject("missing-image", path.join(root, "missing-image"));
    const note = notes.createQuickNote({
      projectId: project.id, title: "Lost bytes", content: "Body", harnessId: "pi",
      images: [{ kind: "image", name: "lost.png", mimeType: "image/png", data: Buffer.from("gone").toString("base64") }],
    });
    await unlink(path.join(root, "data", "quick-note-images", note.id, note.images[0].id));
    assert.throws(() => notes.getQuickNote(note.id), /image file is missing/i, "reading the note must surface the lost image");
    // Dispatch eligibility is metadata-only, so planning still works without the bytes.
    const summaries = notes.listPendingQuickNoteSummaries();
    assert.deepEqual(summaries.map((summary) => summary.id), [note.id]);
    assert.equal(summaries[0].status, "pending");
    assert.equal(summaries[0].scheduledAt, null);
    assert.ok(summaries[0].createdAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending quick notes list oldest-first across projects for dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-order-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const first = await store.addProject("first", path.join(root, "first"));
    const second = await store.addProject("second", path.join(root, "second"));
    const oldest = notes.createQuickNote({ projectId: second.id, title: "Oldest", content: "Body", harnessId: "pi" });
    const middle = notes.createQuickNote({ projectId: first.id, title: "Middle", content: "Body", harnessId: "pi" });
    const newest = notes.createQuickNote({ projectId: second.id, title: "Newest", content: "Body", harnessId: "pi" });
    // Timestamps share millisecond resolution, so the durable order is forced the
    // same way a slower save would produce it.
    const database = new DatabaseSync(path.join(root, "data", "node.db"));
    try {
      const stamp = (id: string, value: string) => database.prepare("UPDATE quick_notes SET created_at = ? WHERE id = ?").run(value, id);
      stamp(oldest.id, "2026-01-01T00:00:01.000Z");
      stamp(middle.id, "2026-01-01T00:00:02.000Z");
      stamp(newest.id, "2026-01-01T00:00:03.000Z");
    } finally {
      database.close();
    }
    assert.deepEqual(notes.listPendingQuickNoteSummaries().map((note) => note.id), [oldest.id, middle.id, newest.id]);
    assert.deepEqual(notes.listAllQuickNotes().map((note) => note.title).sort(), ["Middle", "Newest", "Oldest"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery fails both starting and started launches without retrying them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-note-recover-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = `${Date.now()}-${Math.random()}`;
  const store = await import(`../src/store.js?quick-note=${token}`);
  const notes = await import(`../src/quick-notes.js?quick-note=${token}`);
  try {
    const project = await store.addProject("recover", path.join(root, "recover"));
    const uncertain = notes.claimQuickNoteForLaunch(
      notes.createQuickNote({ projectId: project.id, title: "Interrupted", content: "Body", harnessId: "pi" }).id,
      randomUUID(),
      randomUUID(),
    )!;
    const runningNote = notes.claimQuickNoteForLaunch(
      notes.createQuickNote({ projectId: project.id, title: "Crashed mid-run", content: "Body", harnessId: "pi" }).id,
      randomUUID(),
      randomUUID(),
    )!;
    notes.markQuickNoteStarted(runningNote.id);
    const settled = notes.createQuickNote({ projectId: project.id, title: "Settled", content: "Body", harnessId: "pi" });
    const completed = notes.claimQuickNoteForLaunch(
      notes.createQuickNote({ projectId: project.id, title: "Finished earlier", content: "Body", harnessId: "pi" }).id,
      randomUUID(),
      randomUUID(),
    )!;
    notes.markQuickNoteStarted(completed.id);
    notes.finishQuickNote(completed.id, "completed", null);
    const recovered = notes.recoverUncertainQuickNoteLaunches();
    assert.deepEqual(recovered.map((note) => note.id).sort(), [runningNote.id, uncertain.id].sort());
    for (const note of [uncertain, runningNote]) {
      const after = notes.getQuickNote(note.id)!;
      assert.equal(after.status, "failed");
      assert.match(after.error!, /uncertain/i);
      assert.equal(after.sessionId, note.sessionId, "the session id stays durable for reconciliation");
    }
    assert.equal(notes.getQuickNote(settled.id)?.status, "pending");
    assert.equal(notes.getQuickNote(completed.id)?.status, "completed", "a settled note is never replayed");
    assert.deepEqual(notes.recoverUncertainQuickNoteLaunches(), [], "recovery is idempotent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
