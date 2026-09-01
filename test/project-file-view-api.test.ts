import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("viewing a project file serves a content type the browser renders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-file-view-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let appServer: import("node:http").Server | undefined;
  try {
    ({ server: appServer } = await import(new URL(`../src/server.ts?file-view=${Date.now()}`, import.meta.url).href));
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
    await writeFile(path.join(projectPath, "README.md"), "# Title\n");
    await writeFile(path.join(projectPath, "script.py"), "print('hi')\n");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(path.join(projectPath, "logo.png"), png);

    const view = async (file: string): Promise<Response> =>
      fetch(`${baseUrl}/api/projects/${project.id}/file?path=${encodeURIComponent(file)}`, { headers });

    for (const file of ["src/config.ts", "README.md", "script.py"]) {
      const response = await view(file);
      assert.equal(response.status, 200, `${file} should be viewable`);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8", `${file} content type`);
      assert.equal(response.headers.get("content-disposition"), `inline; filename="${path.basename(file)}"`);
      assert.ok((await response.text()).length > 0);
    }

    const image = await view("logo.png");
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");

    const download = await fetch(`${baseUrl}/api/projects/${project.id}/file?path=${encodeURIComponent("src/config.ts")}&download=1`, { headers });
    assert.equal(download.headers.get("content-disposition"), 'attachment; filename="config.ts"');
  } finally {
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
