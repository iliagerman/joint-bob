import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function databaseText(dataDir: string): Promise<string> {
  const files = ["node.db", "node.db-wal"];
  return (await Promise.all(files.map(async (file) => {
    try { return (await readFile(path.join(dataDir, file))).toString("utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }))).join("");
}

function credentialRowExists(dataDir: string, table: string, keyColumn: string, key: string): boolean {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE ${keyColumn} = ?`).get(key);
  db.close();
  return Boolean(row);
}

function legacyMigrationRow(dataDir: string, legacyPath: string): { digest: string; applied_digest: string | null } | undefined {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const row = db.prepare("SELECT digest, applied_digest FROM github_legacy_file_migrations WHERE path = ?").get(legacyPath) as { digest: string; applied_digest: string | null } | undefined;
  db.close();
  return row;
}

test("legacy GitHub credentials migrate into encrypted node-local SQLite and enqueue once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-migration-"));
  const localDataDir = path.join(root, "local-data");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    await mkdir(localDataDir, { recursive: true });
    const defaultLegacyPath = path.join(localDataDir, "github-auth.json");
    const configuredLegacyPath = path.join(root, "configured-github-auth.json");
    const legacyStore = JSON.stringify({ accounts: { personal: "legacy-token" }, projects: {} });
    await writeFile(defaultLegacyPath, legacyStore);
    await writeFile(configuredLegacyPath, legacyStore);
    process.env.PI_WEB_DATA_DIR = localDataDir;
    process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = configuredLegacyPath;
    const auth = await import(`../src/github-auth.js?migration=${Date.now()}`);

    assert.deepEqual((await auth.getGitHubAuthStatus()).groups, [{ id: "personal", label: "Personal", isDefault: true }]);
    assert.equal(auth.gitHubEnvironment("project").GH_TOKEN, "legacy-token");
    const events = await auth.githubCredentialEventsForPeer("11111111-1111-4111-8111-111111111111");
    assert.equal(events.length, 2);
    assert.ok(events.some((event) => event.entityType === "account" && event.key === "personal" && event.operation === "upsert"));
    assert.ok(events.some((event) => event.entityType === "account" && event.key === "sela" && event.operation === "delete"));
    assert.equal((await auth.githubCredentialEventsForPeer("11111111-1111-4111-8111-111111111111")).length, 2);
    assert.doesNotMatch(await databaseText(localDataDir), /legacy-token/);
    await access(defaultLegacyPath);
    await access(configuredLegacyPath);
    auth.cleanupLegacyGitHubCredentialFiles();
    await assert.rejects(access(defaultLegacyPath));
    await assert.rejects(access(configuredLegacyPath));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured GitHub legacy source takes precedence while tracking both files for cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-precedence-"));
  const localDataDir = path.join(root, "local-data");
  const configuredPath = path.join(root, "configured-github-auth.json");
  const defaultPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(configuredPath, JSON.stringify({
      accounts: { personal: "configured-token" },
      projects: { configured: { account: "personal", token: "configured-project-token" } },
    }));
    await writeFile(defaultPath, JSON.stringify({ accounts: { personal: "default-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = configuredPath;
    const auth = await import(`../src/github-auth.js?precedence=${Date.now()}`);

    assert.equal(auth.gitHubEnvironment("other").GH_TOKEN, "configured-token");
    assert.equal(auth.gitHubEnvironment("configured").GH_TOKEN, "configured-project-token");
    const configuredMigration = legacyMigrationRow(localDataDir, configuredPath);
    const defaultMigration = legacyMigrationRow(localDataDir, defaultPath);
    assert.ok(configuredMigration);
    assert.ok(defaultMigration);
    assert.equal(configuredMigration.applied_digest, configuredMigration.digest);
    assert.equal(defaultMigration.applied_digest, null);

    auth.cleanupLegacyGitHubCredentialFiles();
    await assert.rejects(access(configuredPath));
    await assert.rejects(access(defaultPath));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("default GitHub legacy source is promoted after the configured source disappears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-promotion-"));
  const localDataDir = path.join(root, "local-data");
  const configuredPath = path.join(root, "configured-github-auth.json");
  const defaultPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(configuredPath, JSON.stringify({ accounts: { personal: "configured-token" }, projects: {} }));
    await writeFile(defaultPath, JSON.stringify({ accounts: { personal: "fallback-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = configuredPath;
    const initial = await import(`../src/github-auth.js?promotion-initial=${Date.now()}`);

    assert.equal(initial.gitHubEnvironment("project").GH_TOKEN, "configured-token");
    assert.equal(legacyMigrationRow(localDataDir, defaultPath)?.applied_digest, null);
    await rm(configuredPath);
    await writeFile(defaultPath, JSON.stringify({ accounts: { personal: "promoted-token" }, projects: {} }));
    const promoted = await import(`../src/github-auth.js?promotion-restart=${Date.now()}`);

    assert.equal(promoted.gitHubEnvironment("project").GH_TOKEN, "promoted-token");
    const migration = legacyMigrationRow(localDataDir, defaultPath);
    assert.ok(migration);
    assert.equal(migration.applied_digest, migration.digest);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub legacy cleanup retries rollback-era credential updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-cleanup-"));
  const localDataDir = path.join(root, "local-data");
  const legacyPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    const oldStore = JSON.stringify({ accounts: { personal: "old-token" }, projects: {} });
    const newStore = JSON.stringify({ accounts: { personal: "new-token" }, projects: {} });
    await mkdir(localDataDir, { recursive: true });
    await writeFile(legacyPath, oldStore);
    process.env.PI_WEB_DATA_DIR = localDataDir;
    delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
    const initial = await import(`../src/github-auth.js?cleanup-initial=${Date.now()}`);

    assert.equal(initial.gitHubEnvironment("project").GH_TOKEN, "old-token");
    await access(legacyPath);
    await writeFile(legacyPath, newStore);
    assert.throws(() => initial.cleanupLegacyGitHubCredentialFiles(), { message: "Legacy GitHub credential file changed after migration" });
    assert.equal(await readFile(legacyPath, "utf8"), newStore);

    const retry = await import(`../src/github-auth.js?cleanup-retry=${Date.now()}`);
    assert.deepEqual((await retry.getGitHubAuthStatus()).groups, [{ id: "personal", label: "Personal", isDefault: true }]);
    assert.equal(retry.gitHubEnvironment("project").GH_TOKEN, "new-token");
    assert.doesNotMatch(await databaseText(localDataDir), /new-token/);
    retry.cleanupLegacyGitHubCredentialFiles();
    await assert.rejects(access(legacyPath));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub legacy cleanup removes unchanged migrated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-unchanged-"));
  const localDataDir = path.join(root, "local-data");
  const legacyPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ accounts: { personal: "unchanged-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    const auth = await import(`../src/github-auth.js?cleanup-unchanged=${Date.now()}`);

    await auth.getGitHubAuthStatus();
    auth.cleanupLegacyGitHubCredentialFiles();
    await assert.rejects(access(legacyPath));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub legacy cleanup preflights configured and default files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-preflight-"));
  const localDataDir = path.join(root, "local-data");
  const configuredPath = path.join(root, "configured-github-auth.json");
  const defaultPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(configuredPath, JSON.stringify({ accounts: { personal: "configured-token" }, projects: {} }));
    await writeFile(defaultPath, JSON.stringify({ accounts: { personal: "default-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = configuredPath;
    const auth = await import(`../src/github-auth.js?cleanup-preflight=${Date.now()}`);

    await auth.getGitHubAuthStatus();
    await writeFile(configuredPath, JSON.stringify({ accounts: { personal: "changed-configured-token" }, projects: {} }));
    assert.throws(() => auth.cleanupLegacyGitHubCredentialFiles(), { message: "Legacy GitHub credential file changed after migration" });
    await access(configuredPath);
    await access(defaultPath);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub legacy cleanup refuses to remove files before migration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-cleanup-guard-"));
  const localDataDir = path.join(root, "local-data");
  const legacyPath = path.join(localDataDir, "github-auth.json");
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    await mkdir(localDataDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ accounts: { personal: "legacy-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    const auth = await import(`../src/github-auth.js?cleanup-guard=${Date.now()}`);

    assert.throws(() => auth.cleanupLegacyGitHubCredentialFiles(), /GitHub credential migration is not complete/);
    await access(legacyPath);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("changed legacy snapshots authoritatively clear accounts and project overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-rollback-clear-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    const localDataDir = path.join(root, "local");
    const peerDataDir = path.join(root, "peer");
    const legacyPath = path.join(localDataDir, "github-auth.json");
    const peerId = "44444444-4444-4444-8444-444444444444";
    await mkdir(localDataDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
      accounts: { personal: "personal-token", sela: "sela-token" },
      projects: {
        retained: { account: "personal", token: "retained-token" },
        removed: { account: "sela", token: "removed-token" },
      },
    }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
    const initial = await import(`../src/github-auth.js?rollback-clear-initial=${Date.now()}`);
    await initial.getGitHubAuthStatus();
    process.env.PI_WEB_DATA_DIR = peerDataDir;
    const peer = await import(`../src/github-auth.js?rollback-clear-peer=${Date.now()}`);
    const initialEvents = await initial.githubCredentialEventsForPeer(peerId);
    await peer.receiveGitHubCredentialEvents(initialEvents);
    await initial.recordGitHubCredentialReceipt(peerId, initialEvents.map((event) => event.id));

    await writeFile(legacyPath, JSON.stringify({
      accounts: { personal: "personal-token" },
      projects: { retained: { account: "personal", token: "retained-token" } },
    }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    const rollback = await import(`../src/github-auth.js?rollback-clear-changed=${Date.now()}`);
    assert.deepEqual((await rollback.getGitHubAuthStatus()).groups, [{ id: "personal", label: "Personal", isDefault: true }]);
    assert.equal((await rollback.getGitHubAuthStatus("removed")).project?.hasOverride, false);
    assert.equal(credentialRowExists(localDataDir, "github_accounts", "account", "sela"), false);
    assert.equal(credentialRowExists(localDataDir, "github_account_tombstones", "account", "sela"), true);
    assert.equal(credentialRowExists(localDataDir, "github_project_auth", "project_id", "removed"), false);
    assert.equal(credentialRowExists(localDataDir, "github_project_auth_tombstones", "project_id", "removed"), true);

    const clearEvents = await rollback.githubCredentialEventsForPeer(peerId);
    assert.ok(clearEvents.some((event) => event.entityType === "account" && event.key === "sela" && event.operation === "delete"));
    assert.ok(clearEvents.some((event) => event.entityType === "project" && event.key === "removed" && event.operation === "delete"));
    await peer.receiveGitHubCredentialEvents(clearEvents);
    assert.deepEqual((await peer.getGitHubAuthStatus()).groups, [{ id: "personal", label: "Personal", isDefault: true }]);
    assert.equal((await peer.getGitHubAuthStatus("removed")).project?.hasOverride, false);
    assert.equal(peer.gitHubEnvironment("removed").GH_TOKEN, "personal-token");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("changed legacy snapshots emit one newer credential rotation event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-rollback-rotation-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousAuthPath = process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
  try {
    const localDataDir = path.join(root, "local");
    const peerDataDir = path.join(root, "peer");
    const legacyPath = path.join(localDataDir, "github-auth.json");
    const peerId = "55555555-5555-4555-8555-555555555555";
    await mkdir(localDataDir, { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ accounts: { personal: "old-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH;
    const initial = await import(`../src/github-auth.js?rollback-rotation-initial=${Date.now()}`);
    process.env.PI_WEB_DATA_DIR = peerDataDir;
    const peer = await import(`../src/github-auth.js?rollback-rotation-peer=${Date.now()}`);
    const historicalEvents = await initial.githubCredentialEventsForPeer(peerId);
    const historical = historicalEvents.find((event) => event.entityType === "account" && event.key === "personal" && event.operation === "upsert");
    assert.ok(historical);
    await peer.receiveGitHubCredentialEvents(historicalEvents);
    await initial.recordGitHubCredentialReceipt(peerId, historicalEvents.map((event) => event.id));

    await writeFile(legacyPath, JSON.stringify({ accounts: { personal: "new-token" }, projects: {} }));
    process.env.PI_WEB_DATA_DIR = localDataDir;
    const rotation = await import(`../src/github-auth.js?rollback-rotation-changed=${Date.now()}`);
    const rotationEvents = await rotation.githubCredentialEventsForPeer(peerId);
    const rotated = rotationEvents.find((event) => event.entityType === "account" && event.key === "personal" && event.operation === "upsert");
    assert.ok(rotated);
    assert.notEqual(rotated.id, historical.id);
    assert.ok(rotated.updatedAt > historical.updatedAt);
    assert.deepEqual(rotated.value, { label: "Personal", token: "new-token", isDefault: true });
    await peer.receiveGitHubCredentialEvents(rotationEvents);
    assert.equal(peer.gitHubEnvironment("project").GH_TOKEN, "new-token");

    await rotation.recordGitHubCredentialReceipt(peerId, rotationEvents.map((event) => event.id));
    assert.deepEqual(await rotation.githubCredentialEventsForPeer(peerId), []);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousAuthPath === undefined) delete process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH; else process.env.PI_MOBILE_WEB_GITHUB_AUTH_PATH = previousAuthPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub account and project credentials converge through encrypted idempotent events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-github-auth-sync-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  try {
    const macData = path.join(root, "mac");
    const homeData = path.join(root, "home");
    process.env.PI_WEB_DATA_DIR = macData;
    const mac = await import(`../src/github-auth.js?mac=${Date.now()}`);
    process.env.PI_WEB_DATA_DIR = homeData;
    const home = await import(`../src/github-auth.js?home=${Date.now()}`);
    const macId = "22222222-2222-4222-8222-222222222222";
    const homeId = "33333333-3333-4333-8333-333333333333";

    await mac.saveGitHubGroup({ id: "personal", label: "Personal", token: "mac-personal-token" });
    await mac.updateProjectGitHubAuth("shared-project", "personal", "mac-project-token");
    const first = await mac.githubCredentialEventsForPeer(homeId);
    assert.deepEqual(await home.receiveGitHubCredentialEvents(first), first.map((event) => event.id));
    await mac.recordGitHubCredentialReceipt(homeId, first.map((event) => event.id));
    assert.deepEqual((await home.getGitHubAuthStatus()).groups, [{ id: "personal", label: "Personal", isDefault: true }]);
    assert.equal(home.gitHubEnvironment("shared-project").GH_TOKEN, "mac-project-token");

    await home.saveGitHubGroup({ id: "personal", label: "Personal", token: "home-personal-token" });
    await home.updateProjectGitHubAuth("shared-project", "sela", "home-project-token");
    const second = await home.githubCredentialEventsForPeer(macId);
    assert.deepEqual(await mac.receiveGitHubCredentialEvents(second), second.map((event) => event.id));
    await home.recordGitHubCredentialReceipt(macId, second.map((event) => event.id));
    assert.equal(mac.gitHubEnvironment("shared-project").GH_TOKEN, "home-project-token");
    assert.equal((await mac.getGitHubAuthStatus("shared-project")).project?.group, "sela");

    assert.deepEqual(await mac.receiveGitHubCredentialEvents(second), second.map((event) => event.id));
    assert.equal(mac.gitHubEnvironment("shared-project").GH_TOKEN, "home-project-token");

    await home.deleteGitHubGroup("personal");
    await mac.removeProjectGitHubAuth("shared-project");
    const homeClears = await home.githubCredentialEventsForPeer(macId);
    const macClear = await mac.githubCredentialEventsForPeer(homeId);
    await mac.receiveGitHubCredentialEvents(homeClears);
    await home.receiveGitHubCredentialEvents(macClear);
    assert.deepEqual((await mac.getGitHubAuthStatus()).groups, []);
    assert.deepEqual((await home.getGitHubAuthStatus()).groups, []);
    assert.equal(mac.gitHubEnvironment("shared-project").GH_TOKEN, undefined);
    assert.equal(home.gitHubEnvironment("shared-project").GH_TOKEN, undefined);

    await mac.saveGitHubGroup({ id: "personal", label: "Personal", token: "retry-token" });
    const retryAt = new Date("2030-01-01T00:00:00.000Z");
    const retryEvents = await mac.githubCredentialEventsForPeer(homeId, retryAt);
    await mac.recordGitHubCredentialFailure(homeId, retryEvents.map((event) => event.id), "offline", retryAt);
    assert.equal((await mac.githubCredentialEventsForPeer(homeId, new Date("2030-01-01T00:00:01.999Z"))).length, 0);
    assert.ok((await mac.githubCredentialEventsForPeer(homeId, new Date("2030-01-01T00:00:02.000Z"))).length > 0);

    for (const secret of ["mac-personal-token", "mac-project-token", "home-personal-token", "home-project-token", "retry-token"]) {
      assert.doesNotMatch(await databaseText(macData), new RegExp(secret));
      assert.doesNotMatch(await databaseText(homeData), new RegExp(secret));
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
