import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("a pre-groups database drops the project_type CHECK without losing rows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-type-migration-"));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  // Recreate the exact schema the previous build shipped, including the two-value CHECK.
  const legacy = new DatabaseSync(path.join(dataDir, "node.db"));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_type TEXT NOT NULL DEFAULT 'personal' CHECK (project_type IN ('personal', 'work')),
      path TEXT NOT NULL UNIQUE,
      mac_path TEXT,
      sync_folder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX projects_sync_folder_id ON projects(sync_folder_id) WHERE sync_folder_id IS NOT NULL;
    CREATE TABLE project_locations (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, node_id)
    );
    CREATE TABLE project_aliases (
      alias_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    INSERT INTO projects (id, name, project_type, path, mac_path, sync_folder_id, created_at, updated_at)
      VALUES ('legacy-1', 'legacy', 'work', '/tmp/joint-bob-legacy-project', NULL, 'legacy-folder', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO project_locations (project_id, node_id, path)
      VALUES ('legacy-1', 'node-1', '/tmp/joint-bob-legacy-project');
    INSERT INTO project_aliases (alias_id, project_id, created_at)
      VALUES ('alias-1', 'legacy-1', '2024-01-01T00:00:00.000Z');
  `);
  legacy.close();

  process.env.PI_WEB_DATA_DIR = dataDir;
  const { addProject, listProjects } = await import("../src/store.js");

  try {
    const projects = await listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "legacy-1");
    assert.equal(projects[0].type, "work");
    assert.equal(projects[0].syncFolderId, "legacy-folder");
    assert.deepEqual(projects[0].locations, [{ nodeId: "node-1", path: "/tmp/joint-bob-legacy-project" }]);

    const inspector = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const schema = inspector.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string };
      assert.doesNotMatch(schema.sql, /CHECK/i);
      assert.ok(inspector.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'projects_sync_folder_id'").get());
      assert.equal(inspector.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal((inspector.prepare("SELECT COUNT(*) AS total FROM project_aliases").get() as { total: number }).total, 1);
      assert.equal((inspector.prepare("SELECT COUNT(*) AS total FROM project_locations").get() as { total: number }).total, 1);
      assert.equal((inspector.prepare("SELECT foreign_keys FROM pragma_foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    } finally {
      inspector.close();
    }

    // A type the old CHECK would have rejected now saves.
    const created = await addProject("fresh", path.join(root, "fresh"), { type: "client-work" });
    assert.equal(created.type, "client-work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
