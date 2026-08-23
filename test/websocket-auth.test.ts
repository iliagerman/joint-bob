import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}

function message(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

test("WebSockets require a changed-password session cookie and exact same origin", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-websocket-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  process.env.PI_WEB_DATA_DIR = dataDir;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let server: import("node:http").Server | undefined;
  try {
    const moduleUrl = new URL(`../src/server.ts?websocket=${Date.now()}`, import.meta.url);
    ({ server } = await import(moduleUrl.href));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const origin = baseUrl;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { csrfToken: string };
    const cookie = sessionCookie(login);
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changed.status, 204);

    const projectPath = path.join(dataDir, "project");
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": loginBody.csrfToken },
      body: JSON.stringify({ name: "WebSocket test", path: projectPath }),
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json() as { project: { id: string } };
    const socketUrl = `ws://127.0.0.1:${address.port}/ws?projectId=${project.project.id}&sessionPath=watch`;

    const noCookie = new WebSocket(socketUrl, { origin });
    assert.equal(await closeCode(noCookie), 1008);

    const queryToken = new WebSocket(`${socketUrl}&token=anything`, { origin });
    assert.equal(await closeCode(queryToken), 1008);

    const machineToken = (await (await fetch(`${baseUrl}/api/cluster/invite`, { headers: { Cookie: cookie } })).json() as { token: string }).token;
    const machineWithoutTask = new WebSocket(socketUrl, { headers: { Authorization: `Bearer ${machineToken}` } });
    assert.equal(await closeCode(machineWithoutTask), 1008);

    const routedMachineSession = new WebSocket(`${socketUrl}&nodeSession=1`, { headers: { Authorization: `Bearer ${machineToken}` } });
    assert.deepEqual(await message(routedMachineSession), { type: "watchReady" });
    const routedMachineClosed = closeCode(routedMachineSession);
    routedMachineSession.close();
    await routedMachineClosed;

    const crossOrigin = new WebSocket(socketUrl, { origin: "http://example.test", headers: { Cookie: cookie } });
    assert.equal(await closeCode(crossOrigin), 1008);

    const authorized = new WebSocket(socketUrl, { origin, headers: { Cookie: cookie } });
    assert.deepEqual(await message(authorized), { type: "watchReady" });
    const authorizedClosed = closeCode(authorized);
    authorized.close();
    await authorizedClosed;
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(dataDir, { recursive: true, force: true });
  }
});
