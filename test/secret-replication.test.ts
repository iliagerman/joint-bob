import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// `src/secret-replication.js` reaches `src/secrets.js` through a bare import, so every test in
// this file shares one instance of it, pinned to the first data dir. A configured key keeps
// every instance's crypto in agreement whichever temp dir a test builds.
process.env.JOINT_BOB_SECRET_KEY = Buffer.alloc(32, 11).toString("base64");

async function loadNode(tag: string) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `joint-bob-secret-replication-${tag}-`));
  process.env.PI_WEB_DATA_DIR = dataDir;
  const suffix = `${tag}=${Date.now()}-${Math.random()}`;
  return {
    dataDir,
    secrets: await import(`../src/secrets.js?${suffix}`),
    replication: await import(`../src/secret-replication.js?${suffix}`),
  };
}

async function withNode(tag: string, body: (node: Awaited<ReturnType<typeof loadNode>>) => Promise<void>): Promise<void> {
  const previous = process.env.PI_WEB_DATA_DIR;
  let dataDir = "";
  try {
    const node = await loadNode(tag);
    dataDir = node.dataDir;
    await body(node);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previous;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}

/** Peer replication is exercised through the outbox rows a call produces, not a second node. */
function outboxKeys(dataDir: string): string[] {
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try {
    return (database.prepare("SELECT entity_key FROM secret_credential_events ORDER BY entity_key").all() as unknown as Array<{ entity_key: string }>).map((row) => row.entity_key);
  } finally {
    database.close();
  }
}

test("twins receive owned accounts without the cluster replication flag", async () => {
  await withNode("local", async ({ dataDir, secrets, replication }) => {
    const local = await secrets.saveSecretAccount({ label: "Local", provider: "custom", variables: [{ name: "LOCAL_TOKEN", kind: "value", value: "stays-here" }] });
    const shared = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "SHARED_TOKEN", kind: "value", value: "travels" }] });

    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), [local.id, shared.id].sort());

    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.find((event: { entityKey: string }) => event.entityKey === local.id)?.value.replicate, false);
    assert.equal(events.find((event: { entityKey: string }) => event.entityKey === shared.id)?.value.replicate, true);
  });
});

test("new provider accounts can be replicated without losing their type", async () => {
  await withNode("new-providers", async ({ secrets, replication }) => {
    const account = await secrets.saveSecretAccount({ label: "PostgreSQL", provider: "postgres", replicate: true, variables: [{ name: "DATABASE_URL", kind: "value", value: "postgres://synthetic.invalid/test" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.find((event: { entityKey: string }) => event.entityKey === account.id)?.value.provider, "postgres");
  });
});

test("Jira accounts replicate and incoming credentials retain their provider", async () => {
  await withNode("jira", async ({ secrets, replication }) => {
    const variables = [
      { name: "JIRA_URL", kind: "value" as const, value: "https://synthetic.atlassian.net" },
      { name: "JIRA_EMAIL", kind: "value" as const, value: "synthetic@example.test" },
      { name: "JIRA_API_TOKEN", kind: "value" as const, value: "synthetic-jira-token" },
    ];
    const account = await secrets.saveSecretAccount({ label: "Jira", provider: "jira", variables });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.find((event: { entityKey: string }) => event.entityKey === account.id)?.value.provider, "jira");
    const remoteId = randomUUID();
    const timestamp = new Date().toISOString();
    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(), entityKey: remoteId, operation: "upsert",
      value: { label: "Remote Jira", provider: "jira", variables },
      originNodeId: peerId, updatedAt: timestamp, createdAt: timestamp,
    }]);
    const remote = (await secrets.listSecretAccounts()).find((item: { id: string }) => item.id === remoteId);
    assert.equal(remote?.provider, "jira");
    assert.deepEqual(remote?.variables, variables.map(({ name, kind }) => ({ name, kind, configured: true })));
  });
});

