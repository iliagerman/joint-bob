import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

test("runtime audit events are redacted, local, and session-admin readable", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-audit-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = dataDir;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const { createApp } = await import(`../src/app.js?audit=${Date.now()}`);
    const cluster = await import(`../src/cluster.js?audit=${Date.now()}`);
    const replication = await import(`../src/replication.js?audit=${Date.now()}`);
    const tasks = await import(`../src/tasks.js?audit=${Date.now()}`);
    const store = await import(`../src/store.js?audit=${Date.now()}`);
    const github = await import(`../src/github-auth.js?audit=${Date.now()}`);
    const { appendAuditEvent, ensureAuditSchema, listAuditEvents } = await import(`../src/audit.js?audit=${Date.now()}`);
    server = createServer(createApp());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await fetch(`${baseUrl}/api/audit`)).status, 401);
    const failedLogin = () => fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "unknown", password: "wrong-password" }),
    });
    assert.equal((await failedLogin()).status, 401);
    for (let index = 0; index < 4; index += 1) assert.equal((await failedLogin()).status, 401);
    assert.equal((await failedLogin()).status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const cookie = sessionCookie(login);
    const headers = { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken };
    const password = "replacement-audit-password";
    assert.equal((await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: password }),
    })).status, 204);
    assert.equal((await fetch(`${baseUrl}/api/settings`, {
      method: "PUT", headers, body: JSON.stringify({
        pi: { executable: "pi", configPath: "/tmp/pi", sessionPath: "/tmp/pi-sessions" },
        claude: { executable: "claude", configPath: "/tmp/claude", sessionPath: "/tmp/claude-sessions" },
        syncthing: { endpoint: "http://127.0.0.1:8384", apiKey: "fake-syncthing-api-key" },
      }),
    })).status, 200);
    await github.saveGitHubGroup({ label: "Personal", token: "fake-github-token" });

    const local = await cluster.getClusterNode();
    const peerId = randomUUID();
    await cluster.mergeClusterMembership({ members: [{
      id: peerId, name: "Peer", url: "https://peer.example", token: "fake-machine-token",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] });
    const project = await store.addProject("Audit project", path.join(dataDir, "audit-project"));
    const taskId = "audit-task";
    const task = { id: taskId, title: "Audit", description: "synthetic task", status: "backlog" as const, engine: "pi" as const, planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: local.id, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle" as const, handoffContext: null, originNodeId: local.id, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    await replication.receiveReplicationBatch({ events: [{ id: randomUUID(), originNodeId: local.id, entityType: "task", entityKey: `${project.id}:${taskId}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: local.id }, createdAt: task.updatedAt }] });
    const claim = await tasks.claimTaskLease(project.id, taskId, local.id);
    const released = await tasks.releaseTaskLease(project.id, taskId, local.id, claim.leaseToken);
    const incomingTimestamp = new Date().toISOString();
    const incomingTask = { ...task, id: "audit-incoming-task", createdAt: incomingTimestamp, updatedAt: incomingTimestamp };
    await tasks.prepareTaskHandoff(randomUUID(), project.id, project.id, incomingTask, peerId, null, "fake-transcript-content", incomingTimestamp);
    const outgoing = await tasks.beginOutgoingTaskHandoff(project.id, released, local.id, peerId);
    await tasks.markOutgoingTaskHandoff(outgoing.handoffId, "prepared");
    await tasks.completeTaskHandoff(outgoing.handoffId, project.id, taskId, local.id, peerId);

    const audit = await fetch(`${baseUrl}/api/audit?limit=200`, { headers: { Cookie: cookie } });
    assert.equal(audit.status, 200);
    const events = (await audit.json() as { events: Array<{ eventType: string }> }).events;
    const eventTypes = new Set(events.map((event) => event.eventType));
    for (const eventType of ["auth.login.failed", "auth.login.rate_limited", "auth.login.succeeded", "auth.password.changed", "settings.updated", "github.group.saved", "cluster.membership.merged", "task.lease.claimed", "task.lease.released", "task.handoff.prepared", "task.handoff.committed"]) assert.ok(eventTypes.has(eventType), eventType);
    assert.equal((await fetch(`${baseUrl}/api/audit`, { headers: { Authorization: `Bearer ${await cluster.getClusterMachineToken()}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken } })).status, 204);

    const rawAudit = JSON.stringify(await listAuditEvents(200));
    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    ensureAuditSchema(db);
    assert.throws(() => appendAuditEvent(db, { eventType: "bad", actorType: "system", entityType: "test", details: { password: "forbidden" } }), /forbidden key/);
    const rawRows = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    const credentialPayloads = JSON.stringify(db.prepare("SELECT payload_encrypted FROM github_credential_events").all());
    for (const secret of ["initial-password", password, "fake-syncthing-api-key", "fake-github-token", "fake-machine-token", "fake-transcript-content", loginBody.csrfToken]) {
      assert.doesNotMatch(rawAudit, new RegExp(secret));
      assert.doesNotMatch(rawRows, new RegExp(secret));
      assert.doesNotMatch(credentialPayloads, new RegExp(secret));
    }
    const rawDatabase = (await readFile(path.join(dataDir, "node.db"))).toString("utf8");
    const rawWal = (await readFile(path.join(dataDir, "node.db-wal"))).toString("utf8");
    for (const secret of ["fake-syncthing-api-key", "fake-github-token", "fake-machine-token"]) {
      assert.doesNotMatch(rawDatabase, new RegExp(secret));
      assert.doesNotMatch(rawWal, new RegExp(secret));
    }
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(dataDir, { recursive: true, force: true });
  }
});
