import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

/** Rebuilds the exact pre-workspace schema the previous build shipped. */
async function legacyHome(tag: string): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `joint-bob-${tag}-`));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const legacy = new DatabaseSync(path.join(dataDir, "node.db"));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_type TEXT NOT NULL DEFAULT 'personal',
      color TEXT,
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
    CREATE TABLE project_types (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      github_group TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO project_types (id, label, github_group, created_at, updated_at) VALUES
      ('personal', 'Personal', NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
      ('work', 'Work', NULL, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    INSERT INTO projects (id, name, project_type, path, sync_folder_id, created_at, updated_at) VALUES
      ('legacy-1', 'legacy', 'work', '/tmp/joint-bob-workspace-legacy', 'legacy-folder', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  `);
  legacy.close();
  return { root, dataDir };
}

test("renaming project types to workspaces keeps ids, labels and project membership", async () => {
  const { root, dataDir } = await legacyHome("workspace-schema");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const { listProjects, listWorkspaces } = await import(`../src/store.js?workspace-schema=${Date.now()}-${Math.random()}`);

    const workspaces = await listWorkspaces();
    assert.deepEqual(workspaces, [{ id: "personal", label: "Personal" }, { id: "work", label: "Work" }]);

    const projects = await listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, "legacy-1");
    // Membership survives the rename because the workspace id never changed.
    assert.equal(projects[0].type, "work");

    const inspector = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const columns = (inspector.prepare("PRAGMA table_info(projects)").all() as unknown as Array<{ name: string }>).map((column) => column.name);
      assert.ok(columns.includes("workspace_id"));
      assert.ok(!columns.includes("project_type"));
      const workspaceColumns = (inspector.prepare("PRAGMA table_info(workspaces)").all() as unknown as Array<{ name: string }>).map((column) => column.name);
      assert.ok(!workspaceColumns.includes("github_group"));
      assert.equal(inspector.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_types'").get(), undefined);
    } finally {
      inspector.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the workspaces rename moves no directory on disk", async () => {
  const { root, dataDir } = await legacyHome("workspace-dirs");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  const home = path.join(root, "JointBob");
  await mkdir(path.join(home, "work", "legacy"), { recursive: true });
  const before = await readdir(home);
  try {
    const { listProjects } = await import(`../src/store.js?workspace-dirs=${Date.now()}-${Math.random()}`);
    await listProjects();
    // The workspace id doubles as the folder name, and the id did not change.
    assert.deepEqual(await readdir(home), before);
    assert.deepEqual(await readdir(path.join(home, "work")), ["legacy"]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("secret assignments accept the three scope types and reject anything else", async () => {
  const { root, dataDir } = await legacyHome("workspace-scopes");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const tag = `${Date.now()}-${Math.random()}`;
    const { listWorkspaces } = await import(`../src/store.js?workspace-scopes=${tag}`);
    await listWorkspaces();
    const secrets = await import(`../src/secrets.js?workspace-scopes=${tag}`);
    const account = await secrets.saveSecretAccount({ label: "Scoped", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "scoped-value" }] });

    await secrets.setScopeSecretAccounts("workspace", "work", [account.id]);
    await secrets.setScopeSecretAccounts("project", "legacy-1", [account.id]);
    await secrets.setScopeSecretAccounts("conversation", "claude:session-1", [account.id]);
    for (const [scopeType, scopeId] of [["workspace", "work"], ["project", "legacy-1"], ["conversation", "claude:session-1"]] as const) {
      assert.deepEqual(await secrets.getScopeSecretAccounts(scopeType, scopeId), { accountIds: [account.id] });
    }

    await assert.rejects(() => secrets.getScopeSecretAccounts("project_type" as never, "work"), /Secret scope type/);
    await assert.rejects(() => secrets.getScopeSecretAccounts("workspace", "missing"), /Secret workspace not found/);
    await assert.rejects(() => secrets.getScopeSecretAccounts("conversation", "GPT:session-1"), /Secret conversation scope/);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
