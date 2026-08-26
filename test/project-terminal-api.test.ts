import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected a session cookie");
  return value.split(";", 1)[0];
}

test("terminal action launches locally or routes to the selected peer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-terminal-"));
  const markerPath = path.join(root, "terminal-marker");
  const terminalPath = path.join(root, "terminal-fixture.sh");
  await writeFile(terminalPath, "#!/bin/sh\nprintf '%s' \"$1\" > \"$JOINT_BOB_TERMINAL_MARKER\"\n");
  await chmod(terminalPath, 0o755);

  const previous = {
    dataDir: process.env.PI_WEB_DATA_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
    terminal: process.env.JOINT_BOB_TERMINAL_EXECUTABLE,
    marker: process.env.JOINT_BOB_TERMINAL_MARKER,
  };
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.JOINT_BOB_TERMINAL_EXECUTABLE = terminalPath;
  process.env.JOINT_BOB_TERMINAL_MARKER = markerPath;

  let appServer: import("node:http").Server | undefined;
  let peerServer: import("node:http").Server | undefined;
  try {
    const moduleUrl = new URL(`../src/server.ts?terminal=${Date.now()}`, import.meta.url);
    ({ server: appServer } = await import(moduleUrl.href));
    const { getClusterNode, saveClusterPeer } = await import("../src/cluster.js");
    await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
    const address = appServer.address();
    if (!address || typeof address === "string") throw new Error("App server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const auth = await login.json() as { csrfToken: string };
    const headers = {
      "Content-Type": "application/json",
      Cookie: sessionCookie(login),
      "X-CSRF-Token": auth.csrfToken,
    };
    await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers,
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });

    const projectPath = path.join(root, "project");
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Terminal project", path: projectPath }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json() as { project: { id: string } }).project;
    const local = await getClusterNode();

    const localOpen = await fetch(`${baseUrl}/api/projects/${project.id}/terminal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nodeId: local.id }),
    });
    const localBody = await localOpen.json();
    assert.equal(localOpen.status, 200, JSON.stringify(localBody));
    assert.deepEqual(localBody, { opened: true, nodeId: local.id });
    assert.equal(await readFile(markerPath, "utf8"), projectPath);

    const peerId = "836610a8-3002-4e64-8907-6c48ff92d1e6";
    let peerRequest: { authorization?: string; body?: unknown } = {};
    peerServer = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      peerRequest = { authorization: request.headers.authorization, body: JSON.parse(raw) };
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ opened: true, nodeId: peerId }));
    });
    await new Promise<void>((resolve) => peerServer?.listen(0, "127.0.0.1", resolve));
    const peerAddress = peerServer.address();
    if (!peerAddress || typeof peerAddress === "string") throw new Error("Peer server did not bind");
    const peer = {
      id: peerId,
      name: "Mac",
      url: `http://127.0.0.1:${peerAddress.port}`,
      token: "peer-machine-token",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveClusterPeer(peer);

    const remoteOpen = await fetch(`${baseUrl}/api/projects/${project.id}/terminal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ nodeId: peer.id }),
    });
    const remoteBody = await remoteOpen.json();
    assert.equal(remoteOpen.status, 200, JSON.stringify(remoteBody));
    assert.deepEqual(remoteBody, { opened: true, nodeId: peerId });
    assert.deepEqual(peerRequest, {
      authorization: "Bearer peer-machine-token",
      body: { projectId: project.id },
    });
  } finally {
    if (appServer?.listening) await new Promise<void>((resolve) => appServer?.close(() => resolve()));
    if (peerServer?.listening) await new Promise<void>((resolve) => peerServer?.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      const name = {
        dataDir: "PI_WEB_DATA_DIR",
        username: "MASTER_BOB_ADMIN_USERNAME",
        password: "MASTER_BOB_INITIAL_PASSWORD",
        terminal: "JOINT_BOB_TERMINAL_EXECUTABLE",
        marker: "JOINT_BOB_TERMINAL_MARKER",
      }[key as keyof typeof previous];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
