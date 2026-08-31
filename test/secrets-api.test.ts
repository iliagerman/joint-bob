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

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

const SECRET_VALUE = "ghp_test_never_leaves";

test("every secrets endpoint returns metadata only and the three scopes round-trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-secrets-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?secrets-api=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());

    const login = await fetch(`${node.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const cookie = sessionCookie(login);
    const loginBody = await login.json() as { csrfToken: string };
    assert.equal((await fetch(`${node.baseUrl}/api/auth/change-password`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    })).status, 204);
    const headers = { Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" };

    const created = await fetch(`${node.baseUrl}/api/secrets/accounts`, {
      method: "POST", headers,
      body: JSON.stringify({ label: "Work GitHub", provider: "github", replicate: true, variables: [{ name: "GH_TOKEN", kind: "value", value: SECRET_VALUE }] }),
    });
    assert.equal(created.status, 201);
    const createdText = await created.text();
    // The value never comes back, only its name and kind.
    assert.doesNotMatch(createdText, new RegExp(SECRET_VALUE));
    const account = (JSON.parse(createdText) as { account: { id: string; replicate: boolean; variables: Array<{ name: string; kind: string; configured: boolean }> } }).account;
    assert.equal(account.replicate, true);
    assert.deepEqual(account.variables, [{ name: "GH_TOKEN", kind: "value", configured: true }]);

    const listed = await fetch(`${node.baseUrl}/api/secrets`, { headers: { Cookie: cookie } });
    assert.equal(listed.status, 200);
    assert.doesNotMatch(await listed.text(), new RegExp(SECRET_VALUE));

    const project = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ name: "scoped site", type: "personal" }),
    });
    assert.equal(project.status, 201);
    const projectId = (await project.json() as { project: { id: string } }).project.id;

    for (const [scopeType, scopeId] of [["workspace", "personal"], ["project", projectId], ["conversation", "claude:session-api"]] as const) {
      const saved = await fetch(`${node.baseUrl}/api/secrets/scopes/${scopeType}/${encodeURIComponent(scopeId)}`, {
        method: "PUT", headers, body: JSON.stringify({ accountIds: [account.id] }),
      });
      assert.equal(saved.status, 200, scopeType);
      const savedText = await saved.text();
      assert.doesNotMatch(savedText, new RegExp(SECRET_VALUE), scopeType);
      assert.deepEqual(JSON.parse(savedText), { accountIds: [account.id] }, scopeType);

      const read = await fetch(`${node.baseUrl}/api/secrets/scopes/${scopeType}/${encodeURIComponent(scopeId)}`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200, scopeType);
      assert.deepEqual(await read.json(), { accountIds: [account.id] }, scopeType);
    }

    // The removed scope tier is rejected by the route schema, not silently accepted.
    assert.equal((await fetch(`${node.baseUrl}/api/secrets/scopes/project_type/personal`, { headers: { Cookie: cookie } })).status, 400);
    // The GitHub credential group routes are gone.
    assert.equal((await fetch(`${node.baseUrl}/api/github-auth`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await node?.close();
    process.env.PI_WEB_DATA_DIR = previousDataDir;
    process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
