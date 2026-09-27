import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProject, getProject } from "../src/store.js";

for (const synced of [false, true]) {
  test(`creating a ${synced ? "synced" : "local"} project does not generate agent instructions`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-no-instructions-"));
    try {
      const folder = path.join(root, "project");
      const project = await addProject("No instructions", folder, { synced });
      assert.equal((await getProject(project.id))?.path, folder);
      assert.equal(Boolean(project.syncFolderId), synced);
      assert.deepEqual(await readdir(folder), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("registering a synced project preserves user-written agent instructions", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "joint-bob-existing-instructions-"));
  try {
    const file = path.join(folder, "AGENTS.md");
    const content = "# My project rules\nKeep these instructions.\n";
    await writeFile(file, content);
    await addProject("Existing instructions", folder, { synced: true });
    assert.equal(await readFile(file, "utf8"), content);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
