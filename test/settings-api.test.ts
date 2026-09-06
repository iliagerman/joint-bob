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
    const piRuntime = { configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") };
    const claudeRuntime = { configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-sessions") };
    const defaults = await fetch(`${node.baseUrl}/api/settings/runtime-defaults`, { headers });
    assert.equal(defaults.status, 200);
    const checked = await fetch(`${node.baseUrl}/api/settings/runtime-check`, {
      method: "POST", headers,
      body: JSON.stringify({ pi: { executable: "missing-pi", configPath: path.join(root, "missing"), sessionPath: path.join(root, "missing") }, claude: { executable: "claude", configPath: "", sessionPath: "" } }),
    });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).pi.configPath.ok, false, "missing config folder is reported");
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        syncthing: { endpoint: "http://127.0.0.1:8384", apiKey: "secret-api-key" },
        projects: { homePath: path.join(root, "JointBob") },
        resources: { skills: [path.join(root, "skills"), path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      pi: { executable: "/usr/local/bin/pi", ...piRuntime },
      claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
      syncthing: { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true },
      projects: { homePath: path.join(root, "JointBob") },
      resources: { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      restartRequired: { pi: true, claude: true },
    });

    const read = await fetch(`${node.baseUrl}/api/settings`, { headers });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), {
      pi: { executable: "/usr/local/bin/pi", ...piRuntime },
      claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
      syncthing: { endpoint: "http://127.0.0.1:8384", apiKeyConfigured: true },
      projects: { homePath: path.join(root, "JointBob") },
      resources: { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] },
      restartRequired: { pi: false, claude: false },
    });

    const preservedResources = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        pi: { executable: "/usr/local/bin/pi", ...piRuntime },
        claude: { executable: "/usr/local/bin/claude", ...claudeRuntime },
        syncthing: { endpoint: "http://127.0.0.1:8384" },
        projects: { homePath: path.join(root, "JointBob") },
      }),
    });
    assert.equal(preservedResources.status, 200);
    assert.deepEqual((await preservedResources.json()).resources, { skills: [path.join(root, "skills")], prompts: [path.join(root, "prompts")], rules: [path.join(root, "rules")], plugins: [path.join(root, "plugins")] });

    const project = await fetch(`${node.baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Resource project", path: path.join(root, "project") }) });
    const projectBody = await project.json() as { project: { id: string } };
    assert.equal(project.status, 201);
    const projectPaths = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, {
      method: "PUT", headers,
      body: JSON.stringify({ resources: { skills: [path.join(root, "project-skills"), path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(projectPaths.status, 200);
    assert.deepEqual(await projectPaths.json(), { resources: { skills: [path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } });
    const readProjectPaths = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, { headers });
    assert.equal(readProjectPaths.status, 200);
    assert.deepEqual(await readProjectPaths.json(), { resources: { skills: [path.join(root, "project-skills")], prompts: [], rules: [], plugins: [] } });
    const relativeProjectResources = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}/resource-paths`, {
      method: "PUT", headers,
      body: JSON.stringify({ resources: { skills: ["relative"], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(relativeProjectResources.status, 400);
    const missingProjectPaths = await fetch(`${node.baseUrl}/api/projects/missing/resource-paths`, { headers });
    assert.equal(missingProjectPaths.status, 404);

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

    const relativeResources = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: "" }, claude: { executable: "", configPath: "", sessionPath: "" }, syncthing: { endpoint: "http://127.0.0.1:8384" }, projects: { homePath: path.join(root, "JointBob") }, resources: { skills: ["relative"], prompts: [], rules: [], plugins: [] } }),
    });
    assert.equal(relativeResources.status, 400);

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

    const overlappingSessions = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT", headers,
      body: JSON.stringify({ pi: { executable: "", configPath: "", sessionPath: path.join(root, "sessions") }, claude: { executable: "", configPath: "", sessionPath: path.join(root, "sessions", "claude") }, syncthing: { endpoint: "" } }),
    });
    assert.equal(overlappingSessions.status, 400);
    assert.match((await overlappingSessions.json() as { error: string }).error, /must not overlap/);
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
