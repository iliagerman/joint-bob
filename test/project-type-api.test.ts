import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function isMissing(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

test("project types are listed, created with a GitHub group, and drive managed project paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-type-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?project-types=${Date.now()}-${Math.random()}`);
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

    const seeded = await fetch(`${node.baseUrl}/api/project-types`, { headers: { Cookie: cookie } });
    assert.equal(seeded.status, 200);
    const seededBody = await seeded.json() as { types: Array<{ id: string; label: string; githubGroup: string | null }> };
    assert.deepEqual(seededBody.types.map((type) => type.id), ["personal", "work"]);

    const created = await fetch(`${node.baseUrl}/api/project-types`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ label: "Client Work", githubGroup: "clients" }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json() as { type: { id: string; githubGroup: string | null } };
    assert.equal(createdBody.type.id, "client-work");
    assert.equal(createdBody.type.githubGroup, "clients");

    const reserved = await fetch(`${node.baseUrl}/api/project-types`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ label: "tickets" }),
    });
    assert.equal(reserved.status, 400);

    const homePath = path.join(root, "JointBob");
    const settings = await fetch(`${node.baseUrl}/api/settings`, { headers: { Cookie: cookie } });
    const current = await settings.json() as { pi: unknown; claude: unknown; syncthing: { endpoint: string } };
    const saved = await fetch(`${node.baseUrl}/api/settings`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ pi: current.pi, claude: current.claude, syncthing: { endpoint: current.syncthing.endpoint }, projects: { homePath } }),
    });
    assert.equal(saved.status, 200);

    // The managed path drops the old "projects" segment and uses the type folder directly.
    const project = await fetch(`${node.baseUrl}/api/projects`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ name: "client site", type: "client-work" }),
    });
    assert.equal(project.status, 201);
    const projectBody = await project.json() as { project: { id: string; path: string; type: string } };
    assert.equal(projectBody.project.type, "client-work");
    assert.equal(projectBody.project.path, path.join(homePath, "client-work", "client_site"));

    const inUse = await fetch(`${node.baseUrl}/api/project-types/client-work`, { method: "DELETE", headers: requestHeaders });
    assert.equal(inUse.status, 400);

    await writeFile(path.join(projectBody.project.path, "content.txt"), "preserved\n");
    const moved = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ type: "personal" }),
    });
    assert.equal(moved.status, 200);
    const movedBody = await moved.json() as { project: { path: string; type: string } };
    const personalPath = path.join(homePath, "personal", "client_site");
    assert.equal(movedBody.project.type, "personal");
    assert.equal(movedBody.project.path, personalPath);
    assert.equal(await isMissing(projectBody.project.path), true);
    assert.equal(await readFile(path.join(personalPath, "content.txt"), "utf8"), "preserved\n");

    await mkdir(projectBody.project.path, { recursive: true });
    await writeFile(path.join(projectBody.project.path, "marker.txt"), "occupied\n");
    const occupied = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ type: "client-work" }),
    });
    assert.equal(occupied.status, 409);
    assert.equal(await readFile(path.join(personalPath, "content.txt"), "utf8"), "preserved\n");
    assert.equal(await readFile(path.join(projectBody.project.path, "marker.txt"), "utf8"), "occupied\n");

    const unknown = await fetch(`${node.baseUrl}/api/projects/${projectBody.project.id}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ type: "does-not-exist" }),
    });
    assert.equal(unknown.status, 400);

    const removed = await fetch(`${node.baseUrl}/api/project-types/work`, { method: "DELETE", headers: requestHeaders });
    assert.equal(removed.status, 204);
  } finally {
    await node?.close();
    process.env.PI_WEB_DATA_DIR = previousDataDir;
    process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
