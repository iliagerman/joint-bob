import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// `src/secrets.js` is reached through bare imports, so every test in this file shares one
// instance of it, pinned to the first data dir. A configured key keeps the fixture and that
// instance in agreement regardless of which temp dir each test builds.
const TEST_KEY = Buffer.alloc(32, 7);
process.env.JOINT_BOB_SECRET_KEY = TEST_KEY.toString("base64");

// Obvious fakes: a leaked fixture must be unmistakably not a credential.
const DEFAULT_TOKEN = "ghp_test_default";
const WORK_TOKEN = "ghp_test_work";
const CLIENT_TOKEN = "ghp_test_client";
const OVERRIDE_TOKEN = "ghp_test_override";

function encryptWith(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

/**
 * Rebuilds the exact nine-table `github_*` schema and the pre-rename project shape the
 * previous build shipped, seeded with one credential group per resolution tier.
 */
async function legacyNode(tag: string): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `joint-bob-${tag}-`));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const key = TEST_KEY;
  await writeFile(path.join(dataDir, "secret.key"), key.toString("base64"), { mode: 0o600 });

  const legacy = new DatabaseSync(path.join(dataDir, "node.db"));
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_type TEXT NOT NULL DEFAULT 'personal', color TEXT,
      path TEXT NOT NULL UNIQUE, mac_path TEXT, sync_folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE project_locations (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, node_id TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, node_id));
    CREATE TABLE project_aliases (alias_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
    CREATE TABLE project_types (id TEXT PRIMARY KEY, label TEXT NOT NULL, github_group TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE github_accounts (account TEXT PRIMARY KEY, token TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE github_project_auth (project_id TEXT PRIMARY KEY, account TEXT NOT NULL, token TEXT, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE github_auth_migrations (source TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);
    CREATE TABLE github_legacy_file_migrations (path TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_digest TEXT, migrated_at TEXT NOT NULL);
    CREATE TABLE github_account_tombstones (account TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
    CREATE TABLE github_project_auth_tombstones (project_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL);
    CREATE TABLE github_credential_events (event_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_key TEXT NOT NULL, operation TEXT NOT NULL, payload_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL, origin_node_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE github_credential_deliveries (event_id TEXT NOT NULL, peer_id TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, PRIMARY KEY(event_id, peer_id));
    CREATE TABLE github_credential_inbox (event_id TEXT PRIMARY KEY, origin_node_id TEXT NOT NULL, received_at TEXT NOT NULL);
  `);
  const at = "2024-01-01T00:00:00.000Z";
  const insertType = legacy.prepare("INSERT INTO project_types (id, label, github_group, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  insertType.run("personal", "Personal", null, at, at);
  insertType.run("work", "Work", "work-group", at, at);
  const insertProject = legacy.prepare("INSERT INTO projects (id, name, project_type, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  // One project per resolution tier of the old four-tier chain.
  insertProject.run("p-default", "Default project", "personal", path.join(root, "p-default"), at, at);
  insertProject.run("p-type", "Type project", "work", path.join(root, "p-type"), at, at);
  insertProject.run("p-group", "Group project", "personal", path.join(root, "p-group"), at, at);
  insertProject.run("p-override", "Override project", "personal", path.join(root, "p-override"), at, at);
  const insertAccount = legacy.prepare("INSERT INTO github_accounts (account, token, label, is_default, updated_at, origin_node_id) VALUES (?, ?, ?, ?, ?, 'node-1')");
  insertAccount.run("default-group", encryptWith(key, DEFAULT_TOKEN), "Default", 1, at);
  insertAccount.run("work-group", encryptWith(key, WORK_TOKEN), "Work", 0, at);
  insertAccount.run("client-group", encryptWith(key, CLIENT_TOKEN), "Client", 0, at);
  const insertProjectAuth = legacy.prepare("INSERT INTO github_project_auth (project_id, account, token, updated_at, origin_node_id) VALUES (?, ?, ?, ?, 'node-1')");
  insertProjectAuth.run("p-group", "client-group", null, at);
  insertProjectAuth.run("p-override", "", encryptWith(key, OVERRIDE_TOKEN), at);
  legacy.close();
  return { root, dataDir };
}

/** What the old four-tier chain resolved for each project, computed by hand from the fixture. */
const TOKEN_BEFORE: Record<string, string> = {
  "p-default": DEFAULT_TOKEN,
  "p-type": WORK_TOKEN,
  "p-group": CLIENT_TOKEN,
  "p-override": OVERRIDE_TOKEN,
};

test("every project resolves the same GitHub token after the migration as before it", async () => {
  const { root, dataDir } = await legacyNode("secrets-migration");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const tag = `${Date.now()}-${Math.random()}`;
    const { listProjects } = await import(`../src/store.js?secrets-migration=${tag}`);
    await listProjects();
    const secrets = await import(`../src/secrets.js?secrets-migration=${tag}`);

    for (const [projectId, expected] of Object.entries(TOKEN_BEFORE)) {
      const env = secrets.genericSecretEnvironment(projectId);
      assert.equal(env.GH_TOKEN, expected, projectId);
      // The whole GitHub variable set follows the one resolved token.
      assert.equal(env.GITHUB_TOKEN, expected, projectId);
      assert.equal(env.PI_GITHUB_TOKEN, expected, projectId);
      assert.equal(env.GIT_TERMINAL_PROMPT, "0", projectId);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the migration is marker-gated and a second run changes nothing", async () => {
  const { root, dataDir } = await legacyNode("secrets-migration-idempotent");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const tag = `${Date.now()}-${Math.random()}`;
    const { listProjects } = await import(`../src/store.js?secrets-migration-idempotent=${tag}`);
    await listProjects();

    const inspector = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const snapshot = () => JSON.stringify({
        accounts: inspector.prepare("SELECT id, label, provider FROM secret_accounts ORDER BY id").all(),
        assignments: inspector.prepare("SELECT scope_type, scope_id, account_id FROM secret_assignments ORDER BY scope_type, scope_id, account_id").all(),
      });
      const first = snapshot();
      assert.ok(inspector.prepare("SELECT 1 FROM secrets_migrations WHERE source = 'github-groups-v1'").get());

      const { ensureWorkspaceSecretsMigration } = await import(`../src/secrets-migration.js?secrets-migration-idempotent=${tag}`);
      ensureWorkspaceSecretsMigration(inspector);
      assert.equal(snapshot(), first);
    } finally {
      inspector.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the migration converts groups into accounts and drops the legacy GitHub schema", async () => {
  const { root, dataDir } = await legacyNode("secrets-migration-shape");
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = dataDir;
  try {
    const tag = `${Date.now()}-${Math.random()}`;
    const { listProjects } = await import(`../src/store.js?secrets-migration-shape=${tag}`);
    await listProjects();

    const inspector = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const accounts = inspector.prepare("SELECT label, provider, replicate FROM secret_accounts ORDER BY label").all() as unknown as Array<{ label: string; provider: string; replicate: number }>;
      // Three groups plus the per-project override's own account.
      assert.deepEqual(accounts.map((account) => account.label), ["Client", "Default", "Override project GitHub", "Work"]);
      assert.ok(accounts.every((account) => account.provider === "github"));
      // Migrated accounts default to node-local; replication is opt-in per account.
      assert.ok(accounts.every((account) => account.replicate === 0));

      // The default group backfills only the workspace that resolved nothing of its own.
      const workspaceScopes = inspector.prepare("SELECT scope_id FROM secret_assignments WHERE scope_type = 'workspace' ORDER BY scope_id").all() as unknown as Array<{ scope_id: string }>;
      assert.deepEqual(workspaceScopes.map((scope) => scope.scope_id), ["personal", "work"]);

      for (const table of ["github_accounts", "github_project_auth", "github_credential_events", "github_credential_inbox"]) {
        assert.equal(inspector.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), undefined, table);
      }
      // No plaintext token survives anywhere in the converted rows.
      const raw = JSON.stringify(inspector.prepare("SELECT * FROM secret_accounts").all());
      for (const token of [DEFAULT_TOKEN, WORK_TOKEN, CLIENT_TOKEN, OVERRIDE_TOKEN]) assert.doesNotMatch(raw, new RegExp(token));
    } finally {
      inspector.close();
    }
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
