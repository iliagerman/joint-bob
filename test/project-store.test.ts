import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("project store persists and updates the paired Mac path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-project-store-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, importProject, listProjects, updateProjectMacPath, updateProjectWorkspaceAndPath } = await import("../src/store.js");

  try {
    const project = await addProject("demo", path.join(root, "server", "demo"), {
      macPath: "/Users/example/Work/demo",
      type: "work",
      synced: true,
      syncFolderId: "demo-sync-folder",
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

    await importProject({ ...project, path: project.path }, undefined, "node-a");
    const relocatedPath = path.join(root, "server", "personal", "demo");
    const relocated = await updateProjectWorkspaceAndPath(project.id, "personal", relocatedPath);
    assert.equal(relocated.id, project.id);
    assert.equal(relocated.type, "personal");
    assert.equal(relocated.path, path.resolve(relocatedPath));
    assert.equal(relocated.macPath, duplicate.macPath);
    assert.equal(relocated.syncFolderId, project.syncFolderId);
    assert.deepEqual(relocated.locations, [{ nodeId: "node-a", path: path.resolve(relocatedPath) }]);

    const listed = await listProjects();
    const storedRelocated = listed.find((entry) => entry.id === project.id);
    assert.equal(storedRelocated?.type, "personal");
    assert.equal(storedRelocated?.path, path.resolve(relocatedPath));
    assert.equal(storedRelocated?.macPath, duplicate.macPath);
    assert.equal(storedRelocated?.syncFolderId, project.syncFolderId);
    assert.deepEqual(storedRelocated?.locations, [{ nodeId: "node-a", path: path.resolve(relocatedPath) }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
