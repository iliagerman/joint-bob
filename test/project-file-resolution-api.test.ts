import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("project file references resolve only within their project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-file-resolution-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let appServer: import("node:http").Server | undefined;
  try {
    ({ server: appServer } = await import(new URL(`../src/server.ts?file-resolution=${Date.now()}`, import.meta.url).href));
    await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
    const address = appServer.address();
    if (!address || typeof address === "string") throw new Error("App server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const auth = await login.json() as { csrfToken: string };
    const headers = { "Content-Type": "application/json", Cookie: cookie(login), "X-CSRF-Token": auth.csrfToken };
    await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    const projectPath = path.join(root, "project");
    const created = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Files", path: projectPath }) });
    const project = (await created.json() as { project: { id: string } }).project;
    await mkdir(path.join(projectPath, "src"), { recursive: true });
    await writeFile(path.join(projectPath, "src", "config.ts"), "export const config = true;\n");

    const resolved = await fetch(`${baseUrl}/api/projects/${project.id}/file-resolution?path=${encodeURIComponent("/old/checkout/src/config.ts")}`, { headers });
    const body = await resolved.json() as { path: string; viewUrl: string; downloadUrl: string; contentUrl: string };
    assert.equal(resolved.status, 200);
    assert.equal(body.path, "src/config.ts");
    for (const url of [body.viewUrl, body.downloadUrl, body.contentUrl]) assert.match(url, new RegExp(`^/api/projects/${project.id}/`));
    const content = await fetch(`${baseUrl}${body.contentUrl}`, { headers });
    assert.equal((await content.json() as { content: string }).content, "export const config = true;\n");

    await mkdir(path.join(projectPath, "a"), { recursive: true });
    await mkdir(path.join(projectPath, "b"), { recursive: true });
    await writeFile(path.join(projectPath, "a", "notes.txt"), "a\n");
    await writeFile(path.join(projectPath, "b", "notes.txt"), "b\n");
    const ambiguous = await fetch(`${baseUrl}/api/projects/${project.id}/file-resolution?path=notes.txt`, { headers });
    assert.equal(ambiguous.status, 409);
    assert.match((await ambiguous.json() as { error: string }).error, /^File reference is ambiguous:/);

    const traversal = await fetch(`${baseUrl}/api/projects/${project.id}/file-resolution?path=${encodeURIComponent("../notes.txt")}`, { headers });
    assert.equal(traversal.status, 403);
    assert.equal((await traversal.json() as { error: string }).error, "File is outside the project directory");

    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(projectPath, "escape.txt"));
    const escape = await fetch(`${baseUrl}/api/projects/${project.id}/file-resolution?path=escape.txt`, { headers });
    assert.equal(escape.status, 403);
    assert.equal((await escape.json() as { error: string }).error, "File is outside the project directory");
  } finally {
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