test("replicated accounts carry their workspace attachments", async () => {
  await withNode("workspace-outbox", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
    } finally {
      database.close();
    }
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "TOKEN", kind: "value", value: "travels" }] });
    await secrets.setScopeSecretAccounts("workspace", "personal", [account.id]);

    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);

    assert.deepEqual(events[0].value.workspaceIds, ["personal"]);
  });
});

test("changing a workspace attachment produces a new replication event", async () => {
  await withNode("workspace-update", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
    } finally {
      database.close();
    }
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "TOKEN", kind: "value", value: "travels" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const [first] = await replication.secretCredentialEventsForPeer(peerId);
    await replication.recordSecretCredentialReceipt(peerId, [first.id]);

    await secrets.setScopeSecretAccounts("workspace", "personal", [account.id]);
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);

    assert.equal(events.length, 1);
    assert.deepEqual(events[0].value.workspaceIds, ["personal"]);
  });
});

test("sync upgrades an older account event with workspace attachments", async () => {
  await withNode("workspace-upgrade", async ({ dataDir, secrets, replication }) => {
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "TOKEN", kind: "value", value: "travels" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const [first] = await replication.secretCredentialEventsForPeer(peerId);
    await replication.recordSecretCredentialReceipt(peerId, [first.id]);

    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
      database.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES ('workspace', 'personal', ?)").run(account.id);
      const legacy = { label: "Shared", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "travels" }] };
      database.prepare("UPDATE secret_credential_events SET payload_encrypted = ? WHERE event_id = ?").run(secrets.encryptSecretValue(JSON.stringify(legacy)), first.id);
    } finally {
      database.close();
    }

    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].value.workspaceIds, ["personal"]);
  });
});

test("disabling cluster replication keeps the account available to twins", async () => {
  await withNode("withdraw", async ({ dataDir, secrets, replication }) => {
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "SHARED_TOKEN", kind: "value", value: "travels" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), [account.id]);

    await secrets.saveSecretAccount({ id: account.id, label: "Shared", provider: "custom", replicate: false, variables: [{ name: "SHARED_TOKEN", kind: "value" }] });
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), [account.id]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.length, 1);
    assert.equal(events[0].value.replicate, false);
  });
});

test("a received account is re-encrypted locally and a local overwrite wins afterwards", async () => {
  await withNode("receive", async ({ dataDir, secrets, replication }) => {
    const accountId = randomUUID();
    const event = {
      id: randomUUID(),
      entityKey: accountId,
      operation: "upsert" as const,
      value: { label: "From peer", provider: "github" as const, variables: [{ name: "GH_TOKEN", kind: "value" as const, value: "ghp_test_peer" }] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    assert.deepEqual(await replication.receiveSecretCredentialEvents([event]), [event.id]);

    const accounts = await secrets.listSecretAccounts();
    assert.deepEqual(accounts.map((account: { label: string }) => account.label), ["From peer"]);

    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      // Stored under this node's own key, never the sender's plaintext.
      const row = database.prepare("SELECT variables_encrypted FROM secret_accounts WHERE id = ?").get(accountId) as { variables_encrypted: string };
      assert.doesNotMatch(row.variables_encrypted, /ghp_test_peer/);
      assert.match(row.variables_encrypted, /^[^.]+\.[^.]+\.[^.]+$/);
    } finally {
      database.close();
    }

    // Replaying the same event is a no-op, and a local overwrite outranks the peer's version.
    assert.deepEqual(await replication.receiveSecretCredentialEvents([event]), [event.id]);
    await secrets.saveSecretAccount({ id: accountId, label: "Mine", provider: "github", variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_test_local" }] });
    await replication.receiveSecretCredentialEvents([{ ...event, id: randomUUID() }]);
    assert.deepEqual((await secrets.listSecretAccounts()).map((account: { label: string }) => account.label), ["Mine"]);
  });
});

test("a received account attaches to matching local workspaces", async () => {
  await withNode("workspace-receive", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
    } finally {
      database.close();
    }
    const accountId = randomUUID();
    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(),
      entityKey: accountId,
      operation: "upsert",
      value: {
        label: "From peer",
        provider: "github",
        variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_test_peer" }],
        workspaceIds: ["missing", "personal"],
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);

    assert.deepEqual(await secrets.getScopeSecretAccounts("workspace", "personal"), { accountIds: [accountId] });
  });
});

test("a received workspace attachment retains accounts with the same variable names", async () => {
  await withNode("workspace-collision", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
    } finally {
      database.close();
    }
    const local = await secrets.saveSecretAccount({ label: "Local", provider: "custom", variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "synthetic-local" }] });
    await secrets.setScopeSecretAccounts("workspace", "personal", [local.id]);
    const remoteId = randomUUID();

    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(),
      entityKey: remoteId,
      operation: "upsert",
      value: {
        label: "From peer",
        provider: "custom",
        variables: [{ name: "AWS_ACCESS_KEY_ID", kind: "value", value: "synthetic-peer" }],
        workspaceIds: ["personal"],
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);

    assert.deepEqual((await secrets.getScopeSecretAccounts("workspace", "personal")).accountIds, [local.id, remoteId].sort());
    assert.deepEqual((await secrets.listSecretAccounts()).map((account: { id: string }) => account.id).sort(), [local.id, remoteId].sort());
  });
});

