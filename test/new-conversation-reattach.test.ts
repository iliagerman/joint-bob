import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 4_000);
    const timer = setInterval(() => {
      if (!predicate()) return;
      clearInterval(timer);
      clearTimeout(timeout);
      resolve();
    }, 10);
  });
}
function cookie(response: Response): string { return response.headers.get("set-cookie")!.split(";", 1)[0]; }

async function auth(baseUrl: string): Promise<{ cookie: string; headers: Record<string, string> }> {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const session = cookie(login); const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { Cookie: session, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  return { cookie: session, headers };
}
async function connect(url: string, cookieValue: string): Promise<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> {
  const socket = new WebSocket(url, { origin: url.replace(/^ws/, "http"), headers: { Cookie: cookieValue } });
  const messages: Array<Record<string, unknown>> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve) => socket.once("open", resolve));
  await waitFor(messages, () => messages.some((message) => message.type === "ready"));
  return { socket, messages };
}

test("a Claude draft reconnects with its original session id before its first prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-reattach-"));
  const prior = { data: process.env.JOINT_BOB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD, calls: process.env.JOINT_BOB_FAKE_CALLS };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data"); process.env.MASTER_BOB_ADMIN_USERNAME = "admin"; process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password"; process.env.JOINT_BOB_FAKE_CALLS = path.join(root, "calls.log");
  let server: Server | undefined; let first: WebSocket | undefined; let second: WebSocket | undefined;
  try {
    const executable = path.join(root, "fake-claude.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await appendFile(process.env.JOINT_BOB_FAKE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
const i = process.argv.indexOf('--session-id');
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: process.argv[i + 1] }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: prompt.trim() }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false }));
`); await chmod(executable, 0o755);
    const module = await import(`../src/server.ts?reattach=${Date.now()}`); server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Server did not bind");
    const base = `http://127.0.0.1:${address.port}`; const credentials = await auth(base);
    const projectPath = path.join(root, "project"); await mkdir(projectPath);
    const created = await fetch(`${base}/api/projects`, { method: "POST", headers: credentials.headers, body: JSON.stringify({ name: "Draft", path: projectPath }) });
    const { project } = await created.json() as { project: { id: string } };
    await fetch(`${base}/api/settings`, { method: "PUT", headers: credentials.headers, body: JSON.stringify({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable, configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } }) });
    const ws = (sessionPath: string, id = "") => `ws://127.0.0.1:${address.port}/ws?projectId=${project.id}&sessionPath=${encodeURIComponent(sessionPath)}${id ? `&sessionId=${id}` : ""}`;
    const opened = await connect(ws("claude:new"), credentials.cookie); first = opened.socket;
    const id = String(opened.messages.find((message) => message.type === "ready")!.sessionId); first.close(); await new Promise<void>((resolve) => first!.once("close", resolve));
    const sessions = await fetch(`${base}/api/projects/${project.id}/sessions`, { headers: credentials.headers });
    const body = await sessions.json() as { sessions: Array<{ id: string; path: string; draft?: boolean }> };
    assert.ok(body.sessions.some((session) => session.id === id && session.path === `draft:claude:${id}` && session.draft));
    const resumed = await connect(ws(`draft:claude:${id}`, id), credentials.cookie); second = resumed.socket;
    second.send(JSON.stringify({ type: "prompt", message: "hello" })); await waitFor(resumed.messages, () => resumed.messages.some((message) => message.type === "agent_end"));
    const calls = (await readFile(process.env.JOINT_BOB_FAKE_CALLS!, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 1); const index = calls[0].indexOf("--session-id"); assert.equal(calls[0][index + 1], id);
  } finally {
    first?.terminate(); second?.terminate(); if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(prior)) { const env = { data: "JOINT_BOB_DATA_DIR", user: "MASTER_BOB_ADMIN_USERNAME", password: "MASTER_BOB_INITIAL_PASSWORD", calls: "JOINT_BOB_FAKE_CALLS" }[key]!; if (value === undefined) delete process.env[env]; else process.env[env] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
