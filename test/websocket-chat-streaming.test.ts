import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function waitFor(messages: Array<Record<string, unknown>>, predicate: () => boolean, timeout = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error(`Timed out: ${JSON.stringify(messages.slice(-30).map(({ type, text, error }) => ({ type, text, error })))}`)); }
    }, 10);
  });
}

async function fakeClaude(root: string): Promise<string> {
  const executable = path.join(root, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await appendFile(process.env.JOINT_BOB_FAKE_INVOCATIONS, prompt.trim() + '\\n');
const args = process.argv.slice(2);
const supplied = args.indexOf('--session-id');
const resumed = args.indexOf('--resume');
const sessionId = supplied >= 0 ? args[supplied + 1] : args[resumed + 1];
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: prompt.trim() } } }));
await new Promise((resolve) => setTimeout(resolve, 120));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: prompt.trim() }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false }));
`);
  await chmod(executable, 0o755);
  return executable;
}

async function authenticate(baseUrl: string): Promise<{ cookie: string; headers: Record<string, string> }> {
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
  const cookie = cookieFrom(login);
  const { csrfToken } = await login.json() as { csrfToken: string };
  const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
  const changed = await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
  assert.equal(changed.status, 204);
  return { cookie, headers };
}

test("Claude WebSocket streams before finalization and executes queued prompts once in FIFO order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-streaming-ws-"));
  const previous = { data: process.env.JOINT_BOB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD, invocations: process.env.JOINT_BOB_FAKE_INVOCATIONS };
  process.env.JOINT_BOB_DATA_DIR = path.join(root, "data");
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  process.env.JOINT_BOB_FAKE_INVOCATIONS = path.join(root, "invocations.log");
  let server: Server | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await fakeClaude(root);
    const module = await import(`../src/server.ts?streaming=${Date.now()}-${Math.random()}`);
    server = module.server;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { cookie, headers } = await authenticate(baseUrl);
    const projectPath = path.join(root, "project");
    await mkdir(projectPath);
    const projectResponse = await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Stream", path: projectPath }) });
    const { project } = await projectResponse.json() as { project: { id: string } };
    await fetch(`${baseUrl}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: path.join(root, "pi", "sessions") }, claude: { executable, configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") }, syncthing: { endpoint: "" } }) });

    const wsUrl = new URL(`/ws?projectId=${project.id}&sessionPath=claude:new`, baseUrl);
    wsUrl.protocol = "ws:";
    socket = new WebSocket(wsUrl, { origin: baseUrl, headers: { Cookie: cookie } });
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await waitFor(messages, () => messages.some((message) => message.type === "ready"));
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(messages, () => messages.some((message) => message.type === "textDelta" && message.text === "first"));
    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    socket.send(JSON.stringify({ type: "setEffort", effort: "high" }));
    await waitFor(messages, () => messages.filter((message) => message.type === "agent_end").length === 2);

    const firstDelta = messages.findIndex((message) => message.type === "textDelta" && message.text === "first");
    const firstEnd = messages.findIndex((message) => message.type === "agent_end");
    assert.ok(firstDelta >= 0 && firstDelta < firstEnd);
    assert.ok(messages.some((message) => message.type === "userMessage" && message.text === "second" && message.queued === true));
    assert.ok(messages.some((message) => message.type === "queueUpdate" && Number(message.pending) >= 1));
    assert.ok(messages.some((message) => message.type === "error" && String(message.error).includes("while Claude is working")));

    socket.send(JSON.stringify({ type: "prompt", message: "third" }));
    await waitFor(messages, () => messages.some((message) => message.type === "textDelta" && message.text === "third"));
    const abortedAt = Date.now();
    socket.send(JSON.stringify({ type: "abort" }));
    await waitFor(messages, () => messages.filter((message) => message.type === "agent_end").length === 3);
    assert.ok(Date.now() - abortedAt < 1_000);
    assert.deepEqual((await readFile(process.env.JOINT_BOB_FAKE_INVOCATIONS, "utf8")).trim().split("\n"), ["first", "second", "third"]);
  } finally {
    socket?.terminate();
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const [key, value] of Object.entries(previous)) {
      const envKey = { data: "JOINT_BOB_DATA_DIR", user: "MASTER_BOB_ADMIN_USERNAME", password: "MASTER_BOB_INITIAL_PASSWORD", invocations: "JOINT_BOB_FAKE_INVOCATIONS" }[key]!;
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