test("ordinary replicated variables do not collide with bound website accounts", async () => {
  await withNode("website-collision", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try { database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('personal')"); }
    finally { database.close(); }
    const website = await secrets.saveSecretAccount({ label: "Website", provider: "custom", websiteOrigin: "https://example.com", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "website-only" }] });
    await secrets.setScopeSecretAccounts("workspace", "personal", [website.id]);
    const ordinaryId = randomUUID();
    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(), entityKey: ordinaryId, operation: "upsert",
      value: { label: "Ordinary", provider: "custom", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "replicated" }], workspaceIds: ["personal"] },
      updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    assert.deepEqual(await secrets.getScopeSecretAccounts("workspace", "personal"), { accountIds: [ordinaryId, website.id].sort() });
  });
});

/** Secrets resolve project scopes against the projects table, which the node schema owns. */
function seedProject(dataDir: string): void {
  const database = new DatabaseSync(path.join(dataDir, "node.db"));
  try { database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT); INSERT INTO workspaces VALUES ('work'); INSERT INTO projects VALUES ('project-a', 'work')"); }
  finally { database.close(); }
}

test("a replicating website account travels with its origin binding", async () => {
  await withNode("website-outbox", async ({ secrets, replication }) => {
    const website = await secrets.saveSecretAccount({ label: "Login", provider: "website", websiteOrigin: "https://app.example.com", replicate: true, variables: [
      { name: "LOGIN_USERNAME", kind: "value", value: "synthetic-user" }, { name: "LOGIN_PASSWORD", kind: "value", value: "synthetic-pass" },
    ] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.deepEqual(events.map((event: { entityKey: string }) => event.entityKey), [website.id]);
    assert.equal(events[0].value.provider, "website");
    assert.equal(events[0].value.websiteOrigin, "https://app.example.com");
  });
});

test("a received website account keeps its origin binding and attachments", async () => {
  await withNode("website-receive", async ({ dataDir, secrets, replication }) => {
    seedProject(dataDir);
    const accountId = randomUUID();
    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(), entityKey: accountId, operation: "upsert",
      value: { label: "Login", provider: "website", websiteOrigin: "https://app.example.com", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "synthetic-pass" }], assignments: [{ scopeType: "project", scopeId: "project-a" }] },
      updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
    }]);
    const [account] = await secrets.listSecretAccounts();
    assert.equal(account.websiteOrigin, "https://app.example.com");
    assert.equal(account.replicate, true);
    // A stored origin is what keeps values out of the shell and inside login-fill (website-secrets.test.ts).
    assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [accountId] });
  });
});

