import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// The auth check writes (it sweeps expired login sessions) on every authenticated
// request. When another process holds the database write lock, that request must
// wait the lock out; throwing "database is locked" inside the auth middleware is
// an unhandled rejection that kills the whole node. The server runs as a child
// process because the SQLite busy wait blocks its thread: in one process the
// request would block the very commit that releases it.
test("an authenticated request waits out a database write lock instead of dying", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-auth-lock-"));
  const homeDir = path.join(root, "home");
  const dataDir = path.join(root, "data");
  let child: ChildProcess | undefined;
  try {
    await mkdir(homeDir, { recursive: true });
    let output = "";
    child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve("."),
      env: { ...process.env, PORT: "0", HOME: homeDir, JOINT_BOB_DATA_DIR: dataDir, MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let base = "";
    for (let attempt = 0; attempt < 1_200 && !base; attempt += 1) {
      assert.equal(child.exitCode, null, `server exited during startup\n${output}`);
      const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
      if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) base = `http://127.0.0.1:${match[1]}`;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(base, `server did not become healthy\n${output}`);

    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) })).status, 204);
    assert.equal((await fetch(`${base}/api/projects`, { headers })).status, 200);

    const db = new DatabaseSync(path.join(dataDir, "node.db"));
    db.exec("BEGIN IMMEDIATE");
    const pending = fetch(`${base}/api/projects`, { headers });
    await new Promise((resolve) => setTimeout(resolve, 300));
    db.exec("COMMIT");
    db.close();
    assert.equal((await pending).status, 200);
    assert.ok((await fetch(`${base}/api/health`)).ok, `the node died while the database was locked\n${output}`);
    assert.equal(child.exitCode, null, `the node crashed on a locked database\n${output}`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
