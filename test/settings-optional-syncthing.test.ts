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
  const { createApp } = await import(`../src/app.js?settings=${Date.now()}-${Math.random()}`);
  const server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function authenticatedHeaders(baseUrl: string): Promise<Record<string, string>> {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const body = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Missing session cookie");
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": body.csrfToken },
    body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
  });
  assert.equal(changed.status, 204);
  return { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" };
}

test("a settings save without Syncthing keeps the configured endpoint and key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-settings-optional-syncthing-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, username: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  try {
    node = await startNode(root);
    const headers = await authenticatedHeaders(node.baseUrl);
    const configured = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ syncthing: { endpoint: "http://127.0.0.1:8384", apiKey: "secret-api-key" }, conversationHistoryDays: 45 }),
    });
    assert.equal(configured.status, 200);
    assert.deepEqual((await configured.json()).syncthing, { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true });

    const saved = await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ conversationHistoryDays: 30 }) });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.conversationHistoryDays, 30);
    assert.deepEqual(body.syncthing, { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true }, "leaving Syncthing out never clears it");

    const read = await (await fetch(`${node.baseUrl}/api/settings`, { headers })).json();
    assert.deepEqual(read.syncthing, { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true });
    assert.equal(read.conversationHistoryDays, 30);

    const cleared = await fetch(`${node.baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ syncthing: { endpoint: "", apiKey: null } }) });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await cleared.json()).syncthing, { endpoint: "", apiKeyConfigured: false }, "a save that names Syncthing still changes it");
  } finally {
    if (node) await node.close();
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.username], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
