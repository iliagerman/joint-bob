import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function startNode(dataDir: string) {
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  const { createApp } = await import(`../src/app.js?account=${Date.now()}-${Math.random()}`);
  const server = createServer(createApp());
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

test("account sessions can be listed, revoked, and logged out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-account-settings-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  try {
    node = await startNode(root);
    const firstLogin = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const firstCookie = sessionCookie(firstLogin);
    const firstBody = await firstLogin.json() as { csrfToken: string };
    const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: firstCookie, "X-CSRF-Token": firstBody.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changed.status, 204);

    const secondLogin = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "replacement-password" }),
    });
    const secondCookie = sessionCookie(secondLogin);

    const sessionsResponse = await fetch(`${node.baseUrl}/api/auth/sessions`, { headers: { Cookie: firstCookie } });
    assert.equal(sessionsResponse.status, 200);
    const sessions = await sessionsResponse.json() as { currentSessionId: string; sessions: Array<{ id: string }> };
    assert.equal(sessions.sessions.length, 2);
    const secondSession = sessions.sessions.find((session) => session.id !== sessions.currentSessionId);
    if (!secondSession) throw new Error("Second login session was not listed");

    const unknown = await fetch(`${node.baseUrl}/api/auth/sessions/not-a-session`, {
      method: "DELETE",
      headers: { Cookie: firstCookie, "X-CSRF-Token": firstBody.csrfToken },
    });
    assert.equal(unknown.status, 404);

    const revoked = await fetch(`${node.baseUrl}/api/auth/sessions/${encodeURIComponent(secondSession.id)}`, {
      method: "DELETE",
      headers: { Cookie: firstCookie, "X-CSRF-Token": firstBody.csrfToken },
    });
    assert.equal(revoked.status, 204);

    const revokedSession = await fetch(`${node.baseUrl}/api/settings`, { headers: { Cookie: secondCookie } });
    assert.equal(revokedSession.status, 401);

    const logout = await fetch(`${node.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: firstCookie, "X-CSRF-Token": firstBody.csrfToken },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie") || "", /Secure/);
    assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);

    const loggedOut = await fetch(`${node.baseUrl}/api/settings`, { headers: { Cookie: firstCookie } });
    assert.equal(loggedOut.status, 401);
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
