import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("project files can be listed, deleted, and copied between folders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-file-explorer-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let appServer: import("node:http").Server | undefined;
  try {
    ({ server: appServer } = await import(new URL(`../src/server.ts?file-explorer=${Date.now()}`, import.meta.url).href));
    const settings = await import("../src/settings.ts");
    const sessionId = "file-explorer-session";
    const sessionRoot = path.join(root, "pi-sessions");
    const currentSettings = settings.getSettings();
    settings.updateSettings({ ...currentSettings, pi: { ...currentSettings.pi, sessionPath: sessionRoot } });
    await mkdir(sessionRoot, { recursive: true });
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
    await mkdir(path.join(projectPath, "docs"), { recursive: true });
    await writeFile(path.join(sessionRoot, `${sessionId}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: projectPath })}\n`);
    await writeFile(path.join(projectPath, "readme.md"), "# hello\n");
    await writeFile(path.join(projectPath, "notes.txt"), "keep\n");
    await writeFile(path.join(projectPath, "docs", "guide.md"), "guide\n");

    const { getClusterMachineToken } = await import("../src/cluster.ts");
    const machineToken = await getClusterMachineToken();
    const clusterFilesUrl = new URL(`${baseUrl}/api/cluster/project-files`);
    clusterFilesUrl.searchParams.set("projectId", project.id);
    const clusterListed = await fetch(clusterFilesUrl, { headers: { Authorization: `Bearer ${machineToken}` } });
    assert.equal(clusterListed.status, 200);
    assert.deepEqual((await clusterListed.json() as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name), ["docs", "notes.txt", "readme.md"]);

    const filesUrl = (dir?: string): string => {
      const url = new URL(`${baseUrl}/api/projects/${project.id}/files`);
      if (dir !== undefined) url.searchParams.set("dir", dir);
      return url.href;
    };
    const listed = await fetch(filesUrl(), { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { path: string; entries: Array<{ name: string; path: string; type: string; size: number | null }> };
    assert.equal(listedBody.path, "");
    assert.deepEqual(listedBody.entries.map((entry) => entry.name), ["docs", "notes.txt", "readme.md"]);
    assert.deepEqual(listedBody.entries[0], { name: "docs", path: "docs", type: "directory", size: null });
    assert.deepEqual(listedBody.entries[2], { name: "readme.md", path: "readme.md", type: "file", size: 8 });

    const sub = await fetch(filesUrl("docs"), { headers });
    assert.equal(sub.status, 200);
    const subBody = await sub.json() as { path: string; entries: Array<{ name: string; path: string; type: string }> };
    assert.equal(subBody.path, "docs");
    assert.deepEqual(subBody.entries.map((entry) => entry.path), ["docs/guide.md"]);

    const escape = await fetch(filesUrl("../"), { headers });
    assert.equal(escape.status, 403);
    assert.equal((await escape.json() as { error: string }).error, "Directory is outside the project directory");

    const missingDir = await fetch(filesUrl("missing"), { headers });
    assert.equal(missingDir.status, 404);
    assert.equal((await missingDir.json() as { error: string }).error, "Directory not found");

    const deleteUrl = (target: string): string => {
      const url = new URL(`${baseUrl}/api/projects/${project.id}/file-delete`);
      url.searchParams.set("path", target);
      return url.href;
    };
    const missingSession = await fetch(deleteUrl("notes.txt"), { method: "POST", headers, body: JSON.stringify({}) });
    assert.equal(missingSession.status, 400);
    const unknownSession = await fetch(deleteUrl("notes.txt"), { method: "POST", headers, body: JSON.stringify({ sessionId: "missing-session" }) });
    assert.equal(unknownSession.status, 409);
    assert.equal((await unknownSession.json() as { error: string }).error, "Conversation was not found on this node");
    assert.equal(await readFile(path.join(projectPath, "notes.txt"), "utf8"), "keep\n");
    const deleted = await fetch(deleteUrl("notes.txt"), { method: "POST", headers, body: JSON.stringify({ sessionId }) });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { path: "notes.txt" });
    await assert.rejects(readFile(path.join(projectPath, "notes.txt"), "utf8"), /ENOENT/);
    const deletedTwice = await fetch(deleteUrl("notes.txt"), { method: "POST", headers, body: JSON.stringify({ sessionId }) });
    assert.equal(deletedTwice.status, 404);
    assert.equal((await deletedTwice.json() as { error: string }).error, "File not found");

    const copyUrl = (target: string): string => {
      const url = new URL(`${baseUrl}/api/projects/${project.id}/file-copy`);
      url.searchParams.set("path", target);
      return url.href;
    };
    const copied = await fetch(copyUrl("readme.md"), { method: "POST", headers, body: JSON.stringify({ destinationDir: "docs", sessionId }) });
    assert.equal(copied.status, 200);
    assert.deepEqual(await copied.json(), { path: "docs/readme.md" });
    assert.equal(await readFile(path.join(projectPath, "docs", "readme.md"), "utf8"), "# hello\n");
    const duplicate = await fetch(copyUrl("readme.md"), { method: "POST", headers, body: JSON.stringify({ destinationDir: "docs", sessionId }) });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { error: string }).error, "A file with that name already exists in the destination");
    const badDestination = await fetch(copyUrl("readme.md"), { method: "POST", headers, body: JSON.stringify({ destinationDir: "nope", sessionId }) });
    assert.equal(badDestination.status, 404);
    assert.equal((await badDestination.json() as { error: string }).error, "Directory not found");
    const escapedDestination = await fetch(copyUrl("readme.md"), { method: "POST", headers, body: JSON.stringify({ destinationDir: "../", sessionId }) });
    assert.equal(escapedDestination.status, 403);
    assert.equal((await escapedDestination.json() as { error: string }).error, "Directory is outside the project directory");
  } finally {
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
