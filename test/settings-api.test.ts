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
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "initial-password" }),
  });
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

test("settings API persists runtime and Syncthing choices without returning secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-bob-settings-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  try {
    node = await startNode(root);
    const headers = await authenticatedHeaders(node.baseUrl);
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "/usr/local/bin/pi", configPath: "/tmp/pi-config", sessionPath: "/tmp/pi-sessions" },
        claude: { executable: "/usr/local/bin/claude", configPath: "/tmp/claude-config", sessionPath: "/tmp/claude-sessions" },
        syncthing: { endpoint: "http://127.0.0.1:8384", apiKey: "secret-api-key" },
        projects: { homePath: path.join(root, "JointBob") },
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      pi: { executable: "/usr/local/bin/pi", configPath: "/tmp/pi-config", sessionPath: "/tmp/pi-sessions" },
      claude: { executable: "/usr/local/bin/claude", configPath: "/tmp/claude-config", sessionPath: "/tmp/claude-sessions" },
      syncthing: { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true },
      projects: { homePath: path.join(root, "JointBob") },
      restartRequired: { pi: true, claude: true },
    });

    const read = await fetch(`${node.baseUrl}/api/settings`, { headers });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), {
      pi: { executable: "/usr/local/bin/pi", configPath: "/tmp/pi-config", sessionPath: "/tmp/pi-sessions" },
      claude: { executable: "/usr/local/bin/claude", configPath: "/tmp/claude-config", sessionPath: "/tmp/claude-sessions" },
      syncthing: { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true },
      projects: { homePath: path.join(root, "JointBob") },
      restartRequired: { pi: false, claude: false },
    });

    const remoteEndpoint = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        syncthing: { endpoint: "https://not-local.example", apiKey: "must-not-send" },
        projects: { homePath: path.join(root, "JointBob") },
      }),
    });
    assert.equal(remoteEndpoint.status, 400);
    assert.deepEqual(await remoteEndpoint.json(), { error: "Syncthing endpoint must use a loopback host" });

    const relativeHomeFolder = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "", configPath: "", sessionPath: "" },
        claude: { executable: "", configPath: "", sessionPath: "" },
        syncthing: { endpoint: "http://127.0.0.1:8384" },
        projects: { homePath: "relative" },
      }),
    });
    assert.equal(relativeHomeFolder.status, 400);
    assert.deepEqual(await relativeHomeFolder.json(), { error: "Joint Bob home folder must be absolute" });
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
