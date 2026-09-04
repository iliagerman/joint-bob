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

test("a node-local account produces no outbound replication row", async () => {
  await withNode("local", async ({ dataDir, secrets, replication }) => {
    const local = await secrets.saveSecretAccount({ label: "Local", provider: "custom", variables: [{ name: "LOCAL_TOKEN", kind: "value", value: "stays-here" }] });
    const shared = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "SHARED_TOKEN", kind: "value", value: "travels" }] });

    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), [shared.id]);

    const events = await replication.secretCredentialEventsForPeer(peerId);
    assert.deepEqual(events.map((event: { entityKey: string }) => event.entityKey), [shared.id]);
    assert.doesNotMatch(JSON.stringify(events), /stays-here/);
    assert.ok(!outboxKeys(dataDir).includes(local.id));
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

test("switching an account back to node-local withdraws it from the outbox", async () => {
  await withNode("withdraw", async ({ dataDir, secrets, replication }) => {
    const account = await secrets.saveSecretAccount({ label: "Shared", provider: "custom", replicate: true, variables: [{ name: "SHARED_TOKEN", kind: "value", value: "travels" }] });
    const peerId = randomUUID();
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), [account.id]);

    await secrets.saveSecretAccount({ id: account.id, label: "Shared", provider: "custom", replicate: false, variables: [{ name: "SHARED_TOKEN", kind: "value" }] });
    await replication.enqueueSecretCredentialSync([peerId]);
    assert.deepEqual(outboxKeys(dataDir), []);
    assert.deepEqual(await replication.secretCredentialEventsForPeer(peerId), []);
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
