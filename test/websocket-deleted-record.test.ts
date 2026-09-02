import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`Timed out waiting for WebSocket message; saw ${JSON.stringify(messages.map(({ type }) => type))}`));
    }, 4_000);
    const timer = setInterval(() => {
      if (!predicate()) return;
      clearInterval(timer);
      clearTimeout(timeout);
      resolve();
    }, 10);
  });
}

// A browser that still names a deleted conversation (sessionPath=new plus the
// session id it remembered) must get a protocol close, not an unhandled
// "Conversation record was deleted" rejection that kills the node — which then
// crash-loops, because the browser reconnects straight back into it.
test("reopening a deleted conversation closes the socket instead of killing the node", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-deleted-record-"));
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const prior = { data: process.env.JOINT_BOB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD, home: process.env.HOME };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  // A real Pi session is created here; without an isolated home it would load the
  // developer's own ~/.pi extensions and their MCP child processes.
  process.env.HOME = homeDir;
  let server: Server | undefined;
  let opened: WebSocket | undefined;
  let reopened: WebSocket | undefined;
  try {
    const module = await import(`../src/server.ts?deletedrecord=${Date.now()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    await fetch(`${base}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    const projectPath = path.join(root, "project");
    await mkdir(projectPath);
    const created = await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Deleted", path: projectPath }) });
    const { project } = await created.json() as { project: { id: string } };
    await fetch(`${base}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } }) });

    const wsUrl = (sessionPath: string, sessionId = "") => `ws://127.0.0.1:${(server!.address() as { port: number }).port}/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(sessionPath)}${sessionId ? `&sessionId=${sessionId}` : ""}`;
    opened = new WebSocket(wsUrl("new"), { origin: base, headers: { Cookie: cookie } });
    const ready: Array<Record<string, unknown>> = [];
    opened.on("message", (raw) => ready.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve) => opened!.once("open", resolve));
    await waitFor(ready, () => ready.some((message) => message.type === "ready"));
    const sessionId = String(ready.find((message) => message.type === "ready")!.sessionId);
    opened.close();
    await new Promise<void>((resolve) => opened!.once("close", resolve));

    assert.equal((await fetch(`${base}/api/projects/${project.id}/sessions?engine=pi&sessionId=${sessionId}`, { method: "DELETE", headers })).status, 204);

    reopened = new WebSocket(wsUrl("new", sessionId), { origin: base, headers: { Cookie: cookie } });
    const [code, reason] = await new Promise<[number, string]>((resolve, reject) => {
      reopened!.once("close", (closeCode, closeReason) => resolve([closeCode, closeReason.toString()]));
      reopened!.once("error", reject);
    });
    assert.equal(code, 1008, `expected a protocol close, got ${code} (${reason})`);
    assert.equal(reason, "Conversation not found");
    assert.ok((await fetch(`${base}/api/health`)).ok, "the node died reopening a deleted conversation");
  } finally {
    opened?.terminate();
    reopened?.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(prior)) {
      const envKey = { data: "JOINT_BOB_DATA_DIR", user: "MASTER_BOB_ADMIN_USERNAME", password: "MASTER_BOB_INITIAL_PASSWORD", home: "HOME" }[key]!;
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