test("a received website account with an origin already bound in its scope is rejected", async () => {
  await withNode("website-duplicate", async ({ dataDir, secrets, replication }) => {
    seedProject(dataDir);
    const local = await secrets.saveSecretAccount({ label: "Local", provider: "website", websiteOrigin: "https://app.example.com", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "local" }] });
    await secrets.setScopeSecretAccounts("project", "project-a", [local.id]);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{
      id: randomUUID(), entityKey: randomUUID(), operation: "upsert",
      value: { label: "Remote", provider: "website", websiteOrigin: "https://app.example.com", variables: [{ name: "OTHER_PASSWORD", kind: "value", value: "remote" }], assignments: [{ scopeType: "project", scopeId: "project-a" }] },
      updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
    }]), /duplicate origins/);
    assert.deepEqual((await secrets.listSecretAccounts()).map((account: { id: string }) => account.id), [local.id]);
  });
});

test("malformed website events are rejected", async () => {
  await withNode("website-reject", async ({ secrets, replication }) => {
    const event = (value: Record<string, unknown>) => ({
      id: randomUUID(), entityKey: randomUUID(), operation: "upsert" as const,
      value: { label: "Login", provider: "website", variables: [{ name: "LOGIN_PASSWORD", kind: "value", value: "x" }], ...value },
      updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
    });
    await assert.rejects(() => replication.receiveSecretCredentialEvents([event({})]), /website origin/i);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([event({ websiteOrigin: "http://example.com" })]), /HTTPS/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([event({ websiteOrigin: "https://example.com", variables: [{ name: "FILE", kind: "file", value: "x" }] })]), /file/i);
    assert.deepEqual(await secrets.listSecretAccounts(), []);
  });
});

test("malformed peer input is rejected rather than half-applied", async () => {
  await withNode("reject", async ({ secrets, replication }) => {
    const base = {
      id: randomUUID(),
      entityKey: randomUUID(),
      operation: "upsert" as const,
      value: { label: "Bad", provider: "custom" as const, variables: [{ name: "TOKEN", kind: "value" as const, value: "value" }] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, entityKey: "not-a-uuid" }]), /secret account UUID/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, provider: "gitlab" } }]), /provider is invalid/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, variables: [] } }]), /between 1 and 20 variables/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, workspaceIds: [""] } }]), /workspace IDs are invalid/);
    // A rejected batch writes nothing at all.
    assert.deepEqual(await secrets.listSecretAccounts(), []);
  });
});

test("replicated accounts carry project and conversation attachments even without a local project", async () => {
  await withNode("assignments-outbox", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY); INSERT OR IGNORE INTO workspaces (id) VALUES ('personal')");
    } catch {
      database.close();
      throw new Error("workspaces seed failed");
    }
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "TOKEN", kind: "value", value: "travels" }] });
    // No local project exists for "remote-project" — the attachment must still travel.
    const insert = database.prepare("INSERT INTO secret_assignments (scope_type, scope_id, account_id) VALUES (?, ?, ?)");
    insert.run("project", "remote-project", account.id);
    insert.run("conversation", "pi:session-1", account.id);
    database.close();

    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.deepEqual(events[0].value.assignments, [
      { scopeType: "conversation", scopeId: "pi:session-1" },
      { scopeType: "project", scopeId: "remote-project" },
    ]);
  });
});

