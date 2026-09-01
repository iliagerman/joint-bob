import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
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

interface ShortcutBody { shortcuts: Array<{ binding: string; sessionId: string; projectId: string; engine: string }> }

test("canvas shortcuts are read, assigned, and released over HTTP for the signed-in account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-canvas-shortcut-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.MASTER_BOB_ADMIN_USERNAME = "ada";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?shortcuts=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ada", password: "initial-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const csrf = (await login.json() as { csrfToken: string }).csrfToken;
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf };
    // The seeded password must be replaced before the account can use the app.
    const changePassword = await fetch(`${node.baseUrl}/api/auth/change-password`, {
      method: "POST", headers,
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changePassword.status, 204);

    const empty = await fetch(`${node.baseUrl}/api/canvas/shortcuts`, { headers: { Cookie: cookie } });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json() as ShortcutBody).shortcuts, []);

    const assigned = await fetch(`${node.baseUrl}/api/canvas/shortcuts/4`, {
      method: "PUT", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "session-one" }),
    });
    assert.equal(assigned.status, 200);
    const [shortcut] = (await assigned.json() as ShortcutBody).shortcuts;
    assert.deepEqual({ binding: shortcut.binding, projectId: shortcut.projectId, engine: shortcut.engine, sessionId: shortcut.sessionId },
      { binding: "4", projectId: "project-a", engine: "pi", sessionId: "session-one" });
    const reread = await fetch(`${node.baseUrl}/api/canvas/shortcuts`, { headers: { Cookie: cookie } });
    assert.deepEqual((await reread.json() as ShortcutBody).shortcuts.map((row) => row.binding), ["4"]);

    // A lower-case key is the same key, and reassigning moves the binding.
    const moved = await fetch(`${node.baseUrl}/api/canvas/shortcuts/b`, {
      method: "PUT", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "session-one" }),
    });
    assert.equal(moved.status, 200);
    assert.deepEqual((await moved.json() as ShortcutBody).shortcuts.map((row) => row.binding), ["B"]);

    const released = await fetch(`${node.baseUrl}/api/canvas/shortcuts/B`, { method: "DELETE", headers });
    assert.equal(released.status, 200);
    assert.deepEqual((await released.json() as ShortcutBody).shortcuts, []);

    // Closing a conversation releases whatever key it holds now, not the key the page
    // last saw: another node may have moved that key to a different conversation.
    await fetch(`${node.baseUrl}/api/canvas/shortcuts/7`, {
      method: "PUT", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "session-two" }),
    });
    const releasedByIdentity = await fetch(`${node.baseUrl}/api/canvas/shortcuts/release`, {
      method: "POST", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "session-two" }),
    });
    assert.equal(releasedByIdentity.status, 200);
    assert.deepEqual((await releasedByIdentity.json() as ShortcutBody).shortcuts, []);
    const releasingUnbound = await fetch(`${node.baseUrl}/api/canvas/shortcuts/release`, {
      method: "POST", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "never-bound" }),
    });
    assert.equal(releasingUnbound.status, 200, "releasing a conversation that holds no key is not an error");

    const badBinding = await fetch(`${node.baseUrl}/api/canvas/shortcuts/ctrl`, {
      method: "PUT", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "pi", sessionId: "session-one" }),
    });
    assert.equal(badBinding.status, 400);
    const badEngine = await fetch(`${node.baseUrl}/api/canvas/shortcuts/5`, {
      method: "PUT", headers,
      body: JSON.stringify({ projectId: "project-a", engine: "gpt", sessionId: "session-one" }),
    });
    assert.equal(badEngine.status, 400);

    const unauthorized = await fetch(`${node.baseUrl}/api/canvas/shortcuts`);
    assert.equal(unauthorized.status, 401);
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
