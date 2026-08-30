import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

test("preferences are authenticated, validated, and persist across listener restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-preferences-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?preferences=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());

    const login = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const cookie = sessionCookie(login);
    const loginBody = await login.json() as { csrfToken: string };
    const changePassword = await fetch(`${node.baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changePassword.status, 204);

    const requestHeaders = { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" };
    const defaults = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(defaults.status, 200);
    assert.deepEqual(await defaults.json(), {
      theme: null,
      notificationsEnabled: false,
      completionSound: "chime",
      installDismissed: false,
      mobileView: "projects",
      activeProjectId: null,
      activeSessionPath: null,
      activeSessionId: null,
      activeNodeId: null,
      legacyMigrated: false,
      pinnedProjectIds: [],
      pinnedSessionPaths: [],
      projectsPanelCollapsed: false,
      chatsPanelCollapsed: false,
      recentSessions: [],
      lastSeenVersion: null,
    });

    const values = {
      theme: "dark",
      notificationsEnabled: true,
      completionSound: "bell",
      installDismissed: true,
      mobileView: "board",
      activeProjectId: "project-123",
      activeSessionPath: "/tmp/session.jsonl",
      activeSessionId: "session-123",
      activeNodeId: "72cfed24-549b-4c90-ab61-42d2899ab9bb",
      legacyMigrated: true,
      pinnedProjectIds: ["project-123"],
      pinnedSessionPaths: ["/tmp/session.jsonl"],
      projectsPanelCollapsed: true,
      chatsPanelCollapsed: true,
      recentSessions: [{ projectId: "project-123", sessionPath: "/tmp/session.jsonl", title: "Session 123", openedAt: "2026-08-27T10:00:00.000Z" }],
      lastSeenVersion: "1.4.2",
    };
    const updated = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers: requestHeaders, body: JSON.stringify(values) });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), values);

    const canonicalPath = "/tmp/session.jsonl";
    const duplicateSessions = [
      { projectId: "project-123", sessionPath: "/tmp/session.sync-conflict-20260827-120000-ABC.jsonl", title: "Newest", openedAt: "2026-08-27T12:00:00.000Z" },
      { projectId: "project-123", sessionPath: "/tmp/session.sync-conflict-20260827-110000-ABC.jsonl", title: "Older conflict", openedAt: "2026-08-27T11:00:00.000Z" },
      { projectId: "project-123", sessionPath: canonicalPath, title: "Older canonical", openedAt: "2026-08-27T10:00:00.000Z" },
      { projectId: "other-project", sessionPath: canonicalPath, title: "Other project", openedAt: "2026-08-27T09:00:00.000Z" },
    ];
    const cleanedSessions = [
      { ...duplicateSessions[0], sessionPath: canonicalPath },
      duplicateSessions[3],
    ];
    const deduplicated = await fetch(`${node.baseUrl}/api/preferences`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ recentSessions: duplicateSessions }),
    });
    assert.equal(deduplicated.status, 200);
    assert.deepEqual((await deduplicated.json() as { recentSessions: unknown }).recentSessions, cleanedSessions);

    const persistenceDb = new DatabaseSync(path.join(root, "node.db"));
    const stored = persistenceDb.prepare("SELECT recent_sessions FROM user_preferences").get() as { recent_sessions: string };
    assert.deepEqual(JSON.parse(stored.recent_sessions), cleanedSessions);

    const staleSessions = [duplicateSessions[2], duplicateSessions[0], duplicateSessions[0], duplicateSessions[3], { projectId: 1 }];
    persistenceDb.prepare("UPDATE user_preferences SET recent_sessions = ?").run(JSON.stringify(staleSessions));
    persistenceDb.close();
    const repaired = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(repaired.status, 200);
    assert.deepEqual((await repaired.json() as { recentSessions: unknown }).recentSessions, [duplicateSessions[2], duplicateSessions[3]]);

    const invalidEnum = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ mobileView: "invalid" }) });
    assert.equal(invalidEnum.status, 400);
    const invalidSound = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ completionSound: "siren" }) });
    assert.equal(invalidSound.status, 400);
    const invalidPath = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers: requestHeaders, body: JSON.stringify({ activeSessionPath: "x".repeat(2001) }) });
    assert.equal(invalidPath.status, 400);
    const unauthorized = await fetch(`${node.baseUrl}/api/preferences`);
    assert.equal(unauthorized.status, 401);
    const secondAdministrator = await fetch(`${node.baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other", password: "another-long-password" }),
    });
    assert.equal(secondAdministrator.status, 409);

    await node.close();
    node = await listen(app.createApp());
    const persisted = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), {
      ...values,
      recentSessions: [duplicateSessions[2], duplicateSessions[3]],
    });
  } finally {
    if (node) await node.close();
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