test("a received assignment set stores project attachments for projects this node does not have", async () => {
  await withNode("assignments-receive", async ({ dataDir, secrets, replication }) => {
    const database = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      database.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY); INSERT INTO workspaces (id) VALUES ('personal')");
    } finally {
      database.close();
    }
    const accountId = randomUUID();
    await replication.receiveSecretCredentialEvents([{
      id: randomUUID(),
      entityKey: accountId,
      operation: "upsert",
      value: {
        label: "From peer",
        provider: "github",
        variables: [{ name: "GH_TOKEN", kind: "value", value: "ghp_test_peer" }],
        assignments: [
          { scopeType: "workspace", scopeId: "personal" },
          { scopeType: "workspace", scopeId: "missing" },
          { scopeType: "project", scopeId: "not-here-yet" },
          { scopeType: "conversation", scopeId: "claude:session-9" },
        ],
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    }]);

    // Unknown workspace rows are skipped; project and conversation rows persist so they
    // activate when the project later arrives through an invitation.
    const rows = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      const stored = (rows.prepare("SELECT scope_type, scope_id FROM secret_assignments WHERE account_id = ? ORDER BY scope_type, scope_id").all(accountId) as Array<{ scope_type: string; scope_id: string }>).map((row) => ({ ...row }));
      assert.deepEqual(stored, [
        { scope_type: "conversation", scope_id: "claude:session-9" },
        { scope_type: "project", scope_id: "not-here-yet" },
        { scope_type: "workspace", scope_id: "personal" },
      ]);
    } finally {
      rows.close();
    }
  });
});

for (const scopeType of ["project", "conversation"] as const) {
  test(`${scopeType} attachment changes and removals produce new twin events, unchanged saves do not`, async () => {
    await withNode(`${scopeType}-changes`, async ({ dataDir, secrets, replication }) => {
      seedProject(dataDir);
      const scopeId = scopeType === "project" ? "project-a" : "pi:session-1";
      const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "TOKEN", kind: "value", value: "synthetic" }] });
      const peerId = randomUUID();
      for (const accountIds of [[], [account.id], [], [account.id]]) {
        await secrets.setScopeSecretAccounts(scopeType, scopeId, accountIds);
        await replication.enqueueSecretCredentialSync([peerId]);
        const events = await replication.secretCredentialEventsForPeer(peerId);
        assert.equal(events.length, 1, "changed attachments must invalidate the delivered snapshot");
        assert.deepEqual(events[0].value.assignments, accountIds.map(() => ({ scopeType, scopeId })));
        await replication.recordSecretCredentialReceipt(peerId, [events[0].id]);
        await secrets.setScopeSecretAccounts(scopeType, scopeId, accountIds);
        await replication.enqueueSecretCredentialSync([peerId]);
        assert.deepEqual(await replication.secretCredentialEventsForPeer(peerId), [], "unchanged attachments must not create another event");
      }
    });
  });
}

