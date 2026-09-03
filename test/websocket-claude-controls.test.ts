import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("Claude tool and compact commands work over the chat WebSocket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-controls-"));
  const previous = {
    dataDir: process.env.JOINT_BOB_DATA_DIR,
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    username: process.env.MASTER_BOB_ADMIN_USERNAME,
    password: process.env.MASTER_BOB_INITIAL_PASSWORD,
    engineLog: process.env.JOINT_BOB_TEST_ENGINE_LOG,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.NODE_ENV = "test";
  process.env.JOINT_BOB_TEST_ENGINE_LOG = path.join(root, "engine.log");
  let server: Server | undefined;
  let socket: WebSocket | undefined;

  try {
    const settings = await import(`../src/settings.ts?claude-controls=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-agent"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: path.join(root, "claude-projects") },
      syncthing: { endpoint: "" },
    });
    const { claudeSessionFilePath } = await import(`../src/claude-service.ts?claude-controls=${Date.now()}-${Math.random()}`);
    const module = await import(`../src/server.ts?claude-controls=${Date.now()}-${Math.random()}`);
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
    await mkdir(projectPath, { recursive: true });
    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "ClaudeControls", path: projectPath }),
    });
    assert.equal(projectResponse.status, 201);
    const { project } = await projectResponse.json() as { project: { id: string } };

    const sessionId = "22222222-2222-4222-8222-222222222222";
    const filePath = claudeSessionFilePath(projectPath, sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const record = (extra: Record<string, unknown>): string =>
      `${JSON.stringify({ sessionId, cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", ...extra })}\n`;
    await writeFile(filePath, [
      record({ type: "user", message: { role: "user", content: "seed prompt" } }),
      record({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "seed reply" }] } }),
    ].join(""), "utf8");

    const wsUrl = new URL(`/ws?projectId=${project.id}&sessionPath=claude:${filePath}`, baseUrl);
    wsUrl.protocol = "ws:";
    socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await waitFor(messages, () => messages.some((message) => message.type === "ready"));

    // A fresh connection has not seen a Claude turn, so no tool list exists yet.
    socket.send(JSON.stringify({ type: "tools" }));
    await waitFor(messages, () => messages.some((message) => message.type === "tools"));
    const listed = messages.find((message) => message.type === "tools") as { supported: boolean; tools: unknown[] };
    assert.equal(listed.supported, true);
    assert.deepEqual(listed.tools, []);

    socket.send(JSON.stringify({ type: "setTools", toolNames: ["Bash"] }));
    await waitFor(messages, () => messages.some((message) => message.type === "error" && /Claude has not reported its tools yet/.test(String(message.error))));

    // Compaction rides the same turn machinery: a /compact command turn, not a Pi-only refusal.
    const compactStart = messages.length;
    socket.send(JSON.stringify({ type: "compact", message: "keep decisions" }));
    await waitFor(messages, () => messages.some((message) => message.type === "userMessage" && message.text === "/compact keep decisions"));
    await waitFor(messages, () => messages.some((message) => message.type === "agent_end"));
    assert.ok(!messages.slice(compactStart).some((message) => message.type === "error"), `Unexpected error: ${JSON.stringify(messages.filter((message) => message.type === "error"))}`);

    // The stubbed run reports the CLI's init tool list, which now feeds the dialog.
    socket.send(JSON.stringify({ type: "tools" }));
    await waitFor(messages, () => messages.filter((message) => message.type === "tools").length >= 2);
    const afterTurn = messages.filter((message) => message.type === "tools").at(-1) as { tools: Array<{ name: string; active: boolean }> };
    assert.deepEqual(afterTurn.tools.map((tool) => tool.name), ["Bash", "Edit", "Read"]);
    assert.ok(afterTurn.tools.every((tool) => tool.active));

    socket.send(JSON.stringify({ type: "setTools", toolNames: ["Bash"] }));
    await waitFor(messages, () => messages.filter((message) => message.type === "tools").length >= 3);
    const restricted = messages.filter((message) => message.type === "tools").at(-1) as { tools: Array<{ name: string; active: boolean }> };
    assert.deepEqual(restricted.tools.filter((tool) => tool.active).map((tool) => tool.name), ["Bash"]);

    socket.send(JSON.stringify({ type: "setTools", toolNames: ["Missing"] }));
    await waitFor(messages, () => messages.some((message) => message.type === "error" && message.error === "Unknown tool: Missing"));
  } finally {
    socket?.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (previous.dataDir === undefined) delete process.env.JOINT_BOB_DATA_DIR; else process.env.JOINT_BOB_DATA_DIR = previous.dataDir;
    if (previous.piAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.piAgentDir;
    if (previous.username === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME; else process.env.MASTER_BOB_ADMIN_USERNAME = previous.username;
    if (previous.password === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD; else process.env.MASTER_BOB_INITIAL_PASSWORD = previous.password;
    if (previous.engineLog === undefined) delete process.env.JOINT_BOB_TEST_ENGINE_LOG; else process.env.JOINT_BOB_TEST_ENGINE_LOG = previous.engineLog;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    await rm(root, { recursive: true, force: true });
  }
});
