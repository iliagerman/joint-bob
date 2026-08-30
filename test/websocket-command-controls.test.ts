import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

function cookieFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

async function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for WebSocket message: ${JSON.stringify(messages.slice(-10))}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Pi tool commands list and change active tools over the chat WebSocket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-command-controls-"));
  const previous = {
    dataDir: process.env.JOINT_BOB_DATA_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
  };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let server: Server | undefined;
  let socket: WebSocket | undefined;

  try {
    const settings = await import(`../src/settings.ts?command-controls=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-agent"), sessionPath: path.join(root, "claude-sessions") },
      syncthing: { endpoint: "" },
    });
    const module = await import(`../src/server.ts?command-controls=${Date.now()}-${Math.random()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "initial-password" }),
    });
    const cookie = cookieFrom(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers,
      body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }),
    });
    assert.equal(changed.status, 204);

    const projectPath = path.join(root, "project");
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Commands", path: projectPath }),
    });
    assert.equal(projectResponse.status, 201);
    const { project } = await projectResponse.json() as { project: { id: string } };

    const wsUrl = new URL(`/ws?projectId=${project.id}&sessionPath=new`, baseUrl);
    wsUrl.protocol = "ws:";
    socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await waitFor(messages, () => messages.some((message) => message.type === "ready"));

    socket.send(JSON.stringify({ type: "tools" }));
    await waitFor(messages, () => messages.some((message) => message.type === "tools"));
    const listed = messages.find((message) => message.type === "tools") as { supported: boolean; tools: Array<{ name: string; active: boolean }> };
    assert.equal(listed.supported, true);
    assert.ok(listed.tools.length > 0);

    const selected = listed.tools[0].name;
    socket.send(JSON.stringify({ type: "setTools", toolNames: [selected] }));
    await waitFor(messages, () => messages.filter((message) => message.type === "tools").length === 2);
    const updated = messages.filter((message) => message.type === "tools")[1] as { tools: Array<{ name: string; active: boolean }> };
    assert.deepEqual(updated.tools.filter((tool) => tool.active).map((tool) => tool.name), [selected]);

    socket.send(JSON.stringify({ type: "setTools", toolNames: ["missing-tool"] }));
    await waitFor(messages, () => messages.some((message) => message.type === "error" && message.error === "Unknown tool: missing-tool"));
  } finally {
    socket?.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (previous.dataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous.dataDir;
    if (previous.piAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.piAgentDir;
    if (previous.username === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previous.username;
    if (previous.password === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previous.password;
    await rm(root, { recursive: true, force: true });
  }
});