test("twins receive project-owned accounts with their project restriction", async () => {
  await withNode("project-owned", async ({ dataDir, secrets, replication }) => {
    seedProject(dataDir);
    const account = await secrets.saveSecretAccount({ label: "Project", provider: "custom", projectId: "project-a", variables: [{ name: "TOKEN", kind: "value", value: "synthetic" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.equal(events.length, 1);
    assert.equal(events[0].entityKey, account.id);
    assert.equal(events[0].value.projectId, "project-a");
    assert.equal(events[0].value.replicate, false);
  });
});

test("twin sync excludes other users and imported accounts, including imported projects", async () => {
  await withNode("owned-only", async ({ dataDir, secrets, replication }) => {
    seedProject(dataDir);
    const own = await secrets.saveSecretAccount({ label: "Own", provider: "custom", variables: [{ name: "OWN", kind: "value", value: "synthetic" }] });
    const member = await secrets.saveSecretAccount({ label: "Member", provider: "custom", replicate: true, variables: [{ name: "MEMBER", kind: "value", value: "synthetic" }] });
    const imported = await secrets.saveSecretAccount({ label: "Imported", provider: "custom", replicate: true, variables: [{ name: "IMPORTED", kind: "value", value: "synthetic" }] });
    const project = await secrets.saveSecretAccount({ label: "Imported project", provider: "custom", projectId: "project-a", variables: [{ name: "PROJECT", kind: "value", value: "synthetic" }] });
    const handle = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      handle.prepare("INSERT INTO resource_account_owners VALUES ('secret', ?, 'member', ?)").run(member.id, new Date().toISOString());
      handle.prepare("UPDATE secret_accounts SET origin_node_id = ? WHERE id = ?").run(randomUUID(), imported.id);
      handle.exec("CREATE TABLE sharing_resource_owners (kind TEXT, resource_id TEXT, owner_node_id TEXT); INSERT INTO sharing_resource_owners VALUES ('project', 'project-a', 'another-node')");
    } finally { handle.close(); }
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual((await replication.secretCredentialEventsForPeer(peerId)).map((event: { entityKey: string }) => event.entityKey), [own.id]);
    assert.ok(!outboxKeys(dataDir).includes(project.id));
  });
});

test("pairing promotes an equal-version scoped copy without losing its project or sharing flag", async () => {
  await withNode("promote-scoped", async ({ dataDir, secrets, replication }) => {
    seedProject(dataDir);
    const event = {
      id: randomUUID(), entityKey: randomUUID(), operation: "upsert" as const,
      value: { label: "Project", provider: "custom" as const, projectId: "project-a", replicate: false, variables: [{ name: "TOKEN", kind: "value" as const, value: "synthetic" }], assignments: [{ scopeType: "project" as const, scopeId: "project-a" }] },
      updatedAt: "2026-01-01T00:00:00.000Z", originNodeId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z",
    };
    await replication.receiveSecretCredentialEvents([event]);
    const handle = new DatabaseSync(path.join(dataDir, "node.db"));
    try {
      handle.exec("CREATE TABLE cluster_v2_scoped_secret_copies (account_id TEXT PRIMARY KEY, peer_id TEXT)");
      handle.prepare("INSERT INTO cluster_v2_scoped_secret_copies VALUES (?, ?)").run(event.entityKey, event.originNodeId);
      await replication.receiveSecretCredentialEvents([{ ...event, id: randomUUID() }]);
      assert.equal(handle.prepare("SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE account_id = ?").get(event.entityKey), undefined, "scoped cleanup must not remove a promoted twin account");
      const [account] = await secrets.listSecretAccounts();
      assert.equal(account.projectId, "project-a");
      assert.equal(account.replicate, false, "twin receipt must not enable cluster export");
      assert.deepEqual(await secrets.getScopeSecretAccounts("project", "project-a"), { accountIds: [event.entityKey] });
    } finally { handle.close(); }
  });
});

test("a queued account reassigned to a member is withdrawn from twin delivery", async () => {
  await withNode("withdraw-member", async ({ dataDir, secrets, replication }) => {
    const account = await secrets.saveSecretAccount({ label: "Reassigned", provider: "custom", variables: [{ name: "TOKEN", kind: "value", value: "synthetic" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.equal((await replication.secretCredentialEventsForPeer(peerId)).length, 1);
    const handle = new DatabaseSync(path.join(dataDir, "node.db"));
    try { handle.prepare("INSERT INTO resource_account_owners VALUES ('secret', ?, 'member', ?)").run(account.id, new Date().toISOString()); }
    finally { handle.close(); }
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(await replication.secretCredentialEventsForPeer(peerId), []);
  });
});

test("malformed assignments are rejected rather than half-applied", async () => {
  await withNode("assignments-reject", async ({ secrets, replication }) => {
    const base = {
      id: randomUUID(),
      entityKey: randomUUID(),
      operation: "upsert" as const,
      value: { label: "Bad", provider: "custom" as const, variables: [{ name: "TOKEN", kind: "value" as const, value: "value" }] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      originNodeId: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, replicate: "yes" } }]), /replicate flag is invalid/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, projectId: " " } }]), /project ID is invalid/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, assignments: [{ scopeType: "galaxy", scopeId: "x" }] } }]), /assignments are invalid/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, assignments: [{ scopeType: "project", scopeId: "" }] } }]), /assignments are invalid/);
    await assert.rejects(() => replication.receiveSecretCredentialEvents([{ ...base, value: { ...base.value, assignments: [{ scopeType: "project", scopeId: "p" }, { scopeType: "project", scopeId: "p" }] } }]), /assignments are invalid/);
    assert.deepEqual(await secrets.listSecretAccounts(), []);
  });
});
