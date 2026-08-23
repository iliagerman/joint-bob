import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

test("first startup lets the owner create credentials and signs them in", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "master-bob-auth-api-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  const previousRelease = process.env.MASTER_BOB_RELEASE;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = dataDir;
    delete process.env.MASTER_BOB_ADMIN_USERNAME;
    delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    process.env.MASTER_BOB_RELEASE = "development";
    const { createApp } = await import(`../src/app.js?test=${Date.now()}-${Math.random()}`);
    server = createServer(createApp());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initialStatus = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await initialStatus.json(), { authenticated: false, setupRequired: true });
    assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 401);

    const setup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "owner-selected-password" }),
    });
    assert.equal(setup.status, 201);
    const setupBody = await setup.json() as { mustChangePassword: boolean; csrfToken: string; username: string };
    assert.equal(setupBody.username, "owner");
    assert.equal(setupBody.mustChangePassword, false);
    assert.match(setupBody.csrfToken, /^[a-f0-9]{64}$/);
    const sessionCookie = cookie(setup);

    const authenticatedStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: sessionCookie } });
    assert.deepEqual(await authenticatedStatus.json(), {
      authenticated: true,
      setupRequired: false,
      mustChangePassword: false,
      csrfToken: setupBody.csrfToken,
      username: "owner",
    });
    assert.equal((await fetch(`${baseUrl}/api/projects`, { headers: { Cookie: sessionCookie } })).status, 200);

    const duplicateSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "other", password: "another-owner-password" }),
    });
    assert.equal(duplicateSetup.status, 409);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    if (previousRelease === undefined) delete process.env.MASTER_BOB_RELEASE;
    else process.env.MASTER_BOB_RELEASE = previousRelease;
    await rm(dataDir, { recursive: true, force: true });
  }
});
