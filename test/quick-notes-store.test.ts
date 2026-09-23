import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
