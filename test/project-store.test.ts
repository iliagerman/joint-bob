import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("project store persists and updates the paired Mac path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-project-store-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, importProject, listProjects, updateProjectMacPath } = await import("../src/store.js");

  try {
    const project = await addProject("demo", path.join(root, "server", "demo"), {
      macPath: "/Users/example/Work/demo",
      type: "work",
    });
    assert.equal(project.macPath, "/Users/example/Work/demo");
    assert.equal(project.type, "work");

    const updated = await updateProjectMacPath(project.id, "/Users/example/Projects/demo");
    assert.equal(updated.macPath, "/Users/example/Projects/demo");

    const duplicate = await addProject("demo", path.join(root, "server", "demo"), {
      macPath: "/Users/example/Code/demo",
    });
    assert.equal(duplicate.id, project.id);
    assert.equal(duplicate.macPath, "/Users/example/Code/demo");

    const stored = await listProjects();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].macPath, "/Users/example/Code/demo");
    assert.equal(stored[0].type, "work");

    const importedPath = path.join(root, "mac", "shared");
    await mkdir(importedPath, { recursive: true });
    const imported = await importProject({
      ...project,
      id: "shared-project-id",
      path: path.join(root, "server", "shared"),
      syncFolderId: "shared-folder-id",
    }, importedPath);
    assert.equal(imported.id, "shared-project-id");
    assert.equal(imported.path, importedPath);
    assert.equal(imported.macPath, project.macPath);
    assert.equal(imported.type, "work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
